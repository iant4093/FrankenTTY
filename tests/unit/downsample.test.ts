import { describe, expect, it } from 'vitest';
import { downsampleHalfblock } from '../../src/renderer/downsample.ts';

describe('downsampleHalfblock', () => {
  it('averages a 2x2 block with rounding half up', () => {
    // Red channel: 1, 2, 2, 2 -> 7/4 = 1.75 -> 2. Green: 0, 0, 0, 1 -> 0.25 -> 0. Blue: 0, 1, 1, 0 -> 0.5 -> 1.
    const src = Uint8Array.from([
      1, 0, 0, /**/ 2, 0, 1,
      2, 0, 1, /**/ 2, 1, 0,
    ]);
    const dst = new Uint8Array(3);
    downsampleHalfblock(src, 2, 2, dst);
    expect(Array.from(dst)).toEqual([2, 0, 1]);
  });

  it('keeps 255 and 0 uniform blocks exact', () => {
    const white = new Uint8Array(2 * 2 * 3).fill(255);
    const dst = new Uint8Array(3);
    downsampleHalfblock(white, 2, 2, dst);
    expect(Array.from(dst)).toEqual([255, 255, 255]);
    downsampleHalfblock(new Uint8Array(12), 2, 2, dst);
    expect(Array.from(dst)).toEqual([0, 0, 0]);
  });

  it('maps a 4x4 image to 2x2 with each block averaged separately', () => {
    // Row-major 4x4 single-valued pixels (r = g = b = v).
    const values = [
      10, 10, 100, 100,
      10, 10, 100, 100,
      0, 40, 200, 200,
      0, 40, 200, 200,
    ];
    const src = new Uint8Array(4 * 4 * 3);
    values.forEach((v, i) => src.fill(v, i * 3, i * 3 + 3));
    const dst = new Uint8Array(2 * 2 * 3);
    downsampleHalfblock(src, 4, 4, dst);
    expect(Array.from(dst)).toEqual([10, 10, 10, 100, 100, 100, 20, 20, 20, 200, 200, 200]);
  });

  it('accepts a larger dst and leaves the extra bytes untouched', () => {
    const dst = new Uint8Array(6).fill(77);
    downsampleHalfblock(new Uint8Array(12).fill(5), 2, 2, dst);
    expect(Array.from(dst)).toEqual([5, 5, 5, 77, 77, 77]);
  });

  it('throws RangeError for odd or non-integer sizes', () => {
    const dst = new Uint8Array(1000);
    for (const [w, h] of [[3, 2], [2, 3], [0, 2], [2, 0], [2.5, 2], [-2, 2], [NaN, 2]] as const) {
      expect(() => downsampleHalfblock(new Uint8Array(1000), w, h, dst)).toThrow(RangeError);
    }
  });

  it('throws RangeError when src or dst is too small', () => {
    expect(() => downsampleHalfblock(new Uint8Array(11), 2, 2, new Uint8Array(3))).toThrow(RangeError);
    expect(() => downsampleHalfblock(new Uint8Array(12), 2, 2, new Uint8Array(2))).toThrow(RangeError);
    expect(() => downsampleHalfblock(new Uint8Array(4 * 4 * 3), 4, 4, new Uint8Array(11))).toThrow(RangeError);
  });
});
