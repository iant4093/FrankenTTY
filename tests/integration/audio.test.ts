import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { buildAudioDecoderArgs, buildAudioPlayerArgs, createAudioPlayer } from '../../src/audio/player.ts';
import type { AudioPlayer } from '../../src/audio/player.ts';
import { demoAudioInputArgs, getDemo } from '../../src/ingest/demo.ts';

const hasTool = (name: string): boolean => spawnSync(name, ['-version'], { stdio: 'ignore' }).status === 0;
const hasAudioTools = hasTool('ffmpeg') && hasTool('ffplay');

const DEMO_AUDIO = demoAudioInputArgs(getDemo('testsrc2'));

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await sleep(10);
  }
  return cond();
}

function silentPlayer(): AudioPlayer {
  return createAudioPlayer({ inputArgs: DEMO_AUDIO, volume: 0 });
}

describe.skipIf(!hasAudioTools)('audio player (real ffmpeg + ffplay, volume 0)', () => {
  it('starts both processes and stop() ends them within 2 s', async () => {
    const player = silentPlayer();
    player.play(0);
    const pids = player.pids();
    expect(pids).toHaveLength(2);
    await sleep(1500);
    for (const pid of pids) expect(isAlive(pid)).toBe(true);

    const t0 = Date.now();
    await player.stop();
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(await waitFor(() => pids.every((pid) => !isAlive(pid)), 2000)).toBe(true);
    expect(player.pids()).toEqual([]);
  });

  it('stop() is idempotent and works before any play()', async () => {
    const player = silentPlayer();
    await player.stop();
    player.play(0);
    await Promise.all([player.stop(), player.stop()]);
    await player.stop();
  });

  it('play() returns a spawn time on the injected clock', async () => {
    let t = 123456;
    const player = createAudioPlayer({ inputArgs: DEMO_AUDIO, volume: 0, now: () => t });
    expect(player.play(0)).toBe(123456);
    t = 999;
    await player.stop();
  });

  it('fires onEnd when the audio finishes (play from 55 s of a 60 s clip)', async () => {
    const player = silentPlayer();
    let ended = 0;
    const errors: string[] = [];
    player.onEnd(() => {
      ended++;
    });
    player.onError((m) => errors.push(m));
    const t0 = Date.now();
    player.play(55);
    expect(await waitFor(() => ended > 0 || errors.length > 0, 8000)).toBe(true);
    expect(errors).toEqual([]);
    expect(ended).toBe(1);
    // About 5 s of audio plus start-up overhead.
    expect(Date.now() - t0).toBeGreaterThan(3000);
    expect(player.pids()).toEqual([]);
    await player.stop();
  }, 15_000);

  it('does not fire onEnd after stop()', async () => {
    const player = silentPlayer();
    let ended = 0;
    player.onEnd(() => {
      ended++;
    });
    player.play(58);
    await sleep(300);
    await player.stop();
    await sleep(500);
    expect(ended).toBe(0);
  });

  it('killNow() kills both processes synchronously', async () => {
    const player = silentPlayer();
    player.play(0);
    const pids = player.pids();
    await sleep(500);
    for (const pid of pids) expect(isAlive(pid)).toBe(true);
    player.killNow();
    expect(player.pids()).toEqual([]);
    // SIGKILL is delivered synchronously; the process table entry goes away right after.
    expect(await waitFor(() => pids.every((pid) => !isAlive(pid)), 1000)).toBe(true);
    await player.stop();
  });

  it('repeated play() calls leave at most one ffmpeg + ffplay pair alive', async () => {
    const player = silentPlayer();
    const all: number[] = [];
    for (let i = 0; i < 5; i++) {
      player.play(i);
      all.push(...player.pids());
      await sleep(120);
      const alive = all.filter(isAlive);
      expect(alive.length).toBeLessThanOrEqual(2 + 2); // previous pair may still be exiting
    }
    const last = player.pids();
    expect(last).toHaveLength(2);
    await sleep(100);
    expect(await waitFor(() => all.filter(isAlive).length <= 2, 2000)).toBe(true);
    expect(all.filter(isAlive).sort()).toEqual([...last].sort());
    await player.stop();
    expect(await waitFor(() => all.every((pid) => !isAlive(pid)), 2000)).toBe(true);
  }, 20_000);

  it('a replaced play() does not fire onEnd or onError for the old session', async () => {
    const player = silentPlayer();
    let ended = 0;
    const errors: string[] = [];
    player.onEnd(() => {
      ended++;
    });
    player.onError((m) => errors.push(m));
    player.play(0);
    await sleep(200);
    player.play(10);
    await sleep(800);
    await player.stop();
    expect(ended).toBe(0);
    expect(errors).toEqual([]);
  });

  it('reports an ffmpeg failure once with a one-line message', async () => {
    const player = createAudioPlayer({ inputArgs: ['-i', 'does-not-exist.wav'], volume: 0 });
    const errors: string[] = [];
    let ended = 0;
    player.onError((m) => errors.push(m));
    player.onEnd(() => {
      ended++;
    });
    player.play(0);
    expect(await waitFor(() => errors.length > 0, 5000)).toBe(true);
    await sleep(300);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^ffmpeg: /);
    expect(errors[0]).not.toContain('\n');
    expect(ended).toBe(0);
    await player.stop();
  });
});

describe('audio player without tools', () => {
  it('builds the ffmpeg and ffplay argv', () => {
    expect(buildAudioDecoderArgs(['-i', 'a b.mp4'], 0)).toEqual([
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-i', 'a b.mp4',
      '-vn', '-sn', '-dn', '-ac', '2', '-ar', '48000', '-f', 'wav', 'pipe:1',
    ]);
    const seeked = buildAudioDecoderArgs(['-i', 'x'], 12.3456);
    expect(seeked.slice(4, 8)).toEqual(['-ss', '12.346', '-i', 'x']);
    expect(buildAudioPlayerArgs(40)).toEqual([
      '-hide_banner', '-loglevel', 'error', '-nodisp', '-autoexit', '-volume', '40', '-i', 'pipe:0',
    ]);
  });

  it('reports a missing ffplay once and then does nothing', async () => {
    const player = createAudioPlayer({
      inputArgs: DEMO_AUDIO,
      volume: 0,
      ffplayPath: 'frankentty-no-such-ffplay',
    });
    const errors: string[] = [];
    let ended = 0;
    player.onError((m) => errors.push(m));
    player.onEnd(() => {
      ended++;
    });

    expect(() => player.play(0)).not.toThrow();
    expect(await waitFor(() => errors.length > 0, 3000)).toBe(true);
    // Later calls are no-ops that do not report again.
    expect(() => player.play(5)).not.toThrow();
    expect(() => player.play(10)).not.toThrow();
    await sleep(300);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('ffplay');
    expect(errors[0]).not.toContain('\n');
    expect(ended).toBe(0);
    expect(player.pids()).toEqual([]);
    await player.stop();
  });

  it('reports a missing ffmpeg once', async () => {
    const player = createAudioPlayer({
      inputArgs: DEMO_AUDIO,
      volume: 0,
      ffmpegPath: 'frankentty-no-such-ffmpeg',
      ffplayPath: 'frankentty-no-such-ffplay',
    });
    const errors: string[] = [];
    player.onError((m) => errors.push(m));
    player.play(0);
    expect(await waitFor(() => errors.length > 0, 3000)).toBe(true);
    player.play(0);
    await sleep(300);
    expect(errors).toHaveLength(1);
    await player.stop();
  });

  it('validates options and the start position', () => {
    expect(() => createAudioPlayer({ inputArgs: [], volume: 0 })).toThrow(RangeError);
    expect(() => createAudioPlayer({ inputArgs: DEMO_AUDIO, volume: 101 })).toThrow(RangeError);
    expect(() => createAudioPlayer({ inputArgs: DEMO_AUDIO, volume: -1 })).toThrow(RangeError);
    const player = createAudioPlayer({ inputArgs: DEMO_AUDIO, volume: 0, ffmpegPath: 'x', ffplayPath: 'y' });
    expect(() => player.play(-1)).toThrow(RangeError);
    expect(() => player.play(Number.NaN)).toThrow(RangeError);
  });
});
