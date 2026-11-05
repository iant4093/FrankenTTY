import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { createDecoder } from '../../src/ingest/decoder.ts';
import type { DecoderEndInfo } from '../../src/ingest/decoder.ts';

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
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

async function waitUntilGone(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await sleep(10);
  }
  return !isAlive(pid);
}

describe('Decoder.killNow', () => {
  it('is a no-op after a spawn failure', () => {
    const dec = createDecoder({
      inputArgs: ['-i', 'x'], width: 4, height: 4, fps: 30, generation: 1, isFile: true,
      ffmpegPath: '/nonexistent/ffmpeg',
    });
    expect(() => {
      dec.killNow();
      dec.killNow();
    }).not.toThrow();
  });

  it.skipIf(!hasFfmpeg)('kills a running ffmpeg synchronously, reports the end and can be called twice', async () => {
    const dec = createDecoder({ inputArgs: INFINITE, width: 64, height: 36, fps: 30, generation: 1, isFile: false });
    const pid = dec.pid;
    expect(pid).toBeTypeOf('number');
    const ended = new Promise<DecoderEndInfo>((resolve) => dec.onEnd(resolve));
    while (dec.takeOldest() === null) await sleep(5);

    dec.killNow();
    dec.killNow();
    expect(await waitUntilGone(pid ?? -1, 2000)).toBe(true);
    // onEnd waits until every byte has entered the assembler, so keep consuming.
    let info: DecoderEndInfo | null = null;
    void ended.then((i) => {
      info = i;
    });
    while (info === null) {
      dec.takeOldest();
      await sleep(5);
    }
    expect((info as DecoderEndInfo).signal).toBe('SIGKILL');
    await dec.stop();
    dec.killNow();
  });

  it.skipIf(!hasFfmpeg)('kills ffmpeg even while the pipe is paused by a full queue', async () => {
    const dec = createDecoder({ inputArgs: INFINITE, width: 64, height: 36, fps: 30, generation: 1, isFile: false });
    const pid = dec.pid;
    await sleep(700);
    expect(dec.stats().framesCompleted).toBe(4);
    dec.killNow();
    expect(await waitUntilGone(pid ?? -1, 2000)).toBe(true);
    await dec.stop();
  });

  it.skipIf(!hasFfmpeg)('does nothing after stop() has finished', async () => {
    const dec = createDecoder({ inputArgs: INFINITE, width: 64, height: 36, fps: 30, generation: 1, isFile: false });
    await sleep(200);
    await dec.stop();
    expect(() => dec.killNow()).not.toThrow();
  });
});
