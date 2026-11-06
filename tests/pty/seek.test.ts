// Task 4.6 in a real PTY on a real MP4 with audio (SDL dummy driver, so silent): seeking is fast and drops
// no frames, and one ffplay lives for the whole session through seek, pause and resume.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { SYNC_BEGIN, SYNC_END } from '../../src/renderer/sequences.ts';
import { ciBound, hex, hudSeconds, isAlive, ON_CI, playerChildren, rowText, screenAt, startPty } from '../helpers/pty.ts';
import type { PtyRun } from '../helpers/pty.ts';
import { sleep, waitFor } from '../helpers/player-fakes.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MP4 = path.join(root, 'assets', 'demo-testsrc2.mp4');

function available(cmd: string, args: string[]): boolean {
  return spawnSync(cmd, args, { stdio: 'ignore' }).status === 0;
}

const canRun =
  process.platform !== 'win32' &&
  available('python3', ['--version']) &&
  spawnSync('pgrep', ['-f', `no-such-process-marker-${String(process.pid)}`], { stdio: 'ignore' }).status === 1 && // pid-unique: parallel probes must not match each other
  available('ffmpeg', ['-version']) &&
  available('ffprobe', ['-version']) &&
  available('ffplay', ['-version']) &&
  available('bash', ['--version']);

const COLS = 100;
const ROWS = 30;
const HUD_ROW = ROWS - 1;
const RIGHT = '\x1b[C';
const LEFT = '\x1b[D';

/** Everything the process wrote, with the time each byte offset was read. */
function timeline(run: PtyRun): { text: string; timeAt: (offset: number) => number } {
  const parts = run.chunks.map((c) => c.data.toString('latin1'));
  const ends: number[] = [];
  let total = 0;
  for (const p of parts) {
    total += p.length;
    ends.push(total);
  }
  return {
    text: parts.join(''),
    timeAt: (offset) => {
      const i = ends.findIndex((end) => offset < end);
      return run.chunks[i === -1 ? run.chunks.length - 1 : i]?.t ?? 0;
    },
  };
}

interface SeekResult {
  /** Seconds from the key press to the first frame write after the seek. */
  latency: number;
  /**
   * Frame writes in the 1 s that starts 150 ms after that frame (the first 100 ms hold the first frame while the
   * sound's output latency elapses), 30 expected.
   */
  framesInSecond: number;
}

/**
 * The seek shows its message on the HUD (`» +5s`). The first frame write after the key is the one that carries the
 * message inside it, or the first frame write that follows a HUD-only write of it.
 */
function measureSeek(run: PtyRun, keyAt: number, message: string): SeekResult | null {
  const { text, timeAt } = timeline(run);
  const needle = Buffer.from(message, 'utf8').toString('latin1');
  let from = 0;
  for (;;) {
    const at = text.indexOf(needle, from);
    if (at === -1) return null;
    from = at + 1;
    if (timeAt(at) < keyAt) continue;
    const begin = text.lastIndexOf(SYNC_BEGIN, at);
    const end = begin === -1 ? -1 : text.indexOf(SYNC_END, begin);
    const inFrame = begin !== -1 && (end === -1 || end > at) && begin >= 0 && timeAt(begin) >= keyAt;
    const frameAt = inFrame ? begin : text.indexOf(SYNC_BEGIN, at);
    if (frameAt === -1) return null;
    const t = timeAt(frameAt);
    let n = 0;
    for (let i = text.indexOf(SYNC_BEGIN, frameAt); i !== -1; i = text.indexOf(SYNC_BEGIN, i + 1)) {
      const dt = timeAt(i) - t;
      if (dt >= 1.15) break;
      if (dt >= 0.15) n++;
    }
    return { latency: t - keyAt, framesInSecond: n };
  }
}

describe.skipIf(!canRun)('seek, pause and resume in a PTY on a 20 s MP4 with audio', () => {
  beforeAll(() => {
    if (existsSync(MP4)) return;
    const r = spawnSync('bash', [path.join(root, 'scripts', 'generate-demo-media.sh'), 'testsrc2', '20'], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`generate-demo-media.sh failed: ${r.stdout}${r.stderr}`);
  }, 60_000);

  it('seeks forward and back quickly, drops (almost) no frames, and uses one ffplay for the whole run', async () => {
    const pty = startPty({
      args: [MP4],
      timeout: 25,
      events: [
        { at: 2.0, hex: hex(RIGHT) }, // +5 s
        { at: 4.0, hex: hex(LEFT) }, // -5 s
        { at: 6.0, hex: hex(' ') }, // pause
        { at: 7.5, hex: hex(RIGHT) }, // seek while paused
        { at: 9.0, hex: hex(' ') }, // resume
        { at: 11.0, hex: hex('q') },
      ],
    });

    const pids = new Map<number, string>();
    /** In how many samples each pid was seen. */
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
        pids.set(c.pid, c.name);
        seenCount.set(c.pid, (seenCount.get(c.pid) ?? 0) + 1);
      }
      samples.push({ t: (performance.now() - t0) / 1000, names: children.map((c) => c.name) });
      await sleep(100);
    }
    const run = await pty.finished;
    expect(run.timedOut).toBe(false);
    expect(run.exitCode).toBe(0);

    // main.ts also runs `ffplay -version` once as a prerequisite check; that child lives for milliseconds, so a
    // loaded machine may sample it. The session's ffplay is the one seen for most of the run.
    function sessionFfplays(): number[] {
      return [...pids].filter(([pid, n]) => n === 'ffplay' && (seenCount.get(pid) ?? 0) >= 10).map(([pid]) => pid);
    }
    const forward = measureSeek(run, 2.0, '\u00bb +5s');
    const back = measureSeek(run, 4.0, '\u00bb -5s');
    console.info(
      `[4.6 measurement] seek forward: ${JSON.stringify(forward)}; seek back: ${JSON.stringify(back)}; ` +
        `ffplay pids: ${String(sessionFfplays().length)}; processes seen: ${String(pids.size)}; ` +
        `latency bound: ${String(ciBound(0.4, 0.8))} s (CI=${String(ON_CI)})`,
    );
    expect(forward).not.toBeNull();
    expect(back).not.toBeNull();
    const latencyBound = ciBound(0.4, 0.8);
    for (const r of [forward, back]) {
      // Key press -> first frame of the new position: 120 ms key coalescing + decoder + audio source.
      expect(r?.latency ?? Infinity).toBeLessThan(latencyBound);
      expect(r?.latency ?? -1).toBeGreaterThan(0.1);
      // 30 frames expected in the second after it; at most 3 are lost (more on a loaded hosted runner).
      expect(r?.framesInSecond ?? 0).toBeGreaterThanOrEqual(ciBound(27, 22));
    }

    // One ffplay for the whole run, alive through the seeks, the pause and the resume.
    const ffplays = sessionFfplays();
    expect(ffplays).toHaveLength(1);
    const during = (from: number, to: number): string[][] => samples.filter((s) => s.t >= from && s.t <= to).map((s) => s.names);
    for (const names of [...during(2.5, 3.5), ...during(6.3, 7.3), ...during(7.9, 8.9), ...during(9.5, 10.5)]) {
      expect(names).toContain('ffplay');
    }
    expect(await waitFor(() => [...pids.keys()].every((pid) => !isAlive(pid)), 4000)).toBe(true);

    // Paused seek: the HUD shows the new time and stays paused; the sound only continues after the resume.
    const hud = async (t: number): Promise<string> => {
      const term = await screenAt(run, t, COLS, ROWS);
      try {
        return rowText(term, HUD_ROW);
      } finally {
        term.dispose();
      }
    };
    const before = await hud(7.2);
    const afterSeek = await hud(8.5);
    expect(before.startsWith('\u23f8')).toBe(true);
    expect(afterSeek.startsWith('\u23f8')).toBe(true);
    expect((hudSeconds(afterSeek) ?? 0) - (hudSeconds(before) ?? 0)).toBeGreaterThanOrEqual(4);
  }, 90_000);
});
