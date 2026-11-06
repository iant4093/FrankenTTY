// Seekable cache for the lavfi demos.
//
// lavfi sources cannot seek: `-ss 30` decodes from 0 (mandelbrot needs ~2 s to reach 30 s).
// This module renders a demo once, in the background, into a short-GOP Matroska file that
// seeks in tens of milliseconds, and reports when it is ready. It owns one ffmpeg child.
//
// File layout in the cache directory:
//   <name>-<hash>.mkv               final render (valid only together with the .ok marker)
//   <name>-<hash>.mkv.ok            marker written after the atomic rename
//   <name>-<hash>.mkv.partial.mkv   render in progress (doubles as the cross-process lock)

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { demoAudioInputArgs, demoVideoInputArgs } from './demo.ts';
import type { DemoSource } from './demo.ts';
import { killTreeSync } from './kill-tree.ts';

/** Bump to invalidate every cached file (encoder settings changed). */
export const CACHE_VERSION = 1;

/** A partial file modified within this window means another process is rendering. */
const PARTIAL_FRESH_MS = 60_000;
const POLL_INTERVAL_MS = 500;
const POLL_GIVE_UP_MS = 120_000;
const STDERR_TAIL_BYTES = 400;
/** `os.setPriority` niceness for the render: yields CPU to playback. */
const RENDER_NICENESS = 10;

export interface DemoCacheEntry {
  path: string;
  ready: boolean;
}

export interface DemoCacheOptions {
  /** Cache directory. Default: `<os.tmpdir()>/frankentty-cache`. */
  dir?: string;
  /** ffmpeg executable. Default: `ffmpeg` from PATH. */
  ffmpegPath?: string;
  /** Called once, with the final path, when the cache becomes usable. Never called after `cancel()`. */
  onReady?: (path: string) => void;
  /** Called at most once, when the render could not be completed. */
  onError?: (message: string) => void;
  /**
   * For tests only: render this many seconds instead of the demo's full length, so a test
   * need not wait for 60 s of video. Never set in production code; the cache path does not
   * depend on it, so always pair it with a throwaway `dir`.
   */
  durationSec?: number;
}

function defaultDir(): string {
  return path.join(os.tmpdir(), 'frankentty-cache');
}

/** Pure: the final cache file for `demo`. Stable for equal filters and `CACHE_VERSION`. */
export function demoCachePath(demo: DemoSource, opts: { dir?: string } = {}): string {
  const hash = createHash('sha256')
    .update(`${demo.videoFilter}\n${demo.audioFilter}\n${CACHE_VERSION}`)
    .digest('hex')
    .slice(0, 16);
  return path.join(opts.dir ?? defaultDir(), `${demo.name}-${hash}.mkv`);
}

const markerPath = (finalPath: string): string => `${finalPath}.ok`;
const partialPath = (finalPath: string): string => `${finalPath}.partial.mkv`;

function isComplete(finalPath: string): boolean {
  try {
    return statSync(finalPath).size > 0 && existsSync(markerPath(finalPath));
  } catch {
    return false;
  }
}

function removeQuietly(file: string): void {
  try {
    rmSync(file, { force: true });
  } catch {
    // Best effort: a failed delete only leaves a file the next run overwrites.
  }
}

/** Pure: ffmpeg argv that renders the demo to `output`. */
export function renderArgs(demo: DemoSource, output: string, durationSec: number): string[] {
  return [
    '-hide_banner', '-nostdin', '-v', 'error', '-y',
    ...demoVideoInputArgs(demo),
    ...demoAudioInputArgs(demo),
    '-t', String(durationSec),
    '-map', '0:v:0', '-map', '1:a:0',
    // Keyframe every 15 frames (0.5 s at 30 fps) so a seek decodes at most 0.5 s.
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
    '-g', '15', '-keyint_min', '15', '-sc_threshold', '0',
    '-pix_fmt', 'yuv420p',
    // Uncompressed audio: no decoder warm-up after a seek.
    '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2',
    '-f', 'matroska',
    output,
  ];
}

/**
 * Ensures the seekable cache for `demo` exists, rendering it in the background if needed.
 * Returns at once. `entry.ready` flips to true (and `onReady` fires) when the file is usable.
 * `pid` is the render's ffmpeg pid, or undefined when nothing was spawned by this call.
 */
export function ensureDemoCache(
  demo: DemoSource,
  opts: DemoCacheOptions = {},
): { entry: DemoCacheEntry; cancel(): void; pid: number | undefined } {
  const finalPath = demoCachePath(demo, opts);
  const partial = partialPath(finalPath);
  const entry: DemoCacheEntry = { path: finalPath, ready: false };
  let cancelled = false;
  let settled = false; // onReady or onError already delivered
  let ownsPartial = false;
  let pollTimer: NodeJS.Timeout | undefined;
  let killTarget: number | undefined;

  const deliverReady = (): void => {
    if (cancelled || settled) return;
    settled = true;
    entry.ready = true;
    opts.onReady?.(finalPath);
  };
  const deliverError = (message: string): void => {
    if (cancelled || settled) return;
    settled = true;
    opts.onError?.(message);
  };
  const cancel = (): void => {
    if (cancelled) return;
    cancelled = true;
    if (pollTimer !== undefined) clearTimeout(pollTimer);
    killTreeSync(killTarget);
    if (ownsPartial) removeQuietly(partial);
  };
  const result: { entry: DemoCacheEntry; cancel(): void; pid: number | undefined } = {
    entry,
    cancel,
    pid: undefined,
  };

  // 1. Already cached.
  if (isComplete(finalPath)) {
    entry.ready = true;
    process.nextTick(() => {
      if (cancelled || settled) return;
      settled = true;
      opts.onReady?.(finalPath);
    });
    return result;
  }

  // 2. Take the partial file as a lock, or wait for the process that holds it.
  try {
    mkdirSync(path.dirname(finalPath), { recursive: true });
  } catch (err) {
    const message = `Demo cache: cannot create ${path.dirname(finalPath)}: ${String(err)}`;
    process.nextTick(() => deliverError(message));
    return result;
  }
  let foreignRender = false;
  try {
    closeSync(openSync(partial, 'wx'));
    ownsPartial = true;
  } catch {
    try {
      if (Date.now() - statSync(partial).mtimeMs < PARTIAL_FRESH_MS) {
        foreignRender = true;
      } else {
        // Stale partial from a crashed run: take over.
        rmSync(partial, { force: true });
        closeSync(openSync(partial, 'wx'));
        ownsPartial = true;
      }
    } catch (err) {
      const message = `Demo cache: cannot create ${partial}: ${String(err)}`;
      process.nextTick(() => deliverError(message));
      return result;
    }
  }

  if (foreignRender) {
    const deadline = Date.now() + POLL_GIVE_UP_MS;
    const poll = (): void => {
      if (cancelled) return;
      if (isComplete(finalPath)) {
        deliverReady();
        return;
      }
      if (Date.now() >= deadline) return; // give up quietly; entry stays not ready
      pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
      pollTimer.unref();
    };
    pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
    pollTimer.unref();
    return result;
  }

  // 3. Render in the background.
  const args = renderArgs(demo, partial, opts.durationSec ?? demo.durationSec);
  const child = spawn(opts.ffmpegPath ?? 'ffmpeg', args, {
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
  result.pid = child.pid;
  killTarget = child.pid;
  if (child.pid !== undefined) {
    try {
      os.setPriority(child.pid, RENDER_NICENESS);
    } catch {
      // Not supported here, or not permitted: render at normal priority.
    }
  }

  let stderrTail = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
  });

  const fail = (reason: string): void => {
    removeQuietly(partial);
    const tail = stderrTail.trim();
    deliverError(`Demo cache render failed (${reason})${tail === '' ? '' : `: ${tail}`}`);
  };
  child.once('error', (err) => {
    killTarget = undefined;
    fail(err.message);
  });
  child.once('close', (code, signal) => {
    killTarget = undefined;
    if (cancelled) {
      removeQuietly(partial); // on Windows the file may have been locked during cancel()
      return;
    }
    if (code !== 0) {
      fail(code === null ? `signal ${String(signal)}` : `exit ${code}`);
      return;
    }
    try {
      renameSync(partial, finalPath);
      writeFileSync(markerPath(finalPath), String(CACHE_VERSION));
    } catch (err) {
      fail(String(err));
      return;
    }
    deliverReady();
  });

  return result;
}
