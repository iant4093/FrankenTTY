import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { colorDistanceSq } from '../../src/renderer/cells.ts';
import type { ColorMapper } from '../../src/renderer/cells.ts';
import { create16Mapper, create256Mapper } from '../../src/renderer/color-depth.ts';

const rgb = fc.integer({ min: 0, max: 0xffffff });

interface Case {
  readonly label: string;
  readonly mapper: ColorMapper;
  readonly first: number;
  readonly last: number;
}

const cases: Case[] = [
  { label: '256', mapper: create256Mapper(), first: 16, last: 255 },
  { label: '16', mapper: create16Mapper(), first: 0, last: 15 },
];

for (const { label, mapper, first, last } of cases) {
  describe(`${label}-color mapper`, () => {
    const candidate = fc.integer({ min: first, max: last });

    it('(a) map returns a valid index', () => {
      fc.assert(
        fc.property(rgb, (c) => {
          const i = mapper.map(c);
          return Number.isInteger(i) && i >= first && i <= last;
        }),
        { numRuns: 10000 },
      );
    });

    it('(b) map is no farther than a random other candidate', () => {
      fc.assert(
        fc.property(rgb, candidate, (c, k) => {
          const chosen = colorDistanceSq(c, mapper.toRgb(mapper.map(c)));
          return chosen <= colorDistanceSq(c, mapper.toRgb(k));
        }),
        { numRuns: 10000 },
      );
    });

    it('(b2) map is no farther than every candidate (brute force)', () => {
      fc.assert(
        fc.property(rgb, (c) => {
          const chosen = colorDistanceSq(c, mapper.toRgb(mapper.map(c)));
          for (let k = first; k <= last; k++) {
            if (colorDistanceSq(c, mapper.toRgb(k)) < chosen) return false;
          }
          return true;
        }),
        { numRuns: 10000 },
      );
    });

    it('(c) map(toRgb(map(x))) === map(x)', () => {
      fc.assert(
        fc.property(rgb, (c) => {
          const i = mapper.map(c);
          return mapper.map(mapper.toRgb(i)) === i;
        }),
        { numRuns: 10000 },
      );
    });

    it('maps every palette color to itself', () => {
      for (let k = first; k <= last; k++) expect(mapper.map(mapper.toRgb(k))).toBe(k);
    });

    it('logs map() throughput', () => {
      const n = 2_000_000;
      let sink = 0;
      const t0 = performance.now();
      let c = 0x123456;
      for (let i = 0; i < n; i++) {
        c = (c * 1103515245 + 12345) & 0xffffff;
        sink += mapper.map(c);
      }
      const ms = performance.now() - t0;
      console.log(`${label}-color map(): ${(n / ms).toFixed(0)} calls/ms (sink ${String(sink)})`);
      expect(ms).toBeGreaterThan(0);
    });
  });
}
