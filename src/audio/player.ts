// Audio output (REQ-SYNC-01, REQ-SYNC-03, REQ-SYNC-04).
//
// One long-lived `ffplay` per playback session reads raw PCM (s16le, 48 kHz, stereo) on stdin. A
// separate source `ffmpeg` decodes `-ss <pos> <input> -vn ... -f s16le pipe:1` into this process.
// A PCM pump moves bytes from the source to ffplay at real-time pace and keeps no more than
// LEAD_MS of audio written ahead of the device. That bound makes pause immediate (ffplay drains at
// most LEAD_MS plus its device buffer, then plays silence) and makes the audio position computable:
// it is the media time of the PCM written so far, minus what is still queued ahead, minus the
// output latency. Pause, resume and seek never respawn ffplay, so there is no gap in the sound
// while a process starts and opens the audio device.
//
// Feeding ffplay over stdin means it exits when FrankenTTY dies, and it can never read the user's
// keys because its stdin is our pipe.

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { killTree, killTreeSync } from '../ingest/kill-tree.ts';

// ---- Constants ---------------------------------------------------------------------------------

export const PCM_RATE = 48_000;
/** s16le, 2 channels. */
export const PCM_FRAME_BYTES = 4;
/**
 * PCM written ahead of the device, at most. Large enough to ride over a 100 ms event-loop stall
 * without an underrun, small enough that pause stops the sound within about a tenth of a second.
 */
export const LEAD_MS = 120;
/** Size of one write to ffplay. */
export const CHUNK_MS = 20;
/**
 * Time from a sample leaving the pump to it being audible: pipe, ffplay's decoder and SDL's device
 * buffer. A constant, not measured; `--av-offset` corrects the rest.
 */
export const OUTPUT_LATENCY_MS = 100;
/** How often the pump looks at the clock while audio runs. Half a chunk. */
export const PUMP_INTERVAL_MS = 10;
/** The source is paused (backpressure) while this much PCM waits in the queue: about 340 ms. */
export const QUEUE_HIGH_BYTES = 65_536;

const LEAD_FRAMES = Math.round((LEAD_MS * PCM_RATE) / 1000);
const CHUNK_FRAMES = Math.round((CHUNK_MS * PCM_RATE) / 1000);
const CHUNK_BYTES = CHUNK_FRAMES * PCM_FRAME_BYTES;
const FRAMES_PER_MS = PCM_RATE / 1000;

// ---- PCM pump (pure apart from the injected `now`) -----------------------------------------------

export interface PcmSink {
  write(chunk: Uint8Array): unknown;
  /** Bytes queued inside the sink. When positive, the consumer is slower than the pump and writing waits. */
  readonly writableLength?: number;
}

export interface PumpStats {
  /** Writes to the sink. */
  writes: number;
  bytesWritten: number;
  /** Ticks that wrote nothing because the sink had queued bytes. */
  sinkBusy: number;
  /** Times the device ran dry: the pump found nothing written ahead while it was running. */
  underruns: number;
  /** Written-ahead (frames) sampled at each tick while running. */
  aheadSamples: number;
  aheadSumFrames: number;
  aheadMaxFrames: number;
  aheadMinFrames: number;
}

export interface PcmPump {
  /** PCM from the source. The pump keeps the array, never changes it. */
  feed(chunk: Uint8Array): void;
  /** The source has no more PCM. */
  endOfSource(): void;
  /** Starts a new segment at `sec`: drops queued PCM and holds (nothing is written) until release(). */
  seek(sec: number): void;
  /** Starts writing the segment. No effect if already released. */
  release(): void;
  /** Stops writing and freezes the position. The device drains what it has and plays silence. */
  pause(): void;
  /** Continues writing and counting from the frozen position. Does not release a held segment. */
  resume(): void;
  /** Writes whatever is due. Call every PUMP_INTERVAL_MS while the pump is wanted. */
  tick(): void;
  /** Audio position in seconds (media time that is audible now). Never decreases within a segment. */
  positionSec(): number;
  /** PCM written ahead of the device, in frames, per the model. 0 while held or paused. */
  aheadFrames(): number;
  /** The queue holds a full chunk, or the source ended: the segment can start without a gap. */
  ready(): boolean;
  /** The queue has room for more PCM; the source may be read. */
  wantsMore(): boolean;
  /** The source ended and every byte of it was written. */
  finished(): boolean;
  readonly stats: Readonly<PumpStats>;
}

export interface PumpOptions {
  sink: PcmSink;
  /** Monotonic time in milliseconds. */
  now: () => number;
  /** Media time of the first sample, seconds. Default 0. */
  startSec?: number;
  /** Default OUTPUT_LATENCY_MS. */
  outputLatencyMs?: number;
}

export function createPcmPump(opts: PumpOptions): PcmPump {
  const { sink, now } = opts;
  const latencySec = (opts.outputLatencyMs ?? OUTPUT_LATENCY_MS) / 1000;
  if (!Number.isFinite(latencySec) || latencySec < 0) {
    throw new RangeError(`outputLatencyMs must be >= 0, got ${String(opts.outputLatencyMs)}`);
  }

  let segStartSec = Math.max(0, opts.startSec ?? 0);
  /** Frames written to the sink since the segment started. */
  let written = 0;
  const queue: Uint8Array[] = [];
  /** Read offset into queue[0]. */
  let head = 0;
  let queued = 0;
  let sourceEnded = false;
  let released = false;
  let paused = false;
  /** Running model: at `runStartMs` the device had played `runFrames0` frames. */
  let runStartMs = 0;
  let runFrames0 = 0;
  /** Frames played at the moment of the last pause: where the device ends up once it has drained. */
  let pausedPlayed = 0;
  /** True once something was written since the run was (re)started; only then can the device run dry. */
  let wroteInRun = false;
  const stats: PumpStats = {
    writes: 0,
    bytesWritten: 0,
    sinkBusy: 0,
    underruns: 0,
    aheadSamples: 0,
    aheadSumFrames: 0,
    aheadMaxFrames: 0,
    aheadMinFrames: Infinity,
  };

  const finished = (): boolean => sourceEnded && queued < PCM_FRAME_BYTES;
  const anchor = (): void => {
    runStartMs = now();
    runFrames0 = written;
  };
  const startRun = (fromFrames: number): void => {
    runStartMs = now();
    runFrames0 = fromFrames;
    wroteInRun = false;
  };
  /** Frames the device has played in this segment, per the model. */
  const idealPlayed = (): number => runFrames0 + Math.max(0, now() - runStartMs) * FRAMES_PER_MS;
  const played = (): number => {
    // Held: nothing was written. Paused: nothing more will be written, so the device ends up at `pausedPlayed`.
    if (!released) return written;
    if (paused) return pausedPlayed;
    const ideal = idealPlayed();
    // After the last byte the device is silent but time goes on, so the position keeps moving.
    return finished() ? ideal : Math.min(ideal, written);
  };

  /** Removes `n` bytes (a multiple of PCM_FRAME_BYTES, at most `queued`) from the queue front. */
  const take = (n: number): Uint8Array => {
    const first = queue[0] as Uint8Array;
    if (first.length - head >= n) {
      const out = first.subarray(head, head + n);
      head += n;
      if (head === first.length) {
        queue.shift();
        head = 0;
      }
      queued -= n;
      return out;
    }
    // The chunk spans source buffers: one copy, 50 times a second at most.
    const out = new Uint8Array(n);
    let filled = 0;
    while (filled < n) {
      const b = queue[0] as Uint8Array;
      const k = Math.min(n - filled, b.length - head);
      out.set(b.subarray(head, head + k), filled);
      filled += k;
      head += k;
      if (head === b.length) {
        queue.shift();
        head = 0;
      }
    }
    queued -= n;
    return out;
  };

  return {
    stats,
    feed(chunk) {
      if (chunk.length === 0) return;
      queue.push(chunk);
      queued += chunk.length;
    },
    endOfSource() {
      sourceEnded = true;
    },
    seek(sec) {
      if (!Number.isFinite(sec)) throw new RangeError(`sec must be finite, got ${String(sec)}`);
      queue.length = 0;
      head = 0;
      queued = 0;
      sourceEnded = false;
      written = 0;
      segStartSec = Math.max(0, sec);
      released = false;
      pausedPlayed = 0;
    },
    release() {
      if (released) return;
      released = true;
      if (!paused) startRun(written);
    },
    pause() {
      if (paused) return;
      // The device drains the PCM already written; after the end of the source, time has kept running too.
      pausedPlayed = released ? Math.max(written, finished() ? idealPlayed() : 0) : written;
      paused = true;
    },
    resume() {
      if (!paused) return;
      paused = false;
      // The device drained during the pause (or will have, within LEAD_MS): count from where it ended up.
      if (released) startRun(pausedPlayed);
    },
    tick() {
      if (!released || paused) return;
      let p = idealPlayed();
      if (!finished() && p >= written) {
        // The device has consumed everything written. Count from here, so the lead bound holds again.
        if (wroteInRun && p - written >= 1) stats.underruns++;
        anchor();
        p = written;
      }
      if (!finished()) p = Math.min(p, written);
      while (queued >= PCM_FRAME_BYTES) {
        let n = CHUNK_BYTES;
        if (queued < n) {
          if (!sourceEnded) break; // wait for a full chunk
          n = queued - (queued % PCM_FRAME_BYTES);
        }
        if (written - p + n / PCM_FRAME_BYTES > LEAD_FRAMES) break;
        if ((sink.writableLength ?? 0) > 0) {
          stats.sinkBusy++;
          break;
        }
        sink.write(take(n));
        wroteInRun = true;
        written += n / PCM_FRAME_BYTES;
        stats.writes++;
        stats.bytesWritten += n;
      }
      if (finished()) {
        // Only a sub-frame remainder may be left: it can never be played.
        queue.length = 0;
        head = 0;
        queued = 0;
      }
      const ahead = Math.max(0, written - p);
      stats.aheadSamples++;
      stats.aheadSumFrames += ahead;
      if (ahead > stats.aheadMaxFrames) stats.aheadMaxFrames = ahead;
      if (ahead < stats.aheadMinFrames) stats.aheadMinFrames = ahead;
    },
    positionSec() {
      return segStartSec + Math.max(0, played() / PCM_RATE - latencySec);
    },
    aheadFrames() {
      return Math.max(0, written - played());
    },
    ready: () => queued >= CHUNK_BYTES || sourceEnded,
    wantsMore: () => queued < QUEUE_HIGH_BYTES,
    finished,
  };
}

// ---- argv builders -------------------------------------------------------------------------------

/** Pure argv builder for the audio source decoder (without the executable). */
export function buildAudioDecoderArgs(inputArgs: readonly string[], startSec: number): string[] {
  if (!Number.isFinite(startSec) || startSec < 0) {
    throw new RangeError(`startSec must be >= 0, got ${String(startSec)}`);
  }
  // Round to milliseconds so String() never yields exponent notation.
  const seek = Math.round(startSec * 1000) / 1000;
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    ...(seek > 0 ? ['-ss', String(seek)] : []),
    ...inputArgs,
    '-vn', '-sn', '-dn',
    '-ac', '2', '-ar', String(PCM_RATE),
    '-f', 's16le', 'pipe:1',
  ];
}

/**
 * Pure argv builder for ffplay (without the executable): raw s16le stereo PCM on stdin, no probing
 * and no input buffering. Checked against ffplay 9.0.2 (`-ar` and `-ch_layout` are demuxer options).
 */
export function buildAudioPlayerArgs(volume: number): string[] {
  return [
    '-hide_banner', '-loglevel', 'error', '-nodisp', '-autoexit',
    '-fflags', 'nobuffer', '-flags', 'low_delay', '-probesize', '32', '-analyzeduration', '0',
    '-f', 's16le', '-ar', String(PCM_RATE), '-ch_layout', 'stereo',
    '-volume', String(volume),
    '-i', 'pipe:0',
  ];
}

// ---- Audio player (child processes) --------------------------------------------------------------

export interface AudioPlayerOptions {
  /** ffmpeg input arguments, e.g. `['-i', path]` or `['-f', 'lavfi', '-i', 'aevalsrc=...']`. */
  inputArgs: string[];
  ffmpegPath?: string;
  ffplayPath?: string;
  /** 0..100, passed to ffplay `-volume`. Default 100. */
  volume?: number;
  /** Time source in ms. Default `performance.now`. */
  now?: () => number;
  /** Default OUTPUT_LATENCY_MS. */
  outputLatencyMs?: number;
}

export interface AudioPlayer {
  /**
   * Starts ffplay (once per session) and the source at `atSec`, held: no sound until release().
   * A second call behaves like seek(). After a failure this does nothing.
   * `inputArgs`, when given, replaces the source's ffmpeg input arguments from this segment on.
   */
  start(atSec: number, inputArgs?: string[]): void;
  /**
   * Kills only the source, starts a new one at `sec`, drops its old PCM and holds until release(). ffplay stays.
   * `inputArgs`, when given, replaces the source's ffmpeg input arguments from this segment on.
   */
  seek(sec: number, inputArgs?: string[]): void;
  /** Starts the held segment. The position then runs. */
  release(): void;
  /** Stops writing; the position freezes. Both processes stay alive. */
  pause(): void;
  /** Continues from the same source. Does not release a held segment. */
  resume(): void;
  /** The held segment has PCM for a gap-free start (or audio failed, so nothing will come). */
  ready(): boolean;
  /** Audio position in seconds: the master clock (REQ-SYNC-01). Frozen while held or paused. */
  positionSec(): number;
  /** True after audio failed or a tool was missing. The caller should fall back to the wall clock. */
  failed(): boolean;
  /** Idempotent. SIGTERM, then SIGKILL after 1000 ms. Resolves when every process has exited. */
  stop(): Promise<void>;
  /** Synchronous kill of every audio process (on Windows the whole tree). For exit paths. */
  killNow(): void;
  /** PIDs of the ffplay process and the current source, if any. */
  pids(): number[];
  /** Called when the source ended and all its PCM was written. Not called after stop() or a seek. */
  onEnd(cb: () => void): void;
  /** Called with a one-line message when audio fails. A missing tool is reported once. */
  onError(cb: (message: string) => void): void;
  /** Pump statistics, or null before start(). */
  stats(): Readonly<PumpStats> | null;
}

const STDERR_TAIL_BYTES = 4096;
const KILL_GRACE_MS = 1000;

interface Proc {
  child: ChildProcess;
  label: string;
  tail: Buffer;
  code: number | null;
  signal: string | null;
  exited: Promise<void>;
  closed: boolean;
  /** True once we killed it on purpose. */
  killed: boolean;
}

function noop(): void {
  // Pipe errors (EPIPE after the other end died) are expected during teardown.
}

function lastLine(tail: Buffer): string {
  const lines = tail.toString('utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '');
  return lines[lines.length - 1] ?? '';
}

function spawnProc(label: string, command: string, args: string[], stdio: ['ignore' | 'pipe', 'pipe' | 'ignore', 'pipe']): Proc {
  const child = spawn(command, args, { stdio, windowsHide: true });
  const proc: Proc = {
    child,
    label,
    tail: Buffer.alloc(0),
    code: null,
    signal: null,
    closed: false,
    killed: false,
    exited: Promise.resolve(),
  };
  proc.exited = new Promise<void>((resolve) => {
    child.once('close', (code, signal) => {
      proc.code = code;
      proc.signal = signal;
      proc.closed = true;
      resolve();
    });
    // A failed spawn (for example ENOENT) may not be followed by 'close'.
    child.once('error', () => {
      if (child.pid === undefined) {
        proc.closed = true;
        resolve();
      }
    });
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    proc.tail = Buffer.concat([proc.tail, chunk]);
    if (proc.tail.length > STDERR_TAIL_BYTES) proc.tail = proc.tail.subarray(-STDERR_TAIL_BYTES);
  });
  child.stderr?.on('error', noop);
  return proc;
}

export function createAudioPlayer(opts: AudioPlayerOptions): AudioPlayer {
  const volume = opts.volume ?? 100;
  if (!Number.isInteger(volume) || volume < 0 || volume > 100) {
    throw new RangeError(`volume must be an integer in 0..100, got ${String(volume)}`);
  }
  if (!Array.isArray(opts.inputArgs) || opts.inputArgs.length === 0) {
    throw new RangeError('inputArgs must be a non-empty array');
  }
  /** Input arguments of the next source. A segment may replace them (see `useInputArgs`). */
  let inputArgs = [...opts.inputArgs];
  const useInputArgs = (next: string[] | undefined): void => {
    if (next === undefined) return;
    if (!Array.isArray(next) || next.length === 0) throw new RangeError('inputArgs must be a non-empty array');
    inputArgs = [...next];
  };
  const ffmpegPath = opts.ffmpegPath ?? 'ffmpeg';
  const ffplayPath = opts.ffplayPath ?? 'ffplay';
  const now = opts.now ?? ((): number => performance.now());
  const playerArgs = buildAudioPlayerArgs(volume);

  const endCallbacks: (() => void)[] = [];
  const errorCallbacks: ((message: string) => void)[] = [];
  /** Every process that may still be alive. */
  const live = new Set<Proc>();
  let ffplay: Proc | null = null;
  let pump: PcmPump | null = null;
  let source: Proc | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let hasFailed = false;
  let stopping = false;
  let endReported = false;

  const reportError = (message: string): void => {
    for (const cb of errorCallbacks) cb(message);
  };

  const stopTimer = (): void => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };

  /** Ends the source without waiting. Its events are ignored from now on (`source` no longer matches). */
  const dropSource = (): void => {
    const s = source;
    source = null;
    if (s === null) return;
    s.killed = true;
    s.child.stdout?.destroy();
    if (!s.closed) void killTree(s.child.pid, 'SIGKILL');
  };

  const fail = (message: string): void => {
    if (hasFailed || stopping) return;
    hasFailed = true;
    stopTimer();
    dropSource();
    if (ffplay !== null && !ffplay.closed) {
      ffplay.killed = true;
      ffplay.child.stdin?.destroy();
      void killTree(ffplay.child.pid, 'SIGTERM');
    }
    reportError(message);
  };

  const spawnFailed = (p: Proc, err: Error & { code?: string }): void => {
    if (err.code === 'ENOENT') fail(`${p.label} not found on PATH, playing without audio`);
    else fail(`${p.label}: ${err.message}`);
  };

  const startSource = (atSec: number): void => {
    const proc = spawnProc('ffmpeg', ffmpegPath, buildAudioDecoderArgs(inputArgs, atSec), ['ignore', 'pipe', 'pipe']);
    live.add(proc);
    source = proc;
    const out = proc.child.stdout;
    out?.on('error', noop);
    out?.on('data', (chunk: Buffer) => {
      if (source !== proc || pump === null) return;
      pump.feed(chunk);
      if (!pump.wantsMore()) proc.child.stdout?.pause();
    });
    proc.child.on('error', (err) => {
      if (source === proc) spawnFailed(proc, err);
    });
    void proc.exited.then(() => {
      live.delete(proc);
      if (source !== proc || proc.killed || stopping || hasFailed) return;
      if (proc.code === 0 && proc.signal === null) {
        pump?.endOfSource();
        return;
      }
      fail(`ffmpeg: ${lastLine(proc.tail) || `exited with ${String(proc.code ?? proc.signal)}`}`);
    });
  };

  const onTick = (): void => {
    const pm = pump;
    if (pm === null) return;
    const out = source?.child.stdout;
    if (out?.isPaused() === true && pm.wantsMore()) out.resume();
    pm.tick();
    if (!endReported && pm.finished()) {
      endReported = true;
      for (const cb of endCallbacks) cb();
    }
  };

  const spawnPlayer = (): Proc => {
    const proc = spawnProc('ffplay', ffplayPath, playerArgs, ['pipe', 'ignore', 'pipe']);
    live.add(proc);
    proc.child.stdin?.on('error', noop);
    proc.child.on('error', (err) => {
      spawnFailed(proc, err);
    });
    void proc.exited.then(() => {
      live.delete(proc);
      if (proc.killed || stopping || hasFailed) return;
      // ffplay is the end of the chain and must outlive the session; it never exits on its own here.
      fail(`ffplay: ${lastLine(proc.tail) || `exited with ${String(proc.code ?? proc.signal)}`}`);
    });
    return proc;
  };

  const seekImpl = (sec: number, args?: string[]): void => {
    useInputArgs(args);
    if (pump === null || hasFailed || stopping) return;
    dropSource();
    pump.seek(sec);
    endReported = false;
    startSource(sec);
  };

  return {
    start(atSec, args) {
      if (!Number.isFinite(atSec) || atSec < 0) throw new RangeError(`atSec must be >= 0, got ${String(atSec)}`);
      if (hasFailed || stopping) return;
      if (pump !== null) {
        seekImpl(atSec, args);
        return;
      }
      useInputArgs(args);
      const player = spawnPlayer();
      ffplay = player;
      const stdin = player.child.stdin;
      pump = createPcmPump({
        sink: {
          write(chunk) {
            if (stdin === null || stdin.destroyed) return false;
            return stdin.write(chunk);
          },
          get writableLength() {
            return stdin?.writableLength ?? 0;
          },
        },
        now,
        startSec: atSec,
        ...(opts.outputLatencyMs === undefined ? {} : { outputLatencyMs: opts.outputLatencyMs }),
      });
      startSource(atSec);
      timer = setInterval(onTick, PUMP_INTERVAL_MS);
      timer.unref();
    },
    seek(sec, args) {
      if (!Number.isFinite(sec) || sec < 0) throw new RangeError(`sec must be >= 0, got ${String(sec)}`);
      seekImpl(sec, args);
    },
    release() {
      pump?.release();
    },
    pause() {
      pump?.pause();
    },
    resume() {
      pump?.resume();
    },
    ready: () => pump === null || hasFailed || pump.ready(),
    positionSec: () => pump?.positionSec() ?? 0,
    failed: () => hasFailed,
    stop() {
      stopping = true;
      stopTimer();
      source = null;
      const procs = [...live];
      for (const p of procs) {
        p.killed = true;
        p.child.stdout?.destroy();
        p.child.stdin?.destroy();
      }
      for (const p of procs) {
        if (!p.closed) void killTree(p.child.pid, 'SIGTERM');
      }
      const grace = setTimeout(() => {
        for (const p of procs) {
          if (!p.closed) void killTree(p.child.pid, 'SIGKILL');
        }
      }, KILL_GRACE_MS);
      return Promise.all(procs.map((p) => p.exited)).then(() => {
        clearTimeout(grace);
      });
    },
    killNow() {
      stopping = true;
      stopTimer();
      source = null;
      for (const p of live) {
        p.killed = true;
        p.child.stdout?.destroy();
        p.child.stdin?.destroy();
        if (!p.closed) killTreeSync(p.child.pid, 'SIGKILL');
      }
    },
    pids() {
      return [ffplay, source]
        .map((p) => p?.child.pid)
        .filter((pid): pid is number => pid !== undefined);
    },
    onEnd(cb) {
      endCallbacks.push(cb);
    },
    onError(cb) {
      errorCallbacks.push(cb);
    },
    stats: () => pump?.stats ?? null,
  };
}
