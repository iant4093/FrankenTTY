import { writeSync } from 'node:fs';
import {
  ALT_ON,
  AUTOWRAP_OFF,
  CLEAR,
  CURSOR_HIDE,
  RESTORE_SEQUENCE,
  cursorPosition,
} from '../renderer/sequences.ts';

export interface ScreenOutput {
  /** When present, teardown writes use fs.writeSync on this descriptor. */
  fd?: number | undefined;
  write(data: string): unknown;
}

export interface ScreenInput {
  setRawMode?: ((mode: boolean) => unknown) | undefined;
}

export interface Screen {
  /** True between enter() and restore(). */
  readonly isActive: boolean;
  /** Alt screen, hidden cursor, autowrap off, cleared, raw stdin. */
  enter(): void;
  /** Idempotent. Restores the terminal in the required order, then runs cleanups once. */
  restore(): void;
  /** Registers a callback (for example killing a child process) run once by restore(). */
  addCleanup(fn: () => void): void;
}

/** Synchronous write, safe in exit paths. Falls back to stream.write without an fd. */
function writeNow(out: ScreenOutput, data: string): void {
  if (typeof out.fd !== 'number') {
    out.write(data);
    return;
  }
  const bytes = Buffer.from(data);
  let offset = 0;
  let retries = 0;
  while (offset < bytes.length) {
    try {
      offset += writeSync(out.fd, bytes, offset);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EAGAIN' && retries++ < 1000) continue;
      return; // terminal gone (EPIPE, EIO): nothing more to do
    }
  }
}

export function createScreen(stdout: ScreenOutput, stdin: ScreenInput): Screen {
  let state: 'idle' | 'active' | 'restored' = 'idle';
  const cleanups: (() => void)[] = [];

  const runCleanup = (fn: () => void): void => {
    try {
      fn();
    } catch {
      // A failing cleanup must not stop the others.
    }
  };

  return {
    get isActive(): boolean {
      return state === 'active';
    },

    enter(): void {
      if (state !== 'idle') return;
      state = 'active';
      writeNow(stdout, ALT_ON + CURSOR_HIDE + AUTOWRAP_OFF + CLEAR);
      stdin.setRawMode?.(true);
    },

    restore(): void {
      if (state === 'restored') return;
      const wasActive = state === 'active';
      state = 'restored';
      if (wasActive) {
        writeNow(stdout, RESTORE_SEQUENCE);
        try {
          stdin.setRawMode?.(false);
        } catch {
          // stdin already closed
        }
      }
      for (const fn of cleanups.splice(0)) runCleanup(fn);
    },

    addCleanup(fn: () => void): void {
      if (state === 'restored') runCleanup(fn);
      else cleanups.push(fn);
    },
  };
}

/** Clears the screen and writes `lines` centered, one per row. */
export function drawCentered(out: ScreenOutput, lines: readonly string[], cols: number, rows: number): void {
  let text = CLEAR;
  const top = Math.max(1, Math.floor((rows - lines.length) / 2) + 1);
  lines.forEach((line, i) => {
    const col = Math.max(1, Math.floor((cols - line.length) / 2) + 1);
    text += cursorPosition(top + i, col) + line;
  });
  writeNow(out, text);
}

export type TrapHost = Pick<NodeJS.Process, 'platform' | 'on' | 'removeListener' | 'exit' | 'stderr'>;

type Listener = (...args: unknown[]) => void;

function describeError(err: unknown): string {
  if (err instanceof Error) return err.stack ?? err.message;
  return String(err);
}

/**
 * Restores the terminal on every exit path (REQ-TERM-03). Returns a function
 * that removes the handlers again.
 */
export function installExitTraps(screen: Screen, host: TrapHost = process): () => void {
  const installed: [string, Listener][] = [];
  const add = (event: string, listener: Listener): void => {
    host.on(event, listener);
    installed.push([event, listener]);
  };

  const onSignal = (code: number): Listener => () => {
    screen.restore();
    host.exit(code);
  };
  add('SIGINT', onSignal(130));
  add('SIGTERM', onSignal(143));
  add('SIGHUP', onSignal(129));
  if (host.platform === 'win32') add('SIGBREAK', onSignal(149));

  const onFatal: Listener = (err) => {
    screen.restore();
    host.stderr.write(`frankentty: ${describeError(err)}\n`);
    host.exit(1);
  };
  add('uncaughtException', onFatal);
  add('unhandledRejection', onFatal);

  add('exit', () => {
    screen.restore();
  });

  return () => {
    for (const [event, listener] of installed.splice(0)) host.removeListener(event, listener);
  };
}
