// ffmpeg rgb24 pipe -> frames (REQ-INGEST-02, -04, -05). Owns one ffmpeg child process.
// A seek or resize creates a new decoder with a new generation; the old one is stopped.

import { spawn } from 'node:child_process';
import { GenerationalAssembler } from './assembler.ts';

export interface DecoderOptions {
  /** ffmpeg input arguments, e.g. `['-i', path]` or `['-f', 'lavfi', '-i', 'testsrc2=...']`. */
  inputArgs: string[];
  /** Output frame size in pixels. Both must be even and >= 2. */
  width: number;
  height: number;
  fps: number;
  startSec?: number;
  generation: number;
  ffmpegPath?: string;
  /** Frames the assembler may queue before the pipe is paused. Default 4. */
  capacity?: number;
  /**
   * True for a local file, false for a URL or lavfi source. Accepted so the controller can
   * pass what it knows. The argv is the same either way: input-side `-ss` also works on
   * lavfi and http inputs.
   */
  isFile: boolean;
}

export interface DecoderEndInfo {
  code: number | null;
  signal: string | null;
  stderrTail: string;
  trailingBytes: number;
}

export interface DecoderStats {
  framesCompleted: number;
  dropped: number;
  staleChunks: number;
  trailingBytes: number;
}

export interface Decoder {
  readonly generation: number;
  readonly pid: number | undefined;
  takeOldest(): Uint8Array | null;
  takeLatest(): Uint8Array | null;
  stats(): DecoderStats;
  /**
   * Called once, after the ffmpeg process has closed and every byte it wrote has entered the
   * assembler. Frames may still be queued; keep calling take* until they return null. If the
   * callback is added after the end, it runs asynchronously.
   */
  onEnd(cb: (info: DecoderEndInfo) => void): void;
  /** Idempotent. SIGTERM, then SIGKILL after 1000 ms. Resolves when the child has exited. */
  stop(): Promise<void>;
  /**
   * Synchronous and idempotent: sends SIGKILL if the child is still alive. For exit paths
   * where the asynchronous stop() cannot run. Does not wait for the child to exit.
   */
  killNow(): void;
}

const STDERR_TAIL_BYTES = 4096;
const KILL_GRACE_MS = 1000;

function assertEvenSize(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 2 || value % 2 !== 0) {
    throw new RangeError(`${name} must be an even integer >= 2, got ${String(value)}`);
  }
}

/** Pure argv builder for the decoder (without the executable). */
export function buildDecoderArgs(
  opts: Pick<DecoderOptions, 'inputArgs' | 'width' | 'height' | 'fps' | 'startSec'>,
): string[] {
  assertEvenSize('width', opts.width);
  assertEvenSize('height', opts.height);
  if (!Number.isFinite(opts.fps) || opts.fps <= 0) {
    throw new RangeError(`fps must be a positive number, got ${String(opts.fps)}`);
  }
  const startSec = opts.startSec ?? 0;
  if (!Number.isFinite(startSec) || startSec < 0) {
    throw new RangeError(`startSec must be >= 0, got ${String(startSec)}`);
  }
  // Round to milliseconds so String() never yields exponent notation.
  const seek = Math.round(startSec * 1000) / 1000;
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    ...(seek > 0 ? ['-ss', String(seek)] : []),
    ...opts.inputArgs,
    '-an', '-sn', '-dn',
    '-vf', `fps=${String(opts.fps)},scale=${String(opts.width)}:${String(opts.height)}:flags=area,format=rgb24`,
    '-f', 'rawvideo', '-pix_fmt', 'rgb24',
    'pipe:1',
  ];
}

export function createDecoder(opts: DecoderOptions): Decoder {
  const argv = buildDecoderArgs(opts);
  const capacity = opts.capacity ?? 4;
  const generation = opts.generation;
  const frameSize = opts.width * opts.height * 3;

  const asm = new GenerationalAssembler(capacity);
  asm.start(generation, frameSize);

  const child = spawn(opts.ffmpegPath ?? 'ffmpeg', argv, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const stdout = child.stdout;

  // Chunks that did not fit in the assembler yet. Only non-empty while the pipe is paused.
  const pending: Uint8Array[] = [];
  let paused = false;
  let stderrTail: Buffer = Buffer.alloc(0);

  let exited = false;
  let endInfo: DecoderEndInfo | null = null;
  let endFired = false;
  const endCallbacks: ((info: DecoderEndInfo) => void)[] = [];
  let stopPromise: Promise<void> | null = null;

  const fireEnd = (): void => {
    if (endInfo === null || endFired || pending.length > 0) return;
    endFired = true;
    const info: DecoderEndInfo = { ...endInfo, trailingBytes: asm.trailingBytes };
    for (const cb of endCallbacks) cb(info);
  };

  // Moves pending bytes into the assembler without overflowing it, then pauses or resumes
  // the pipe. Resume waits until the queue is at most half full.
  const pump = (): void => {
    while (pending.length > 0 && !asm.isFull()) {
      const chunk = pending[0];
      if (chunk === undefined) break;
      const n = Math.min(chunk.length, asm.bytesUntilFull());
      if (n === chunk.length) {
        asm.push(generation, chunk);
        pending.shift();
      } else {
        asm.push(generation, chunk.subarray(0, n));
        pending[0] = chunk.subarray(n);
      }
    }
    if (!paused && (asm.isFull() || pending.length > 0)) {
      paused = true;
      stdout.pause();
    } else if (paused && pending.length === 0 && asm.queued <= capacity / 2) {
      paused = false;
      stdout.resume();
    }
    fireEnd();
  };

  stdout.on('data', (chunk: Buffer) => {
    pending.push(chunk);
    pump();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderrTail = Buffer.concat([stderrTail, chunk]);
    if (stderrTail.length > STDERR_TAIL_BYTES) stderrTail = stderrTail.subarray(-STDERR_TAIL_BYTES);
  });
  child.on('error', (err) => {
    // Spawn failure (for example ffmpeg missing): no 'close' event follows.
    exited = true;
    endInfo ??= { code: null, signal: null, stderrTail: err.message, trailingBytes: 0 };
    fireEnd();
  });
  child.on('exit', () => {
    exited = true;
  });
  child.on('close', (code, signal) => {
    exited = true;
    endInfo ??= { code, signal, stderrTail: stderrTail.toString('utf8'), trailingBytes: 0 };
    fireEnd();
  });

  const afterTake = (frame: Uint8Array | null): Uint8Array | null => {
    pump();
    return frame;
  };

  return {
    generation,
    pid: child.pid,
    takeOldest: () => afterTake(asm.takeOldest()),
    takeLatest: () => afterTake(asm.takeLatest()),
    stats: () => ({
      framesCompleted: asm.framesCompleted,
      dropped: asm.dropped,
      staleChunks: asm.staleChunks,
      trailingBytes: asm.trailingBytes,
    }),
    onEnd(cb) {
      if (endFired && endInfo !== null) {
        const info: DecoderEndInfo = { ...endInfo, trailingBytes: asm.trailingBytes };
        setImmediate(() => cb(info));
        return;
      }
      endCallbacks.push(cb);
    },
    killNow() {
      if (exited || child.pid === undefined) return;
      try {
        child.kill('SIGKILL');
      } catch {
        // The process is already gone.
      }
    },
    stop() {
      if (stopPromise !== null) return stopPromise;
      stopPromise = new Promise<void>((resolve) => {
        const finish = (): void => {
          pending.length = 0;
          fireEnd();
          resolve();
        };
        if (exited || child.pid === undefined) {
          stdout.destroy();
          finish();
          return;
        }
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
        }, KILL_GRACE_MS);
        child.once('exit', () => {
          clearTimeout(timer);
          finish();
        });
        child.kill('SIGTERM');
        // Closing our read end also unblocks an ffmpeg stuck writing to a full pipe.
        stdout.destroy();
      });
      return stopPromise;
    },
  };
}
