// Backpressure path of the player (task 4.9): ticks skipped because stdout is busy.
// Regression for F-4.8-1: `govSkip` once called itself instead of `governor.recordSkip`, so the first
// busy tick overflowed the stack. Real ffmpeg lavfi sources feed the player; stdout, stdin, screen and
// audio are fakes. The governor module is wrapped (not replaced) so every recordSkip call is observed.

import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeAudio, STARTUP_MS, setup, sleep, waitFor } from '../helpers/player-fakes.ts';
import type { FakeStdout } from '../helpers/player-fakes.ts';

const spies = vi.hoisted(() => ({ skips: [] as number[] }));

vi.mock('../../src/renderer/governor.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/renderer/governor.ts')>();
  return {
    ...original,
    createGovernor: (options: Parameters<typeof original.createGovernor>[0]) => {
      const governor = original.createGovernor(options);
      return {
        ...governor,
        recordSkip(atMs: number): void {
          spies.skips.push(atMs);
          governor.recordSkip(atMs);
        },
      };
    },
  };
});

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

const RIGHT = '\x1b[C';
/** Mirror of the controller's 500 ms governor mute after the barrier, with a little slack for the call order. */
const MUTE_MS = 500;
const SLACK_MS = 5;

/** Makes `writableLength` report `busy()` on every read. `writableNeedDrain` stays false. */
function setBusy(stdout: FakeStdout, busy: () => boolean): void {
  Object.defineProperty(stdout, 'writableLength', {
    configurable: true,
    get: () => (busy() ? 4096 : 0),
  });
}

describe.skipIf(!hasFfmpeg)('[REQ-PERF-01] busy stdout (backpressure skips)', () => {
  beforeEach(() => {
    spies.skips.length = 0;
  });

  it('keeps running while stdout is busy, counts skips, and feeds the governor only outside the barrier and its mute', async () => {
    const audio = new FakeAudio();
    const releases: number[] = [];
    const seekCalls: number[] = [];
    const origRelease = audio.release.bind(audio);
    audio.release = (): void => {
      releases.push(performance.now());
      origRelease();
    };
    const origSeek = audio.seek.bind(audio);
    audio.seek = (sec: number, inputArgs?: string[]): void => {
      seekCalls.push(performance.now());
      origSeek(sec, inputArgs);
    };

    const { stdout, stdin, player } = setup({
      marker: 'skip-mute',
      extra: { audio, quality: 'max' },
    });
    let busy = true;
    setBusy(stdout, () => busy);

    const result = player.start();
    let finished = false;
    void result.then(() => {
      finished = true;
    });

    // Phase 1: start-up barrier. The first frame releases it; stdout is busy from the start.
    expect(await waitFor(() => releases.length >= 1, STARTUP_MS)).toBe(true);
    const release1 = releases[0] as number;
    await waitFor(() => performance.now() >= release1 + 400, STARTUP_MS);
    // Inside the mute window ticks are skipped and counted, but the governor sees nothing.
    expect(player.counters().ticksSkipped).toBeGreaterThanOrEqual(5);
    expect(spies.skips.length).toBe(0);

    // After the mute the skips reach the governor.
    expect(await waitFor(() => spies.skips.length >= 10, STARTUP_MS)).toBe(true);
    expect(spies.skips.every((at) => at >= release1 + MUTE_MS - SLACK_MS)).toBe(true);
    expect(finished).toBe(false);

    // Phase 2: a seek puts the clock behind a barrier again. Hold it for 600 ms with a slow audio source.
    audio.readyAfterMs = 600;
    const skipsBeforeSeek = spies.skips.length;
    stdin.key(RIGHT);
    expect(await waitFor(() => seekCalls.length >= 1 && releases.length >= 2, STARTUP_MS)).toBe(true);
    const seekAt = seekCalls[0] as number;
    const release2 = releases[1] as number;
    expect(release2 - seekAt).toBeGreaterThanOrEqual(550);
    // Resume of skips after the second mute.
    expect(await waitFor(() => spies.skips.length >= skipsBeforeSeek + 5 && spies.skips.some((at) => at >= release2), STARTUP_MS)).toBe(true);
    for (const at of spies.skips) {
      // Nothing between the seek (barrier start) and the end of the mute that follows its release.
      expect(at >= seekAt && at < release2 + MUTE_MS - SLACK_MS).toBe(false);
    }
    expect(finished).toBe(false);

    // Phase 3: stdout drains. Frames flow again and the player was never disturbed.
    const skipped = player.counters().ticksSkipped;
    busy = false;
    const frames = stdout.frames();
    expect(await waitFor(() => stdout.frames() > frames + 5, STARTUP_MS)).toBe(true);
    expect(player.counters().ticksSkipped).toBeLessThanOrEqual(skipped + 3); // at most a tick or two in flight
    expect(player.counters().framesDropped).toBeGreaterThan(0);
    expect(player.lastError()).toBeNull();

    stdin.key('q');
    expect(await result).toBe(0);
  });

  it('survives a long busy spell without a stack overflow and recovers', async () => {
    const { stdout, stdin, player } = setup({ marker: 'skip-recover', extra: { quality: 'max' } });
    let busy = false;
    setBusy(stdout, () => busy);
    const result = player.start();
    expect(await waitFor(() => stdout.frames() >= 3, STARTUP_MS)).toBe(true);
    await sleep(600); // past the start-up mute

    busy = true;
    const before = spies.skips.length;
    expect(await waitFor(() => spies.skips.length >= before + 30, STARTUP_MS)).toBe(true);
    expect(player.counters().ticksSkipped).toBeGreaterThanOrEqual(30);

    busy = false;
    const frames = stdout.frames();
    expect(await waitFor(() => stdout.frames() > frames + 5, STARTUP_MS)).toBe(true);

    stdin.key('q');
    expect(await result).toBe(0);
  });
});

describe.skipIf(!hasFfmpeg)('[REQ-PERF-01] quality governor with busy-stdout skips', () => {
  beforeEach(() => {
    spies.skips.length = 0;
  });

  it('30 fps with stdout busy on 2 of every 3 ticks steps the governor down', async () => {
    const { stdout, stdin, player } = setup({ marker: 'skip-gov', extra: { quality: 'auto' } });
    let reads = 0;
    // Every tick that has a frame asks once; 2 of 3 asks find the stream busy. Writes themselves take no time.
    setBusy(stdout, () => reads++ % 3 !== 0);

    const result = player.start();
    expect(await waitFor(() => player.state().qualityLevel >= 1, STARTUP_MS)).toBe(true);
    const skipped = player.counters().ticksSkipped;
    expect(skipped).toBeGreaterThan(0);
    expect(spies.skips.length).toBeGreaterThan(0);
    // Steps taken are visible in the settings, not only in the level number.
    const s = player.state();
    expect(s.threshold > 8 || s.depth !== 24).toBe(true);
    // Frames still got through on the free ticks.
    expect(stdout.frames()).toBeGreaterThan(0);
    expect(player.lastError()).toBeNull();

    stdin.key('q');
    expect(await result).toBe(0);
  });

  it('the same busy pattern with --quality max never steps', async () => {
    const { stdout, stdin, player } = setup({ marker: 'skip-gov-max', extra: { quality: 'max' } });
    let reads = 0;
    setBusy(stdout, () => reads++ % 3 !== 0);
    const result = player.start();
    expect(await waitFor(() => spies.skips.length >= 30, STARTUP_MS)).toBe(true);
    expect(player.state().qualityLevel).toBe(0);
    stdin.key('q');
    expect(await result).toBe(0);
  });
});
