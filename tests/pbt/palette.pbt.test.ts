import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { lumaPacked } from '../../src/renderer/luma.ts';
import { AMBER_RAMP, GREEN_RAMP, PALETTE_NAMES, createPalette } from '../../src/renderer/palette.ts';

// P3: palette closure in [0,255], idempotence, and monotonic luma for the phosphor/LCD ramps.
const rgb = fc.integer({ min: 0, max: 0xffffff });

describe('[P3][REQ-PAL-01] palettes', () => {
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

// P3 (ramp span): amber and green cover the full luma range, and inputs that are far apart inside
// the 16..240 span never collapse to the same entry (no clipping).
describe('[P3][REQ-PAL-01] phosphor ramp span', () => {
  for (const [name, ramp] of [['amber', AMBER_RAMP], ['green', GREEN_RAMP]] as const) {
    const palette = createPalette(name);
    const lumas = ramp.map((c) => lumaPacked(c));

    it(`${name}: ramp lumas span at least [16, 240]; dark grays stay dark, bright grays reach white-hot`, () => {
      expect(Math.min(...lumas)).toBeLessThanOrEqual(16);
      expect(Math.max(...lumas)).toBeGreaterThanOrEqual(240);
      const gray = (y: number): number => (y << 16) | (y << 8) | y;
      fc.assert(
        fc.property(fc.integer({ min: 0, max: 16 }), fc.integer({ min: 240, max: 255 }), (dark, bright) => {
          const lo = lumaPacked(palette.apply(gray(dark)));
          const hi = lumaPacked(palette.apply(gray(bright)));
          return lo <= 23 && hi >= 228 && hi - lo >= 200;
        }),
        { numRuns: 1000 },
      );
    });

    it(`${name}: inputs at least 25 luma apart inside 16..240 map to different entries`, () => {
      fc.assert(
        fc.property(rgb, rgb, (a, b) => {
          const ya = lumaPacked(a);
          const yb = lumaPacked(b);
          if (ya < 16 || yb < 16 || ya > 240 || yb > 240 || Math.abs(ya - yb) < 25) return true;
          return palette.apply(a) !== palette.apply(b);
        }),
        { numRuns: 10000 },
      );
    });
  }
});
