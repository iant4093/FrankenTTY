// Replays a recorded session into a real @xterm/xterm Terminal, deterministically.
// "State at time t" = state after every chunk with chunk.t <= t and every resize with time <= t.
// Frames can arrive out of order across workers: asking for an earlier time resets the terminal and
// replays from zero. In-order requests only write the new chunks.

import { Terminal } from '@xterm/xterm';
import { buildOps, countAtOrBefore, validateSession } from '../lib/session.ts';
import type { Session, TimelineOp } from '../lib/session.ts';

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export class ReplayEngine {
  readonly session: Session;
  readonly term: Terminal;
  private readonly ops: TimelineOp[];
  private applied = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(session: Session) {
    this.session = session;
    this.ops = buildOps(session);
    this.term = new Terminal({
      cols: session.cols,
      rows: session.rows,
      scrollback: 0,
      allowProposedApi: true,
      convertEol: false,
    });
  }

  get cols(): number {
    return this.term.cols;
  }

  get rows(): number {
    return this.term.rows;
  }

  /** Brings the terminal to the state at `tSec`. Calls are serialized. */
  advanceTo(tSec: number): Promise<void> {
    const run = this.queue.then(() => this.advance(tSec));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async advance(tSec: number): Promise<void> {
    const target = countAtOrBefore(this.ops, tSec);
    if (target < this.applied) {
      this.term.reset();
      this.term.resize(this.session.cols, this.session.rows);
      this.applied = 0;
    }
    while (this.applied < target) {
      const op = this.ops[this.applied];
      if (op === undefined) break;
      if (op.kind === 'resize') {
        this.term.resize(op.cols, op.rows);
        this.applied++;
        continue;
      }
      // Coalesce consecutive chunks into one write.
      let end = this.applied;
      let size = 0;
      const parts: Uint8Array[] = [];
      while (end < target) {
        const next = this.ops[end];
        if (next === undefined || next.kind !== 'chunk') break;
        const bytes = decodeBase64(this.session.chunks[next.index]?.b64 ?? '');
        parts.push(bytes);
        size += bytes.length;
        end++;
      }
      const joined = new Uint8Array(size);
      let at = 0;
      for (const p of parts) {
        joined.set(p, at);
        at += p.length;
      }
      await new Promise<void>((resolve) => this.term.write(joined, resolve));
      this.applied = end;
    }
  }

  dispose(): void {
    this.term.dispose();
  }
}

const sessionCache = new Map<string, Promise<Session>>();

/** Loads public/sessions/<name>.json once per page. */
export function loadSession(url: string): Promise<Session> {
  let p = sessionCache.get(url);
  if (p === undefined) {
    p = fetch(url).then(async (r) => {
      if (!r.ok) throw new Error(`cannot load ${url}: HTTP ${String(r.status)}`);
      return validateSession(await r.json());
    });
    sessionCache.set(url, p);
  }
  return p;
}

const engineCache = new Map<string, ReplayEngine>();

/** One engine per key (session name plus a purpose tag) for the lifetime of the page. */
export function getEngine(key: string, session: Session): ReplayEngine {
  let e = engineCache.get(key);
  if (e === undefined || e.session !== session) {
    e?.dispose();
    e = new ReplayEngine(session);
    engineCache.set(key, e);
  }
  return e;
}
