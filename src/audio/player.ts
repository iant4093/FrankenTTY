// Audio output (REQ-SYNC-04). `ffmpeg -ss <pos> ... -f wav pipe:1 | ffplay -nodisp -autoexit -i -`.
// Owns two child processes per play() call. Feeding ffplay over stdin means it exits when
// FrankenTTY dies, and it can never read the user's keys because its stdin is our pipe.

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { killTree, killTreeSync } from '../ingest/kill-tree.ts';

export interface AudioPlayerOptions {
  /** ffmpeg input arguments, e.g. `['-i', path]` or `['-f', 'lavfi', '-i', 'aevalsrc=...']`. */
  inputArgs: string[];
  ffmpegPath?: string;
  ffplayPath?: string;
  /** 0..100, passed to ffplay `-volume`. Default 100. */
  volume?: number;
  /** Time source in ms. Must be the same one the clock uses. Default `performance.now`. */
  now?: () => number;
}

export interface AudioPlayer {
  /**
   * Stops any current playback, then starts ffmpeg and ffplay at `atSec`. Returns the time
   * (from `now`) at which the processes were spawned, for `clock.anchor()`. After a missing
   * ffmpeg or ffplay was reported, this is a no-op that returns the current time.
   */
  play(atSec: number): number;
  /** Idempotent. SIGTERM, then SIGKILL after 1000 ms. Resolves when both processes have exited. */
  stop(): Promise<void>;
  /** Synchronous kill of every audio process (on Windows the whole tree). For exit paths. */
  killNow(): void;
  /** PIDs of the ffmpeg and ffplay processes of the current play() call, if any. */
  pids(): number[];
  /** Called when ffplay finishes on its own (end of audio). Not called after stop() or a new play(). */
  onEnd(cb: () => void): void;
  /** Called with a one-line message when audio fails. A missing tool is reported once. */
  onError(cb: (message: string) => void): void;
}

const STDERR_TAIL_BYTES = 4096;
const KILL_GRACE_MS = 1000;

/** Pure argv builder for the audio decoder (without the executable). */
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
    '-ac', '2', '-ar', '48000',
    '-f', 'wav', 'pipe:1',
  ];
}

/** Pure argv builder for ffplay (without the executable). */
export function buildAudioPlayerArgs(volume: number): string[] {
  return ['-hide_banner', '-loglevel', 'error', '-nodisp', '-autoexit', '-volume', String(volume), '-i', 'pipe:0'];
}

interface Proc {
  child: ChildProcess;
  label: string;
  tail: Buffer;
  code: number | null;
  signal: string | null;
  exited: Promise<void>;
  closed: boolean;
}

interface Session {
  ffmpeg: Proc;
  ffplay: Proc;
  /** True once stop(), killNow() or a newer play() ended this session on purpose. */
  stopping: boolean;
  /** True once an error was reported or a tool was missing; end-of-audio is then not reported. */
  failed: boolean;
  /** True when we killed ffmpeg because ffplay had already exited. */
  ffmpegKilledByUs: boolean;
  termination: Promise<void> | null;
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
  const inputArgs = [...opts.inputArgs];
  const ffmpegPath = opts.ffmpegPath ?? 'ffmpeg';
  const ffplayPath = opts.ffplayPath ?? 'ffplay';
  const now = opts.now ?? ((): number => performance.now());
  const playerArgs = buildAudioPlayerArgs(volume);

  const endCallbacks: (() => void)[] = [];
  const errorCallbacks: ((message: string) => void)[] = [];
  /** Sessions whose processes may still be alive (current one and ones being terminated). */
  const live = new Set<Session>();
  let current: Session | null = null;
  /** Set when ffmpeg or ffplay could not be started. play() then does nothing. */
  let disabled = false;

  const reportError = (message: string): void => {
    for (const cb of errorCallbacks) cb(message);
  };

  const destroyPipes = (s: Session): void => {
    s.ffmpeg.child.stdout?.destroy();
    s.ffplay.child.stdin?.destroy();
  };

  const terminate = (s: Session): Promise<void> => {
    if (s.termination !== null) return s.termination;
    s.stopping = true;
    if (current === s) current = null;
    destroyPipes(s);
    const procs = [s.ffmpeg, s.ffplay];
    for (const p of procs) {
      if (!p.closed) void killTree(p.child.pid, 'SIGTERM');
    }
    const timer = setTimeout(() => {
      for (const p of procs) {
        if (!p.closed) void killTree(p.child.pid, 'SIGKILL');
      }
    }, KILL_GRACE_MS);
    s.termination = Promise.all(procs.map((p) => p.exited)).then(() => {
      clearTimeout(timer);
      live.delete(s);
    });
    return s.termination;
  };

  const decide = (s: Session): void => {
    if (s.stopping || s.failed || current !== s) return;
    const { ffmpeg, ffplay } = s;
    const ffmpegBad = !s.ffmpegKilledByUs && (ffmpeg.code !== 0 || ffmpeg.signal !== null);
    if (ffmpegBad) {
      s.failed = true;
      reportError(`ffmpeg: ${lastLine(ffmpeg.tail) || `exited with ${String(ffmpeg.code ?? ffmpeg.signal)}`}`);
      return;
    }
    if (ffplay.code !== 0) {
      s.failed = true;
      reportError(`ffplay: ${lastLine(ffplay.tail) || `exited with ${String(ffplay.code ?? ffplay.signal)}`}`);
      return;
    }
    current = null;
    for (const cb of endCallbacks) cb();
  };

  const spawnFailed = (s: Session, p: Proc, err: Error & { code?: string }): void => {
    if (s.failed || s.stopping) return;
    s.failed = true;
    if (err.code === 'ENOENT') {
      disabled = true;
      reportError(`${p.label} not found on PATH, playing without audio`);
    } else {
      reportError(`${p.label}: ${err.message}`);
    }
    void terminate(s);
  };

  return {
    play(atSec) {
      const argv = buildAudioDecoderArgs(inputArgs, atSec);
      if (disabled) return now();
      if (current !== null) void terminate(current);

      const ffmpeg = spawnProc('ffmpeg', ffmpegPath, argv, ['ignore', 'pipe', 'pipe']);
      const ffplay = spawnProc('ffplay', ffplayPath, playerArgs, ['pipe', 'ignore', 'pipe']);
      const session: Session = {
        ffmpeg,
        ffplay,
        stopping: false,
        failed: false,
        ffmpegKilledByUs: false,
        termination: null,
      };
      live.add(session);
      current = session;
      const spawnedAt = now();

      const ffmpegOut = ffmpeg.child.stdout;
      const ffplayIn = ffplay.child.stdin;
      if (ffmpegOut !== null && ffplayIn !== null) {
        ffmpegOut.on('error', noop);
        ffplayIn.on('error', noop);
        ffmpegOut.pipe(ffplayIn);
      }

      ffmpeg.child.on('error', (err) => {
        spawnFailed(session, ffmpeg, err);
      });
      ffplay.child.on('error', (err) => {
        spawnFailed(session, ffplay, err);
      });

      // ffplay is the end of the chain: when it exits, stop ffmpeg if it is still writing.
      void ffplay.exited.then(() => {
        if (!session.stopping && !ffmpeg.closed) {
          session.ffmpegKilledByUs = true;
          destroyPipes(session);
          void killTree(ffmpeg.child.pid, 'SIGKILL');
        }
      });
      void Promise.all([ffmpeg.exited, ffplay.exited]).then(() => {
        live.delete(session);
        decide(session);
      });
      return spawnedAt;
    },
    stop() {
      const sessions = [...live];
      return Promise.all(sessions.map(terminate)).then(() => undefined);
    },
    killNow() {
      for (const s of live) {
        s.stopping = true;
        if (current === s) current = null;
        destroyPipes(s);
        for (const p of [s.ffmpeg, s.ffplay]) {
          if (!p.closed) killTreeSync(p.child.pid, 'SIGKILL');
        }
      }
    },
    pids() {
      if (current === null) return [];
      return [current.ffmpeg.child.pid, current.ffplay.child.pid].filter((pid): pid is number => pid !== undefined);
    },
    onEnd(cb) {
      endCallbacks.push(cb);
    },
    onError(cb) {
      errorCallbacks.push(cb);
    },
  };
}
