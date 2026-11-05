// Shared integer luma (owned by architect-opus; used by braille, ascii and palette code).
// Y = (54R + 183G + 19B) >> 8 approximates Rec. 709 weights (0.2126, 0.7152, 0.0722) in 8-bit
// fixed point. The weights sum to 256, so white maps to 255 and black to 0 with no division.

export function luma(r: number, g: number, b: number): number {
  return (54 * r + 183 * g + 19 * b) >> 8;
}

export function lumaPacked(rgb: number): number {
  return (54 * ((rgb >>> 16) & 0xff) + 183 * ((rgb >>> 8) & 0xff) + 19 * (rgb & 0xff)) >> 8;
}
