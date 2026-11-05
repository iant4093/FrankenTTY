import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { CellGrid, ColorMapper } from '../../src/renderer/cells.ts';
import { GLYPH_SPACE, GLYPH_UPPER_HALF, colorDistanceSq, createCellGrid } from '../../src/renderer/cells.ts';
import { create16Mapper, create256Mapper } from '../../src/renderer/color-depth.ts';
import { createEncoder } from '../../src/renderer/encoder.ts';
import { SGR_RESET, SYNC_BEGIN, SYNC_END } from '../../src/renderer/sequences.ts';
import { feed, readCell, readPaletteCell, replayInto } from '../helpers/emulator.ts';
import { IDENTITY_MAPPER } from '../helpers/mappers.ts';

const SYNC_BEGIN_BYTES = Buffer.from(SYNC_BEGIN);
const FRAME_END_BYTES = Buffer.from(SGR_RESET + SYNC_END);

// A few base colors make repeats and near-repeats common; the plain integers keep the space wide.
const BASE_COLORS = [0x000000, 0xffffff, 0xff0000, 0x00ff00, 0x0000ff, 0x808080, 0x123456];
const colorArb = fc.oneof(
  { arbitrary: fc.integer({ min: 0, max: 0xffffff }), weight: 2 },
  { arbitrary: fc.constantFrom(...BASE_COLORS), weight: 3 },
  {
    arbitrary: fc
      .tuple(fc.constantFrom(...BASE_COLORS), fc.integer({ min: -3, max: 3 }))
      .map(([c, d]) => clampAll(c, d)),
    weight: 2,
  },
);
const glyphArb = fc.constantFrom(GLYPH_SPACE, GLYPH_UPPER_HALF);

function clampAll(color: number, delta: number): number {
  const ch = (shift: number): number => Math.min(255, Math.max(0, ((color >>> shift) & 255) + delta));
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

interface GridData {
  cols: number;
  rows: number;
  glyph: number[];
  fg: number[];
  bg: number[];
}

const sizeArb = fc.record({ cols: fc.integer({ min: 1, max: 30 }), rows: fc.integer({ min: 1, max: 12 }) });

const gridDataArb: fc.Arbitrary<GridData> = sizeArb.chain(({ cols, rows }) => {
  const n = cols * rows;
  return fc.record({
    cols: fc.constant(cols),
    rows: fc.constant(rows),
    glyph: fc.array(glyphArb, { minLength: n, maxLength: n }),
    fg: fc.array(colorArb, { minLength: n, maxLength: n }),
    bg: fc.array(colorArb, { minLength: n, maxLength: n }),
  });
});

function toGrid(d: GridData): CellGrid {
  const grid = createCellGrid(d.cols, d.rows);
  grid.glyph.set(d.glyph);
  grid.fg.set(d.fg);
  grid.bg.set(d.bg);
  return grid;
}

const thresholdArb = fc.integer({ min: 0, max: 40 });
// The real mappers from color-depth.ts, so P2a/P2b cover the byte lengths of real 256/16-color SGRs.
const MAPPER_256 = create256Mapper();
const MAPPER_16 = create16Mapper();
const mapperArb: fc.Arbitrary<ColorMapper> = fc.constantFrom(IDENTITY_MAPPER, MAPPER_256, MAPPER_16);
const offsetArb = fc.record({ offsetX: fc.integer({ min: 0, max: 8 }), offsetY: fc.integer({ min: 0, max: 5 }) });

// P2a: framing of every non-empty output.
describe('P2a encoder framing', () => {
  it('starts with SYNC_BEGIN, ends with SGR_RESET SYNC_END and is valid UTF-8', () => {
    fc.assert(
      fc.property(gridDataArb, thresholdArb, mapperArb, offsetArb, (d, t, mapper, off) => {
        const enc = createEncoder({ cols: d.cols, rows: d.rows, mapper, ...off });
        const out = enc.encode(toGrid(d), t * t);
        expect(out.length).toBeGreaterThan(0); // first frame writes every cell
        expect(out.length).toBeLessThanOrEqual(enc.capacity);
        expect(out.subarray(0, SYNC_BEGIN_BYTES.length).equals(SYNC_BEGIN_BYTES)).toBe(true);
        expect(out.subarray(out.length - FRAME_END_BYTES.length).equals(FRAME_END_BYTES)).toBe(true);
        new TextDecoder('utf-8', { fatal: true }).decode(out);
        expect(enc.stats.bytes).toBe(out.length);
        expect(enc.stats.cellsWritten + enc.stats.cellsSkipped).toBe(d.cols * d.rows);
      }),
      { numRuns: 1000 },
    );
  });
});

// P2b: the first frame never costs more than the naive serializer.
describe('P2b encoder non-expansion', () => {
  it('first frame: bytes <= naiveBytes and sgrEmitted <= naiveSgr', () => {
    fc.assert(
      fc.property(gridDataArb, thresholdArb, mapperArb, offsetArb, (d, t, mapper, off) => {
        const enc = createEncoder({ cols: d.cols, rows: d.rows, mapper, ...off });
        enc.encode(toGrid(d), t * t);
        expect(enc.stats.bytes).toBeLessThanOrEqual(enc.stats.naiveBytes);
        expect(enc.stats.sgrEmitted).toBeLessThanOrEqual(enc.stats.naiveSgr);
      }),
      { numRuns: 1000 },
    );
  });
});

function isSpace(ch: string): boolean {
  return ch === ' ' || ch === '';
}

// P2c: replaying the output in a real emulator reproduces the grid within the threshold.
describe('P2c encoder in @xterm/headless', () => {
  it('shows every glyph, and fg/bg within the threshold of the grid (exact at threshold 0)', async () => {
    await fc.assert(
      fc.asyncProperty(gridDataArb, thresholdArb, offsetArb, async (d, t, off) => {
        const tsq = t * t;
        const enc = createEncoder({ cols: d.cols, rows: d.rows, mapper: IDENTITY_MAPPER, ...off });
        const term = await replayInto(enc.encode(toGrid(d), tsq), d.cols + off.offsetX, d.rows + off.offsetY + 1);
        try {
          for (let y = 0; y < d.rows; y++) {
            for (let x = 0; x < d.cols; x++) {
              const i = y * d.cols + x;
              const got = readCell(term, off.offsetX + x, off.offsetY + y);
              const glyph = d.glyph[i] ?? GLYPH_SPACE;
              const bg = d.bg[i] ?? 0;
              if (got.bg === null || colorDistanceSq(got.bg, bg) > tsq) return false;
              if (glyph === GLYPH_SPACE) {
                if (!isSpace(got.char)) return false;
              } else {
                const fg = d.fg[i] ?? 0;
                if (got.char !== '\u2580' || got.fg === null || colorDistanceSq(got.fg, fg) > tsq) return false;
              }
            }
          }
          return true;
        } finally {
          term.dispose();
        }
      }),
      { numRuns: 300 },
    );
  });
});

// P2c at depth 8: the emulator's palette indexes, read back with cell.isFgPalette()/getFgColor(), map
// (through the 256-color table) to colors within the threshold of the mapped source.
describe('P2c encoder in @xterm/headless at depth 8', () => {
  it('shows every glyph, and palette-index fg/bg within the threshold of the mapped grid (exact at threshold 0)', async () => {
    await fc.assert(
      fc.asyncProperty(gridDataArb, thresholdArb, offsetArb, async (d, t, off) => {
        const tsq = t * t;
        const enc = createEncoder({ cols: d.cols, rows: d.rows, mapper: MAPPER_256, ...off });
        const term = await replayInto(enc.encode(toGrid(d), tsq), d.cols + off.offsetX, d.rows + off.offsetY + 1);
        try {
          for (let y = 0; y < d.rows; y++) {
            for (let x = 0; x < d.cols; x++) {
              const i = y * d.cols + x;
              const got = readPaletteCell(term, off.offsetX + x, off.offsetY + y);
              const glyph = d.glyph[i] ?? GLYPH_SPACE;
              const wantBg = MAPPER_256.toRgb(MAPPER_256.map(d.bg[i] ?? 0));
              if (got.bgIndex === null || colorDistanceSq(MAPPER_256.toRgb(got.bgIndex), wantBg) > tsq) return false;
              if (glyph === GLYPH_SPACE) {
                if (!isSpace(got.char)) return false;
              } else {
                const wantFg = MAPPER_256.toRgb(MAPPER_256.map(d.fg[i] ?? 0));
                if (got.char !== '\u2580' || got.fgIndex === null) return false;
                if (colorDistanceSq(MAPPER_256.toRgb(got.fgIndex), wantFg) > tsq) return false;
              }
            }
          }
          return true;
        } finally {
          term.dispose();
        }
      }),
      { numRuns: 300 },
    );
  });
});

// P2d: after random frame sequences with deltas, the emulator equals the screen model, and the model
// stays within the threshold of every frame's source.
const cellEditArb = fc.record({
  kind: fc.integer({ min: 0, max: 9 }), // 0-4 keep, 5-6 jitter, 7-9 replace
  glyph: glyphArb,
  fg: colorArb,
  bg: colorArb,
  jitter: fc.integer({ min: -6, max: 6 }),
});

describe('P2d encoder deltas', () => {
  it('keeps the emulator equal to the screen model and within the threshold of each frame', async () => {
    const caseArb = gridDataArb.chain((d) => {
      const n = d.cols * d.rows;
      return fc.record({
        d: fc.constant(d),
        t: thresholdArb,
        off: offsetArb,
        frames: fc.array(
          fc.record({
            invalidate: fc.integer({ min: 0, max: 7 }),
            edits: fc.array(cellEditArb, { minLength: n, maxLength: n }),
          }),
          { minLength: 1, maxLength: 5 },
        ),
      });
    });

    await fc.assert(
      fc.asyncProperty(caseArb, async ({ d, t, off, frames }) => {
        const tsq = t * t;
        const enc = createEncoder({ cols: d.cols, rows: d.rows, mapper: IDENTITY_MAPPER, ...off });
        const grid = toGrid(d);
        const term = await replayInto(enc.encode(grid, tsq), d.cols + off.offsetX, d.rows + off.offsetY + 1);
        try {
          const check = (): boolean => {
            for (let y = 0; y < d.rows; y++) {
              for (let x = 0; x < d.cols; x++) {
                const i = y * d.cols + x;
                const got = readCell(term, off.offsetX + x, off.offsetY + y);
                const glyph = grid.glyph[i] ?? 0;
                if (enc.model.glyph[i] !== glyph) return false;
                const modelBg = enc.model.bg[i] ?? 0;
                if (got.bg !== modelBg || colorDistanceSq(modelBg, grid.bg[i] ?? 0) > tsq) return false;
                if (glyph === GLYPH_SPACE) {
                  if (!isSpace(got.char)) return false;
                } else {
                  const modelFg = enc.model.fg[i] ?? 0;
                  if (got.char !== '\u2580' || got.fg !== modelFg || colorDistanceSq(modelFg, grid.fg[i] ?? 0) > tsq) {
                    return false;
                  }
                }
              }
            }
            return enc.stats.cellsWritten + enc.stats.cellsSkipped === d.cols * d.rows;
          };
          if (!check()) return false;
          for (const frame of frames) {
            if (frame.invalidate === 0) enc.invalidate();
            frame.edits.forEach((e, i) => {
              if (e.kind <= 4) return;
              if (e.kind <= 6) {
                grid.fg[i] = clampAll(grid.fg[i] ?? 0, e.jitter);
                grid.bg[i] = clampAll(grid.bg[i] ?? 0, e.jitter);
              } else {
                grid.glyph[i] = e.glyph;
                grid.fg[i] = e.fg;
                grid.bg[i] = e.bg;
              }
            });
            await feed(term, enc.encode(grid, tsq));
            if (!check()) return false;
          }
          return true;
        } finally {
          term.dispose();
        }
      }),
      { numRuns: 200 },
    );
  });
});
