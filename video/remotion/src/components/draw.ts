// Draws an xterm.js buffer onto a 2D canvas. xterm does all the parsing and holds the state; this only
// paints cells. Block elements and Braille are drawn as exact shapes (fonts leave seams between rows),
// everything else with the bundled monospace font.

import type { IBufferCell, Terminal } from '@xterm/xterm';
import { CELL_FONT_PX, CELL_H, CELL_W, FONT_FAMILY } from '../lib/theme.ts';

export const DEFAULT_FG = 0xd8d8d8;
export const DEFAULT_BG = 0x0a0a0a;

const ANSI16 = [
  0x000000, 0xcd3131, 0x0dbc79, 0xe5e510, 0x2472c8, 0xbc3fbc, 0x11a8cd, 0xe5e5e5, 0x666666, 0xf14c4c, 0x23d18b,
  0xf5f543, 0x3b8eea, 0xd670d6, 0x29b8db, 0xffffff,
];

/** xterm 256-color palette entry as 0xRRGGBB. */
export function paletteColor(index: number): number {
  if (index < 16) return ANSI16[index] ?? 0;
  if (index < 232) {
    const i = index - 16;
    const level = (n: number): number => (n === 0 ? 0 : 55 + n * 40);
    return (level(Math.floor(i / 36)) << 16) | (level(Math.floor(i / 6) % 6) << 8) | level(i % 6);
  }
  const g = 8 + (index - 232) * 10;
  return (g << 16) | (g << 8) | g;
}

export function css(rgb: number): string {
  return `#${rgb.toString(16).padStart(6, '0')}`;
}

export function mix(a: number, b: number, t: number): number {
  const ch = (shift: number): number => {
    const x = (a >> shift) & 255;
    const y = (b >> shift) & 255;
    return Math.round(x + (y - x) * t) & 255;
  };
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

export function cellFg(cell: IBufferCell): number {
  if (cell.isFgRGB()) return cell.getFgColor();
  if (cell.isFgPalette()) return paletteColor(cell.getFgColor());
  return DEFAULT_FG;
}

export function cellBg(cell: IBufferCell): number {
  if (cell.isBgRGB()) return cell.getBgColor();
  if (cell.isBgPalette()) return paletteColor(cell.getBgColor());
  return DEFAULT_BG;
}

// Quadrant block masks, bit 0 = upper left, 1 = upper right, 2 = lower left, 3 = lower right.
const QUADRANTS: Record<number, number> = {
  0x2596: 0b0100,
  0x2597: 0b1000,
  0x2598: 0b0001,
  0x2599: 0b1101,
  0x259a: 0b1001,
  0x259b: 0b0111,
  0x259c: 0b1011,
  0x259d: 0b0010,
  0x259e: 0b0110,
  0x259f: 0b1110,
};

// Braille dot bit -> [column, row] in the 2x4 dot grid.
const BRAILLE_DOTS: [number, number, number][] = [
  [0x01, 0, 0],
  [0x02, 0, 1],
  [0x04, 0, 2],
  [0x40, 0, 3],
  [0x08, 1, 0],
  [0x10, 1, 1],
  [0x20, 1, 2],
  [0x80, 1, 3],
];

function drawShape(ctx: CanvasRenderingContext2D, code: number, px: number, py: number, w: number, h: number, fg: number, bg: number): boolean {
  const half = h / 2;
  if (code === 0x2580) {
    ctx.fillStyle = css(fg);
    ctx.fillRect(px, py, w, half);
    return true;
  }
  if (code >= 0x2581 && code <= 0x2588) {
    const eighths = code - 0x2580;
    const bh = Math.round((h * eighths) / 8);
    ctx.fillStyle = css(fg);
    ctx.fillRect(px, py + h - bh, w, bh);
    return true;
  }
  if (code >= 0x2589 && code <= 0x258f) {
    const bw = Math.round((w * (0x2590 - code)) / 8);
    ctx.fillStyle = css(fg);
    ctx.fillRect(px, py, bw, h);
    return true;
  }
  if (code === 0x2590) {
    ctx.fillStyle = css(fg);
    ctx.fillRect(px + w / 2, py, w / 2, h);
    return true;
  }
  if (code >= 0x2591 && code <= 0x2593) {
    ctx.fillStyle = css(mix(bg, fg, (code - 0x2590) / 4));
    ctx.fillRect(px, py, w, h);
    return true;
  }
  if (code === 0x2594) {
    ctx.fillStyle = css(fg);
    ctx.fillRect(px, py, w, h / 8);
    return true;
  }
  if (code === 0x2595) {
    ctx.fillStyle = css(fg);
    ctx.fillRect(px + w - w / 8, py, w / 8, h);
    return true;
  }
  const q = QUADRANTS[code];
  if (q !== undefined) {
    ctx.fillStyle = css(fg);
    const hw = w / 2;
    if (q & 1) ctx.fillRect(px, py, hw, half);
    if (q & 2) ctx.fillRect(px + hw, py, hw, half);
    if (q & 4) ctx.fillRect(px, py + half, hw, half);
    if (q & 8) ctx.fillRect(px + hw, py + half, hw, half);
    return true;
  }
  if (code >= 0x2800 && code <= 0x28ff) {
    const bits = code - 0x2800;
    ctx.fillStyle = css(fg);
    const r = Math.min(w * 0.2, h * 0.1);
    for (const [bit, dx, dy] of BRAILLE_DOTS) {
      if ((bits & bit) === 0) continue;
      ctx.beginPath();
      ctx.arc(px + w * (0.3 + 0.4 * dx), py + h * (0.125 + 0.25 * dy), r, 0, Math.PI * 2);
      ctx.fill();
    }
    return true;
  }
  return false;
}

/** Paints the whole visible buffer. The canvas is resized to cols x rows cells when needed. */
export function drawTerminal(canvas: HTMLCanvasElement, term: Terminal): void {
  const cols = term.cols;
  const rows = term.rows;
  const w = cols * CELL_W;
  const h = rows * CELL_H;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('2d canvas context unavailable');
  ctx.fillStyle = css(DEFAULT_BG);
  ctx.fillRect(0, 0, w, h);
  ctx.textBaseline = 'alphabetic';
  const buffer = term.buffer.active;
  const cell = buffer.getNullCell();
  let lastFont = '';
  for (let y = 0; y < rows; y++) {
    const line = buffer.getLine(y);
    if (line === undefined) continue;
    const py = y * CELL_H;
    // Backgrounds first, merged into runs.
    let runStart = 0;
    let runColor = -1;
    for (let x = 0; x <= cols; x++) {
      let color = -2;
      if (x < cols) {
        const c = line.getCell(x, cell);
        if (c === undefined) color = DEFAULT_BG;
        else color = c.isInverse() ? cellFg(c) : cellBg(c);
      }
      if (color !== runColor) {
        if (runColor !== -1 && runColor !== DEFAULT_BG) {
          ctx.fillStyle = css(runColor);
          ctx.fillRect(runStart * CELL_W, py, (x - runStart) * CELL_W, CELL_H);
        }
        runStart = x;
        runColor = color;
      }
    }
    // Glyphs.
    for (let x = 0; x < cols; x++) {
      const c = line.getCell(x, cell);
      if (c === undefined || c.getWidth() === 0) continue;
      const chars = c.getChars();
      if (chars === '' || chars === ' ' || c.isInvisible() !== 0) continue;
      const inverse = c.isInverse() !== 0;
      let fg = inverse ? cellBg(c) : cellFg(c);
      const bg = inverse ? cellFg(c) : cellBg(c);
      if (c.isDim() !== 0) fg = mix(fg, bg, 0.5);
      const px = x * CELL_W;
      const cw = c.getWidth() * CELL_W;
      const code = c.getCode();
      if (drawShape(ctx, code, px, py, cw, CELL_H, fg, bg)) continue;
      const font = `${c.isBold() !== 0 ? '700' : '400'} ${String(CELL_FONT_PX)}px ${FONT_FAMILY}`;
      if (font !== lastFont) {
        ctx.font = font;
        lastFont = font;
      }
      ctx.fillStyle = css(fg);
      ctx.fillText(chars, px, py + 18);
      if (c.isUnderline() !== 0) ctx.fillRect(px, py + 21, cw, 1);
    }
  }
}

/** Reads one cell's characters and colors without drawing. */
export function inspectCell(term: Terminal, x: number, y: number): { chars: string; fg: number; bg: number } | null {
  const line = term.buffer.active.getLine(y);
  const c = line?.getCell(x);
  if (c === undefined) return null;
  return { chars: c.getChars(), fg: cellFg(c), bg: cellBg(c) };
}
