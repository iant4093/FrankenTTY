import xterm from '@xterm/headless';

// @xterm/headless is CommonJS; take the class from the default export so the
// import works under Node's ESM loader and under Vitest.
const { Terminal } = xterm;

export interface ReplayState {
  /** Which buffer the emulator shows after replay: 'normal' or 'alternate'. */
  bufferType: string;
  /** DECRQM answer per mode: 1 = set, 2 = reset, 0 = not recognized. */
  modes: Record<number, number>;
  /** Text of the visible rows, right-trimmed. */
  rows: string[];
}

function write(term: InstanceType<typeof Terminal>, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}

/**
 * Feeds `output` into a real emulator core and reports what it shows, so
 * tests read terminal state instead of mocking it. Modes are read back with
 * DECRQM (`CSI ? Ps $ p`).
 */
export async function replay(
  output: string,
  cols: number,
  rows: number,
  queryModes: readonly number[] = [7, 25, 2026],
): Promise<ReplayState> {
  const term = new Terminal({ cols, rows, allowProposedApi: true });
  try {
    await write(term, output);
    const bufferType = term.buffer.active.type;
    const lines: string[] = [];
    for (let y = 0; y < term.rows; y++) {
      lines.push(term.buffer.active.getLine(y)?.translateToString(true) ?? '');
    }

    const replies: string[] = [];
    const subscription = term.onData((data) => replies.push(data));
    const modes: Record<number, number> = {};
    for (const mode of queryModes) {
      replies.length = 0;
      await write(term, `\x1b[?${mode}$p`);
      const match = new RegExp(`\\x1b\\[\\?${mode};(\\d)\\$y`).exec(replies.join(''));
      modes[mode] = match === null ? 0 : Number(match[1]);
    }
    subscription.dispose();
    return { bufferType, modes, rows: lines };
  } finally {
    term.dispose();
  }
}

export type Emulator = InstanceType<typeof Terminal>;

/**
 * Feeds `output` into a real emulator core and returns the terminal so a test can read its
 * cell buffer. The caller disposes it.
 */
export async function replayInto(output: string | Uint8Array, cols: number, rows: number): Promise<Emulator> {
  const term = new Terminal({ cols, rows, allowProposedApi: true });
  await new Promise<void>((resolve) => {
    if (typeof output === 'string') term.write(output, resolve);
    else term.write(output, resolve);
  });
  return term;
}

export interface CellInfo {
  char: string;
  /** Packed 0xRRGGBB, or null when the foreground is not a 24-bit color. */
  fg: number | null;
  bg: number | null;
}

/** Reads one cell (0-based) from the active buffer. */
export function readCell(term: Emulator, x: number, y: number): CellInfo {
  const cell = term.buffer.active.getLine(y)?.getCell(x);
  if (cell === undefined) return { char: '', fg: null, bg: null };
  return {
    char: cell.getChars(),
    fg: cell.isFgRGB() ? cell.getFgColor() : null,
    bg: cell.isBgRGB() ? cell.getBgColor() : null,
  };
}
