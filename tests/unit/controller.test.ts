import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { createPlayer } from '../../src/player/controller.ts';
import type { PlayerStdin, PlayerStdout } from '../../src/player/controller.ts';
import { CLEAR, SYNC_BEGIN } from '../../src/renderer/sequences.ts';
import type { Screen } from '../../src/term/screen.ts';

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
const hasPgrep = spawnSync('pgrep', ['-f', 'no-such-process-marker'], { stdio: 'ignore' }).status === 1;

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

function setup(opts: { cols?: number; rows?: number; inputArgs: string[]; loop?: boolean }) {
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
  });
  return { stdout, stdin, screen, cleanups, player };
}

describe.skipIf(!hasFfmpeg)('createPlayer', () => {
  it('plays a 1 s source to the end, exits 0 and paces on the wall clock', async () => {
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

  it("'q' resolves 0 and 0x03 resolves 130; listeners are removed", async () => {
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

  it('renders every frame inside the render area and keeps the HUD row free', async () => {
    const { stdout, stdin, player } = setup({ cols: 40, rows: 12, inputArgs: lavfi('d', null) });
    const result = player.start();
    await waitFor(() => stdout.frames() > 2, STARTUP_MS);
    stdin.emit('data', Buffer.from('q'));
    await result;
    const text = stdout.text();
    const rows = [...text.matchAll(/\x1b\[(\d+);\d+H/g)].map((m) => Number(m[1]));
    expect(Math.max(...rows)).toBeLessThanOrEqual(11);
    expect(Math.min(...rows)).toBeGreaterThanOrEqual(1);
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

  it('debounces resize by 150 ms, clears the screen and redraws for the new geometry', async () => {
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
    const rows = [...after.matchAll(/\x1b\[(\d+);\d+H/g)].map((m) => Number(m[1]));
    // 60x30 at 16:9: 60 cols x 17 rows, centered in the 29 rows above the HUD.
    expect(Math.max(...rows)).toBeGreaterThan(12);
    expect(Math.max(...rows)).toBeLessThanOrEqual(29);
    expect(Math.min(...rows)).toBeGreaterThan(1);

    stdin.emit('data', Buffer.from('q'));
    expect(await result).toBe(0);
  });

  it('loops: restarts at 0 when the stream ends', async () => {
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

  it('refuses to start twice', async () => {
    const { stdin, player } = setup({ inputArgs: lavfi('j', null) });
    const result = player.start();
    await expect(player.start()).rejects.toThrow();
    stdin.emit('data', Buffer.from('q'));
    await result;
  });

  it.skipIf(!hasPgrep)('leaves no ffmpeg behind after q, and the screen cleanup kills the rest', async () => {
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
