import { describe, expect, it } from 'vitest';
import type { CellGrid, ColorMapper } from '../../src/renderer/cells.ts';
import { GLYPH_SPACE, GLYPH_UPPER_HALF, createCellGrid, packRgb } from '../../src/renderer/cells.ts';
import { createEncoder } from '../../src/renderer/encoder.ts';
import { createHalfblockSerializer } from '../../src/renderer/halfblock.ts';
import { SGR_RESET, SYNC_BEGIN, SYNC_END, cursorPosition } from '../../src/renderer/sequences.ts';
import { IDENTITY_MAPPER, STUB_MAPPER_16, STUB_MAPPER_256 } from '../helpers/mappers.ts';

const CSI = '\x1b[';
const BLOCK = '\u2580';
const BEGIN = SYNC_BEGIN;
const END = SGR_RESET + SYNC_END;

const RED = packRgb(255, 0, 0);
const GREEN = packRgb(0, 255, 0);
const BLUE = packRgb(0, 0, 255);
const WHITE = packRgb(255, 255, 255);

function rgbText(c: number): string {
  return `${String((c >>> 16) & 255)};${String((c >>> 8) & 255)};${String(c & 255)}`;
}

function setCell(grid: CellGrid, i: number, glyph: number, fg: number, bg: number): void {
  grid.glyph[i] = glyph;
  grid.fg[i] = fg;
  grid.bg[i] = bg;
}

function gridOf(cells: readonly (readonly [number, number, number])[], cols = cells.length): CellGrid {
  const grid = createCellGrid(cols, cells.length / cols);
  cells.forEach(([g, f, b], i) => {
    setCell(grid, i, g, f, b);
  });
  return grid;
}

function encodeText(enc: ReturnType<typeof createEncoder>, grid: CellGrid, tsq = 0): string {
  return enc.encode(grid, tsq).toString('utf8');
}

function opts(cols: number, rows: number, mapper: ColorMapper = IDENTITY_MAPPER, offsetX = 0, offsetY = 0) {
  return { cols, rows, offsetX, offsetY, mapper };
}

describe('createEncoder, 24-bit', () => {
  it('writes exact bytes for a 1x1 grid with one combined SGR', () => {
    const enc = createEncoder(opts(1, 1));
    const out = encodeText(enc, gridOf([[GLYPH_UPPER_HALF, packRgb(10, 20, 30), packRgb(40, 50, 60)]]));
    expect(out).toBe(BEGIN + cursorPosition(1, 1) + `${CSI}38;2;10;20;30;48;2;40;50;60m${BLOCK}` + END);
    expect(enc.stats.sgrEmitted).toBe(1);
    expect(enc.stats.cellsWritten).toBe(1);
    expect(enc.stats.cursorMoves).toBe(1);
    expect(enc.stats.bytes).toBe(out.length + 2); // the block glyph is 3 bytes but 1 UTF-16 unit
  });

  it('reuses colors across a 3x1 row and sends only the changed half', () => {
    const enc = createEncoder(opts(3, 1));
    const grid = gridOf([
      [GLYPH_UPPER_HALF, RED, BLUE],
      [GLYPH_UPPER_HALF, RED, GREEN],
      [GLYPH_UPPER_HALF, RED, GREEN],
    ]);
    expect(encodeText(enc, grid)).toBe(
      BEGIN +
        cursorPosition(1, 1) +
        `${CSI}38;2;${rgbText(RED)};48;2;${rgbText(BLUE)}m${BLOCK}` +
        `${CSI}48;2;${rgbText(GREEN)}m${BLOCK}${BLOCK}` +
        END,
    );
    expect(enc.stats.sgrEmitted).toBe(2);
    expect(enc.stats.naiveSgr).toBe(6);
  });

  it('returns an empty buffer for an unchanged frame and one CUP + SGR + glyph for one changed cell', () => {
    const enc = createEncoder(opts(3, 1, IDENTITY_MAPPER, 4, 2));
    const grid = gridOf([
      [GLYPH_UPPER_HALF, RED, BLUE],
      [GLYPH_UPPER_HALF, RED, GREEN],
      [GLYPH_UPPER_HALF, RED, GREEN],
    ]);
    enc.encode(grid, 0);

    const again = enc.encode(grid, 0);
    expect(again.length).toBe(0);
    expect(enc.stats.bytes).toBe(0);
    expect(enc.stats.cellsWritten).toBe(0);
    expect(enc.stats.cellsSkipped).toBe(3);
    expect(enc.stats.sgrEmitted).toBe(0);

    setCell(grid, 1, GLYPH_UPPER_HALF, WHITE, BLUE);
    expect(encodeText(enc, grid)).toBe(
      BEGIN + cursorPosition(3, 6) + `${CSI}38;2;255;255;255;48;2;0;0;255m${BLOCK}` + END,
    );
    expect(enc.stats.cellsWritten).toBe(1);
    expect(enc.stats.cellsSkipped).toBe(2);
  });

  it('writes only a background SGR and a space for solid cells', () => {
    const enc = createEncoder(opts(2, 1));
    const grid = gridOf([
      [GLYPH_SPACE, RED, BLUE],
      [GLYPH_SPACE, GREEN, BLUE],
    ]);
    expect(encodeText(enc, grid)).toBe(BEGIN + cursorPosition(1, 1) + `${CSI}48;2;${rgbText(BLUE)}m  ` + END);
  });

  it('treats colors within the threshold as equal for RLE and for deltas', () => {
    const enc = createEncoder(opts(2, 1));
    const near = packRgb(101, 100, 100);
    const grid = gridOf([
      [GLYPH_UPPER_HALF, packRgb(100, 100, 100), BLUE],
      [GLYPH_UPPER_HALF, near, BLUE],
    ]);
    // Distance of (100,100,100) to (101,100,100) is 2, so threshold 4 -> thresholdSq 16 keeps one SGR.
    expect(encodeText(enc, grid, 16)).toBe(
      BEGIN + cursorPosition(1, 1) + `${CSI}38;2;100;100;100;48;2;0;0;255m${BLOCK}${BLOCK}` + END,
    );
    // The model holds the color actually shown, so the second cell shows 100,100,100 (within 4 of its source).
    expect(enc.model.fg[1]).toBe(packRgb(100, 100, 100));

    // A source drifting by the same small step does not trigger a rewrite...
    setCell(grid, 0, GLYPH_UPPER_HALF, packRgb(102, 100, 100), BLUE);
    expect(enc.encode(grid, 16).length).toBe(0);
    // ...but drifting past the threshold relative to what is SHOWN does.
    setCell(grid, 0, GLYPH_UPPER_HALF, packRgb(110, 100, 100), BLUE);
    expect(enc.encode(grid, 16).length).toBeGreaterThan(0);
  });

  it('writes every cell again after invalidate()', () => {
    const enc = createEncoder(opts(2, 2));
    const grid = createCellGrid(2, 2);
    for (let i = 0; i < 4; i++) setCell(grid, i, GLYPH_SPACE, 0, BLUE);
    const first = Buffer.from(enc.encode(grid, 0));
    expect(enc.encode(grid, 0).length).toBe(0);
    enc.invalidate();
    expect(Buffer.from(enc.encode(grid, 0)).equals(first)).toBe(true);
    expect(enc.stats.cellsWritten).toBe(4);
  });

  it('moves the cursor per row with offsets, and never moves over trailing unchanged cells', () => {
    const enc = createEncoder(opts(3, 2, IDENTITY_MAPPER, 10, 5));
    const grid = createCellGrid(3, 2);
    for (let i = 0; i < 6; i++) setCell(grid, i, GLYPH_SPACE, 0, BLUE);
    enc.encode(grid, 0);
    setCell(grid, 0, GLYPH_SPACE, 0, RED);
    setCell(grid, 5, GLYPH_SPACE, 0, RED);
    expect(encodeText(enc, grid)).toBe(
      BEGIN +
        cursorPosition(6, 11) +
        `${CSI}48;2;${rgbText(RED)}m ` +
        cursorPosition(7, 13) +
        ' ' + // same background as the cell just written, so no second SGR
        END,
    );
  });

  describe('skip run: CSI k C versus reprinting', () => {
    // Cells 0 and k+1 change glyph; the k cells between them are unchanged and need no SGR once
    // cell 0 is written, so the encoder chooses the shorter of `CSI k C` (4 bytes up to k = 9) and the cells.
    function runCase(k: number, runGlyph: number): string {
      const cols = k + 2;
      const enc = createEncoder(opts(cols, 1));
      const grid = createCellGrid(cols, 1);
      for (let i = 0; i < cols; i++) setCell(grid, i, GLYPH_SPACE, RED, BLUE);
      for (let i = 1; i <= k; i++) setCell(grid, i, runGlyph, RED, BLUE);
      enc.encode(grid, 0);
      setCell(grid, 0, GLYPH_UPPER_HALF, RED, BLUE);
      setCell(grid, k + 1, GLYPH_UPPER_HALF, RED, BLUE);
      return encodeText(enc, grid);
    }
    const head = (): string => BEGIN + cursorPosition(1, 1) + `${CSI}38;2;${rgbText(RED)};48;2;${rgbText(BLUE)}m${BLOCK}`;

    it('reprints spaces while that is no longer than the jump (k <= 4) and jumps beyond', () => {
      for (let k = 1; k <= 6; k++) {
        const expected = k <= 4 ? head() + ' '.repeat(k) + BLOCK + END : head() + `${CSI}${String(k)}C` + BLOCK + END;
        expect(runCase(k, GLYPH_SPACE), `k = ${String(k)}`).toBe(expected);
      }
    });

    it('reprints a run of 3-byte block glyphs only for k = 1', () => {
      expect(runCase(1, GLYPH_UPPER_HALF)).toBe(head() + BLOCK + BLOCK + END);
      for (let k = 2; k <= 4; k++) {
        expect(runCase(k, GLYPH_UPPER_HALF), `k = ${String(k)}`).toBe(head() + `${CSI}${String(k)}C` + BLOCK + END);
      }
    });

    it('jumps when reprinting would need a color change', () => {
      const enc = createEncoder(opts(3, 1));
      const grid = createCellGrid(3, 1);
      for (let i = 0; i < 3; i++) setCell(grid, i, GLYPH_SPACE, 0, BLUE);
      enc.encode(grid, 0);
      setCell(grid, 0, GLYPH_SPACE, 0, RED);
      setCell(grid, 2, GLYPH_SPACE, 0, RED);
      expect(encodeText(enc, grid)).toBe(
        BEGIN + cursorPosition(1, 1) + `${CSI}48;2;${rgbText(RED)}m ${CSI}1C ` + END,
      );
      expect(enc.stats.cursorMoves).toBe(2);
      expect(enc.stats.cellsSkipped).toBe(1);
    });

    it('counts reprinted cells as written, so written + skipped covers the grid', () => {
      const cols = 5;
      const enc = createEncoder(opts(cols, 1));
      const grid = createCellGrid(cols, 1);
      for (let i = 0; i < cols; i++) setCell(grid, i, GLYPH_SPACE, RED, BLUE);
      enc.encode(grid, 0);
      setCell(grid, 0, GLYPH_UPPER_HALF, RED, BLUE);
      setCell(grid, 4, GLYPH_UPPER_HALF, RED, BLUE);
      enc.encode(grid, 0);
      expect(enc.stats.cellsWritten).toBe(5);
      expect(enc.stats.cellsSkipped).toBe(0);
    });
  });

  it('never exceeds the buffer capacity on worst-case frames', () => {
    let seed = 12345;
    const rnd = (): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed;
    };
    for (const [cols, rows] of [[1, 1], [3, 2], [80, 23], [244, 72]] as const) {
      const enc = createEncoder(opts(cols, rows, IDENTITY_MAPPER, 9000, 9000 - rows));
      const grid = createCellGrid(cols, rows);
      for (let frame = 0; frame < 3; frame++) {
        for (let i = 0; i < cols * rows; i++) {
          // High channel values give three-digit decimals; xor makes neighbours differ.
          setCell(grid, i, GLYPH_UPPER_HALF, 0x808080 | (rnd() & 0xffffff), 0x808080 | (rnd() & 0xffffff));
        }
        expect(enc.encode(grid, 0).length).toBeLessThanOrEqual(enc.capacity);
      }
    }
  });
});

describe('createEncoder, 256 and 16 colors', () => {
  it('emits 38;5;n / 48;5;n at depth 8', () => {
    const enc = createEncoder(opts(2, 1, STUB_MAPPER_256));
    const grid = gridOf([
      [GLYPH_UPPER_HALF, 5, 240 + 7],
      [GLYPH_UPPER_HALF, 5, 3],
    ]);
    const a = STUB_MAPPER_256.map(5);
    const b = STUB_MAPPER_256.map(247);
    const c = STUB_MAPPER_256.map(3);
    expect(encodeText(enc, grid)).toBe(
      BEGIN +
        cursorPosition(1, 1) +
        `${CSI}38;5;${String(a)};48;5;${String(b)}m${BLOCK}` +
        `${CSI}48;5;${String(c)}m${BLOCK}` +
        END,
    );
  });

  it('emits 30-37/90-97 and 40-47/100-107 at depth 4', () => {
    const enc = createEncoder(opts(3, 1, STUB_MAPPER_16));
    // Mapped indexes: fg 3 -> 33, bg 2 -> 42; then fg 9 -> 91 alone; then bg 12 -> 104 alone.
    const grid = gridOf([
      [GLYPH_UPPER_HALF, 3, 2],
      [GLYPH_UPPER_HALF, 9, 2],
      [GLYPH_UPPER_HALF, 9, 12],
    ]);
    expect(encodeText(enc, grid)).toBe(
      BEGIN +
        cursorPosition(1, 1) +
        `${CSI}33;42m${BLOCK}` +
        `${CSI}91m${BLOCK}` +
        `${CSI}104m${BLOCK}` +
        END,
    );
  });

  it('compares shown colors through toRgb for deltas', () => {
    const enc = createEncoder(opts(1, 1, STUB_MAPPER_256));
    const grid = gridOf([[GLYPH_UPPER_HALF, 10, 20]]);
    enc.encode(grid, 0);
    expect(enc.encode(grid, 0).length).toBe(0);
    setCell(grid, 0, GLYPH_UPPER_HALF, 11, 20);
    expect(enc.encode(grid, 0).length).toBeGreaterThan(0);
    // A huge threshold treats any new color as already shown.
    setCell(grid, 0, GLYPH_UPPER_HALF, 12, 21);
    expect(enc.encode(grid, 600_000).length).toBe(0);
  });
});

describe('createEncoder, naive baseline counters', () => {
  it('equal serializeNaive output length for the same half-block frame', () => {
    for (const [cols, rows, ox, oy] of [[1, 1, 0, 0], [7, 3, 0, 0], [12, 5, 9, 99], [20, 4, 120, 7]] as const) {
      const pixels = new Uint8Array(cols * rows * 2 * 3);
      for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 73 + (i >> 3) * 11) % 256;
      const grid = createCellGrid(cols, rows);
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          const t = (2 * y * cols + x) * 3;
          const b = ((2 * y + 1) * cols + x) * 3;
          setCell(
            grid,
            y * cols + x,
            GLYPH_UPPER_HALF,
            packRgb(pixels[t] ?? 0, pixels[t + 1] ?? 0, pixels[t + 2] ?? 0),
            packRgb(pixels[b] ?? 0, pixels[b + 1] ?? 0, pixels[b + 2] ?? 0),
          );
        }
      }
      const naive = createHalfblockSerializer(cols, rows).serializeNaive(pixels, ox, oy);
      const enc = createEncoder(opts(cols, rows, IDENTITY_MAPPER, ox, oy));
      enc.encode(grid, 0);
      expect(enc.stats.naiveBytes).toBe(naive.length);
      expect(enc.stats.naiveSgr).toBe(2 * cols * rows);
    }
  });
});

describe('createEncoder, invalidateRows and the RGB screen model', () => {
  it('invalidateRows() rewrites only the given rows, clipped to the area', () => {
    const enc = createEncoder(opts(3, 4, IDENTITY_MAPPER, 2, 1));
    const grid = createCellGrid(3, 4);
    for (let i = 0; i < 12; i++) setCell(grid, i, GLYPH_UPPER_HALF, RED, BLUE);
    enc.encode(grid, 0);
    expect(enc.encode(grid, 0).length).toBe(0);

    enc.invalidateRows(1, 2);
    const out = encodeText(enc, grid);
    expect(enc.stats.cellsWritten).toBe(6);
    expect(out).toContain(cursorPosition(3, 3)); // row 1 of the area at offsetY 1, column offset 2
    expect(out).toContain(cursorPosition(4, 3));
    expect(out).not.toContain(cursorPosition(2, 3));
    expect(out).not.toContain(cursorPosition(5, 3));

    enc.invalidateRows(3, 99);
    enc.encode(grid, 0);
    expect(enc.stats.cellsWritten).toBe(3);
    for (const [start, count] of [[-5, 0], [4, 2], [0, 0], [2, -1], [Number.NaN, 2]] as const) {
      enc.invalidateRows(start, count);
      expect(enc.encode(grid, 0).length).toBe(0);
    }
  });

  it('stores RGB in the model at every depth, so it can be compared across depths', () => {
    const enc = createEncoder(opts(2, 1, STUB_MAPPER_256));
    const grid = gridOf([
      [GLYPH_UPPER_HALF, RED, BLUE],
      [GLYPH_SPACE, 0, GREEN],
    ]);
    enc.encode(grid, 0);
    expect(enc.model.fg[0]).toBe(STUB_MAPPER_256.toRgb(STUB_MAPPER_256.map(RED)));
    expect(enc.model.bg[0]).toBe(STUB_MAPPER_256.toRgb(STUB_MAPPER_256.map(BLUE)));
    expect(enc.model.bg[1]).toBe(STUB_MAPPER_256.toRgb(STUB_MAPPER_256.map(GREEN)));
    // The same grid is unchanged: the model comparison goes through toRgb.
    expect(enc.encode(grid, 0).length).toBe(0);
  });
});

describe('createEncoder, validation', () => {
  it('rejects bad geometry and mismatched grids', () => {
    expect(() => createEncoder(opts(0, 1))).toThrow(RangeError);
    expect(() => createEncoder(opts(1, 1, IDENTITY_MAPPER, -1, 0))).toThrow(RangeError);
    expect(() => createEncoder(opts(5, 1, IDENTITY_MAPPER, 9996, 0))).toThrow(RangeError);
    expect(() => createEncoder(opts(2, 2)).encode(createCellGrid(3, 2), 0)).toThrow(RangeError);
  });
});
