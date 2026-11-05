// Telemetry row (REQ-HUD-01, REQ-GEO-02). Pure: writes bytes into a caller
// buffer and allocates nothing per call.
//
// Column accounting. Every glyph the HUD writes counts as exactly one terminal
// column. That holds for the ASCII text and for the four symbols the layout
// uses (U+25B6 ▶, U+23F8 ⏸, U+2190 ←, U+2192 →), which are not East Asian
// Wide in Unicode's EastAsianWidth data. The one other non-ASCII glyph allowed
// in a caller message is U+00BB (»), also single column for Western locales.
// Any other character in a message is replaced by `?`, so the row is always
// exactly `cols` columns and never wraps.

import type { Mode, Palette } from '../cli/args.ts';
import {
  HUD_STYLE_MAX_BYTES,
  writeCursorPosition,
  writeDecimal,
  writeEraseLine,
  writeGlyph,
  writeHudStyle,
  writeSgrReset,
} from '../renderer/sequences.ts';

export interface HudState {
  visible: boolean;
  playing: boolean;
  positionSec: number;
  durationSec: number | null;
  fps: number;
  kbPerSec: number;
  sgrSavedPct: number;
  qualityStep: number;
  colorLabel: '24-bit' | '256' | '16';
  mode: Mode;
  palette: Palette;
  /** When set, replaces everything after the time. The caller decides the text. */
  message: string | null;
}

export interface Hud {
  /**
   * Writes the HUD row at `offset` in `out` using `CUP(row, 1)`. Returns the new offset.
   * The caller guarantees `capacity` bytes of room.
   */
  render(state: HudState, out: Uint8Array, offset: number, row: number): number;
  /** Upper bound of bytes one render() call writes. */
  readonly capacity: number;
}

const CP_PLAY = 0x25b6; // ▶
const CP_PAUSE = 0x23f8; // ⏸
const CP_LEFT = 0x2190; // ←
const CP_RIGHT = 0x2192; // →
const CP_GUILLEMET = 0xbb; // »

const MAX_DIGITS_VALUE = 999_999_999;
/** Largest value for positions and durations, in seconds. */
const MAX_SECONDS = MAX_DIGITS_VALUE;

/** Fixed bytes around the text: CUP (24) + style (10) + reset (10) + slack. */
const FRAME_BYTES = 24 + HUD_STYLE_MAX_BYTES + HUD_STYLE_MAX_BYTES + 20;
const MAX_GLYPH_BYTES = 3;
const EMPTY: Uint8Array = new Uint8Array(0);

function clampInt(value: number, min: number, max: number): number {
  if (!(value >= min)) return min; // also catches NaN
  if (value > max) return max;
  return Math.round(value);
}

export function createHud(cols: number): Hud {
  const width = Number.isFinite(cols) && cols >= 1 ? Math.min(Math.floor(cols), 10_000) : 1;
  const capacity = width * MAX_GLYPH_BYTES + FRAME_BYTES;

  // Per-call cursor state, shared by the helpers below. Single-threaded, so no re-entrancy.
  let buf: Uint8Array = EMPTY;
  let pos = 0;
  let col = 0;
  const digits = new Uint8Array(12);

  function putCode(cp: number): void {
    if (col >= width) return;
    pos = writeGlyph(buf, pos, cp);
    col++;
  }

  /** Message-safe text: printable ASCII and the allowed symbols; anything else becomes `?`. */
  function putText(text: string): void {
    for (let i = 0; i < text.length && col < width; i++) {
      const code = text.charCodeAt(i);
      if (
        (code >= 0x20 && code <= 0x7e) ||
        code === CP_GUILLEMET ||
        code === CP_LEFT ||
        code === CP_RIGHT ||
        code === CP_PLAY ||
        code === CP_PAUSE
      ) {
        putCode(code);
      } else {
        putCode(0x3f);
      }
    }
  }

  function putInt(value: number): void {
    const end = writeDecimal(digits, 0, value);
    for (let i = 0; i < end; i++) putCode(digits[i] ?? 0x30);
  }

  function putTwoDigits(value: number): void {
    putCode(0x30 + Math.floor(value / 10));
    putCode(0x30 + (value % 10));
  }

  function putTime(seconds: number | null): void {
    if (seconds === null) {
      putText('--:--');
      return;
    }
    const total = clampInt(Math.floor(seconds), 0, MAX_SECONDS);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    if (hours > 0) {
      putInt(hours);
      putCode(0x3a);
      putTwoDigits(minutes);
    } else {
      putInt(minutes);
    }
    putCode(0x3a);
    putTwoDigits(secs);
  }

  function render(state: HudState, out: Uint8Array, offset: number, row: number): number {
    buf = out;
    pos = offset;
    col = 0;
    const cupRow = Number.isFinite(row) && row >= 1 ? Math.floor(row) : 1;
    pos = writeCursorPosition(buf, pos, Math.min(cupRow, MAX_DIGITS_VALUE), 1);

    if (!state.visible) {
      pos = writeSgrReset(buf, pos);
      pos = writeEraseLine(buf, pos);
      const hiddenEnd = pos;
      buf = EMPTY;
      return hiddenEnd;
    }

    pos = writeHudStyle(buf, pos);

    putCode(state.playing ? CP_PLAY : CP_PAUSE);
    putCode(0x20);
    putTime(state.positionSec);
    putText(' / ');
    putTime(state.durationSec);
    putText('  ');

    if (state.message !== null) {
      putText(state.message);
    } else {
      const fpsTenths = clampInt(state.fps * 10, 0, 99_999);
      putInt(Math.floor(fpsTenths / 10));
      putCode(0x2e);
      putCode(0x30 + (fpsTenths % 10));
      putText(' fps  ');
      putInt(clampInt(state.kbPerSec, 0, MAX_DIGITS_VALUE));
      putText(' KB/s  -');
      putInt(clampInt(state.sgrSavedPct, 0, 100));
      putText('% SGR  Q');
      putInt(clampInt(state.qualityStep, 0, 99));
      putCode(0x20);
      putText(state.colorLabel);
      putText('  ');
      putText(state.mode);
      putCode(0x20);
      putText(state.palette);
      putText('  space ');
      putCode(CP_LEFT);
      putText('/');
      putCode(CP_RIGHT);
      putText(' m c i q');
    }

    while (col < width) putCode(0x20);

    pos = writeSgrReset(buf, pos);
    const end = pos;
    buf = EMPTY; // do not keep the caller's buffer alive between calls
    return end;
  }

  return { render, capacity };
}
