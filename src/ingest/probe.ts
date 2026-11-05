// ffprobe wrapper (REQ-INGEST-01). `parseProbeJson` is pure; `probe` owns the child process.

import { spawn } from 'node:child_process';
import type { MediaInfo, MediaSource } from './media-info.ts';

export class ProbeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProbeError';
  }
}

export interface ProbeOptions {
  /** Kill ffprobe and reject after this many ms. Default 5000. */
  timeoutMs?: number;
  /** Executable to spawn. Default `ffprobe`. */
  ffprobePath?: string;
}

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 5000;

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function toNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') return Number(v);
  return NaN;
}

/** Parses "n/d" or "n:d" into a positive ratio, or null for missing, malformed, zero or negative values. */
function parseRatio(v: unknown, sep: '/' | ':'): number | null {
  if (typeof v !== 'string') return null;
  const parts = v.split(sep);
  if (parts.length !== 2) return null;
  const n = Number(parts[0]);
  const d = Number(parts[1]);
  if (!Number.isFinite(n) || !Number.isFinite(d) || n <= 0 || d <= 0) return null;
  return n / d;
}

function streamsOf(json: Json): Json[] {
  const streams = json['streams'];
  return Array.isArray(streams) ? streams.filter(isObject) : [];
}

function isAttachedPicture(stream: Json): boolean {
  const disposition = stream['disposition'];
  return isObject(disposition) && disposition['attached_pic'] === 1;
}

/** True when the stream is rotated by 90 or 270 degrees (side data or the legacy `rotate` tag). */
function isQuarterTurn(stream: Json): boolean {
  const angles: number[] = [];
  const sideData = stream['side_data_list'];
  if (Array.isArray(sideData)) {
    for (const entry of sideData) {
      if (isObject(entry) && 'rotation' in entry) angles.push(toNumber(entry['rotation']));
    }
  }
  const tags = stream['tags'];
  if (isObject(tags) && 'rotate' in tags) angles.push(toNumber(tags['rotate']));
  for (const angle of angles) {
    if (!Number.isFinite(angle)) continue;
    const mod = ((Math.round(angle) % 180) + 180) % 180;
    if (mod === 90) return true;
  }
  return false;
}

function parseFps(stream: Json): number {
  for (const key of ['avg_frame_rate', 'r_frame_rate']) {
    const fps = parseRatio(stream[key], '/');
    if (fps !== null) return fps;
  }
  throw new ProbeError('video stream has no usable frame rate');
}

function parseDuration(json: Json, stream: Json): number | null {
  const format = json['format'];
  const candidates = [isObject(format) ? format['duration'] : undefined, stream['duration']];
  for (const c of candidates) {
    const d = toNumber(c);
    if (Number.isFinite(d) && d >= 0) return d;
  }
  return null;
}

/** Converts `ffprobe -print_format json -show_streams -show_format` output into MediaInfo. */
export function parseProbeJson(json: unknown, source: MediaSource): MediaInfo {
  if (!isObject(json)) throw new ProbeError('ffprobe returned unexpected output');
  const streams = streamsOf(json);
  const video = streams.find((s) => s['codec_type'] === 'video' && !isAttachedPicture(s));
  if (video === undefined) throw new ProbeError('no video stream found');

  const codedWidth = toNumber(video['width']);
  const codedHeight = toNumber(video['height']);
  if (
    !Number.isInteger(codedWidth) ||
    !Number.isInteger(codedHeight) ||
    codedWidth <= 0 ||
    codedHeight <= 0
  ) {
    throw new ProbeError('video stream has invalid dimensions');
  }

  const sar = parseRatio(video['sample_aspect_ratio'], ':') ?? 1;
  let width = Math.round(codedWidth * sar);
  let height = codedHeight;
  if (isQuarterTurn(video)) [width, height] = [height, width];
  if (width < 1 || height < 1) throw new ProbeError('video stream has invalid dimensions');

  return {
    width,
    height,
    fps: parseFps(video),
    durationSec: parseDuration(json, video),
    hasAudio: streams.some((s) => s['codec_type'] === 'audio'),
    source,
  };
}

/** Classifies an input. Throws for URL schemes other than http(s) (no live streams). */
export function classifyInput(input: string): 'file' | 'url' {
  const m = /^([a-z][a-z0-9+.-]*):\/\//i.exec(input);
  if (m === null) return 'file';
  const scheme = (m[1] ?? '').toLowerCase();
  if (scheme === 'http' || scheme === 'https') return 'url';
  throw new ProbeError('live and non-http streams are not supported');
}

function formatSeconds(ms: number): string {
  return String(Math.round(ms) / 1000);
}

export async function probe(input: string, opts: ProbeOptions = {}): Promise<MediaInfo> {
  const source = classifyInput(input);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ffprobePath = opts.ffprobePath ?? 'ffprobe';
  // `-i` keeps an input that starts with "-" from being read as an option.
  const argv = [
    '-v', 'error',
    '-print_format', 'json',
    '-show_streams',
    '-show_format',
    '-i', input,
  ];

  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn(ffprobePath, argv, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const out: Buffer[] = [];
    let outBytes = 0;
    let stderrTail = '';
    let settled = false;

    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      settle(() => reject(new ProbeError(`ffprobe timed out after ${formatSeconds(timeoutMs)} s`)));
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      outBytes += chunk.length;
      if (outBytes > MAX_OUTPUT_BYTES) {
        child.kill('SIGKILL');
        settle(() => reject(new ProbeError('ffprobe output is too large')));
        return;
      }
      out.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-1024);
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      const msg = err.code === 'ENOENT' ? `${ffprobePath} not found` : `cannot run ${ffprobePath}: ${err.message}`;
      settle(() => reject(new ProbeError(msg)));
    });
    child.on('close', (code) => {
      settle(() => {
        if (code === 0) {
          resolve(Buffer.concat(out).toString('utf8'));
          return;
        }
        const lines = stderrTail.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '');
        const last = lines[lines.length - 1];
        reject(new ProbeError(last ?? `ffprobe exited with code ${String(code)}`));
      });
    });
  });

  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    throw new ProbeError('ffprobe returned unreadable output');
  }
  return parseProbeJson(json, source);
}
