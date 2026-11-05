import { parseArgs as nodeParseArgs } from 'node:util';
import { VERSION } from '../build-info.ts';

export const MODES = ['halfblock', 'ascii', 'braille'] as const;
export const PALETTES = ['truecolor', 'amber', 'green', 'dmg'] as const;
export const COLOR_FLAGS = ['auto', 'truecolor', '256', '16'] as const;
export const QUALITIES = ['auto', 'max'] as const;
export const DEMOS = ['mandelbrot', 'life', 'cellauto', 'gradients', 'testsrc2'] as const;
export const DEFAULT_DEMO = 'mandelbrot';
/** Color merge threshold (0-100) used when `--threshold` is absent. Set from the Wave 3 sweep data. */
export const DEFAULT_THRESHOLD = 8;
/** `--bench` terminal size when `--size` is absent. */
export const DEFAULT_BENCH_SIZE = { cols: 120, rows: 35 } as const;
const SIZE_MAX_COLS = 1000;
const SIZE_MAX_ROWS = 1000;
const SIZE_MIN_ROWS = 2;

export type Mode = (typeof MODES)[number];
export type Palette = (typeof PALETTES)[number];
export type ColorFlag = (typeof COLOR_FLAGS)[number];
export type Quality = (typeof QUALITIES)[number];
export type Demo = (typeof DEMOS)[number];

export interface Options {
  /** File path or URL. Null when `--demo` is used. */
  input: string | null;
  /** Demo source name. Null when an input is given. */
  demo: Demo | null;
  mode: Mode;
  palette: Palette;
  fps: number;
  color: ColorFlag;
  /** Null means "use DEFAULT_THRESHOLD". */
  threshold: number | null;
  /** Null means "use the probe, else 2.0". */
  cellAspect: number | null;
  avOffset: number;
  quality: Quality;
  noAudio: boolean;
  loop: boolean;
  bench: boolean;
  frames: number | null;
  /** `--size COLSxROWS` (bench only). Null means DEFAULT_BENCH_SIZE. */
  size: { cols: number; rows: number } | null;
  /** `--json` (bench only). */
  json: boolean;
  version: boolean;
  help: boolean;
}

export type ParseResult = { ok: true; options: Options } | { ok: false; message: string };

type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

export { VERSION };

export const HELP_TEXT = `FrankenTTY ${VERSION}: play video in a terminal with ANSI escape codes.

Usage:
  frankentty <input> [options]
  frankentty --demo [name] [options]

Input is a local file or a finite http(s) URL.
Demo names: ${DEMOS.join(', ')} (default ${DEFAULT_DEMO}).

Options:
  --mode <${MODES.join('|')}>      Renderer (default halfblock)
  --palette <${PALETTES.join('|')}>  Palette (default truecolor)
  --fps <1-60>                  Frame rate (default 30)
  --color <${COLOR_FLAGS.join('|')}>  Color depth (default auto)
  --threshold <0-100>           Color merge threshold
  --cell-aspect <1.0-3.0>       Cell height/width ratio
  --av-offset <-2000..2000>     Show video this many ms ahead of audio; negative = behind (default 0)
  --quality <${QUALITIES.join('|')}>              Adaptive quality (default auto)
  --no-audio                    Play without audio
  --loop                        Restart at the end
  --bench                       Headless serializer benchmark
  --frames <N>                  Frames to serialize (with --bench only, default 300)
  --size <COLSxROWS>            Terminal size to simulate (with --bench only, default 120x35)
  --json                        Print the bench report as one JSON object (with --bench only)
  --version                     Print the version
  --help                        Print this help

Keys: q quit, Space pause, Left/Right seek 5 s, Shift+Left/Right seek 30 s,
      m mode, c palette, i HUD.
`;

const VALUE_FLAGS = new Set([
  '--mode',
  '--palette',
  '--fps',
  '--color',
  '--threshold',
  '--cell-aspect',
  '--av-offset',
  '--quality',
  '--frames',
  '--size',
]);

const INT_PATTERN = /^-?\d+$/;
const DECIMAL_PATTERN = /^-?\d+(\.\d+)?$/;

function pickEnum<T extends string>(
  flag: string,
  raw: string | undefined,
  allowed: readonly T[],
  fallback: T,
): Parsed<T> {
  if (raw === undefined) return { ok: true, value: fallback };
  const hit = allowed.find((candidate) => candidate === raw);
  if (hit === undefined) {
    return { ok: false, message: `${flag}: expected ${allowed.join('|')}, got "${raw}"` };
  }
  return { ok: true, value: hit };
}

function pickNumber(
  flag: string,
  raw: string | undefined,
  integer: boolean,
  min: number,
  max: number,
): Parsed<number | null> {
  if (raw === undefined) return { ok: true, value: null };
  const text = integer ? 'an integer' : 'a number';
  const pattern = integer ? INT_PATTERN : DECIMAL_PATTERN;
  const value = pattern.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isFinite(value) || value < min || value > max) {
    return { ok: false, message: `${flag}: expected ${text} from ${min} to ${max}, got "${raw}"` };
  }
  return { ok: true, value };
}

const SIZE_PATTERN = /^(\d{1,4})x(\d{1,4})$/;

function pickSize(raw: string | undefined): Parsed<{ cols: number; rows: number } | null> {
  if (raw === undefined) return { ok: true, value: null };
  const match = SIZE_PATTERN.exec(raw);
  const cols = match === null ? Number.NaN : Number(match[1]);
  const rows = match === null ? Number.NaN : Number(match[2]);
  if (!(cols >= 1 && cols <= SIZE_MAX_COLS && rows >= SIZE_MIN_ROWS && rows <= SIZE_MAX_ROWS)) {
    return {
      ok: false,
      message: `--size: expected COLSxROWS with cols 1-${String(SIZE_MAX_COLS)} and rows ${String(SIZE_MIN_ROWS)}-${String(SIZE_MAX_ROWS)}, got "${raw}"`,
    };
  }
  return { ok: true, value: { cols, rows } };
}

/**
 * Lets `--av-offset -100` work: node:util treats a dash-led token after a
 * value flag as ambiguous, so join the pair into `--av-offset=-100`.
 */
function joinNegativeValues(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    const next = argv[i + 1];
    if (VALUE_FLAGS.has(arg) && next !== undefined && /^-\d/.test(next)) {
      out.push(`${arg}=${next}`);
      i++;
    } else {
      out.push(arg);
    }
  }
  return out;
}

function describeParseError(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  const raw = err instanceof Error ? err.message : String(err);
  if (code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
    const name = /'([^']+)'/.exec(raw)?.[1] ?? 'option';
    return `unknown option ${name}; run frankentty --help`;
  }
  const firstLine = raw.split('\n')[0] ?? raw;
  return (firstLine.split('. ')[0] ?? firstLine).trim();
}

function tokenize(argv: readonly string[]) {
  try {
    const parsed = nodeParseArgs({
      args: joinNegativeValues(argv),
      allowPositionals: true,
      strict: true,
      options: {
        mode: { type: 'string' },
        palette: { type: 'string' },
        fps: { type: 'string' },
        color: { type: 'string' },
        threshold: { type: 'string' },
        'cell-aspect': { type: 'string' },
        'av-offset': { type: 'string' },
        quality: { type: 'string' },
        frames: { type: 'string' },
        size: { type: 'string' },
        json: { type: 'boolean' },
        demo: { type: 'boolean' },
        'no-audio': { type: 'boolean' },
        loop: { type: 'boolean' },
        bench: { type: 'boolean' },
        version: { type: 'boolean' },
        help: { type: 'boolean' },
      },
    });
    return { ok: true as const, values: parsed.values, positionals: parsed.positionals };
  } catch (err) {
    return { ok: false as const, message: describeParseError(err) };
  }
}

/** Pure parser for REQ-CLI-01 and REQ-CLI-02. Never touches the process. */
export function parseArgs(argv: readonly string[]): ParseResult {
  const tokens = tokenize(argv);
  if (!tokens.ok) return { ok: false, message: tokens.message };
  const { values, positionals } = tokens;

  const mode = pickEnum('--mode', values.mode, MODES, 'halfblock');
  if (!mode.ok) return mode;
  const palette = pickEnum('--palette', values.palette, PALETTES, 'truecolor');
  if (!palette.ok) return palette;
  const color = pickEnum('--color', values.color, COLOR_FLAGS, 'auto');
  if (!color.ok) return color;
  const quality = pickEnum('--quality', values.quality, QUALITIES, 'auto');
  if (!quality.ok) return quality;
  const fps = pickNumber('--fps', values.fps, true, 1, 60);
  if (!fps.ok) return fps;
  const threshold = pickNumber('--threshold', values.threshold, false, 0, 100);
  if (!threshold.ok) return threshold;
  const cellAspect = pickNumber('--cell-aspect', values['cell-aspect'], false, 1, 3);
  if (!cellAspect.ok) return cellAspect;
  const avOffset = pickNumber('--av-offset', values['av-offset'], true, -2000, 2000);
  if (!avOffset.ok) return avOffset;
  const frames = pickNumber('--frames', values.frames, true, 1, 1_000_000_000);
  if (!frames.ok) return frames;
  const size = pickSize(values.size);
  if (!size.ok) return size;

  const help = values.help === true;
  const version = values.version === true;
  const bench = values.bench === true;
  const useDemo = values.demo === true;

  let input: string | null = null;
  let demo: Demo | null = null;

  if (!help && !version) {
    if (frames.value !== null && !bench) {
      return { ok: false, message: '--frames: only valid together with --bench' };
    }
    if (size.value !== null && !bench) {
      return { ok: false, message: '--size: only valid together with --bench' };
    }
    if (values.json === true && !bench) {
      return { ok: false, message: '--json: only valid together with --bench' };
    }
    if (useDemo) {
      if (positionals.length > 1) {
        return { ok: false, message: '--demo: takes at most one name, or use an input instead of --demo' };
      }
      const name = pickEnum('--demo', positionals[0], DEMOS, DEFAULT_DEMO);
      if (!name.ok) return name;
      demo = name.value;
    } else {
      if (positionals.length !== 1) {
        return {
          ok: false,
          message: 'expected exactly one input (file or http(s) URL), or --demo [name]; run frankentty --help',
        };
      }
      input = positionals[0] as string;
    }
  }

  return {
    ok: true,
    options: {
      input,
      demo,
      mode: mode.value,
      palette: palette.value,
      fps: fps.value ?? 30,
      color: color.value,
      threshold: threshold.value,
      cellAspect: cellAspect.value,
      avOffset: avOffset.value ?? 0,
      quality: quality.value,
      noAudio: values['no-audio'] === true,
      loop: values.loop === true,
      bench,
      frames: frames.value,
      size: size.value,
      json: values.json === true,
      version,
      help,
    },
  };
}
