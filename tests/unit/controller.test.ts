import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { createPlayer } from '../../src/player/controller.ts';
import type { PlayerDeps, PlayerStdin, PlayerStdout } from '../../src/player/controller.ts';
import { CLEAR, SGR_RESET, SYNC_BEGIN, SYNC_END } from '../../src/renderer/sequences.ts';
import type { Screen } from '../../src/term/screen.ts';

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
const hasPgrep = spawnSync('pgrep', ['-f', `no-such-process-marker-${String(process.pid)}`], { stdio: 'ignore' }).status === 1; // pid-unique: parallel probes must not match each other

class FakeStdout extends EventEmitter implements PlayerStdout {
  columns: number;
  rows: number;
  writableNeedDrain = false;
  writableLength = 0;
  writes: (Uint8Array | string)[] = [];
  constructor(columns: number, rows: number) {
    super();
    this.columns = columns;
    this.rows = rows;
  }
  write(data: Uint8Array | string): boolean {
    // The serializer reuses its buffer, so keep a copy.
    this.writes.push(typeof data === 'string' ? data : Uint8Array.from(data));
    return true;
  }
  frames(): number {
    return this.writes.filter((w) => typeof w !== 'string' && Buffer.from(w).toString().startsWith(SYNC_BEGIN)).length;
  }
  /** Text of every write that carries a video frame. */
  frameTexts(): string[] {
    return this.writes
      .map((w) => (typeof w === 'string' ? w : Buffer.from(w).toString('utf8')))
      .filter((t) => t.startsWith(SYNC_BEGIN));
  }
  text(): string {
    return this.writes.map((w) => (typeof w === 'string' ? w : Buffer.from(w).toString('utf8'))).join('');
  }
}

class FakeStdin extends EventEmitter implements PlayerStdin {
  resumed = false;
  resume(): this {
    this.resumed = true;
    return this;
  }
}

function fakeScreen(): { screen: Screen; cleanups: (() => void)[] } {
  const cleanups: (() => void)[] = [];
  const screen: Screen = {
    isActive: true,
    enter: () => undefined,
    restore: () => undefined,
    addCleanup: (fn) => {
      cleanups.push(fn);
    },
  };
  return { screen, cleanups };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await sleep(10);
  }
  return cond();
}

// Process start-up is slow on some machines (Windows CI), so waits for the first frames are generous.
const STARTUP_MS = 20_000;

const MEDIA = { width: 160, height: 90, fps: 30, durationSec: 2, hasAudio: false, source: 'demo' as const };

function lavfi(marker: string, seconds: number | null): string[] {
  const duration = seconds === null ? '' : `:duration=${String(seconds)}`;
  // The metadata tag only gives the ffmpeg command line a unique marker for pgrep.
  return ['-f', 'lavfi', '-i', `testsrc2=size=160x90:rate=30${duration}`, '-metadata', `title=${marker}`];
}

function setup(opts: {
  cols?: number;
  rows?: number;
  inputArgs: string[];
  loop?: boolean;
  extra?: Partial<PlayerDeps>;
}) {
  const stdout = new FakeStdout(opts.cols ?? 40, opts.rows ?? 12);
  const stdin = new FakeStdin();
  const { screen, cleanups } = fakeScreen();
  const player = createPlayer({
    stdout,
    stdin,
    screen,
    mediaInfo: MEDIA,
    inputArgs: opts.inputArgs,
    isFile: false,
    fps: 30,
    cellAspect: 2,
    loop: opts.loop ?? false,
    ...opts.extra,
  });
  return { stdout, stdin, screen, cleanups, player };
}

describe.skipIf(!hasFfmpeg)('createPlayer', () => {
  it('[REQ-SYNC-02] plays a 1 s source to the end, exits 0 and paces on the wall clock', async () => {
    const { stdout, stdin, player } = setup({ inputArgs: lavfi('a', 1) });
    const started = Date.now();
    const code = await player.start();
    const elapsed = Date.now() - started;
    expect(code).toBe(0);
    expect(stdin.resumed).toBe(true);
    // 30 frames at 30 fps take about 1 s of wall time (plus ffmpeg start-up).
    // The upper bound only guards against a hang; start-up time depends on the machine.
    expect(elapsed).toBeGreaterThan(900);
    expect(elapsed).toBeLessThan(STARTUP_MS);
    const c = player.counters();
    expect(c.framesRendered).toBe(stdout.frames());
    // A slow start makes the clock catch up by dropping frames, so only require some output.
    expect(c.framesRendered).toBeGreaterThan(0);
    expect(c.framesRendered + c.framesDropped).toBeLessThanOrEqual(30);
    expect(c.bytesWritten).toBeGreaterThan(0);
    expect(c.ticksSkipped).toBe(0);
    expect(player.lastError()).toBeNull();
  });

  it("[REQ-TERM-03] 'q' resolves 0 and 0x03 resolves 130; listeners are removed", async () => {
    for (const [key, code] of [['q', 0], ['\x03', 130]] as const) {
      const { stdout, stdin, player } = setup({ inputArgs: lavfi('b', null) });
      const result = player.start();
      expect(await waitFor(() => stdout.frames() > 2, STARTUP_MS)).toBe(true);
      stdin.emit('data', Buffer.from('x' + key));
      expect(await result).toBe(code);
      expect(stdin.listenerCount('data')).toBe(0);
      expect(stdout.listenerCount('resize')).toBe(0);
    }
  });

  it('ignores other keys', async () => {
    const { stdout, stdin, player } = setup({ inputArgs: lavfi('c', null) });
    const result = player.start();
    await waitFor(() => stdout.frames() > 2, STARTUP_MS);
    stdin.emit('data', Buffer.from('mci \x1b[C '));
    await sleep(100);
    stdin.emit('data', Buffer.from('q'));
    expect(await result).toBe(0);
  });

  it('[REQ-GEO-02] renders every frame inside the render area and keeps the HUD row free', async () => {
    const { stdout, stdin, player } = setup({ cols: 40, rows: 12, inputArgs: lavfi('d', null) });
    const result = player.start();
    await waitFor(() => stdout.frames() > 2, STARTUP_MS);
    stdin.emit('data', Buffer.from('q'));
    await result;
    const text = stdout.text();
    // Video cells stay above the HUD row (12). The only thing ever positioned on row 12 is the HUD.
    const moves = [...text.matchAll(/\x1b\[(\d+);\d+H(\x1b\[0;37;40m)?/g)];
    const videoRows = moves.filter((m) => m[2] === undefined).map((m) => Number(m[1]));
    expect(videoRows.length).toBeGreaterThan(0);
    expect(Math.max(...videoRows)).toBeLessThanOrEqual(11);
    expect(Math.min(...videoRows)).toBeGreaterThanOrEqual(1);
    const hudRows = moves.filter((m) => m[2] !== undefined).map((m) => Number(m[1]));
    expect(hudRows.length).toBeGreaterThan(0);
    expect(new Set(hudRows)).toEqual(new Set([12]));
  });

  it('[REQ-PLAT-01][REQ-TERM-02] follows window size changes through the stdout resize event, never SIGWINCH, and removes its listener', async () => {
    const sigwinchBefore = process.listenerCount('SIGWINCH');
    const { stdout, stdin, player } = setup({ cols: 40, rows: 12, inputArgs: lavfi('x', null) });
    expect(stdout.listenerCount('resize')).toBe(0);
    const result = player.start();
    await waitFor(() => stdout.frames() > 1, STARTUP_MS);
    expect(stdout.listenerCount('resize')).toBeGreaterThan(0);
    expect(process.listenerCount('SIGWINCH')).toBe(sigwinchBefore);
    stdin.emit('data', Buffer.from('q'));
    expect(await result).toBe(0);
    expect(stdout.listenerCount('resize')).toBe(0);
  });

  it('[REQ-RENDER-04] writes every video frame with exactly one write(), wrapped in sync begin and end', async () => {
    const { stdout, stdin, player } = setup({ cols: 40, rows: 12, inputArgs: lavfi('w', null) });
    const result = player.start();
    await waitFor(() => stdout.frames() > 5, STARTUP_MS);
    stdin.emit('data', Buffer.from('q'));
    await result;
    const texts = stdout.writes.map((w) => (typeof w === 'string' ? w : Buffer.from(w).toString('utf8')));
    const framed = texts.filter((t) => t.includes(SYNC_BEGIN));
    expect(framed.length).toBeGreaterThan(5);
    for (const t of framed) {
      expect(t.startsWith(SYNC_BEGIN)).toBe(true);
      expect(t.endsWith(SGR_RESET + SYNC_END)).toBe(true);
      expect(t.split(SYNC_BEGIN)).toHaveLength(2);
      expect(t.split(SYNC_END)).toHaveLength(2);
    }
    // No frame is split over several writes: the begin marks and the end marks pair up one to one.
    expect(stdout.text().split(SYNC_BEGIN).length - 1).toBe(framed.length);
    expect(stdout.text().split(SYNC_END).length - 1).toBe(framed.length);
  });

  it('skips rendering while stdout needs a drain, and counts it', async () => {
    const { stdout, stdin, player } = setup({ inputArgs: lavfi('e', null) });
    stdout.writableNeedDrain = true;
    const result = player.start();
    expect(await waitFor(() => player.counters().ticksSkipped > 5, STARTUP_MS)).toBe(true);
    expect(stdout.frames()).toBe(0);
    stdout.writableNeedDrain = false;
    await waitFor(() => stdout.frames() > 2, STARTUP_MS);
    expect(stdout.frames()).toBeGreaterThan(2);
    stdin.emit('data', Buffer.from('q'));
    await result;
  });

  it('shows "terminal too small" when no row is left for video, then plays after a resize', async () => {
    const { stdout, stdin, player } = setup({ cols: 40, rows: 1, inputArgs: lavfi('f', null) });
    const result = player.start();
    await sleep(500);
    expect(stdout.text()).toContain('terminal too small');
    expect(stdout.frames()).toBe(0);

    stdout.rows = 12;
    stdout.emit('resize');
    expect(await waitFor(() => stdout.frames() > 2, STARTUP_MS)).toBe(true);
    stdin.emit('data', Buffer.from('q'));
    expect(await result).toBe(0);
  });

  it('q works while the terminal is too small', async () => {
    const { stdin, player } = setup({ cols: 40, rows: 1, inputArgs: lavfi('g', null) });
    const result = player.start();
    await sleep(100);
    stdin.emit('data', Buffer.from('q'));
    expect(await result).toBe(0);
  });

  it('[REQ-TERM-02][REQ-PLAT-01] debounces resize by 150 ms, clears the screen and redraws for the new geometry', async () => {
    const { stdout, stdin, player } = setup({ cols: 40, rows: 12, inputArgs: lavfi('h', null) });
    const result = player.start();
    await waitFor(() => stdout.frames() > 2, STARTUP_MS);

    const clearsBefore = stdout.writes.filter((w) => w === CLEAR).length;
    stdout.columns = 60;
    stdout.rows = 30;
    stdout.emit('resize');
    stdout.emit('resize');
    const waitStart = performance.now();
    await sleep(60);
    // Only check the debounce if the event loop did not stall past the 150 ms window.
    if (performance.now() - waitStart < 120) {
      expect(stdout.writes.filter((w) => w === CLEAR).length).toBe(clearsBefore); // still debouncing
    }
    const redrawn = (): boolean =>
      stdout.writes.filter((w) => w === CLEAR).length === clearsBefore + 1 &&
      stdout.writes.length > stdout.writes.lastIndexOf(CLEAR) + 3;
    expect(await waitFor(redrawn, STARTUP_MS)).toBe(true);

    const after = stdout.writes
      .slice(stdout.writes.lastIndexOf(CLEAR) + 1)
      .map((w) => (typeof w === 'string' ? w : Buffer.from(w).toString('utf8')))
      .join('');
    const rows = [...after.matchAll(/\x1b\[(\d+);\d+H(?!\x1b\[0;37;40m)/g)].map((m) => Number(m[1]));
    // The HUD (row 30, white on black) is excluded. 60x30 at 16:9: 60 cols x 17 rows, centered in the 29 rows above the HUD.
    expect(Math.max(...rows)).toBeGreaterThan(12);
    expect(Math.max(...rows)).toBeLessThanOrEqual(29);
    expect(Math.min(...rows)).toBeGreaterThan(1);

    stdin.emit('data', Buffer.from('q'));
    expect(await result).toBe(0);
  });

  it('[REQ-CLI-01] loops: restarts at 0 when the stream ends', async () => {
    const { stdout, stdin, player } = setup({ inputArgs: lavfi('i', 0.5), loop: true });
    const result = player.start();
    // A 0.5 s source has 15 frames per pass, so more than 30 frames means at least two loop
    // restarts, however long ffmpeg takes to start.
    expect(await waitFor(() => stdout.frames() > 30, STARTUP_MS)).toBe(true);
    stdin.emit('data', Buffer.from('q'));
    expect(await result).toBe(0);
  });

  it('reports a decode failure as exit 1 with one line of text', async () => {
    const { player } = setup({ inputArgs: ['-i', '/nonexistent/file.mp4'] });
    expect(await player.start()).toBe(1);
    const message = player.lastError();
    expect(message).not.toBeNull();
    expect(message?.split('\n')).toHaveLength(1);
  });

  /** Screen rows (1-based) that the video part of a write positions the cursor on; the HUD row is excluded. */
  function videoRows(text: string): number[] {
    return [...text.matchAll(/\x1b\[(\d+);\d+H(?!\x1b\[0;37;40m)/g)].map((m) => Number(m[1]));
  }

  it('[REQ-RENDER-05] writes a static picture once in full, then only the rolling-refresh row of each frame', async () => {
    const still = ['-f', 'lavfi', '-i', 'color=c=0x3366cc:size=160x90:rate=30'];
    const { stdout, stdin, player } = setup({ inputArgs: still });
    const result = player.start();
    expect(await waitFor(() => stdout.frames() > 8, STARTUP_MS)).toBe(true);
    stdin.emit('data', Buffer.from('q'));
    expect(await result).toBe(0);

    const frameWrites = stdout.frameTexts();
    const first = frameWrites[0] ?? '';
    const areaRows = new Set(videoRows(first));
    expect(areaRows.size).toBeGreaterThan(5); // the whole render area
    // Every later frame repositions the cursor exactly once: one refreshed row (K = ceil(rows / 60) = 1).
    for (const text of frameWrites.slice(1)) {
      const rows = videoRows(text);
      expect(rows).toHaveLength(1);
      expect(areaRows.has(rows[0] ?? 0)).toBe(true);
    }
    const c = player.counters();
    expect(c.framesRendered).toBe(stdout.frames());
    expect(c.framesUnchanged).toBe(0);
  });

  it('[REQ-RENDER-05] rewrites every row of a static picture once per refresh cycle, in order, instead of redrawing it all every 10 s', async () => {
    const still = ['-f', 'lavfi', '-i', 'color=c=0x3366cc:size=160x90:rate=30'];
    const { stdout, stdin, player } = setup({ inputArgs: still });
    const result = player.start();
    expect(await waitFor(() => stdout.frames() > 30, STARTUP_MS)).toBe(true);
    stdin.emit('data', Buffer.from('q'));
    expect(await result).toBe(0);

    const frameWrites = stdout.frameTexts();
    const areaRows = [...new Set(videoRows(frameWrites[0] ?? ''))].sort((a, b) => a - b);
    const refreshed = frameWrites.slice(1).map((t) => videoRows(t)[0] ?? 0);
    // The first frame already used the cursor's first row. From there each row follows once, top to
    // bottom, and the cycle wraps.
    const n = areaRows.length;
    const expected = refreshed.map((_, i) => areaRows[(i + 1) % n]);
    expect(refreshed).toEqual(expected);
    expect(new Set(refreshed.slice(0, n)).size).toBe(n);
  });

  it('[REQ-RENDER-06] uses the requested mode: ascii draws ramp characters and no half blocks', async () => {
    const { stdout, stdin, player } = setup({ inputArgs: lavfi('k', null), extra: { mode: 'ascii' } });
    const result = player.start();
    await waitFor(() => stdout.frames() > 2, STARTUP_MS);
    stdin.emit('data', Buffer.from('q'));
    await result;
    expect(stdout.text()).not.toContain('\u2580');
    expect(stdout.text()).toMatch(/[.:\-=+*#%@]/);
  });

  it('[REQ-RENDER-06] uses the requested mode: braille draws Braille glyphs', async () => {
    const { stdout, stdin, player } = setup({ inputArgs: lavfi('l', null), extra: { mode: 'braille' } });
    const result = player.start();
    await waitFor(() => stdout.frames() > 2, STARTUP_MS);
    stdin.emit('data', Buffer.from('q'));
    await result;
    expect(stdout.text()).toMatch(/[\u2801-\u28ff]/);
    expect(stdout.text()).not.toContain('\u2580');
  });

  it('[REQ-RENDER-08] uses the requested color depth: 256-color sequences, no 24-bit ones', async () => {
    const { stdout, stdin, player } = setup({ inputArgs: lavfi('m', null), extra: { depth: 8 } });
    const result = player.start();
    await waitFor(() => stdout.frames() > 2, STARTUP_MS);
    stdin.emit('data', Buffer.from('q'));
    await result;
    expect(stdout.text()).toMatch(/\x1b\[(38|48);5;\d+/);
    expect(stdout.text()).not.toMatch(/\x1b\[[\d;]*[34]8;2;/);
  });

  it('refuses to start twice', async () => {
    const { stdin, player } = setup({ inputArgs: lavfi('j', null) });
    const result = player.start();
    await expect(player.start()).rejects.toThrow();
    stdin.emit('data', Buffer.from('q'));
    await result;
  });

  it.skipIf(!hasPgrep)('[REQ-TERM-03] leaves no ffmpeg behind after q, and the screen cleanup kills the rest', async () => {
    const marker = `zq${String(process.pid)}x`;
    const { stdin, player, cleanups } = setup({ inputArgs: lavfi(marker, null) });
    const alive = (): boolean => spawnSync('pgrep', ['-f', marker], { stdio: 'ignore' }).status === 0;
    const result = player.start();
    expect(await waitFor(alive, STARTUP_MS)).toBe(true);
    stdin.emit('data', Buffer.from('q'));
    await result;
    expect(await waitFor(() => !alive(), 3000)).toBe(true);
    expect(cleanups).toHaveLength(1);
    expect(() => cleanups[0]?.()).not.toThrow();
  });
});
