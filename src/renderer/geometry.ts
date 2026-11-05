// Aspect-ratio fit and letterbox/pillarbox math. Pure: no I/O, no timers.
// REQ-GEO-01, REQ-GEO-02, REQ-TERM-02 (geometry), REQ-PERF-01 step 4 (cell cap).

export interface GeometryInput {
  /** Source width in pixels, integer >= 1. */
  srcWidth: number;
  /** Source height in pixels, integer >= 1. */
  srcHeight: number;
  /** Terminal columns, integer >= 1. */
  cols: number;
  /** Terminal rows, integer >= 1. */
  rows: number;
  /** Rows reserved for the HUD. Default 1 (REQ-GEO-02). */
  hudRows?: number;
  /** Cell height / width, 1.0..3.0. Default 2.0. */
  cellAspect?: number;
  /** Optional cap on renderCols * renderRows, integer >= 1. */
  maxCells?: number;
}

export interface Geometry {
  renderCols: number;
  renderRows: number;
  /** 0-based cell offset of the render area inside the terminal grid. */
  offsetX: number;
  offsetY: number;
  halfblockWidth: number;
  halfblockHeight: number;
  /** Braille base resolution: what the decoder produces (REQ-INGEST-02). */
  decodeWidth: number;
  decodeHeight: number;
  availCols: number;
  availRows: number;
}

export const DEFAULT_CELL_ASPECT = 2.0;
export const DEFAULT_HUD_ROWS = 1;

function requireInt(name: string, value: number, min: number): void {
  if (!Number.isInteger(value) || value < min) {
    throw new RangeError(`${name} must be an integer >= ${min}, got ${value}`);
  }
}

function build(
  c: number,
  r: number,
  availCols: number,
  availRows: number,
): Geometry {
  return {
    renderCols: c,
    renderRows: r,
    offsetX: c === 0 ? 0 : Math.floor((availCols - c) / 2),
    offsetY: r === 0 ? 0 : Math.floor((availRows - r) / 2),
    halfblockWidth: c,
    halfblockHeight: 2 * r,
    decodeWidth: 2 * c,
    decodeHeight: 4 * r,
    availCols,
    availRows,
  };
}

export function computeGeometry(input: GeometryInput): Geometry {
  const { srcWidth, srcHeight, cols, rows } = input;
  const hudRows = input.hudRows ?? DEFAULT_HUD_ROWS;
  const a = input.cellAspect ?? DEFAULT_CELL_ASPECT;
  const maxCells = input.maxCells;

  requireInt('srcWidth', srcWidth, 1);
  requireInt('srcHeight', srcHeight, 1);
  requireInt('cols', cols, 1);
  requireInt('rows', rows, 1);
  requireInt('hudRows', hudRows, 0);
  if (!(a >= 1 && a <= 3)) {
    throw new RangeError(`cellAspect must be within [1, 3], got ${a}`);
  }
  if (maxCells !== undefined) requireInt('maxCells', maxCells, 1);

  const availCols = cols;
  const availRows = Math.max(0, rows - hudRows);
  if (availRows === 0 || availCols === 0) {
    return build(0, 0, availCols, availRows);
  }

  const want = srcWidth / srcHeight;
  const unit = a * want; // columns per row at the source aspect

  let c: number;
  let r: number;
  const widthLimitedRows = Math.round(availCols / unit);
  if (widthLimitedRows < 1) {
    // Very wide source: a single row, full width.
    c = availCols;
    r = 1;
  } else if (widthLimitedRows <= availRows) {
    c = availCols;
    r = widthLimitedRows;
  } else {
    r = availRows;
    c = Math.min(availCols, Math.max(1, Math.round(availRows * unit)));
  }

  if (maxCells !== undefined && c * r > maxCells) {
    const s = Math.sqrt(maxCells / (c * r));
    let c2 = Math.max(1, Math.floor(c * s));
    let r2 = Math.min(availRows, Math.max(1, Math.round(c2 / unit)));
    while (c2 * r2 > maxCells) {
      if (c2 > r2) c2--;
      else r2--;
    }
    c = c2;
    r = r2;
  }

  return build(c, r, availCols, availRows);
}
