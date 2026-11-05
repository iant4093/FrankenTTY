import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDecoder } from '../../src/ingest/decoder.ts';
import type { DecoderEndInfo } from '../../src/ingest/decoder.ts';

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
const SHIM = path.resolve(import.meta.dirname, '..', 'helpers', 'ffmpeg-shim.ts');
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

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await sleep(10);
  }
  return cond();
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
    // Windows taskkill ends the process with a non-zero code and no signal.
    const end = info as DecoderEndInfo;
    expect(end.signal === 'SIGKILL' || (end.code !== null && end.code !== 0)).toBe(true);
    await dec.stop();
    dec.killNow();
  });

  it.skipIf(!hasFfmpeg)('kills ffmpeg even while the pipe is paused by a full queue', async () => {
    const dec = createDecoder({ inputArgs: INFINITE, width: 64, height: 36, fps: 30, generation: 1, isFile: false });
    const pid = dec.pid;
    // Wait for the queue to fill (process start-up time varies by machine).
    expect(await waitFor(() => dec.stats().framesCompleted === 4, 20_000)).toBe(true);
    await sleep(100);
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

  // Chocolatey and Scoop put a shim on PATH that starts the real ffmpeg as a child. Killing only
  // the shim used to leak the real ffmpeg and left the decoder's onEnd pending forever.
  it.skipIf(!hasFfmpeg)('ends the real ffmpeg behind a shim that does not forward signals', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'frankentty-shim-'));
    const pidFile = path.join(dir, 'real.pid');
    let realPid = -1;
    try {
      const dec = createDecoder({
        inputArgs: INFINITE, width: 64, height: 36, fps: 30, generation: 1, isFile: false,
        ffmpegPath: process.execPath,
        ffmpegPrefixArgs: [SHIM, pidFile],
      });
      const shimPid = dec.pid ?? -1;
      expect(shimPid).toBeGreaterThan(0);
      let info: DecoderEndInfo | null = null;
      dec.onEnd((i) => {
        info = i;
      });

      // The real ffmpeg is up once it has produced a frame.
      expect(await waitFor(() => dec.takeOldest() !== null, 20_000)).toBe(true);
      realPid = Number(readFileSync(pidFile, 'utf8'));
      expect(realPid).toBeGreaterThan(0);
      expect(realPid).not.toBe(shimPid);
      expect(isAlive(realPid)).toBe(true);

      dec.killNow();
      expect(await waitUntilGone(shimPid, 5000)).toBe(true);
      // Unix: our end of the pipe is closed, so the real ffmpeg gets EPIPE and exits.
      // Windows: taskkill /T ends the whole tree.
      expect(await waitUntilGone(realPid, 10_000)).toBe(true);
      expect(await waitFor(() => info !== null, 5000)).toBe(true);
      await dec.stop();
    } finally {
      if (realPid > 0 && isAlive(realPid)) process.kill(realPid, 'SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
