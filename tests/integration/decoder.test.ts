import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { buildDecoderArgs, createDecoder } from '../../src/ingest/decoder.ts';
import type { Decoder, DecoderEndInfo } from '../../src/ingest/decoder.ts';

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

const WIDTH = 64;
const HEIGHT = 36;
const FRAME_BYTES = WIDTH * HEIGHT * 3;
const FINITE = ['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=2'];
const INFINITE = ['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30'];

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
    await sleep(5);
  }
  return cond();
}

/** Takes every frame until the decoder reports its end and the queue is empty. */
async function drainToEnd(dec: Decoder): Promise<{ frames: number; end: DecoderEndInfo }> {
  let end: DecoderEndInfo | null = null;
  dec.onEnd((info) => {
    end = info;
  });
  let frames = 0;
  const takeAll = (): void => {
    for (let f = dec.takeOldest(); f !== null; f = dec.takeOldest()) {
      expect(f.length).toBe(FRAME_BYTES);
      frames++;
    }
  };
  for (;;) {
    takeAll();
    if (end !== null) {
      takeAll();
      return { frames, end };
    }
    await sleep(2);
  }
}

describe('buildDecoderArgs', () => {
  const base = { inputArgs: ['-i', 'movie.mp4'], width: 160, height: 90, fps: 30 };

  it('[REQ-INGEST-02][REQ-INGEST-04] builds the exact argv', () => {
    expect(buildDecoderArgs(base)).toEqual([
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      '-i', 'movie.mp4',
      '-an', '-sn', '-dn',
      '-vf', 'fps=30,scale=160:90:flags=area,format=rgb24',
      '-f', 'rawvideo', '-pix_fmt', 'rgb24',
      'pipe:1',
    ]);
  });

  it('puts -ss before the input only when startSec > 0', () => {
    const withSeek = buildDecoderArgs({ ...base, startSec: 12.5 });
    expect(withSeek.slice(0, 7)).toEqual(['-hide_banner', '-loglevel', 'error', '-nostdin', '-ss', '12.5', '-i']);
    expect(buildDecoderArgs({ ...base, startSec: 0 })).not.toContain('-ss');
    expect(buildDecoderArgs({ ...base, startSec: 1e-9 })).not.toContain('-ss');
  });

  it('never renders exponent notation for the seek time', () => {
    expect(buildDecoderArgs({ ...base, startSec: 1234567 })).toContain('1234567');
    expect(buildDecoderArgs({ ...base, startSec: 0.001 })).toContain('0.001');
  });

  it('passes inputs as separate argv entries, untouched', () => {
    const tricky = 'a file; rm -rf $HOME.mp4';
    expect(buildDecoderArgs({ ...base, inputArgs: ['-i', tricky] })).toContain(tricky);
  });

  it('rejects odd, tiny and non-integer sizes', () => {
    for (const [width, height] of [[161, 90], [160, 91], [0, 90], [160, 0], [1, 2], [160.5, 90], [-2, 90], [NaN, 90]]) {
      expect(() => buildDecoderArgs({ ...base, width: width ?? 0, height: height ?? 0 })).toThrow(RangeError);
    }
  });

  it('rejects bad fps and startSec', () => {
    expect(() => buildDecoderArgs({ ...base, fps: 0 })).toThrow(RangeError);
    expect(() => buildDecoderArgs({ ...base, fps: NaN })).toThrow(RangeError);
    expect(() => buildDecoderArgs({ ...base, startSec: -1 })).toThrow(RangeError);
    expect(() => buildDecoderArgs({ ...base, startSec: Infinity })).toThrow(RangeError);
  });

  it('createDecoder throws RangeError before spawning on odd sizes', () => {
    expect(() =>
      createDecoder({ ...base, width: 63, generation: 1, isFile: true, ffmpegPath: '/nonexistent/ffmpeg' }),
    ).toThrow(RangeError);
  });
});

describe('createDecoder without ffmpeg', () => {
  it('reports a spawn failure through onEnd', async () => {
    const dec = createDecoder({
      inputArgs: ['-i', 'x'], width: 4, height: 4, fps: 30, generation: 1, isFile: true,
      ffmpegPath: '/nonexistent/ffmpeg',
    });
    const end = await new Promise<DecoderEndInfo>((resolve) => dec.onEnd(resolve));
    expect(end.code).toBeNull();
    expect(end.stderrTail).toContain('ENOENT');
    expect(dec.pid).toBeUndefined();
    await dec.stop();
  });
});

describe.skipIf(!hasFfmpeg)('createDecoder with ffmpeg', () => {
  it('[REQ-INGEST-02] decodes a 2 s source into exactly 60 frames, then ends with code 0', async () => {
    const dec = createDecoder({ inputArgs: FINITE, width: WIDTH, height: HEIGHT, fps: 30, generation: 7, isFile: false });
    expect(dec.generation).toBe(7);
    const { frames, end } = await drainToEnd(dec);
    expect(frames).toBe(60);
    expect(end.code).toBe(0);
    expect(end.trailingBytes).toBe(0);
    expect(dec.stats()).toEqual({ framesCompleted: 60, dropped: 0, staleChunks: 0, trailingBytes: 0 });
    await dec.stop();
  });

  it('startSec 1 leaves 30 frames', async () => {
    const dec = createDecoder({
      inputArgs: FINITE, width: WIDTH, height: HEIGHT, fps: 30, startSec: 1, generation: 1, isFile: false,
    });
    const { frames, end } = await drainToEnd(dec);
    expect(frames).toBe(30);
    expect(end.code).toBe(0);
    expect(end.trailingBytes).toBe(0);
    await dec.stop();
  });

  it('[REQ-INGEST-04] normalizes the frame rate with the fps filter', async () => {
    const dec = createDecoder({ inputArgs: FINITE, width: WIDTH, height: HEIGHT, fps: 15, generation: 1, isFile: false });
    const { frames } = await drainToEnd(dec);
    expect(frames).toBe(30);
    await dec.stop();
  });

  it('[REQ-INGEST-04] turns a 60 fps source into 30 fps output: 2 s give 60 frames, not 120', async () => {
    const source60 = ['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=60:duration=2'];
    const dec = createDecoder({ inputArgs: source60, width: WIDTH, height: HEIGHT, fps: 30, generation: 1, isFile: false });
    const { frames } = await drainToEnd(dec);
    expect(frames).toBe(60);
    await dec.stop();
  });

  it('keeps onEnd pending until a slow consumer has drained the pipe', async () => {
    const dec = createDecoder({ inputArgs: FINITE, width: WIDTH, height: HEIGHT, fps: 30, generation: 1, isFile: false, capacity: 2 });
    let ended = false;
    dec.onEnd(() => {
      ended = true;
    });
    await sleep(500);
    expect(ended).toBe(false);
    const { frames } = await drainToEnd(dec);
    expect(frames).toBe(60);
    expect(dec.stats().dropped).toBe(0);
    await dec.stop();
  });

  it('stop() on an infinite source resolves within 2 s and the child is gone', async () => {
    const dec = createDecoder({ inputArgs: INFINITE, width: WIDTH, height: HEIGHT, fps: 30, generation: 1, isFile: false });
    const pid = dec.pid;
    expect(pid).toBeTypeOf('number');
    while (dec.takeOldest() === null) await sleep(5);
    const started = Date.now();
    const first = dec.stop();
    expect(dec.stop()).toBe(first);
    await first;
    expect(Date.now() - started).toBeLessThan(2000);
    expect(isAlive(pid ?? -1)).toBe(false);
    await dec.stop();
  });

  it('stop() also works while the pipe is paused by a full queue', async () => {
    const dec = createDecoder({ inputArgs: INFINITE, width: WIDTH, height: HEIGHT, fps: 30, generation: 1, isFile: false });
    const pid = dec.pid;
    // Process start-up time varies by machine, so wait for the queue to fill.
    expect(await waitFor(() => dec.stats().framesCompleted === 4, 20_000)).toBe(true);
    await sleep(100);
    expect(dec.stats().framesCompleted).toBe(4);
    const started = Date.now();
    await dec.stop();
    expect(Date.now() - started).toBeLessThan(2000);
    expect(isAlive(pid ?? -1)).toBe(false);
  });

  it('stop() fires onEnd', async () => {
    const dec = createDecoder({ inputArgs: INFINITE, width: WIDTH, height: HEIGHT, fps: 30, generation: 1, isFile: false });
    const ended = new Promise<DecoderEndInfo>((resolve) => dec.onEnd(resolve));
    await dec.stop();
    const info = await ended;
    expect(info.code === null || typeof info.code === 'number').toBe(true);
  });

  it('applies backpressure to a slow consumer', async () => {
    const capacity = 4;
    const dec = createDecoder({
      inputArgs: INFINITE, width: WIDTH, height: HEIGHT, fps: 30, generation: 1, isFile: false, capacity,
    });
    // Start the 100 ms ticks only once ffmpeg has produced output (start-up is slower on Windows).
    expect(await waitFor(() => dec.stats().framesCompleted > 0, 20_000)).toBe(true);
    let taken = 0;
    for (let tick = 0; tick < 10; tick++) {
      await sleep(100);
      const { framesCompleted, dropped } = dec.stats();
      expect(dropped).toBe(0);
      // Queue length = completed - taken; it never exceeds capacity.
      expect(framesCompleted - taken).toBeLessThanOrEqual(capacity);
      expect(framesCompleted).toBeLessThanOrEqual(taken + capacity + 1);
      if (dec.takeOldest() !== null) taken++;
    }
    const { framesCompleted } = dec.stats();
    expect(taken).toBe(10);
    // ffmpeg did run, but not far ahead of the consumer.
    expect(framesCompleted).toBeGreaterThan(taken);
    expect(framesCompleted).toBeLessThanOrEqual(taken + capacity + 1);
    await dec.stop();
  });

  it('takeLatest returns the newest frame and drops older ones', async () => {
    const dec = createDecoder({ inputArgs: INFINITE, width: WIDTH, height: HEIGHT, fps: 30, generation: 1, isFile: false });
    expect(await waitFor(() => dec.stats().framesCompleted === 4, 20_000)).toBe(true);
    const f = dec.takeLatest();
    expect(f?.length).toBe(FRAME_BYTES);
    expect(dec.stats().dropped).toBe(3);
    await dec.stop();
  });
});
