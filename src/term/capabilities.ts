import type { ColorFlag } from '../cli/args.ts';
import { CSI_BYTE, ESC_BYTE, PROBE_REQUEST } from '../renderer/sequences.ts';

// ---------------------------------------------------------------------------
// Color depth (REQ-CAP-01)
// ---------------------------------------------------------------------------

export type ColorDepth = 24 | 8 | 4;
export type Env = Readonly<Record<string, string | undefined>>;

interface TruecolorRule {
  /** Short label, used by tests and for reading the table. */
  name: string;
  matches(env: Env, platform: string, osRelease: string): boolean;
}

const TRUECOLOR_TERM_PROGRAMS: ReadonlySet<string> = new Set(['iTerm.app', 'ghostty', 'WezTerm', 'vscode', 'Hyper', 'Tabby']);
const TRUECOLOR_TERMS: ReadonlySet<string> = new Set([
  'xterm-ghostty',
  'xterm-kitty',
  'alacritty',
  'wezterm',
  'foot',
  'foot-extra',
  'contour',
  'xterm-direct',
]);
/** First VTE release with truecolor support (VTE_VERSION 0.36.00). */
const VTE_TRUECOLOR_MIN = 3600;

function isSet(value: string | undefined): value is string {
  return value !== undefined && value !== '';
}

/**
 * Environments that identify a truecolor terminal when COLORTERM is missing.
 * Any matching rule gives 24-bit.
 */
const TRUECOLOR_RULES: readonly TruecolorRule[] = [
  {
    name: 'Apple Terminal on Darwin 25+',
    matches: (env, platform, osRelease) => {
      if (env['TERM_PROGRAM'] !== 'Apple_Terminal' || platform !== 'darwin') return false;
      const major = Number.parseInt(osRelease, 10);
      return Number.isFinite(major) && major >= 25;
    },
  },
  { name: 'WT_SESSION', matches: (env) => isSet(env['WT_SESSION']) },
  { name: 'TERM_PROGRAM', matches: (env) => TRUECOLOR_TERM_PROGRAMS.has(env['TERM_PROGRAM'] ?? '') },
  { name: 'TERM', matches: (env) => TRUECOLOR_TERMS.has(env['TERM'] ?? '') },
  {
    name: 'VTE_VERSION',
    matches: (env) => {
      const v = env['VTE_VERSION'];
      return v !== undefined && /^\d+$/.test(v) && Number.parseInt(v, 10) >= VTE_TRUECOLOR_MIN;
    },
  },
  { name: 'KONSOLE_VERSION', matches: (env) => isSet(env['KONSOLE_VERSION']) },
];

/**
 * True inside tmux or GNU screen. The variables of the outer terminal
 * (TERM_PROGRAM, VTE_VERSION, ...) leak into the session, but the
 * multiplexer may not pass truecolor through to the application.
 */
export function insideMultiplexer(env: Env): boolean {
  const term = env['TERM'] ?? '';
  return isSet(env['TMUX']) || term.startsWith('tmux') || term.startsWith('screen');
}

/**
 * Order: `--color` flag; COLORTERM truecolor/24bit; the truecolor rule table
 * (skipped inside tmux/screen); Node's getColorDepth() mapped to 24, 8 or 4.
 */
export function detectColorDepth(
  env: Env,
  platform: string,
  osRelease: string,
  nodeDepth: number,
  flag: ColorFlag,
): ColorDepth {
  if (flag === 'truecolor') return 24;
  if (flag === '256') return 8;
  if (flag === '16') return 4;

  const colorTerm = (env['COLORTERM'] ?? '').toLowerCase();
  if (colorTerm === 'truecolor' || colorTerm === '24bit') return 24;

  if (!insideMultiplexer(env) && TRUECOLOR_RULES.some((rule) => rule.matches(env, platform, osRelease))) return 24;

  if (nodeDepth >= 24) return 24;
  if (nodeDepth >= 8) return 8;
  return 4;
}

// ---------------------------------------------------------------------------
// Locale (REQ-CAP-03)
// ---------------------------------------------------------------------------

export interface UnicodeSupport {
  unicode: boolean;
  braille: boolean;
}

export function detectUnicode(env: Env, platform: string): UnicodeSupport {
  let unicode: boolean;
  if (platform === 'win32') {
    unicode = true;
  } else {
    const locale = [env['LC_ALL'], env['LC_CTYPE'], env['LANG']].find((v) => v !== undefined && v !== '');
    unicode = locale !== undefined && /utf-?8/i.test(locale);
  }
  return { unicode, braille: unicode && env['TERM'] !== 'linux' };
}

// ---------------------------------------------------------------------------
// Install hints (REQ-PREREQ-01)
// ---------------------------------------------------------------------------

/** `osReleaseText` is the content of /etc/os-release, or null when unreadable. */
export function installCommand(platform: string, osReleaseText: string | null): string {
  if (platform === 'darwin') return 'brew install ffmpeg';
  if (platform === 'win32') return 'winget install Gyan.FFmpeg';
  const ids = (osReleaseText ?? '')
    .split('\n')
    .filter((line) => line.startsWith('ID=') || line.startsWith('ID_LIKE='))
    .map((line) => line.slice(line.indexOf('=') + 1).replace(/["']/g, '').toLowerCase())
    .join(' ');
  if (/\b(arch|manjaro|endeavouros)\b/.test(ids)) return 'sudo pacman -S ffmpeg';
  if (/\b(fedora|rhel|centos|rocky|almalinux)\b/.test(ids)) return 'sudo dnf install ffmpeg';
  return 'sudo apt install ffmpeg';
}

// ---------------------------------------------------------------------------
// Probe reply parser (REQ-CAP-02)
// ---------------------------------------------------------------------------

export type Sync2026 = 'supported' | 'unsupported' | 'unknown';

export interface PixelSize {
  w: number;
  h: number;
}

export interface ProbeResult {
  sync2026: Sync2026;
  cellPx: PixelSize | null;
  windowPx: PixelSize | null;
  /** True once the DA1 reply has been seen. */
  done: boolean;
  /** True if any probe reply arrived. */
  replied: boolean;
  /** Bytes that were not probe replies (for example keys typed during the probe). */
  passthrough: Uint8Array;
}

const MAX_SEQUENCE_BYTES = 64;
const DECRQM_REPLY = /^\?2026;(\d+)\$y$/;
const PIXEL_REPLY = /^([46]);(\d+);(\d+)t$/;
const DA1_REPLY = /^\?[\d;]*c$/;

/**
 * Incremental parser for the replies to PROBE_REQUEST. Replies may be split
 * across chunks and interleaved with other bytes. Never throws.
 */
export class ProbeParser {
  private sync: Sync2026 = 'unknown';
  private cell: PixelSize | null = null;
  private window: PixelSize | null = null;
  private sawDa1 = false;
  private readonly pass: number[] = [];
  /** The escape sequence being read, starting with ESC. Empty when idle. */
  private readonly pending: number[] = [];

  get done(): boolean {
    return this.sawDa1;
  }

  feed(bytes: Uint8Array): void {
    for (const b of bytes) this.step(b);
  }

  result(): ProbeResult {
    const passthrough = new Uint8Array(this.pass.length + this.pending.length);
    passthrough.set(this.pass, 0);
    passthrough.set(this.pending, this.pass.length);
    return {
      sync2026: this.sync,
      cellPx: this.cell === null ? null : { ...this.cell },
      windowPx: this.window === null ? null : { ...this.window },
      done: this.sawDa1,
      replied: this.sawDa1 || this.sync !== 'unknown' || this.cell !== null || this.window !== null,
      passthrough,
    };
  }

  private step(b: number): void {
    const p = this.pending;
    if (p.length === 0) {
      if (b === ESC_BYTE) p.push(b);
      else this.pass.push(b);
      return;
    }
    if (p.length === 1) {
      if (b === CSI_BYTE) {
        p.push(b);
      } else {
        this.flush();
        this.step(b);
      }
      return;
    }
    if (b >= 0x20 && b <= 0x3f && p.length < MAX_SEQUENCE_BYTES) {
      p.push(b);
      return;
    }
    if (b >= 0x40 && b <= 0x7e) {
      p.push(b);
      this.complete();
      return;
    }
    // Not part of a CSI sequence (or too long): give the bytes back.
    this.flush();
    this.step(b);
  }

  private flush(): void {
    for (const b of this.pending) this.pass.push(b);
    this.pending.length = 0;
  }

  private complete(): void {
    const text = String.fromCharCode(...this.pending.slice(2));
    const decrqm = DECRQM_REPLY.exec(text);
    if (decrqm !== null) {
      const ps = Number(decrqm[1]);
      if (ps === 1 || ps === 2 || ps === 3) this.sync = 'supported';
      else if (ps === 0 || ps === 4) this.sync = 'unsupported';
      this.pending.length = 0;
      return;
    }
    const pixels = PIXEL_REPLY.exec(text);
    if (pixels !== null) {
      const h = Number(pixels[2]);
      const w = Number(pixels[3]);
      if (w > 0 && h > 0) {
        if (pixels[1] === '6') this.cell = { w, h };
        else this.window = { w, h };
      }
      this.pending.length = 0;
      return;
    }
    if (DA1_REPLY.test(text)) {
      this.sawDa1 = true;
      this.pending.length = 0;
      return;
    }
    this.flush();
  }
}

// ---------------------------------------------------------------------------
// Probe runner (REQ-CAP-02)
// ---------------------------------------------------------------------------

export interface ProbeInput {
  on(event: 'data', listener: (chunk: Uint8Array | string) => void): unknown;
  removeListener(event: 'data', listener: (chunk: Uint8Array | string) => void): unknown;
  resume(): unknown;
}

export interface ProbeOutput {
  write(data: string): unknown;
  columns?: number | undefined;
  rows?: number | undefined;
}

export type ProbeOutcome = ProbeResult & { cellAspect: number | null };

/** Cell height/width from the cell size, else from the window size and grid. */
export function deriveCellAspect(
  probe: Pick<ProbeResult, 'cellPx' | 'windowPx'>,
  cols: number | undefined,
  rows: number | undefined,
): number | null {
  let aspect: number | null = null;
  if (probe.cellPx !== null) {
    aspect = probe.cellPx.h / probe.cellPx.w;
  } else if (probe.windowPx !== null && cols !== undefined && rows !== undefined && cols > 0 && rows > 0) {
    aspect = probe.windowPx.h / rows / (probe.windowPx.w / cols);
  }
  return aspect !== null && Number.isFinite(aspect) && aspect > 0 ? aspect : null;
}

/**
 * Writes the probe once and reads stdin until the DA1 reply or `timeoutMs`.
 * The data listener is removed before the promise resolves.
 */
export function runProbe(stdin: ProbeInput, stdout: ProbeOutput, timeoutMs = 200): Promise<ProbeOutcome> {
  return new Promise((resolve) => {
    const parser = new ProbeParser();
    let settled = false;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stdin.removeListener('data', onData);
      const result = parser.result();
      resolve({ ...result, cellAspect: deriveCellAspect(result, stdout.columns, stdout.rows) });
    };

    const onData = (chunk: Uint8Array | string): void => {
      parser.feed(typeof chunk === 'string' ? Buffer.from(chunk, 'latin1') : chunk);
      if (parser.done) finish();
    };

    // Declared last, but finish() only runs from a stdin event or this timer,
    // both of which fire after the declaration.
    const timer = setTimeout(finish, timeoutMs);
    stdin.on('data', onData);
    stdin.resume();
    stdout.write(PROBE_REQUEST);
  });
}

// ---------------------------------------------------------------------------
// Summary shown by the placeholder screen
// ---------------------------------------------------------------------------

export type CellAspectSource = 'flag' | 'probe' | 'default';

export interface ResolvedCellAspect {
  value: number;
  source: CellAspectSource;
}

/** REQ-GEO-01: `--cell-aspect`, else the probe, else 2.0. */
export function resolveCellAspect(flag: number | null, probe: number | null): ResolvedCellAspect {
  if (flag !== null) return { value: flag, source: 'flag' };
  if (probe !== null) return { value: probe, source: 'probe' };
  return { value: 2, source: 'default' };
}

export interface Capabilities {
  colorDepth: ColorDepth;
  sync2026: Sync2026;
  cellAspect: ResolvedCellAspect;
  unicode: boolean;
  braille: boolean;
  cols: number;
  rows: number;
}

export function describeCapabilities(caps: Capabilities): string[] {
  const depth = caps.colorDepth === 24 ? '24-bit' : caps.colorDepth === 8 ? '256 colors' : '16 colors';
  return [
    `color: ${depth}`,
    `sync2026: ${caps.sync2026}`,
    `cell aspect: ${caps.cellAspect.value.toFixed(2)} (${caps.cellAspect.source})`,
    `unicode: ${caps.unicode ? 'yes' : 'no'}, braille: ${caps.braille ? 'yes' : 'no'}`,
    `size: ${caps.cols}x${caps.rows}`,
  ];
}
