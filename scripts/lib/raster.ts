// Rasterizes terminal cells to RGB pixels for the README screenshots.
//
// One cell is 8 x 16 pixels (aspect 2:1, close to the 2.016 measured in Apple Terminal).
// Supported glyphs: space, the upper half block, Braille (U+2800..U+28FF) and the ASCII luma ramp
// ` .:-=+*#%@`. The ASCII glyphs are bitmaps drawn here; no font is involved. Any other glyph throws,
// so a screenshot can never silently show a wrong cell.
//
// Pixel data is RGB24 in a Uint8Array. Colors are packed 0xRRGGBB integers.

export const CELL_W = 8;
export const CELL_H = 16;

export const GLYPH_SPACE = 0x20;
export const GLYPH_UPPER_HALF = 0x2580;
export const BRAILLE_BASE = 0x2800;

export interface Raster {
  readonly width: number;
  readonly height: number;
  /** RGB24, row-major, `width * height * 3` bytes. */
  readonly data: Uint8Array;
}

export function createRaster(width: number, height: number, fill = 0x000000): Raster {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new RangeError(`raster size must be positive integers, got ${String(width)}x${String(height)}`);
  }
  const raster: Raster = { width, height, data: new Uint8Array(width * height * 3) };
  fillRect(raster, 0, 0, width, height, fill);
  return raster;
}

export function setPixel(raster: Raster, x: number, y: number, rgb: number): void {
  if (x < 0 || y < 0 || x >= raster.width || y >= raster.height) return;
  const i = (y * raster.width + x) * 3;
  raster.data[i] = (rgb >>> 16) & 0xff;
  raster.data[i + 1] = (rgb >>> 8) & 0xff;
  raster.data[i + 2] = rgb & 0xff;
}

export function getPixel(raster: Raster, x: number, y: number): number {
  const i = (y * raster.width + x) * 3;
  return ((raster.data[i] ?? 0) << 16) | ((raster.data[i + 1] ?? 0) << 8) | (raster.data[i + 2] ?? 0);
}

/** Fills a rectangle, clipped to the raster. */
export function fillRect(raster: Raster, x: number, y: number, w: number, h: number, rgb: number): void {
  const x0 = Math.max(0, x);
  const y0 = Math.max(0, y);
  const x1 = Math.min(raster.width, x + w);
  const y1 = Math.min(raster.height, y + h);
  for (let py = y0; py < y1; py++) {
    for (let px = x0; px < x1; px++) setPixel(raster, px, py, rgb);
  }
}

// ---------------------------------------------------------------------------
// ASCII ramp bitmaps. Each glyph is 16 rows; each row is one byte, bit 7 = leftmost pixel.
// Drawn so that ink grows along the ramp (' ' < '.' < ':' < ... < '@'), like a real font would.
// ---------------------------------------------------------------------------

/** Builds a 16-row bitmap from art rows starting at `top`. '#' is ink; any other character is blank. */
function bitmap(top: number, art: readonly string[]): Uint8Array {
  const rows = new Uint8Array(CELL_H);
  art.forEach((line, i) => {
    let bits = 0;
    for (let x = 0; x < CELL_W; x++) if (line[x] === '#') bits |= 0x80 >> x;
    rows[top + i] = bits;
  });
  return rows;
}

const ASCII_BITMAPS: ReadonlyMap<number, Uint8Array> = new Map<number, Uint8Array>([
  [0x20, bitmap(0, [])],
  [0x2e, bitmap(11, ['...##...', '...##...'])],
  [0x3a, bitmap(5, ['...##...', '...##...', '........', '........', '........', '........', '...##...', '...##...'])],
  [0x2d, bitmap(7, ['.######.', '.######.'])],
  [0x3d, bitmap(5, ['.######.', '.######.', '........', '........', '.######.', '.######.'])],
  [
    0x2b,
    bitmap(3, [
      '...##...', '...##...', '...##...', '...##...',
      '.######.', '.######.',
      '...##...', '...##...', '...##...', '...##...',
    ]),
  ],
  [
    0x2a,
    bitmap(3, [
      '...##...', '.#.##.#.', '..####..', '...##...',
      '.######.', '.######.',
      '...##...', '..####..', '.#.##.#.', '#..##..#', '...##...',
    ]),
  ],
  [
    0x23,
    bitmap(2, [
      '..#..#..', '..#..#..', '..#..#..',
      '########', '########',
      '..#..#..', '..#..#..',
      '########', '########',
      '..#..#..', '..#..#..', '..#..#..',
    ]),
  ],
  [
    0x25,
    bitmap(2, [
      '###...##', '#.#..##.', '###.##..', '...###..', '..###...', '.###.###', '##..#.#.',
      '#..###.#', '..#####.', '.##.###.', '##....#.', '#.....##',
    ]),
  ],
  [
    0x40,
    bitmap(2, [
      '..####..', '.######.', '##....##', '##.####.', '##.#####', '##.##.##', '##.##.##',
      '##.#####', '##.####.', '##......', '.#######', '..#####.',
    ]),
  ],
]);

/** The 16-row, 1-bit bitmap of an ASCII ramp glyph, or undefined for any other code point. */
export function glyphBitmap(codePoint: number): Uint8Array | undefined {
  return ASCII_BITMAPS.get(codePoint);
}

/** Number of ink pixels in a bitmap. */
export function inkCount(rows: Uint8Array): number {
  let n = 0;
  for (const row of rows) {
    for (let b = row; b !== 0; b >>= 1) n += b & 1;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Braille: dot (col, row) in a 2 x 4 grid, per Unicode bit order
// bit 0 = (0,0), 1 = (0,1), 2 = (0,2), 3 = (1,0), 4 = (1,1), 5 = (1,2), 6 = (0,3), 7 = (1,3).
// ---------------------------------------------------------------------------

const BRAILLE_DOT_COL: readonly number[] = [0, 0, 0, 1, 1, 1, 0, 1];
const BRAILLE_DOT_ROW: readonly number[] = [0, 1, 2, 0, 1, 2, 3, 3];
/** A dot is a 3 x 3 square; dot pitch is 4 px in both directions. */
const DOT_SIZE = 3;
const DOT_PITCH_X = 4;
const DOT_PITCH_Y = 4;

/**
 * Draws one cell at cell coordinates (`cellX`, `cellY`): fills the 8 x 16 area with `bg`, then
 * the glyph in `fg`. Throws RangeError for a glyph this module cannot draw.
 */
export function drawCell(raster: Raster, cellX: number, cellY: number, codePoint: number, fg: number, bg: number): void {
  const px = cellX * CELL_W;
  const py = cellY * CELL_H;

  if (codePoint === GLYPH_UPPER_HALF) {
    fillRect(raster, px, py, CELL_W, CELL_H / 2, fg);
    fillRect(raster, px, py + CELL_H / 2, CELL_W, CELL_H / 2, bg);
    return;
  }

  fillRect(raster, px, py, CELL_W, CELL_H, bg);

  if (codePoint >= BRAILLE_BASE && codePoint <= BRAILLE_BASE + 0xff) {
    const bits = codePoint - BRAILLE_BASE;
    for (let bit = 0; bit < 8; bit++) {
      if ((bits & (1 << bit)) === 0) continue;
      const dx = (BRAILLE_DOT_COL[bit] ?? 0) * DOT_PITCH_X;
      const dy = (BRAILLE_DOT_ROW[bit] ?? 0) * DOT_PITCH_Y;
      fillRect(raster, px + dx, py + dy, DOT_SIZE, DOT_SIZE, fg);
    }
    return;
  }

  const rows = glyphBitmap(codePoint);
  if (rows === undefined) {
    throw new RangeError(`cannot rasterize U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`);
  }
  for (let y = 0; y < CELL_H; y++) {
    const row = rows[y] ?? 0;
    for (let x = 0; x < CELL_W; x++) {
      if ((row & (0x80 >> x)) !== 0) setPixel(raster, px + x, py + y, fg);
    }
  }
}

// ---------------------------------------------------------------------------
// Window frame
// ---------------------------------------------------------------------------

export const FRAME_BORDER = 24;
export const FRAME_TITLE_HEIGHT = 28;
export const FRAME_BORDER_COLOR = 0x1e1e1e;
export const FRAME_TITLE_COLOR = 0x2b2b2b;
const TRAFFIC_LIGHTS: readonly number[] = [0xff5f57, 0xfebc2e, 0x28c840];
const LIGHT_RADIUS = 6;
const LIGHT_SPACING = 20;

function fillCircle(raster: Raster, cx: number, cy: number, radius: number, rgb: number): void {
  for (let y = cy - radius; y <= cy + radius; y++) {
    for (let x = cx - radius; x <= cx + radius; x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= radius * radius) setPixel(raster, x, y, rgb);
    }
  }
}

/**
 * Puts `inner` in a terminal-window look: a 28 px title bar with three traffic-light dots on top,
 * and a 24 px dark border on the left, right and bottom. Result size:
 * `inner.width + 48` x `inner.height + 52`.
 */
export function frameWindow(inner: Raster): Raster {
  const width = inner.width + 2 * FRAME_BORDER;
  const height = inner.height + FRAME_TITLE_HEIGHT + FRAME_BORDER;
  const out = createRaster(width, height, FRAME_BORDER_COLOR);
  fillRect(out, 0, 0, width, FRAME_TITLE_HEIGHT, FRAME_TITLE_COLOR);
  TRAFFIC_LIGHTS.forEach((color, i) => {
    fillCircle(out, FRAME_BORDER + LIGHT_RADIUS + i * LIGHT_SPACING, FRAME_TITLE_HEIGHT / 2, LIGHT_RADIUS, color);
  });
  for (let y = 0; y < inner.height; y++) {
    const src = inner.data.subarray(y * inner.width * 3, (y + 1) * inner.width * 3);
    out.data.set(src, ((FRAME_TITLE_HEIGHT + y) * width + FRAME_BORDER) * 3);
  }
  return out;
}
