import fc from 'fast-check';
import { describe, it } from 'vitest';
import { lumaPacked } from '../../src/renderer/luma.ts';
import { PALETTE_NAMES, createPalette } from '../../src/renderer/palette.ts';

// P3: palette closure in [0,255], idempotence, and monotonic luma for the phosphor/LCD ramps.
const rgb = fc.integer({ min: 0, max: 0xffffff });

describe('P3 palettes', () => {
  for (const name of PALETTE_NAMES) {
    const palette = createPalette(name);

    it(`${name}: output is a packed 24-bit color (channels are integers in [0,255])`, () => {
      fc.assert(
        fc.property(rgb, (c) => {
          const out = palette.apply(c);
          return Number.isInteger(out) && out >= 0 && out <= 0xffffff;
        }),
        { numRuns: 10000 },
      );
    });

    it(`${name}: apply(apply(x)) === apply(x)`, () => {
      fc.assert(
        fc.property(rgb, (c) => palette.apply(palette.apply(c)) === palette.apply(c)),
        { numRuns: 10000 },
      );
    });

    if (name !== 'truecolor') {
      it(`${name}: output luma is non-decreasing in input luma`, () => {
        fc.assert(
          fc.property(rgb, rgb, (a, b) => {
            const [lo, hi] = lumaPacked(a) <= lumaPacked(b) ? [a, b] : [b, a];
            return lumaPacked(palette.apply(lo)) <= lumaPacked(palette.apply(hi));
          }),
          { numRuns: 10000 },
        );
      });
    }
  }
});
