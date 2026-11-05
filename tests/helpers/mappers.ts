import type { ColorMapper } from '../../src/renderer/cells.ts';
import { packRgb } from '../../src/renderer/cells.ts';

/** Depth 24: the packed color passes through unchanged. */
export const IDENTITY_MAPPER: ColorMapper = {
  depth: 24,
  map: (rgb) => rgb,
  toRgb: (mapped) => mapped,
};

const TABLE_256 = new Uint32Array(256);
for (let i = 0; i < 256; i++) TABLE_256[i] = packRgb((i * 37) & 255, (i * 91) & 255, (i * 53) & 255);

/** Stub 256-color mapper. Real mappers arrive with task 3.3. Indexes are 16..255. */
export const STUB_MAPPER_256: ColorMapper = {
  depth: 8,
  map: (rgb) => 16 + (rgb % 240),
  toRgb: (mapped) => TABLE_256[mapped & 255] ?? 0,
};

const TABLE_16 = new Uint32Array(16);
for (let i = 0; i < 16; i++) TABLE_16[i] = packRgb((i * 17) & 255, (i * 101) & 255, (i * 29) & 255);

/** Stub 16-color mapper. Indexes are 0..15. */
export const STUB_MAPPER_16: ColorMapper = {
  depth: 4,
  map: (rgb) => rgb % 16,
  toRgb: (mapped) => TABLE_16[mapped & 15] ?? 0,
};
