// Session file format (written by task 6.A) and the "state at time t" math. Pure functions.

export interface SessionEvent {
  t: number;
  keys: string;
  label: string;
  /** Optional extension: terminal resize at time t (same key as tests/helpers/pty_run.py). */
  resize?: [number, number];
}

export interface SessionChunk {
  t: number;
  b64: string;
}

export interface Session {
  version: number;
  cols: number;
  rows: number;
  fps: number;
  durationSec: number;
  title: string;
  command: string[];
  env: Record<string, string>;
  events: SessionEvent[];
  chunks: SessionChunk[];
  /** Set on fixtures written by this project; real recordings never carry it. */
  fixture?: boolean;
}

export type TimelineOp =
  | { t: number; kind: 'chunk'; index: number }
  | { t: number; kind: 'resize'; cols: number; rows: number };

export function validateSession(value: unknown): Session {
  if (typeof value !== 'object' || value === null) throw new TypeError('session: not an object');
  const s = value as Record<string, unknown>;
  const num = (k: string): number => {
    const v = s[k];
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new TypeError(`session.${k}: expected a number`);
    return v;
  };
  if (s['version'] !== 1) throw new TypeError('session.version: expected 1');
  if (!Array.isArray(s['chunks'])) throw new TypeError('session.chunks: expected an array');
  if (!Array.isArray(s['events'])) throw new TypeError('session.events: expected an array');
  num('cols');
  num('rows');
  num('durationSec');
  let last = -Infinity;
  for (const c of s['chunks'] as { t?: unknown; b64?: unknown }[]) {
    if (typeof c.t !== 'number' || typeof c.b64 !== 'string') throw new TypeError('session.chunks[]: expected {t, b64}');
    if (c.t < last) throw new TypeError('session.chunks[]: times must not decrease');
    last = c.t;
  }
  return value as Session;
}

/** Number of items whose time is <= t, for a list sorted by time (binary search). */
export function countAtOrBefore(items: readonly { t: number }[], t: number): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((items[mid]?.t ?? Infinity) <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** How many of the session's chunks have been delivered by time t (chunk time <= t). */
export function chunkCountAt(chunks: readonly { t: number }[], t: number): number {
  return countAtOrBefore(chunks, t);
}

/** Resize extracted from an event: the `resize` field, or a label like "resize 160x45" on a key-less event. */
export function eventResize(e: SessionEvent): [number, number] | null {
  if (e.resize !== undefined) return e.resize;
  if (e.keys === '') {
    const m = /^\s*resize\b[^\d]*(\d+)\s*[x×]\s*(\d+)/i.exec(e.label);
    if (m !== null) return [Number(m[1]), Number(m[2])];
  }
  return null;
}

/** Chunks and resizes merged in time order; a resize at the same time as a chunk comes first. */
export function buildOps(session: Session): TimelineOp[] {
  const ops: TimelineOp[] = [];
  for (const e of session.events) {
    const r = eventResize(e);
    if (r !== null) ops.push({ t: e.t, kind: 'resize', cols: r[0], rows: r[1] });
  }
  ops.sort((a, b) => a.t - b.t);
  const out: TimelineOp[] = [];
  let ri = 0;
  session.chunks.forEach((c, index) => {
    while (ri < ops.length && (ops[ri]?.t ?? Infinity) <= c.t) {
      const r = ops[ri];
      if (r !== undefined) out.push(r);
      ri++;
    }
    out.push({ t: c.t, kind: 'chunk', index });
  });
  while (ri < ops.length) {
    const r = ops[ri];
    if (r !== undefined) out.push(r);
    ri++;
  }
  return out;
}

/** Terminal size at time t: the session size, changed by every resize event with time <= t. */
export function sizeAt(session: Session, t: number): { cols: number; rows: number } {
  let cols = session.cols;
  let rows = session.rows;
  const resizes = session.events
    .map((e) => ({ t: e.t, r: eventResize(e) }))
    .filter((x): x is { t: number; r: [number, number] } => x.r !== null)
    .sort((a, b) => a.t - b.t);
  for (const x of resizes) {
    if (x.t > t) break;
    cols = x.r[0];
    rows = x.r[1];
  }
  return { cols, rows };
}

/** Largest size the terminal ever has (used to pick one window scale for the whole replay). */
export function maxSize(session: Session): { cols: number; rows: number } {
  let cols = session.cols;
  let rows = session.rows;
  for (const e of session.events) {
    const r = eventResize(e);
    if (r !== null) {
      cols = Math.max(cols, r[0]);
      rows = Math.max(rows, r[1]);
    }
  }
  return { cols, rows };
}

const KEY_NAMES: Record<string, string> = {
  ' ': 'Space',
  '\u001b': 'Esc',
  '\u0003': 'Ctrl+C',
  '\r': 'Enter',
  '\u001b[C': '→',
  '\u001b[D': '←',
  '\u001b[A': '↑',
  '\u001b[B': '↓',
  '\u001b[1;2C': '⇧→',
  '\u001b[1;2D': '⇧←',
  '\u001b[1;2A': '⇧↑',
  '\u001b[1;2B': '⇧↓',
};

/** Text for a keycap badge: "m", "→", "Space", "⇧←". Empty string for key-less events. */
export function keyCapText(keys: string): string {
  if (keys === '') return '';
  return KEY_NAMES[keys] ?? keys;
}

export interface Badge {
  /** Seconds since spawn. */
  t: number;
  /** Keycap text; empty for events without keys (a resize). */
  cap: string;
  label: string;
  /** How many earlier badges had the same keycap (first press 0, second press 1, ...). */
  index: number;
}

/** One badge per key event, plus one label-only badge per resize, in time order. */
export function badgesOf(session: Session): Badge[] {
  const sorted = session.events
    .filter((e) => e.keys !== '' || eventResize(e) !== null)
    .map((e) => ({ t: e.t, cap: keyCapText(e.keys), label: e.label }))
    .sort((a, b) => a.t - b.t);
  const seen = new Map<string, number>();
  return sorted.map((b) => {
    const index = seen.get(b.cap) ?? 0;
    seen.set(b.cap, index + 1);
    return { ...b, index };
  });
}
