// Where the terminal window sits inside a container. Pure.
import { CELL_H, CELL_W } from './theme.ts';

export const TITLE_BAR_H = 44;
export const WINDOW_MARGIN = 28;

export interface WindowLayout {
  scale: number;
  /** Terminal area size in container pixels at the current terminal size. */
  termW: number;
  termH: number;
  /** Top-left of the whole window (title bar included) in container pixels. */
  left: number;
  top: number;
  windowW: number;
  windowH: number;
}

/**
 * One scale for the whole replay, chosen so the largest terminal size fits `width x (height - band)`.
 * The window is centred horizontally and vertically in that area, for the terminal's current size.
 */
export function computeWindowLayout(args: {
  width: number;
  height: number;
  band: number;
  maxCols: number;
  maxRows: number;
  cols: number;
  rows: number;
  maxScale: number;
}): WindowLayout {
  const availW = args.width - 2 * WINDOW_MARGIN;
  const availH = args.height - args.band - 2 * WINDOW_MARGIN - TITLE_BAR_H;
  const scale = Math.min(args.maxScale, availW / (args.maxCols * CELL_W), availH / (args.maxRows * CELL_H));
  const termW = args.cols * CELL_W * scale;
  const termH = args.rows * CELL_H * scale;
  const windowW = termW;
  const windowH = termH + TITLE_BAR_H;
  return {
    scale,
    termW,
    termH,
    left: (args.width - windowW) / 2,
    top: (args.height - args.band - windowH) / 2,
    windowW,
    windowH,
  };
}

/** Centre of cell (x, y) in container pixels. */
export function cellCenter(layout: WindowLayout, x: number, y: number): { x: number; y: number } {
  return {
    x: layout.left + (x + 0.5) * CELL_W * layout.scale,
    y: layout.top + TITLE_BAR_H + (y + 0.5) * CELL_H * layout.scale,
  };
}
