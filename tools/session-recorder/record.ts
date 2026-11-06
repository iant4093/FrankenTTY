// Records real FrankenTTY sessions for the demo video: runs `node src/main.ts <args>` in a PTY, injects
// timed keys and resizes, and saves every byte the program wrote, with timestamps, as JSON (video/sessions/).
// Dev tooling: never imported by src/, not shipped.
//
// Session file (version 1), consumed by the Remotion project:
//   { version, cols, rows, fps: 30, durationSec, title, command, env, events: [{t, keys, label, resize?}],
//     chunks: [{t, b64}] }
// `cols`/`rows` are the size at spawn; a resize event carries the new size. `command` is what the user types
// ("frankentty ..."). `env` omits machine-specific paths.
//
// CLI: node tools/session-recorder/record.ts [scene...|--all]

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { COLOR_FLAGS, DEFAULT_DEMO, DEMOS, MODES, PALETTES, QUALITIES } from '../../src/cli/args.ts';
import { getDemo } from '../../src/ingest/demo.ts';
import { ensureDemoCache } from '../../src/ingest/demo-cache.ts';
import { SCENES, SCENE_NAMES, getScene } from './scenes.ts';
import type { SceneSpec, SessionEvent } from './scenes.ts';

export type { SceneSpec, SessionEvent } from './scenes.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '..', '..');
export const SESSIONS_DIR = path.join(REPO_ROOT, 'video', 'sessions');
const PTY_HELPER = path.join(here, 'pty_run.py');

/** Above this size a session is written gzipped (`.json.gz`). */
export const MAX_JSON_BYTES = 5 * 1024 * 1024;

export const LIMITS = {
  minCols: 20,
  maxCols: 300,
  minRows: 5,
  maxRows: 100,
  minDurationSec: 0.5,
  maxDurationSec: 120,
  maxEvents: 200,
  maxKeysLength: 16,
  maxLabelLength: 80,
  maxTitleLength: 120,
} as const;

/** Extra seconds past the planned end before the PTY helper kills a stuck program. */
const KILL_GRACE_SEC = 20;
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
const NUMBER_PATTERN = /^-?\d+(\.\d+)?$/;
const INT_PATTERN = /^-?\d+$/;

/** The scene or command is not acceptable. The MCP server answers JSON-RPC -32602. */
export class SceneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SceneError';
  }
}

/** The recording itself failed (cache build, process exit, timeout). */
export class RecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecordError';
  }
}

export interface Session {
  version: 1;
  cols: number;
  rows: number;
  fps: 30;
  durationSec: number;
  title: string;
  command: string[];
  env: Record<string, string>;
  events: SessionEvent[];
  chunks: { t: number; b64: string }[];
}

// ---------------------------------------------------------------------------
// Validation: only FrankenTTY with --demo or a local file may be run
// ---------------------------------------------------------------------------

type ValueCheck = (raw: string) => string | null;

function oneOf(allowed: readonly string[]): ValueCheck {
  return (raw) => (allowed.includes(raw) ? null : `expected ${allowed.join('|')}`);
}

function numberIn(min: number, max: number, integer: boolean): ValueCheck {
  return (raw) => {
    const ok = (integer ? INT_PATTERN : NUMBER_PATTERN).test(raw) && Number(raw) >= min && Number(raw) <= max;
    return ok ? null : `expected ${integer ? 'an integer' : 'a number'} from ${String(min)} to ${String(max)}`;
  };
}

const VALUE_FLAGS: Record<string, ValueCheck> = {
  '--mode': oneOf(MODES),
  '--palette': oneOf(PALETTES),
  '--color': oneOf(COLOR_FLAGS),
  '--quality': oneOf(QUALITIES),
  '--fps': numberIn(1, 60, true),
  '--threshold': numberIn(0, 100, false),
  '--cell-aspect': numberIn(1, 3, false),
  '--av-offset': numberIn(-2000, 2000, true),
};
const SWITCH_FLAGS: readonly string[] = ['--no-audio'];

/**
 * Checks the arguments that follow `frankentty`: exactly one source (`--demo [name]` or an existing local
 * file) and a few playback flags. Anything else (other flags, URLs, `--bench`, a second positional) is rejected.
 * Returns the arguments unchanged.
 */
export function validateCommand(args: readonly string[]): string[] {
  if (args.length === 0 || args.length > 24) throw new SceneError('command must have 1-24 arguments');
  let hasSource = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg.length === 0 || arg.length > 4096 || arg.includes('\0')) throw new SceneError('command has an invalid argument');
    if (arg === '--demo') {
      if (hasSource) throw new SceneError('command may name only one source');
      hasSource = true;
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        if (!(DEMOS as readonly string[]).includes(next)) {
          throw new SceneError(`--demo: expected ${DEMOS.join('|')}, got "${next}"`);
        }
        i++;
      }
    } else if (Object.hasOwn(VALUE_FLAGS, arg)) {
      const value = args[i + 1];
      if (value === undefined) throw new SceneError(`${arg}: missing value`);
      const problem = (VALUE_FLAGS[arg] as ValueCheck)(value);
      if (problem !== null) throw new SceneError(`${arg}: ${problem}, got "${value}"`);
      i++;
    } else if (SWITCH_FLAGS.includes(arg)) {
      // accepted as is
    } else if (arg.startsWith('-')) {
      throw new SceneError(`argument not allowed: ${arg}`);
    } else {
      if (hasSource) throw new SceneError('command may name only one source');
      hasSource = true;
      let isFile: boolean;
      try {
        isFile = statSync(arg).isFile();
      } catch {
        isFile = false;
      }
      if (!isFile) throw new SceneError(`${arg}: no such file`);
    }
  }
  if (!hasSource) throw new SceneError('command needs --demo or a local file');
  return [...args];
}

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

/** Throws SceneError unless `scene` can be recorded. Returns it with the final `q` event guaranteed. */
export function validateScene(scene: SceneSpec): SceneSpec {
  if (!NAME_PATTERN.test(scene.name)) throw new SceneError('name must match [a-z0-9][a-z0-9-]{0,39}');
  if (scene.title.length > LIMITS.maxTitleLength) throw new SceneError('title is too long');
  validateCommand(scene.command);
  if (!isInt(scene.cols) || scene.cols < LIMITS.minCols || scene.cols > LIMITS.maxCols) {
    throw new SceneError(`cols must be an integer from ${String(LIMITS.minCols)} to ${String(LIMITS.maxCols)}`);
  }
  if (!isInt(scene.rows) || scene.rows < LIMITS.minRows || scene.rows > LIMITS.maxRows) {
    throw new SceneError(`rows must be an integer from ${String(LIMITS.minRows)} to ${String(LIMITS.maxRows)}`);
  }
  const d = scene.durationSec;
  if (!Number.isFinite(d) || d < LIMITS.minDurationSec || d > LIMITS.maxDurationSec) {
    throw new SceneError(`durationSec must be from ${String(LIMITS.minDurationSec)} to ${String(LIMITS.maxDurationSec)}`);
  }
  if (scene.events.length > LIMITS.maxEvents) throw new SceneError(`at most ${String(LIMITS.maxEvents)} events`);
  for (const [i, event] of scene.events.entries()) {
    const where = `events[${String(i)}]`;
    if (!Number.isFinite(event.t) || event.t < 0 || event.t > d) throw new SceneError(`${where}.t must be from 0 to durationSec`);
    if (event.keys.length > LIMITS.maxKeysLength) throw new SceneError(`${where}.keys is too long`);
    if (event.label.length > LIMITS.maxLabelLength) throw new SceneError(`${where}.label is too long`);
    if (event.resize === undefined) {
      if (event.keys.length === 0) throw new SceneError(`${where} needs keys or resize`);
    } else {
      const [c, r] = event.resize;
      if (event.keys.length !== 0) throw new SceneError(`${where}: a resize event has no keys`);
      if (!isInt(c) || !isInt(r) || c < LIMITS.minCols || c > LIMITS.maxCols || r < LIMITS.minRows || r > LIMITS.maxRows) {
        throw new SceneError(`${where}.resize is out of range`);
      }
    }
  }
  const events = scene.events.map((e) => ({ ...e }));
  if (!events.some((e) => e.keys === 'q')) events.push({ t: d, keys: 'q', label: 'quit' });
  events.sort((a, b) => a.t - b.t);
  return { ...scene, events };
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

/** The environment the footage is recorded in. Silent audio; no hidden terminal features. */
const SESSION_ENV: Record<string, string> = {
  TERM: 'xterm-256color',
  COLORTERM: 'truecolor',
  LANG: 'en_US.UTF-8',
  SDL_AUDIODRIVER: 'dummy',
};

export function defaultCacheDir(): string {
  return path.join(os.tmpdir(), 'frankentty-session-cache');
}

function demoNameOf(command: readonly string[]): string | null {
  const at = command.indexOf('--demo');
  if (at < 0) return null;
  const next = command[at + 1];
  return next !== undefined && !next.startsWith('-') ? next : DEFAULT_DEMO;
}

/** Renders the seek cache of `name` into `dir` (a no-op when it exists), so no background render runs during the take. */
function buildCache(name: string, dir: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    ensureDemoCache(getDemo(name), {
      dir,
      onReady: () => resolve(),
      onError: (message) => reject(new RecordError(`seek cache for ${name}: ${message}`)),
    });
  });
}

const running = new Set<ChildProcess>();

/** Synchronously stops every recording in flight. Closing the PTY hangs up the program, which restores and exits. */
export function killAllRecordings(): void {
  for (const child of running) child.kill('SIGTERM');
}

export interface RecordOptions {
  /** Directory of the demo seek caches (default: a shared temp directory). */
  cacheDir?: string;
}

function eventToPty(event: SessionEvent): Record<string, unknown> {
  if (event.resize !== undefined) return { at: event.t, resize: event.resize };
  return { at: event.t, hex: Buffer.from(event.keys, 'utf8').toString('hex') };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Records one scene and returns the session. Does not write a file. */
export async function recordSession(input: SceneSpec, options: RecordOptions = {}): Promise<Session> {
  const scene = validateScene(input);
  const demo = demoNameOf(scene.command);
  const cacheDir = options.cacheDir ?? defaultCacheDir();
  if (demo !== null) await buildCache(demo, cacheDir);

  const spec = {
    cmd: [process.execPath, 'src/main.ts', ...scene.command],
    cwd: REPO_ROOT,
    cols: scene.cols,
    rows: scene.rows,
    timeout: scene.durationSec + KILL_GRACE_SEC,
    env: { ...SESSION_ENV, FRANKENTTY_CACHE_DIR: cacheDir },
    events: scene.events.map(eventToPty),
  };
  const raw = await runHelper(spec);
  if (raw.timedOut) throw new RecordError(`${scene.name}: the program did not exit within ${String(spec.timeout)} s`);
  if (raw.exitCode !== 0) throw new RecordError(`${scene.name}: the program exited with code ${String(raw.exitCode)}`);
  const last = raw.chunks[raw.chunks.length - 1];
  if (last === undefined) throw new RecordError(`${scene.name}: the program wrote nothing`);

  return {
    version: 1,
    cols: scene.cols,
    rows: scene.rows,
    fps: 30,
    durationSec: round3(last.t),
    title: scene.title,
    command: ['frankentty', ...scene.command],
    env: { ...SESSION_ENV },
    events: scene.events,
    chunks: raw.chunks,
  };
}

interface HelperResult {
  exitCode: number;
  timedOut: boolean;
  chunks: { t: number; b64: string }[];
}

function runHelper(spec: Record<string, unknown>): Promise<HelperResult> {
  return new Promise<HelperResult>((resolve, reject) => {
    const child = spawn('python3', [PTY_HELPER, JSON.stringify(spec)], { stdio: ['ignore', 'pipe', 'pipe'] });
    running.add(child);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => err.push(c));
    child.once('error', (e) => {
      running.delete(child);
      reject(new RecordError(`cannot run python3: ${e.message}`));
    });
    child.once('close', (code) => {
      running.delete(child);
      if (code !== 0) {
        const detail = Buffer.concat(err).toString('utf8').trim().split('\n').pop() ?? '';
        reject(new RecordError(`pty_run.py failed (exit ${String(code)}): ${detail}`));
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(out).toString('utf8')) as HelperResult;
        resolve({ exitCode: parsed.exitCode, timedOut: parsed.timedOut, chunks: parsed.chunks });
      } catch {
        reject(new RecordError('pty_run.py returned invalid JSON'));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export interface WrittenSession {
  /** Absolute path actually written (`.json`, or `.json.gz` when the JSON exceeds MAX_JSON_BYTES). */
  path: string;
  gzipped: boolean;
  fileBytes: number;
  chunks: number;
  /** Bytes read from the PTY. */
  bytes: number;
}

/** Writes `session` to `jsonPath` (must end with `.json`), gzipped to `<jsonPath>.gz` when over MAX_JSON_BYTES. */
export function writeSession(session: Session, jsonPath: string): WrittenSession {
  mkdirSync(path.dirname(jsonPath), { recursive: true });
  const json = JSON.stringify(session);
  const gzipped = Buffer.byteLength(json) > MAX_JSON_BYTES;
  const target = gzipped ? `${jsonPath}.gz` : jsonPath;
  // Remove the other form so a stale copy never shadows the new one.
  rmSync(gzipped ? jsonPath : `${jsonPath}.gz`, { force: true });
  const data = gzipped ? gzipSync(json) : Buffer.from(json);
  writeFileSync(target, data);
  let bytes = 0;
  for (const c of session.chunks) bytes += Buffer.from(c.b64, 'base64').length;
  return { path: target, gzipped, fileBytes: data.length, chunks: session.chunks.length, bytes };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(argv: string[]): Promise<number> {
  const all = argv.includes('--all');
  const names = argv.filter((a) => a !== '--all');
  if (!all && names.length === 0) {
    process.stderr.write(`usage: node tools/session-recorder/record.ts [scene...|--all]\nscenes: ${SCENE_NAMES.join(', ')}\n`);
    return 2;
  }
  const scenes = all ? [...SCENES] : names.map((n) => getScene(n));
  for (const scene of scenes) {
    process.stdout.write(`recording ${scene.name} (${String(scene.durationSec)} s)...\n`);
    const session = await recordSession(scene);
    const written = writeSession(session, path.join(SESSIONS_DIR, `${scene.name}.json`));
    process.stdout.write(
      `  ${path.relative(REPO_ROOT, written.path)}: ${String(written.fileBytes)} bytes${written.gzipped ? ' (gzipped)' : ''}, ` +
        `${String(written.chunks)} chunks, ${String(written.bytes)} PTY bytes, ${String(session.durationSec)} s\n`,
    );
  }
  return 0;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.on('SIGINT', () => {
    killAllRecordings();
    process.exit(130);
  });
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    },
  );
}
