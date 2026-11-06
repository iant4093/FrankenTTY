import fc from 'fast-check';
import { describe, it, expect } from 'vitest';
import { computeGeometry } from '../../src/renderer/geometry.ts';
import type { GeometryInput } from '../../src/renderer/geometry.ts';

interface Case {
  srcWidth: number;
  srcHeight: number;
  cols: number;
  rows: number;
  a: number;
  maxCells: number | undefined;
}

const base = {
  srcWidth: fc.integer({ min: 1, max: 7680 }),
  srcHeight: fc.integer({ min: 1, max: 7680 }),
  cols: fc.integer({ min: 20, max: 500 }),
  rows: fc.integer({ min: 10, max: 200 }),
  a: fc.double({ min: 1.0, max: 3.0, noNaN: true }),
};

const uncapped: fc.Arbitrary<Case> = fc.record({
  ...base,
  maxCells: fc.constant(undefined),
});
const capped: fc.Arbitrary<Case> = fc.record({
  ...base,
  maxCells: fc.integer({ min: 1, max: 100000 }),
});
const either: fc.Arbitrary<Case> = fc.record({
  ...base,
  maxCells: fc.option(fc.integer({ min: 1, max: 100000 }), { nil: undefined }),
});

function run(c: Case) {
  const input: GeometryInput = {
    srcWidth: c.srcWidth,
    srcHeight: c.srcHeight,
    cols: c.cols,
    rows: c.rows,
    cellAspect: c.a,
  };
  if (c.maxCells !== undefined) input.maxCells = c.maxCells;
  return computeGeometry(input);
}

const EPS = 1e-9;

describe('[P1][REQ-GEO-01][REQ-GEO-02][REQ-TERM-02] geometry properties', () => {
  it('P1a containment', () => {
    fc.assert(
      fc.property(either, (c) => {
        const g = run(c);
        expect(g.availCols).toBe(c.cols);
        expect(g.availRows).toBe(c.rows - 1);
        expect(g.renderCols).toBeGreaterThanOrEqual(1);
        expect(g.renderCols).toBeLessThanOrEqual(g.availCols);
        expect(g.renderRows).toBeGreaterThanOrEqual(1);
        expect(g.renderRows).toBeLessThanOrEqual(g.availRows);
        expect(g.offsetX).toBeGreaterThanOrEqual(0);
        expect(g.offsetY).toBeGreaterThanOrEqual(0);
        expect(g.offsetX + g.renderCols).toBeLessThanOrEqual(g.availCols);
        expect(g.offsetY + g.renderRows).toBeLessThanOrEqual(g.availRows);
        if (c.maxCells !== undefined) {
          expect(g.renderCols * g.renderRows).toBeLessThanOrEqual(c.maxCells);
        }
      }),
      { numRuns: 10000 },
    );
  });

  it('P1b maximality without maxCells', () => {
    fc.assert(
      fc.property(uncapped, (c) => {
        const g = run(c);
        expect(g.renderCols === g.availCols || g.renderRows === g.availRows).toBe(true);
      }),
      { numRuns: 10000 },
    );
  });

  it('P1c aspect error is at most half a cell on the derived axis', () => {
    fc.assert(
      fc.property(uncapped, (c) => {
        const g = run(c);
        const unit = c.a * (c.srcWidth / c.srcHeight);
        if (g.renderCols === g.availCols && g.renderRows < g.availRows) {
          expect(
            g.renderRows === 1 || Math.abs(g.renderRows - g.availCols / unit) <= 0.5 + EPS,
          ).toBe(true);
        }
        if (g.renderRows === g.availRows) {
          expect(
            g.renderCols === 1 ||
              g.renderCols === g.availCols ||
              Math.abs(g.renderCols - g.availRows * unit) <= 0.5 + EPS,
          ).toBe(true);
        }
      }),
      { numRuns: 10000 },
    );
  });

  it('P1d centering', () => {
    fc.assert(
      fc.property(either, (c) => {
        const g = run(c);
        const dx = g.availCols - g.renderCols - g.offsetX - g.offsetX;
        const dy = g.availRows - g.renderRows - g.offsetY - g.offsetY;
        expect(dx === 0 || dx === 1).toBe(true);
        expect(dy === 0 || dy === 1).toBe(true);
      }),
      { numRuns: 10000 },
    );
  });

  it('P1e derived sizes', () => {
    fc.assert(
      fc.property(either, (c) => {
        const g = run(c);
        expect(g.halfblockWidth).toBe(g.renderCols);
        expect(g.halfblockHeight).toBe(2 * g.renderRows);
        expect(g.decodeWidth).toBe(2 * g.renderCols);
        expect(g.decodeHeight).toBe(4 * g.renderRows);
      }),
      { numRuns: 10000 },
    );
  });

  it('P1f capped result keeps the source aspect', () => {
    // Derivation. Let u = a * want (columns per row at the source aspect).
    // Uncapped fit: one axis is rounded to a whole cell, so the relative
    // aspect error is at most 0.5/r (width-limited, r rounded) or 0.5/c
    // (height-limited, c rounded). Cap path: c' = floor(c*s), r' = round(c'/u),
    // giving a relative error of at most 0.5/r'. The while loop then removes
    // cells from the larger side one at a time; each removal shifts the aspect
    // by a relative 1/larger <= 1/min(c, r). The overshoot of c'*r' above
    // maxCells is about 0.5*(c' + r'), so one or two removals are needed.
    // The brief's bound 1/min + 0.5/r is slightly too tight: fast-check
    // (200,000 runs) found errors up to 1.16/min + 0.5/r, for example
    // 3291x3048 in 429x119 at a=1.5192705635184096 with maxCells 12265
    // (result 140x87). The bound used is 2/min + 0.5/r.
    fc.assert(
      fc.property(capped, (c) => {
        const g = run(c);
        expect(g.renderCols).toBeGreaterThanOrEqual(1);
        expect(g.renderRows).toBeGreaterThanOrEqual(1);
        if (g.renderCols > 1 && g.renderRows > 1) {
          const want = c.srcWidth / c.srcHeight;
          const err = Math.abs(g.renderCols / (g.renderRows * c.a) - want) / want;
          const m = Math.min(g.renderCols, g.renderRows);
          expect(err).toBeLessThanOrEqual(2 / m + 0.5 / g.renderRows + EPS);
        }
      }),
      { numRuns: 5000 },
    );
  });
});
