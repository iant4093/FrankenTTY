// Tool definitions for the FrankenTTY MCP server (dev tooling for the vt100-video Power).
// Not shipped, never imported by src/. Each tool has a JSON Schema; `callTool` validates the
// arguments against it before the handler runs.
//
// Error model:
//   ArgError     -> the server answers JSON-RPC -32602 (unknown tool, malformed or out-of-range arguments)
//   ToolFailure  -> a normal result with `isError: true` (missing file, ffmpeg failure, no frame at that time)

import { statSync } from 'node:fs';
import { release } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import tty from 'node:tty';
import xterm from '@xterm/headless';
import { BenchError, runBench } from '../../src/bench/bench.ts';
import type { BenchReport } from '../../src/bench/bench.ts';
import {
  COLOR_FLAGS,
  DEFAULT_BENCH_SIZE,
  DEFAULT_THRESHOLD,
  MODES,
  PALETTES,
} from '../../src/cli/args.ts';
import type { Mode, Palette } from '../../src/cli/args.ts';
import { createDecoder } from '../../src/ingest/decoder.ts';
import type { Decoder } from '../../src/ingest/decoder.ts';
import { DEMO_NAMES, demoMetadata, demoVideoInputArgs, getDemo } from '../../src/ingest/demo.ts';
import type { MediaInfo } from '../../src/ingest/media-info.ts';
import { ProbeError, classifyInput, probe } from '../../src/ingest/probe.ts';
import { createPipeline } from '../../src/player/pipeline.ts';
import type { ColorDepth } from '../../src/renderer/cells.ts';
import { createMapper } from '../../src/renderer/color-depth.ts';
import { DEFAULT_CELL_ASPECT, DEFAULT_HUD_ROWS, computeGeometry } from '../../src/renderer/geometry.ts';
import { AUTOWRAP_OFF } from '../../src/renderer/sequences.ts';
import { detectColorDepth, detectUnicode } from '../../src/term/capabilities.ts';

// ---------------------------------------------------------------------------
// Errors and result types
// ---------------------------------------------------------------------------

export class ArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArgError';
  }
}

export class ToolFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolFailure';
  }
}

export interface ToolResult {
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: true;
}

interface ToolOutput {
  text: string;
  structured: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// JSON Schema subset and validator
// ---------------------------------------------------------------------------

export interface Schema {
  type: 'object' | 'string' | 'number' | 'integer' | 'boolean';
  description?: string;
  enum?: readonly string[];
  minimum?: number;
  maximum?: number;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  default?: string | number | boolean;
  properties?: Record<string, Schema>;
  required?: readonly string[];
  additionalProperties?: boolean | Schema;
  maxProperties?: number;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Returns an error message, or null when `value` satisfies `schema`. */
export function validateValue(value: unknown, schema: Schema, path: string): string | null {
  switch (schema.type) {
    case 'object': {
      if (!isPlainObject(value)) return `${path} must be an object`;
      const keys = Object.keys(value);
      if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) {
        return `${path} has more than ${String(schema.maxProperties)} entries`;
      }
      for (const name of schema.required ?? []) {
        if (!Object.hasOwn(value, name)) return `${path}.${name} is required`;
      }
      const props = schema.properties ?? {};
      for (const key of keys) {
        const sub = Object.hasOwn(props, key) ? props[key] : undefined;
        if (sub !== undefined) {
          const err = validateValue(value[key], sub, `${path}.${key}`);
          if (err !== null) return err;
        } else if (schema.additionalProperties === undefined || schema.additionalProperties === false) {
          return `${path}.${key} is not an accepted argument`;
        } else if (schema.additionalProperties !== true) {
          const err = validateValue(value[key], schema.additionalProperties, `${path}.${key}`);
          if (err !== null) return err;
        }
      }
      return null;
    }
    case 'string': {
      if (typeof value !== 'string') return `${path} must be a string`;
      if (schema.enum !== undefined && !schema.enum.includes(value)) {
        return `${path} must be one of ${schema.enum.join(', ')}`;
      }
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        return `${path} must not be empty`;
      }
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        return `${path} is longer than ${String(schema.maxLength)} characters`;
      }
      if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
        return `${path} does not match ${schema.pattern}`;
      }
      return null;
    }
    case 'number':
    case 'integer': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return `${path} must be a number`;
      if (schema.type === 'integer' && !Number.isInteger(value)) return `${path} must be an integer`;
      if (schema.minimum !== undefined && value < schema.minimum) {
        return `${path} must be at least ${String(schema.minimum)}`;
      }
      if (schema.maximum !== undefined && value > schema.maximum) {
        return `${path} must be at most ${String(schema.maximum)}`;
      }
      return null;
    }
    case 'boolean':
      return typeof value === 'boolean' ? null : `${path} must be a boolean`;
  }
}

// ---------------------------------------------------------------------------
// Shared argument handling
// ---------------------------------------------------------------------------

const SIZE_PATTERN = '^[0-9]{1,4}x[0-9]{1,4}$';
const SIZE_MAX_COLS = 1000;
const SIZE_MAX_ROWS = 1000;
const SIZE_MIN_ROWS = 2;
/** Snapshots return the whole grid as text, so they get a tighter cap than the bench. */
const SNAPSHOT_MAX_COLS = 300;
const SNAPSHOT_MAX_ROWS = 100;
const DEFAULT_SNAPSHOT_SIZE = { cols: 80, rows: 24 } as const;
const ANSI_CAP = 64 * 1024;
const FRAME_TIMEOUT_MS = 15_000;
const TOP_BACKGROUNDS = 8;

const COLOR_ENUM = COLOR_FLAGS.filter((c) => c !== 'auto');
type ToolColor = (typeof COLOR_ENUM)[number];

const demoSchema: Schema = {
  type: 'string',
  enum: DEMO_NAMES,
  description: 'Procedural demo source (lavfi). Give exactly one of demo or input.',
};
const inputSchema: Schema = {
  type: 'string',
  minLength: 1,
  maxLength: 4096,
  description: 'Path to a local media file, or an http(s) URL. Give exactly one of demo or input.',
};
const modeSchema: Schema = { type: 'string', enum: MODES, default: 'halfblock', description: 'Render mode.' };
const paletteSchema: Schema = { type: 'string', enum: PALETTES, default: 'truecolor', description: 'Color palette.' };
const colorSchema: Schema = {
  type: 'string',
  enum: COLOR_ENUM,
  default: 'truecolor',
  description: 'Color depth of the simulated terminal.',
};
const thresholdSchema: Schema = {
  type: 'number',
  minimum: 0,
  maximum: 100,
  description: `Color merge threshold, 0-100 (default ${String(DEFAULT_THRESHOLD)}).`,
};

type Args = Record<string, unknown>;

function str(args: Args, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' ? v : undefined;
}

function num(args: Args, key: string): number | undefined {
  const v = args[key];
  return typeof v === 'number' ? v : undefined;
}

function parseSize(
  raw: string | undefined,
  fallback: { cols: number; rows: number },
  maxCols: number,
  maxRows: number,
): { cols: number; rows: number } {
  if (raw === undefined) return fallback;
  const [c, r] = raw.split('x');
  const cols = Number(c);
  const rows = Number(r);
  if (!(cols >= 1 && cols <= maxCols && rows >= SIZE_MIN_ROWS && rows <= maxRows)) {
    throw new ArgError(
      `size must be COLSxROWS with cols 1-${String(maxCols)} and rows ${String(SIZE_MIN_ROWS)}-${String(maxRows)}, got "${raw}"`,
    );
  }
  return { cols, rows };
}

function pickMode(args: Args): Mode {
  return (str(args, 'mode') ?? 'halfblock') as Mode;
}

function pickPalette(args: Args): Palette {
  return (str(args, 'palette') ?? 'truecolor') as Palette;
}

function pickDepth(args: Args): ColorDepth {
  const color = (str(args, 'color') ?? 'truecolor') as ToolColor;
  return color === 'truecolor' ? 24 : color === '256' ? 8 : 4;
}

function depthName(depth: ColorDepth): string {
  return depth === 24 ? 'truecolor' : depth === 8 ? '256' : '16';
}

function firstLine(text: string): string {
  return text.split('\n')[0] ?? '';
}

function lastLine(text: string): string {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '');
  return lines[lines.length - 1] ?? '';
}

interface Source {
  label: string;
  info: MediaInfo;
  inputArgs: string[];
  isFile: boolean;
}

/** Exactly one of `demo` and `input`. Probes real inputs; local paths must be existing regular files. */
async function resolveSource(args: Args): Promise<Source> {
  const demo = str(args, 'demo');
  const input = str(args, 'input');
  if ((demo === undefined) === (input === undefined)) {
    throw new ArgError('give exactly one of demo or input');
  }
  if (demo !== undefined) {
    const src = getDemo(demo);
    return { label: demo, info: demoMetadata(src), inputArgs: demoVideoInputArgs(src), isFile: false };
  }
  const target = input ?? '';
  try {
    const isFile = classifyInput(target) === 'file';
    if (isFile) requireFile(target);
    return { label: target, info: await probe(target), inputArgs: ['-i', target], isFile };
  } catch (err) {
    if (err instanceof ProbeError) throw new ToolFailure(firstLine(err.message));
    throw err;
  }
}

/** Only plain files reach ffmpeg: this keeps ffmpeg protocol strings (`concat:`, `pipe:`) out. */
function requireFile(path: string): void {
  let isFile: boolean;
  try {
    isFile = statSync(path).isFile();
  } catch {
    isFile = false;
  }
  if (!isFile) throw new ToolFailure(`${path}: no such file`);
}

// ---------------------------------------------------------------------------
// Child process bookkeeping
// ---------------------------------------------------------------------------

const liveDecoders = new Set<Decoder>();

/** Synchronously kills every decoder a snapshot has running. For shutdown paths. */
export function killAllChildren(): void {
  for (const decoder of liveDecoders) decoder.killNow();
}

// ---------------------------------------------------------------------------
// Tool 1: frankentty_bench
// ---------------------------------------------------------------------------

async function benchTool(args: Args): Promise<ToolOutput> {
  const source = await resolveSource(args);
  const size = parseSize(str(args, 'size'), DEFAULT_BENCH_SIZE, SIZE_MAX_COLS, SIZE_MAX_ROWS);
  let report: BenchReport;
  try {
    report = await runBench({
      source: source.label,
      media: source.info,
      inputArgs: source.inputArgs,
      isFile: source.isFile,
      frames: num(args, 'frames') ?? 60,
      cols: size.cols,
      rows: size.rows,
      fps: 30,
      cellAspect: DEFAULT_CELL_ASPECT,
      mode: pickMode(args),
      palette: pickPalette(args),
      depth: pickDepth(args),
      threshold: num(args, 'threshold') ?? DEFAULT_THRESHOLD,
    });
  } catch (err) {
    if (err instanceof BenchError) throw new ToolFailure(firstLine(err.message));
    throw err;
  }
  return { text: JSON.stringify(report), structured: { ...report } };
}

// ---------------------------------------------------------------------------
// Tool 2: frankentty_probe_media
// ---------------------------------------------------------------------------

async function probeTool(args: Args): Promise<ToolOutput> {
  const input = str(args, 'input') ?? '';
  const info = (await resolveSource({ input })).info;
  return { text: JSON.stringify(info), structured: { ...info } };
}

// ---------------------------------------------------------------------------
// Tool 3: frankentty_render_snapshot
// ---------------------------------------------------------------------------

/** Waits for the decoder's first frame. Throws ToolFailure when the media ends first or time runs out. */
async function firstFrame(decoder: Decoder, atSec: number): Promise<Uint8Array> {
  let ended = false;
  let detail = '';
  decoder.onEnd((info) => {
    ended = true;
    detail = lastLine(info.stderrTail);
  });
  const deadline = Date.now() + FRAME_TIMEOUT_MS;
  for (;;) {
    const frame = decoder.takeOldest();
    if (frame !== null) return frame;
    if (ended) {
      throw new ToolFailure(
        detail === '' ? `no frame at ${String(atSec)} s (the media may end earlier)` : `ffmpeg: ${detail}`,
      );
    }
    if (Date.now() > deadline) throw new ToolFailure(`timed out waiting for a frame at ${String(atSec)} s`);
    await delay(2);
  }
}

async function replayBytes(
  bytes: Uint8Array,
  cols: number,
  rows: number,
): Promise<{ lines: string[]; counts: Map<number, number> }> {
  const term = new xterm.Terminal({ cols, rows, allowProposedApi: true });
  try {
    await new Promise<void>((resolve) => term.write(AUTOWRAP_OFF, resolve));
    await new Promise<void>((resolve) => term.write(bytes, resolve));

    const hudRows = DEFAULT_HUD_ROWS;
    const mapper = createMapper(8);
    const counts = new Map<number, number>();
    const lines: string[] = [];
    const buffer = term.buffer.active;
    for (let y = 0; y < rows - hudRows; y++) {
      const line = buffer.getLine(y);
      let text = '';
      for (let x = 0; x < cols; x++) {
        const cell = line?.getCell(x);
        text += cell === undefined ? ' ' : cell.getChars() || ' ';
        if (cell === undefined) continue;
        let rgb = -1;
        if (cell.isBgRGB()) rgb = cell.getBgColor();
        else if (cell.isBgPalette()) rgb = mapper.toRgb(cell.getBgColor());
        if (rgb >= 0) counts.set(rgb, (counts.get(rgb) ?? 0) + 1);
      }
      lines.push(text);
    }
    return { lines, counts };
  } finally {
    term.dispose();
  }
}

function hex(rgb: number): string {
  return `#${(rgb & 0xffffff).toString(16).padStart(6, '0')}`;
}

function showEscapes(bytes: Uint8Array): { text: string; truncated: boolean } {
  const full = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8').replace(/\x1b/g, '\\x1b');
  return full.length > ANSI_CAP ? { text: full.slice(0, ANSI_CAP), truncated: true } : { text: full, truncated: false };
}

async function snapshotTool(args: Args): Promise<ToolOutput> {
  const source = await resolveSource(args);
  const atSec = num(args, 'atSec') ?? 1;
  const { cols, rows } = parseSize(str(args, 'size'), DEFAULT_SNAPSHOT_SIZE, SNAPSHOT_MAX_COLS, SNAPSHOT_MAX_ROWS);
  const mode = pickMode(args);
  const palette = pickPalette(args);
  const depth = pickDepth(args);
  const threshold = num(args, 'threshold') ?? DEFAULT_THRESHOLD;

  const geometry = computeGeometry({
    srcWidth: source.info.width,
    srcHeight: source.info.height,
    cols,
    rows,
    cellAspect: DEFAULT_CELL_ASPECT,
  });
  if (geometry.renderCols === 0 || geometry.renderRows === 0) {
    throw new ToolFailure(`size ${String(cols)}x${String(rows)} leaves no room for video`);
  }
  const pipeline = createPipeline({
    cols: geometry.renderCols,
    rows: geometry.renderRows,
    offsetX: geometry.offsetX,
    offsetY: geometry.offsetY,
    mode,
    palette,
    depth,
    threshold,
  });

  const decoder = createDecoder({
    inputArgs: source.inputArgs,
    width: geometry.decodeWidth,
    height: geometry.decodeHeight,
    fps: 30,
    startSec: atSec,
    generation: 1,
    isFile: source.isFile,
  });
  liveDecoders.add(decoder);
  let bytes: Buffer;
  try {
    const frame = await firstFrame(decoder, atSec);
    bytes = Buffer.from(pipeline.render(frame)); // copy: the pipeline reuses its buffer
  } finally {
    await decoder.stop();
    liveDecoders.delete(decoder);
  }
  const stats = {
    bytes: pipeline.stats.bytes,
    sgrEmitted: pipeline.stats.sgrEmitted,
    naiveBytes: pipeline.stats.naiveBytes,
    naiveSgr: pipeline.stats.naiveSgr,
  };

  const { lines, counts } = await replayBytes(bytes, cols, rows);
  const topBackgrounds = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, TOP_BACKGROUNDS)
    .map(([rgb, count]) => ({ color: hex(rgb), count }));

  const grid = lines.join('\n');
  const structured: Record<string, unknown> = {
    source: source.label,
    atSec,
    cols,
    rows,
    renderCols: geometry.renderCols,
    renderRows: geometry.renderRows,
    mode,
    palette,
    depth: depthName(depth),
    threshold,
    grid,
    stats,
    topBackgrounds,
  };
  let text =
    `${grid}\n\n` +
    `stats: ${JSON.stringify(stats)}\n` +
    `top backgrounds: ${topBackgrounds.map((b) => `${b.color}x${String(b.count)}`).join(' ') || 'none'}`;
  if (args['includeAnsi'] === true) {
    const ansi = showEscapes(bytes);
    structured['ansi'] = ansi.text;
    structured['ansiTruncated'] = ansi.truncated;
    text += `\n\nansi${ansi.truncated ? ` (truncated to ${String(ANSI_CAP)} characters)` : ''}:\n${ansi.text}`;
  }
  return { text, structured };
}

// ---------------------------------------------------------------------------
// Tool 4: frankentty_terminal_caps
// ---------------------------------------------------------------------------

/** What `stdout.getColorDepth()` would report for `env`, without needing a TTY. */
function nodeColorDepth(env: Record<string, string | undefined>): number {
  try {
    return tty.WriteStream.prototype.getColorDepth.call(undefined as never, env);
  } catch {
    return 1;
  }
}

async function capsTool(args: Args): Promise<ToolOutput> {
  const envArg = args['env'];
  const env: Record<string, string | undefined> = isPlainObject(envArg)
    ? (envArg as Record<string, string>)
    : process.env;
  const platform = str(args, 'platform') ?? process.platform;
  const osRelease = str(args, 'osRelease') ?? release();
  const nodeDepth = nodeColorDepth(env);
  const colorDepth = detectColorDepth(env, platform, osRelease, nodeDepth, 'auto');
  const unicode = detectUnicode(env, platform);
  const result = {
    colorDepth,
    colorDepthName: colorDepth === 24 ? 'truecolor' : colorDepth === 8 ? '256' : '16',
    nodeColorDepth: nodeDepth,
    unicode: unicode.unicode,
    braille: unicode.braille,
    platform,
    osRelease,
  };
  return { text: JSON.stringify(result), structured: result };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Schema;
  run(args: Args): Promise<ToolOutput>;
}

export const TOOLS: readonly ToolDef[] = [
  {
    name: 'frankentty_bench',
    description:
      'Run the FrankenTTY encoder headless on N decoded frames and return the bench report as JSON: bytes and SGR counts ' +
      'naive vs compressed, savings percentages, cells skipped and render time percentiles. Needs ffmpeg on PATH.',
    inputSchema: {
      type: 'object',
      properties: {
        demo: demoSchema,
        input: inputSchema,
        frames: { type: 'integer', minimum: 1, maximum: 1000, default: 60, description: 'Frames to process (1-1000).' },
        size: {
          type: 'string',
          pattern: SIZE_PATTERN,
          default: `${String(DEFAULT_BENCH_SIZE.cols)}x${String(DEFAULT_BENCH_SIZE.rows)}`,
          description: `Simulated terminal size COLSxROWS, cols 1-${String(SIZE_MAX_COLS)}, rows ${String(SIZE_MIN_ROWS)}-${String(SIZE_MAX_ROWS)}. The bottom row is reserved for the HUD.`,
        },
        mode: modeSchema,
        palette: paletteSchema,
        color: colorSchema,
        threshold: thresholdSchema,
      },
      additionalProperties: false,
    },
    run: benchTool,
  },
  {
    name: 'frankentty_probe_media',
    description:
      'Read width, height, frame rate, duration and audio presence of a local file or http(s) URL with ffprobe ' +
      '(the same MediaInfo the player uses). Needs ffprobe on PATH.',
    inputSchema: {
      type: 'object',
      properties: { input: inputSchema },
      required: ['input'],
      additionalProperties: false,
    },
    run: probeTool,
  },
  {
    name: 'frankentty_render_snapshot',
    description:
      'Decode one frame at atSec, render it through the FrankenTTY pipeline, replay the bytes into a headless xterm ' +
      'emulator and return what the terminal shows: a text grid of glyphs (the HUD row excluded), byte and SGR stats, ' +
      'and the 8 most common cell background colors. Needs ffmpeg on PATH.',
    inputSchema: {
      type: 'object',
      properties: {
        demo: demoSchema,
        input: inputSchema,
        atSec: { type: 'number', minimum: 0, maximum: 1_000_000, default: 1, description: 'Position of the frame in seconds.' },
        size: {
          type: 'string',
          pattern: SIZE_PATTERN,
          default: `${String(DEFAULT_SNAPSHOT_SIZE.cols)}x${String(DEFAULT_SNAPSHOT_SIZE.rows)}`,
          description: `Terminal size COLSxROWS, cols 1-${String(SNAPSHOT_MAX_COLS)}, rows ${String(SIZE_MIN_ROWS)}-${String(SNAPSHOT_MAX_ROWS)}. The bottom row is reserved for the HUD, so the grid has rows-1 lines.`,
        },
        mode: modeSchema,
        palette: paletteSchema,
        color: colorSchema,
        threshold: thresholdSchema,
        includeAnsi: {
          type: 'boolean',
          default: false,
          description: 'Also return the raw escape stream with ESC written as \\x1b (capped at 64 KB).',
        },
      },
      additionalProperties: false,
    },
    run: snapshotTool,
  },
  {
    name: 'frankentty_terminal_caps',
    description:
      'Report the color depth (24, 8 or 4 bits) and Unicode/Braille support FrankenTTY would choose for a terminal ' +
      'environment. Pure: starts no process. Each omitted field defaults to the server\'s own value; a given env replaces the ' +
      'server environment entirely.',
    inputSchema: {
      type: 'object',
      properties: {
        env: {
          type: 'object',
          additionalProperties: { type: 'string', maxLength: 4096 },
          maxProperties: 256,
          description: 'Environment variables, e.g. {"TERM_PROGRAM":"Apple_Terminal","LANG":"en_US.UTF-8"}.',
        },
        platform: { type: 'string', maxLength: 32, description: 'Node platform name, e.g. darwin, linux, win32.' },
        osRelease: { type: 'string', maxLength: 128, description: 'os.release() string, e.g. "25.0.0" for macOS 26.' },
      },
      additionalProperties: false,
    },
    run: capsTool,
  },
];

/** Validates `rawArgs` against the tool's schema and runs it. */
export async function callTool(name: string, rawArgs: unknown): Promise<ToolResult> {
  const tool = TOOLS.find((t) => t.name === name);
  if (tool === undefined) throw new ArgError(`unknown tool: ${name}`);
  const args = rawArgs === undefined ? {} : rawArgs;
  const problem = validateValue(args, tool.inputSchema, 'arguments');
  if (problem !== null) throw new ArgError(problem);
  try {
    const out = await tool.run(args as Args);
    return { content: [{ type: 'text', text: out.text }], structuredContent: out.structured };
  } catch (err) {
    if (err instanceof ArgError) throw err;
    if (err instanceof ToolFailure) return { content: [{ type: 'text', text: err.message }], isError: true };
    const message = err instanceof Error ? err.message : String(err);
    console.error(`frankentty-mcp: ${name} failed: ${err instanceof Error ? (err.stack ?? message) : message}`);
    return { content: [{ type: 'text', text: firstLine(message) }], isError: true };
  }
}
