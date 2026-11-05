// Braille-resolution pixels -> half-block grid. Pure: no I/O, no timers, no allocation.

/**
 * Averages each 2x2 block of an RGB24 image into one pixel (REQ-INGEST-02, REQ-RENDER-01).
 *
 * `src` is `srcWidth x srcHeight` (decode resolution, 2c x 4r); `dst` receives
 * `srcWidth/2 x srcHeight/2` pixels (c x 2r). Each channel is the rounded mean of four
 * samples: `(a + b + c + d + 2) >> 2`. Only the first `dstWidth*dstHeight*3` bytes of
 * `dst` are written; `dst` may be larger.
 */
export function downsampleHalfblock(
  src: Uint8Array,
  srcWidth: number,
  srcHeight: number,
  dst: Uint8Array,
): void {
  if (
    !Number.isInteger(srcWidth) ||
    !Number.isInteger(srcHeight) ||
    srcWidth < 2 ||
    srcHeight < 2 ||
    srcWidth % 2 !== 0 ||
    srcHeight % 2 !== 0
  ) {
    throw new RangeError(
      `source size must be even integers >= 2, got ${String(srcWidth)}x${String(srcHeight)}`,
    );
  }
  const dstWidth = srcWidth >> 1;
  const dstHeight = srcHeight >> 1;
  if (src.length < srcWidth * srcHeight * 3) {
    throw new RangeError(`src is too small: ${String(src.length)} < ${String(srcWidth * srcHeight * 3)}`);
  }
  if (dst.length < dstWidth * dstHeight * 3) {
    throw new RangeError(`dst is too small: ${String(dst.length)} < ${String(dstWidth * dstHeight * 3)}`);
  }

  const stride = srcWidth * 3;
  let out = 0;
  for (let y = 0; y < dstHeight; y++) {
    let top = y * 2 * stride;
    for (let x = 0; x < dstWidth; x++) {
      const bottom = top + stride;
      // Sizes are validated above; `?? 0` only satisfies noUncheckedIndexedAccess.
      dst[out] = ((src[top] ?? 0) + (src[top + 3] ?? 0) + (src[bottom] ?? 0) + (src[bottom + 3] ?? 0) + 2) >> 2;
      dst[out + 1] =
        ((src[top + 1] ?? 0) + (src[top + 4] ?? 0) + (src[bottom + 1] ?? 0) + (src[bottom + 4] ?? 0) + 2) >> 2;
      dst[out + 2] =
        ((src[top + 2] ?? 0) + (src[top + 5] ?? 0) + (src[bottom + 2] ?? 0) + (src[bottom + 5] ?? 0) + 2) >> 2;
      out += 3;
      top += 6;
    }
  }
}
