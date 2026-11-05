// All escape sequences used by FrankenTTY live here. No other module in src/
// may contain a raw ESC literal.

/** ESC byte, for parsers that work on raw bytes. */
export const ESC_BYTE = 0x1b;
/** `[` byte, the second byte of CSI. */
export const CSI_BYTE = 0x5b;

const ESC = '\x1b';
const CSI = ESC + '[';

// Screen lifecycle
export const ALT_ON = CSI + '?1049h';
export const ALT_OFF = CSI + '?1049l';
export const CURSOR_HIDE = CSI + '?25l';
export const CURSOR_SHOW = CSI + '?25h';
export const AUTOWRAP_OFF = CSI + '?7l';
export const AUTOWRAP_ON = CSI + '?7h';

// Frame framing (synchronized output, mode 2026)
export const SYNC_BEGIN = CSI + '?2026h';
export const SYNC_END = CSI + '?2026l';

// Attributes and screen clearing
export const SGR_RESET = CSI + '0m';
export const CLEAR = CSI + '2J' + CSI + 'H';

/**
 * Teardown, in the required order: sync off, SGR reset, autowrap on,
 * cursor show, alt screen off. Raw mode is disabled afterwards by the caller.
 */
export const RESTORE_SEQUENCE = SYNC_END + SGR_RESET + AUTOWRAP_ON + CURSOR_SHOW + ALT_OFF;

// Capability probe (REQ-CAP-02): DECRQM 2026, cell size, window size, DA1.
export const PROBE_DECRQM_2026 = CSI + '?2026$p';
export const PROBE_CELL_SIZE = CSI + '16t';
export const PROBE_WINDOW_SIZE = CSI + '14t';
export const PROBE_DA1 = CSI + 'c';
export const PROBE_REQUEST = PROBE_DECRQM_2026 + PROBE_CELL_SIZE + PROBE_WINDOW_SIZE + PROBE_DA1;

/** `CSI row ; col H` (1-based) as a string. For non-hot paths. */
export function cursorPosition(row: number, col: number): string {
  return CSI + String(row) + ';' + String(col) + 'H';
}

/**
 * Writes a non-negative integer (at most 9 digits) as ASCII decimal at `pos`.
 * Returns the new cursor. Does not allocate.
 */
export function writeDecimal(buf: Uint8Array, pos: number, value: number): number {
  let digits = 1;
  for (let probe = 10; digits < 9 && value >= probe; probe *= 10) digits++;
  let rest = value;
  for (let i = pos + digits - 1; i >= pos; i--) {
    const next = Math.floor(rest / 10);
    buf[i] = 0x30 + (rest - next * 10);
    rest = next;
  }
  return pos + digits;
}

/**
 * Writes `CSI row ; col H` (1-based) into `buf` at `pos` and returns the new
 * cursor. Does not allocate. The caller guarantees room for 24 bytes.
 */
export function writeCursorPosition(buf: Uint8Array, pos: number, row: number, col: number): number {
  let p = pos;
  buf[p++] = ESC_BYTE;
  buf[p++] = CSI_BYTE;
  p = writeDecimal(buf, p, row);
  buf[p++] = 0x3b; // ;
  p = writeDecimal(buf, p, col);
  buf[p++] = 0x48; // H
  return p;
}
