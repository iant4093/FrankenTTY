import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  CHUNK_MS,
  LEAD_MS,
  OUTPUT_LATENCY_MS,
  PCM_RATE,
  buildAudioDecoderArgs,
  buildAudioPlayerArgs,
  createAudioPlayer,
} from '../../src/audio/player.ts';
import type { AudioPlayer } from '../../src/audio/player.ts';
import { demoAudioInputArgs, getDemo } from '../../src/ingest/demo.ts';

// SDL's dummy driver: real-time pace, no sound device needed (CI runners have none).
process.env['SDL_AUDIODRIVER'] ??= 'dummy';

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

describe.skipIf(!hasAudioTools)('[REQ-SYNC-04][REQ-SYNC-03] audio player (real ffmpeg + ffplay, volume 0)', () => {
  it('starts ffplay and the source, and stop() ends both within 2 s', async () => {
    const player = silentPlayer();
    player.start(0);
    const pids = player.pids();
    expect(pids).toHaveLength(2);
    await sleep(1000);
    for (const pid of pids) expect(isAlive(pid)).toBe(true);

    const t0 = Date.now();
    await player.stop();
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(await waitFor(() => pids.every((pid) => !isAlive(pid)), 2000)).toBe(true);
  });

  it('stop() is idempotent and works before any start()', async () => {
    const player = silentPlayer();
    await player.stop();
    const other = silentPlayer();
    other.start(0);
    await Promise.all([other.stop(), other.stop()]);
    await other.stop();
  });

  it('holds until release(): ready() turns true, the position stays at the start, then it runs', async () => {
    const player = silentPlayer();
    player.start(3);
    expect(await waitFor(() => player.ready(), 5000)).toBe(true);
    await sleep(200);
    expect(player.positionSec()).toBe(3); // held
    expect(player.stats()?.writes).toBe(0);

    player.release();
    await sleep(1000);
    const pos = player.positionSec();
    // About 1 s of playing minus the output latency.
    expect(pos).toBeGreaterThan(3 + 0.55);
    expect(pos).toBeLessThan(3 + 1.1);
    const stats = player.stats();
    expect(stats?.writes).toBeGreaterThan(30);
    // Never more than LEAD_MS written ahead of the model clock.
    expect((stats?.aheadMaxFrames ?? Infinity) / PCM_RATE).toBeLessThanOrEqual(LEAD_MS / 1000 + 1e-9);
    await player.stop();
  }, 15_000);

  it('pause freezes the position and the writes; resume continues; the same two processes stay alive', async () => {
    const player = silentPlayer();
    player.start(0);
    await waitFor(() => player.ready(), 5000);
    player.release();
    await sleep(600);
    const pids = player.pids();
    expect(pids).toHaveLength(2);

    player.pause();
    const frozen = player.positionSec();
    const writes = player.stats()?.writes ?? 0;
    await sleep(500);
    expect(player.positionSec()).toBe(frozen);
    expect(player.stats()?.writes).toBe(writes);
    expect(player.pids()).toEqual(pids);

    player.resume();
    await sleep(500);
    expect(player.positionSec()).toBeGreaterThan(frozen + 0.2);
    expect(player.stats()?.writes).toBeGreaterThan(writes);
    expect(player.pids()).toEqual(pids);
    for (const pid of pids) expect(isAlive(pid)).toBe(true);
    await player.stop();
  }, 15_000);

  it('seek replaces only the source; ffplay keeps its pid and the old source exits', async () => {
    const player = silentPlayer();
    player.start(0);
    await waitFor(() => player.ready(), 5000);
    player.release();
    await sleep(300);
    const [ffplayPid, sourceBefore] = player.pids() as [number, number];

    player.seek(20);
    expect(player.positionSec()).toBe(20); // held at the target
    const [ffplayAfter, sourceAfter] = player.pids() as [number, number];
    expect(ffplayAfter).toBe(ffplayPid);
    expect(sourceAfter).not.toBe(sourceBefore);
    expect(await waitFor(() => !isAlive(sourceBefore), 2000)).toBe(true);
    expect(isAlive(ffplayPid)).toBe(true);

    expect(await waitFor(() => player.ready(), 5000)).toBe(true);
    player.release();
    await sleep(500);
    expect(player.positionSec()).toBeGreaterThan(20.1);
    expect(player.positionSec()).toBeLessThan(20.6);
    await player.stop();
  }, 15_000);

  it('start() on a started player acts as a seek', async () => {
    const player = silentPlayer();
    player.start(0);
    const [ffplayPid] = player.pids() as [number, number];
    player.start(7);
    expect(player.pids()[0]).toBe(ffplayPid);
    expect(player.positionSec()).toBe(7);
    await player.stop();
  });

  it('fires onEnd once the source ended and its PCM was written (from 57 s of a 60 s clip)', async () => {
    const player = silentPlayer();
    let ended = 0;
    const errors: string[] = [];
    player.onEnd(() => {
      ended++;
    });
    player.onError((m) => errors.push(m));
    player.start(57);
    await waitFor(() => player.ready(), 5000);
    player.release();
    expect(await waitFor(() => ended > 0 || errors.length > 0, 8000)).toBe(true);
    expect(errors).toEqual([]);
    expect(ended).toBe(1);
    // The position keeps moving past the end of the PCM, so video can finish by the clock.
    const at = player.positionSec();
    await sleep(300);
    expect(player.positionSec()).toBeGreaterThan(at + 0.2);
    await player.stop();
  }, 20_000);

  it('does not fire onEnd after stop()', async () => {
    const player = silentPlayer();
    let ended = 0;
    player.onEnd(() => {
      ended++;
    });
    player.start(59);
    await waitFor(() => player.ready(), 5000);
    player.release();
    await sleep(100);
    await player.stop();
    await sleep(500);
    expect(ended).toBe(0);
  });

  it('killNow() kills both processes synchronously', async () => {
    const player = silentPlayer();
    player.start(0);
    const pids = player.pids();
    await sleep(500);
    for (const pid of pids) expect(isAlive(pid)).toBe(true);
    player.killNow();
    // SIGKILL is delivered synchronously; the process table entry goes away right after.
    expect(await waitFor(() => pids.every((pid) => !isAlive(pid)), 1000)).toBe(true);
    await player.stop();
  });

  it('repeated seeks leave one ffplay and one source alive', async () => {
    const player = silentPlayer();
    player.start(0);
    const seen = new Set<number>(player.pids());
    for (let i = 1; i <= 6; i++) {
      player.seek(i * 3);
      for (const pid of player.pids()) seen.add(pid);
      await sleep(80);
    }
    const all = [...seen];
    const last = player.pids();
    expect(last).toHaveLength(2);
    expect(all).toHaveLength(8); // one ffplay and seven sources
    expect(await waitFor(() => all.filter(isAlive).length <= 2, 3000)).toBe(true);
    expect(all.filter(isAlive).sort()).toEqual([...last].sort());
    await player.stop();
    expect(await waitFor(() => all.every((pid) => !isAlive(pid)), 3000)).toBe(true);
  }, 20_000);

  it('a replaced source does not fire onEnd or onError', async () => {
    const player = silentPlayer();
    let ended = 0;
    const errors: string[] = [];
    player.onEnd(() => {
      ended++;
    });
    player.onError((m) => errors.push(m));
    player.start(0);
    await sleep(200);
    player.seek(10);
    await sleep(800);
    await player.stop();
    expect(ended).toBe(0);
    expect(errors).toEqual([]);
  });

  it('reports an ffmpeg failure once with a one-line message and then reports ready() (nothing will come)', async () => {
    const player = createAudioPlayer({ inputArgs: ['-i', 'does-not-exist.wav'], volume: 0 });
    const errors: string[] = [];
    let ended = 0;
    player.onError((m) => errors.push(m));
    player.onEnd(() => {
      ended++;
    });
    player.start(0);
    expect(await waitFor(() => errors.length > 0, 5000)).toBe(true);
    await sleep(300);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^ffmpeg: /);
    expect(errors[0]).not.toContain('\n');
    expect(ended).toBe(0);
    expect(player.failed()).toBe(true);
    expect(player.ready()).toBe(true);
    await player.stop();
  });

  it('seek(sec, inputArgs) and start(sec, inputArgs) switch the source input from that segment on', async () => {
    const player = silentPlayer();
    const errors: string[] = [];
    player.onError((m) => errors.push(m));
    player.start(0);
    expect(await waitFor(() => player.ready(), 5000)).toBe(true);
    expect(errors).toEqual([]);
    // The new input does not exist, the old one did: a "No such file" failure shows the source used the new one.
    player.seek(1, ['-i', 'switched-input-does-not-exist.wav']);
    expect(await waitFor(() => errors.length > 0, 5000)).toBe(true);
    expect(errors[0]).toMatch(/^ffmpeg: .*No such file/);
    await player.stop();

    const second = silentPlayer();
    const secondErrors: string[] = [];
    second.onError((m) => secondErrors.push(m));
    second.start(0, ['-i', 'first-input-does-not-exist.wav']);
    expect(await waitFor(() => secondErrors.length > 0, 5000)).toBe(true);
    expect(secondErrors[0]).toMatch(/^ffmpeg: .*No such file/);
    await second.stop();
  });
});

describe('[REQ-SYNC-04] audio player without tools', () => {
  it('[REQ-SYNC-04] builds the source and ffplay argv', () => {
    expect(buildAudioDecoderArgs(['-i', 'a b.mp4'], 0)).toEqual([
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-i', 'a b.mp4',
      '-vn', '-sn', '-dn', '-ac', '2', '-ar', '48000', '-f', 's16le', 'pipe:1',
    ]);
    const seeked = buildAudioDecoderArgs(['-i', 'x'], 12.3456);
    expect(seeked.slice(4, 8)).toEqual(['-ss', '12.346', '-i', 'x']);
    expect(buildAudioPlayerArgs(40)).toEqual([
      '-hide_banner', '-loglevel', 'error', '-nodisp', '-autoexit',
      '-fflags', 'nobuffer', '-flags', 'low_delay', '-probesize', '32', '-analyzeduration', '0',
      '-f', 's16le', '-ar', '48000', '-ch_layout', 'stereo',
      '-volume', '40',
      '-i', 'pipe:0',
    ]);
  });

  it('documents the constants', () => {
    expect(LEAD_MS).toBe(120);
    expect(CHUNK_MS).toBe(20);
    expect(OUTPUT_LATENCY_MS).toBe(100);
    expect(PCM_RATE).toBe(48_000);
  });

  it('[REQ-PREREQ-01] reports a missing ffplay once and then does nothing', async () => {
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

    expect(() => {
      player.start(0);
    }).not.toThrow();
    expect(await waitFor(() => errors.length > 0, 3000)).toBe(true);
    // Later calls are no-ops that do not report again.
    expect(() => {
      player.start(5);
      player.seek(10);
      player.release();
      player.pause();
      player.resume();
    }).not.toThrow();
    await sleep(300);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('ffplay');
    expect(errors[0]).not.toContain('\n');
    expect(ended).toBe(0);
    expect(player.failed()).toBe(true);
    expect(player.ready()).toBe(true);
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
    player.start(0);
    expect(await waitFor(() => errors.length > 0, 3000)).toBe(true);
    player.start(0);
    await sleep(300);
    expect(errors).toHaveLength(1);
    await player.stop();
  });

  it('validates options and positions', () => {
    expect(() => createAudioPlayer({ inputArgs: [], volume: 0 })).toThrow(RangeError);
    expect(() => createAudioPlayer({ inputArgs: DEMO_AUDIO, volume: 101 })).toThrow(RangeError);
    expect(() => createAudioPlayer({ inputArgs: DEMO_AUDIO, volume: -1 })).toThrow(RangeError);
    const player = createAudioPlayer({ inputArgs: DEMO_AUDIO, volume: 0, ffmpegPath: 'x', ffplayPath: 'y' });
    expect(() => {
      player.start(-1);
    }).toThrow(RangeError);
    expect(() => {
      player.start(Number.NaN);
    }).toThrow(RangeError);
    expect(() => {
      player.seek(-1);
    }).toThrow(RangeError);
    expect(() => buildAudioDecoderArgs(['-i', 'x'], -1)).toThrow(RangeError);
    expect(() => {
      player.seek(1, []);
    }).toThrow(RangeError);
    expect(() => {
      player.start(1, []);
    }).toThrow(RangeError);
  });
});
