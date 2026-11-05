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

// ---------------------------------------------------------------------------
// Byte writers for the per-frame hot path. Everything here is built once at
// module load; the writers allocate nothing.
// ---------------------------------------------------------------------------

/** Upper half block, U+2580: foreground = top pixel, background = bottom pixel. */
export const UPPER_HALF_BLOCK = '\u2580';

export const SYNC_BEGIN_BYTES: Uint8Array = Buffer.from(SYNC_BEGIN);
export const SYNC_END_BYTES: Uint8Array = Buffer.from(SYNC_END);
export const SGR_RESET_BYTES: Uint8Array = Buffer.from(SGR_RESET);
export const UPPER_HALF_BLOCK_BYTES: Uint8Array = Buffer.from(UPPER_HALF_BLOCK);
/** `CSI 38;2;` (7 bytes), followed by `R;G;Bm`. */
export const SGR_FG_RGB_PREFIX: Uint8Array = Buffer.from(CSI + '38;2;');
/** `CSI 48;2;` (7 bytes), followed by `R;G;Bm`. */
export const SGR_BG_RGB_PREFIX: Uint8Array = Buffer.from(CSI + '48;2;');

/** Longest `CSI 38;2;R;G;Bm` or `CSI 48;2;R;G;Bm`: 7 + 3 + 1 + 3 + 1 + 3 + 1 bytes. */
export const SGR_RGB_MAX_BYTES = 19;

// Decimal text of 0..255: DEC_LEN[v] digits, left-aligned in DEC_DIGITS[v*3 .. v*3+2].
const DEC_LEN = new Uint8Array(256);
const DEC_DIGITS = new Uint8Array(256 * 3);
for (let v = 0; v < 256; v++) {
  const text = String(v);
  DEC_LEN[v] = text.length;
  for (let i = 0; i < text.length; i++) DEC_DIGITS[v * 3 + i] = text.charCodeAt(i);
}

/** Copies `bytes` into `buf` at `pos`. Returns the new cursor. */
export function writeBytes(buf: Uint8Array, pos: number, bytes: Uint8Array): number {
  const n = bytes.length;
  for (let i = 0; i < n; i++) buf[pos + i] = bytes[i] ?? 0;
  return pos + n;
}

/** Writes an integer 0..255 as ASCII decimal using the precomputed table. Returns the new cursor. */
export function writeByteDecimal(buf: Uint8Array, pos: number, value: number): number {
  const base = value * 3;
  const n = DEC_LEN[value] ?? 1;
  buf[pos] = DEC_DIGITS[base] ?? 0x30;
  if (n > 1) {
    buf[pos + 1] = DEC_DIGITS[base + 1] ?? 0x30;
    if (n > 2) buf[pos + 2] = DEC_DIGITS[base + 2] ?? 0x30;
  }
  return pos + n;
}

/**
 * Writes `<prefix>R;G;Bm`, where `prefix` is SGR_FG_RGB_PREFIX or SGR_BG_RGB_PREFIX.
 * `r`, `g`, `b` must be integers 0..255. The caller guarantees SGR_RGB_MAX_BYTES of room.
 */
export function writeSgrRgb(
  buf: Uint8Array,
  pos: number,
  prefix: Uint8Array,
  r: number,
  g: number,
  b: number,
): number {
  let p = writeBytes(buf, pos, prefix);
  p = writeByteDecimal(buf, p, r);
  buf[p++] = 0x3b; // ;
  p = writeByteDecimal(buf, p, g);
  buf[p++] = 0x3b; // ;
  p = writeByteDecimal(buf, p, b);
  buf[p++] = 0x6d; // m
  return p;
}
