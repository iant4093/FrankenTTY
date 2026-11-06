// Asynchronous PTY runner for tests that must look at the process while it runs.
// Wraps tests/helpers/pty_run.py. The output is kept as timed chunks so a test can replay it up to
// any moment into @xterm/headless and read the screen as it looked then.

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDemo } from '../../src/ingest/demo.ts';
import { ensureDemoCache } from '../../src/ingest/demo-cache.ts';
import { replayInto } from './emulator.ts';
import type { Emulator } from './emulator.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const helper = path.join(root, 'tests', 'helpers', 'pty_run.py');

/** True on CI runners (hosted runners are slower and noisier than a developer machine). */
export const ON_CI = process.env.CI !== undefined && process.env.CI !== '' && process.env.CI !== 'false';

/** `local` on a developer machine, `ci` when `CI` is set. For timing bounds only. */
export function ciBound<T>(local: T, ci: T): T {
  return ON_CI ? ci : local;
}

/** A fresh temp directory for `FRANKENTTY_CACHE_DIR`. The caller removes it with `rmSync`. */
export function makeCacheDir(label: string): string {
  return mkdtempSync(path.join(os.tmpdir(), `frankentty-pty-${label}-`));
}

/**
 * Renders the full seek cache of each named demo into `dir` and resolves when every one is ready, so a PTY run
 * started with `FRANKENTTY_CACHE_DIR=dir` finds a warm cache: no background render competes for the CPU and no
 * "seek cache ready" message can replace a HUD message mid-test.
 */
export async function buildDemoCaches(dir: string, names: readonly string[]): Promise<void> {
  await Promise.all(
    names.map(
      (name) =>
        new Promise<void>((resolve, reject) => {
          ensureDemoCache(getDemo(name), {
            dir,
            onReady: () => resolve(),
            onError: (message) => reject(new Error(`seek cache for ${name}: ${message}`)),
          });
        }),
    ),
  );
}

export type PtyEvent = { at: number; hex: string } | { at: number; signal: string } | { at: number; resize: [number, number] };

export interface PtyChunk {
  /** Seconds since the process was spawned. */
  t: number;
  data: Buffer;
}

export interface PtyRun {
  exitCode: number;
  timedOut: boolean;
  chunks: PtyChunk[];
}

export interface PtyOptions {
  args: string[];
  cols?: number;
  rows?: number;
  timeout: number;
  events: PtyEvent[];
  env?: Record<string, string>;
}

export interface RunningPty {
  /** Unique string in the helper's command line; find the process tree with `treeUnder`. */
  marker: string;
  finished: Promise<PtyRun>;
}

let counter = 0;

export function hex(text: string): string {
  return Buffer.from(text, 'latin1').toString('hex');
}

/** Starts `node src/main.ts <args>` in a PTY. Audio is silent: SDL's dummy driver. */
export function startPty(options: PtyOptions): RunningPty {
  const marker = `ftty-pty-${String(process.pid)}-${String(counter++)}`;
  const spec = {
    cmd: [process.execPath, 'src/main.ts', ...options.args],
    cwd: root,
    cols: options.cols ?? 100,
    rows: options.rows ?? 30,
    timeout: options.timeout,
    env: {
      TERM: 'xterm-256color',
      LANG: 'en_US.UTF-8',
      COLORTERM: 'truecolor',
      SDL_AUDIODRIVER: 'dummy',
      FRANKENTTY_PTY_MARKER: marker,
      ...options.env,
    },
    events: options.events,
  };
  const child = spawn('python3', [helper, JSON.stringify(spec)], { stdio: ['ignore', 'pipe', 'pipe'] });
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  child.stdout.on('data', (c: Buffer) => out.push(c));
  child.stderr.on('data', (c: Buffer) => err.push(c));
  const finished = new Promise<PtyRun>((resolve, reject) => {
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`pty_run.py failed: ${Buffer.concat(err).toString('utf8')}`));
        return;
      }
      const raw = JSON.parse(Buffer.concat(out).toString('utf8')) as {
        exitCode: number;
        timedOut: boolean;
        chunks: { t: number; b64: string }[];
      };
      resolve({
        exitCode: raw.exitCode,
        timedOut: raw.timedOut,
        chunks: raw.chunks.map((c) => ({ t: c.t, data: Buffer.from(c.b64, 'base64') })),
      });
    });
  });
  return { marker, finished };
}

function pgrep(args: string[]): string[] {
  const r = spawnSync('pgrep', args, { encoding: 'utf8' });
  if (r.status !== 0 || typeof r.stdout !== 'string') return [];
  return r.stdout.split('\n').filter((l) => l !== '');
}

/** Children of `pid` with their process names (`pgrep -l`: "pid name"). */
function childrenOf(pid: number): { pid: number; name: string }[] {
  return pgrep(['-l', '-P', String(pid)]).map((line) => {
    const [id = '', name = ''] = line.trim().split(/\s+/, 2);
    return { pid: Number(id), name: path.basename(name) };
  });
}

/**
 * The children of the node process that runs in the PTY of `marker`: python (marker in its argv)
 * -> node -> ffmpeg / ffplay. Empty before the processes exist.
 */
export function playerChildren(marker: string): { pid: number; name: string }[] {
  const out: { pid: number; name: string }[] = [];
  for (const py of pgrep(['-f', marker])) {
    for (const node of childrenOf(Number(py))) out.push(...childrenOf(node.pid));
  }
  return out;
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Replays everything the process had written by `seconds` into a fresh emulator. Caller disposes it. */
export function screenAt(run: PtyRun, seconds: number, cols = 100, rows = 30): Promise<Emulator> {
  const bytes = Buffer.concat(run.chunks.filter((c) => c.t <= seconds).map((c) => c.data));
  return replayInto(bytes, cols, rows);
}

/** One screen row as text, right-trimmed. `row` is 0-based. */
export function rowText(term: Emulator, row: number): string {
  return term.buffer.active.getLine(row)?.translateToString(true) ?? '';
}

/** `m:ss` or `h:mm:ss` in a HUD row -> seconds, or null. */
export function hudSeconds(row: string): number | null {
  const m = /^[▶⏸] (?:(\d+):)?(\d+):(\d\d) \//.exec(row);
  if (m === null) return null;
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}
