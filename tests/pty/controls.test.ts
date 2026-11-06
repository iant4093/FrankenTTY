// Task 4.4 in a real PTY: audio, seek, pause, mode and HUD keys, and teardown of every child process.
// Audio runs through SDL's dummy driver (set by tests/helpers/pty.ts), so these runs are silent.

import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ASCII_RAMP } from '../../src/renderer/ascii.ts';
import { RESTORE_SEQUENCE } from '../../src/renderer/sequences.ts';
import { buildDemoCaches, hex, hudSeconds, isAlive, makeCacheDir, playerChildren, rowText, screenAt, startPty } from '../helpers/pty.ts';
import type { PtyRun } from '../helpers/pty.ts';
import { replayInto } from '../helpers/emulator.ts';
import { sleep, waitFor } from '../helpers/player-fakes.ts';

function available(cmd: string, args: string[]): boolean {
  return spawnSync(cmd, args, { stdio: 'ignore' }).status === 0;
}

const canRun =
  process.platform !== 'win32' &&
  available('python3', ['--version']) &&
  spawnSync('pgrep', ['-f', `no-such-process-marker-${String(process.pid)}`], { stdio: 'ignore' }).status === 1 && // pgrep exists (pid-unique: parallel probes must not match each other)
  available('ffmpeg', ['-version']) &&
  available('ffplay', ['-version']);

const ROWS = 30;
const COLS = 100;
const HUD_ROW = ROWS - 1;

async function endsRestored(run: PtyRun): Promise<void> {
  const all = Buffer.concat(run.chunks.map((c) => c.data)).toString('utf8');
  expect(all.endsWith(RESTORE_SEQUENCE)).toBe(true);
  const term = await replayInto(all, COLS, ROWS);
  try {
    expect(term.buffer.active.type).toBe('normal');
  } finally {
    term.dispose();
  }
}

describe.skipIf(!canRun)('player controls in a PTY', () => {
  // Every run uses a pre-built seek cache in its own directory: no background render competes for the CPU, and no
  // "seek cache ready" HUD message can show up in the middle of a run.
  let cacheDir = '';

  beforeAll(async () => {
    cacheDir = makeCacheDir('controls');
    await buildDemoCaches(cacheDir, ['testsrc2', 'life']);
  }, 180_000);

  afterAll(() => {
    if (cacheDir !== '') rmSync(cacheDir, { recursive: true, force: true });
  });

  it('[REQ-SYNC-03][REQ-SYNC-05][REQ-TERM-03] --demo testsrc2 with audio: seek, pause, resume and quit; no child process is left', async () => {
    const pty = startPty({
      args: ['--demo', 'testsrc2', '--av-offset', '0'],
      timeout: 25,
      env: { FRANKENTTY_CACHE_DIR: cacheDir },
      events: [
        { at: 2.0, hex: hex('\x1b[C') }, // Right: +5 s
        { at: 3.5, hex: hex(' ') }, // pause
        { at: 5.0, hex: hex(' ') }, // resume
        { at: 7.0, hex: hex('q') },
      ],
    });

    // Sample the process tree every 100 ms while the run is going.
    const seen = new Map<number, string>();
    const seenCount = new Map<number, number>();
    const samples: { t: number; names: string[] }[] = [];
    let done = false;
    void pty.finished.then(
      () => {
        done = true;
      },
      () => {
        done = true;
      },
    );
    const t0 = performance.now();
    while (!done) {
      const children = playerChildren(pty.marker);
      for (const c of children) {
        seen.set(c.pid, c.name);
        seenCount.set(c.pid, (seenCount.get(c.pid) ?? 0) + 1);
      }
      samples.push({ t: (performance.now() - t0) / 1000, names: children.map((c) => c.name) });
      await sleep(100);
    }

    const run = await pty.finished;
    expect(run.timedOut).toBe(false);
    expect(run.exitCode).toBe(0);
    await endsRestored(run);

    const during = (from: number, to: number): string[][] => samples.filter((s) => s.t >= from && s.t <= to).map((s) => s.names);
    // Audio started: ffmpeg (video), ffmpeg (audio source) and ffplay run while playing.
    const mostly = (windows: string[][], name: string): void => {
      expect(windows.length).toBeGreaterThanOrEqual(2); // pgrep sampling is slow on hosted macOS runners
      expect(windows.filter((names) => names.includes(name)).length).toBeGreaterThanOrEqual(Math.floor(windows.length * 0.8));
    };
    const playing = during(1.8, 3.3);
    mostly(playing, 'ffplay');
    expect(playing.some((names) => names.filter((n) => n === 'ffmpeg').length >= 2)).toBe(true);
    // Paused (3.5 s .. 5.0 s): both audio processes and the video decoder stay alive.
    const paused = during(4.0, 4.8);
    expect(paused.length).toBeGreaterThanOrEqual(2); // pgrep sampling is slow on hosted macOS runners
    for (const names of paused) {
      expect(names).toContain('ffplay');
      expect(names).toContain('ffmpeg');
    }
    // Resumed: audio again.
    const resumed = during(5.6, 6.8);
    mostly(resumed, 'ffplay');

    // One ffplay for the whole session: seek, pause and resume never respawn it. (main.ts also runs
    // `ffplay -version` once as a prerequisite check; that child lives for milliseconds, so a loaded
    // machine may sample it. The session's ffplay is seen in most samples.)
    const sessionFfplays = [...seen].filter(([pid, n]) => n === 'ffplay' && (seenCount.get(pid) ?? 0) >= 10);
    expect(sessionFfplays).toHaveLength(1);
    // No ffmpeg or ffplay survives q.
    expect(seen.size).toBeGreaterThanOrEqual(3);
    expect(await waitFor(() => [...seen.keys()].every((pid) => !isAlive(pid)), 4000)).toBe(true);

    const hud = async (t: number): Promise<string> => {
      const term = await screenAt(run, t, COLS, ROWS);
      try {
        return rowText(term, HUD_ROW);
      } finally {
        term.dispose();
      }
    };

    // Right: the HUD time is at least 0:05 within 1 s.
    const afterSeek = await hud(2.95);
    expect(hudSeconds(afterSeek)).not.toBeNull();
    expect(hudSeconds(afterSeek) ?? 0).toBeGreaterThanOrEqual(5);

    // Paused: two snapshots 0.5 s apart show the same time and the pause symbol.
    const p1 = await hud(4.0);
    const p2 = await hud(4.5);
    expect(p1.startsWith('\u23f8')).toBe(true);
    expect(p2.startsWith('\u23f8')).toBe(true);
    expect(hudSeconds(p1)).not.toBeNull();
    expect(hudSeconds(p1)).toBe(hudSeconds(p2));

    // Resumed: the symbol is back and the time advances past the paused one.
    const r = await hud(6.4);
    expect(r.startsWith('\u25b6')).toBe(true);
    expect(hudSeconds(r) ?? 0).toBeGreaterThan(hudSeconds(p2) ?? 0);
  }, 60_000);

  it('[REQ-UI-01][REQ-HUD-01] m cycles ASCII then Braille; i hides and shows the HUD', async () => {
    const pty = startPty({
      args: ['--demo', 'testsrc2', '--no-audio'],
      timeout: 20,
      env: { FRANKENTTY_CACHE_DIR: cacheDir },
      events: [
        { at: 2.0, hex: hex('m') },
        { at: 3.0, hex: hex('m') },
        { at: 4.0, hex: hex('i') },
        { at: 5.0, hex: hex('i') },
        { at: 6.0, hex: hex('q') },
      ],
    });
    const run = await pty.finished;
    expect(run.timedOut).toBe(false);
    expect(run.exitCode).toBe(0);
    await endsRestored(run);

    const scan = async (t: number): Promise<{ chars: string[]; hud: string }> => {
      const term = await screenAt(run, t, COLS, ROWS);
      try {
        const chars: string[] = [];
        for (let y = 0; y < HUD_ROW; y++) {
          const line = term.buffer.active.getLine(y);
          for (let x = 0; x < COLS; x++) {
            const ch = line?.getCell(x)?.getChars() ?? '';
            chars.push(ch === '' ? ' ' : ch);
          }
        }
        return { chars, hud: rowText(term, HUD_ROW) };
      } finally {
        term.dispose();
      }
    };

    const half = await scan(1.9);
    expect(half.chars.some((c) => c === '\u2580')).toBe(true);

    // After one 'm': ASCII ramp glyphs only, and some of them.
    const ascii = await scan(2.9);
    expect(ascii.chars.every((c) => ASCII_RAMP.includes(c))).toBe(true);
    expect(ascii.chars.some((c) => c !== ' ')).toBe(true);
    expect(ascii.chars.includes('\u2580')).toBe(false);

    // After another: Braille glyphs (or blanks), and some dots.
    const braille = await scan(3.9);
    expect(braille.chars.every((c) => c === ' ' || (c.codePointAt(0) ?? 0) >= 0x2800 && (c.codePointAt(0) ?? 0) <= 0x28ff)).toBe(true);
    expect(braille.chars.some((c) => (c.codePointAt(0) ?? 0) > 0x2800)).toBe(true);
    expect(braille.hud.startsWith('\u25b6')).toBe(true);

    // 'i' hides the HUD: the bottom row is blank, the video keeps going.
    const hidden = await scan(4.9);
    expect(hidden.hud).toBe('');
    expect(hidden.chars.some((c) => (c.codePointAt(0) ?? 0) > 0x2800)).toBe(true);

    // 'i' again shows it.
    const shown = await scan(5.9);
    expect(shown.hud.startsWith('\u25b6')).toBe(true);
    expect(shown.hud).toContain('braille');
  }, 60_000);

  it('[REQ-TERM-03] SIGTERM during playback with audio restores the terminal and leaves no children', async () => {
    const pty = startPty({
      args: ['--demo', 'life'],
      timeout: 20,
      env: { FRANKENTTY_CACHE_DIR: cacheDir },
      events: [{ at: 3.0, signal: 'SIGTERM' }],
    });
    const seen = new Map<number, string>();
    expect(
      await waitFor(() => {
        for (const c of playerChildren(pty.marker)) seen.set(c.pid, c.name);
        return [...seen.values()].includes('ffplay');
      }, 6000),
    ).toBe(true);
    const run = await pty.finished;
    expect(run.exitCode).toBe(143);
    await endsRestored(run);
    expect(await waitFor(() => [...seen.keys()].every((pid) => !isAlive(pid)), 4000)).toBe(true);
  }, 60_000);
});
