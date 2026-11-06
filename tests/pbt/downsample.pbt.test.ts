import fc from 'fast-check';
import { describe, it } from 'vitest';
import { downsampleHalfblock } from '../../src/renderer/downsample.ts';

// P6: each output channel lies within the min/max of its 2x2 source block.
describe('[P6][REQ-RENDER-01] downsampleHalfblock', () => {
  const sizes = fc.record({ c: fc.integer({ min: 1, max: 40 }), r: fc.integer({ min: 1, max: 20 }) }).chain(({ c, r }) =>
    fc.record({
      c: fc.constant(c),
      r: fc.constant(r),
      src: fc.uint8Array({ minLength: 2 * c * 4 * r * 3, maxLength: 2 * c * 4 * r * 3 }),
    }),
  );

  it('keeps every channel inside the min/max of its 2x2 block', () => {
    fc.assert(
      fc.property(sizes, ({ c, r, src }) => {
        const w = 2 * c;
        const h = 4 * r;
        const dst = new Uint8Array(c * 2 * r * 3);
        downsampleHalfblock(src, w, h, dst);
        for (let y = 0; y < 2 * r; y++) {
          for (let x = 0; x < c; x++) {
            for (let ch = 0; ch < 3; ch++) {
              const at = (px: number, py: number): number => src[(py * w + px) * 3 + ch] ?? 0;
              const block = [at(2 * x, 2 * y), at(2 * x + 1, 2 * y), at(2 * x, 2 * y + 1), at(2 * x + 1, 2 * y + 1)];
              const value = dst[(y * c + x) * 3 + ch] ?? -1;
              if (value < Math.min(...block) || value > Math.max(...block)) return false;
            }
          }
        }
        return true;
      }),
      { numRuns: 1000 },
    );
  });

  it('maps a uniform block to the same value', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 40 }),
        fc.integer({ min: 1, max: 20 }),
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
        (c, r, red, green, blue) => {
          const w = 2 * c;
          const h = 4 * r;
          const src = new Uint8Array(w * h * 3);
          for (let i = 0; i < w * h; i++) {
            src[i * 3] = red;
            src[i * 3 + 1] = green;
            src[i * 3 + 2] = blue;
          }
          const dst = new Uint8Array(c * 2 * r * 3);
          downsampleHalfblock(src, w, h, dst);
          for (let i = 0; i < c * 2 * r; i++) {
            if (dst[i * 3] !== red || dst[i * 3 + 1] !== green || dst[i * 3 + 2] !== blue) return false;
          }
          return true;
        },
      ),
      { numRuns: 1000 },
    );
  });
});
