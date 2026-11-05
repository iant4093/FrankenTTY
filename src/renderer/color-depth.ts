// Color depth mappers (REQ-RENDER-08). Pure: no I/O, no allocation per call.
// Implements the ColorMapper interface from cells.ts using the xterm default palette.

import { colorDistanceSq } from './cells.ts';
import type { ColorDepth, ColorMapper } from './cells.ts';

/** xterm default RGB for ANSI colors 0..15. */
export const ANSI16_RGB: readonly number[] = [
  0x000000, 0xcd0000, 0x00cd00, 0xcdcd00, 0x0000ee, 0xcd00cd, 0x00cdcd, 0xe5e5e5,
  0x7f7f7f, 0xff0000, 0x00ff00, 0xffff00, 0x5c5cff, 0xff00ff, 0x00ffff, 0xffffff,
];

/** xterm 6x6x6 cube levels. */
const CUBE_LEVELS: readonly number[] = [0, 95, 135, 175, 215, 255];

/** xterm RGB for indices 0..255 (0..15 ANSI, 16..231 cube, 232..255 grays 8 + 10 * i). */
const XTERM256_RGB: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 16; i++) t[i] = ANSI16_RGB[i] ?? 0;
  for (let i = 0; i < 216; i++) {
    const r = CUBE_LEVELS[Math.floor(i / 36)] ?? 0;
    const g = CUBE_LEVELS[Math.floor(i / 6) % 6] ?? 0;
    const b = CUBE_LEVELS[i % 6] ?? 0;
    t[16 + i] = (r << 16) | (g << 8) | b;
  }
  for (let i = 0; i < 24; i++) {
    const v = 8 + 10 * i;
    t[232 + i] = (v << 16) | (v << 8) | v;
  }
  return t;
})();

/** For each channel value 0..255: index (0..5) of the largest cube level <= value. */
const CUBE_LOW: Uint8Array = (() => {
  const t = new Uint8Array(256);
  for (let v = 0; v < 256; v++) {
    let k = 0;
    while (k + 1 < CUBE_LEVELS.length && (CUBE_LEVELS[k + 1] ?? 256) <= v) k++;
    t[v] = k;
  }
  return t;
})();

export function createTrueColorMapper(): ColorMapper {
  return {
    depth: 24,
    map(rgb: number): number {
      return rgb;
    },
    toRgb(mapped: number): number {
      return mapped;
    },
  };
}

/**
 * Nearest xterm 256-color index (16..255) by `colorDistanceSq`. Checks the 8 cube points that
 * bracket the color (floor and ceiling level per channel) and 3 gray steps around its weighted mean.
 */
export function create256Mapper(): ColorMapper {
  const table = XTERM256_RGB;
  return {
    depth: 8,
    map(rgb: number): number {
      const r = (rgb >>> 16) & 0xff;
      const g = (rgb >>> 8) & 0xff;
      const b = rgb & 0xff;
      const rl = CUBE_LOW[r] ?? 0;
      const gl = CUBE_LOW[g] ?? 0;
      const bl = CUBE_LOW[b] ?? 0;
      let best = 16;
      let bestDist = Infinity;
      for (let mask = 0; mask < 8; mask++) {
        const ri = Math.min(rl + (mask & 1), 5);
        const gi = Math.min(gl + ((mask >> 1) & 1), 5);
        const bi = Math.min(bl + ((mask >> 2) & 1), 5);
        const idx = 16 + 36 * ri + 6 * gi + bi;
        const d = colorDistanceSq(rgb, table[idx] ?? 0);
        if (d < bestDist) {
          bestDist = d;
          best = idx;
        }
      }
      // Gray ramp: value = 8 + 10 * i. Centre on the weighted mean (2R + 4G + 3B) / 9.
      const mean = (2 * r + 4 * g + 3 * b) / 9;
      const centre = Math.round((mean - 8) / 10);
      const lo = Math.max(0, centre - 1);
      const hi = Math.min(23, centre + 1);
      for (let i = lo; i <= hi; i++) {
        const idx = 232 + i;
        const d = colorDistanceSq(rgb, table[idx] ?? 0);
        if (d < bestDist) {
          bestDist = d;
          best = idx;
        }
      }
      return best;
    },
    toRgb(mapped: number): number {
      return table[mapped] ?? 0;
    },
  };
}

/** Nearest of the 16 ANSI colors (xterm default RGB) by `colorDistanceSq`. */
export function create16Mapper(): ColorMapper {
  const table = Uint32Array.from(ANSI16_RGB);
  return {
    depth: 4,
    map(rgb: number): number {
      let best = 0;
      let bestDist = Infinity;
      for (let i = 0; i < 16; i++) {
        const d = colorDistanceSq(rgb, table[i] ?? 0);
        if (d < bestDist) {
          bestDist = d;
          best = i;
        }
      }
      return best;
    },
    toRgb(mapped: number): number {
      return table[mapped] ?? 0;
    },
  };
}

export function createMapper(depth: ColorDepth): ColorMapper {
  switch (depth) {
    case 24:
      return createTrueColorMapper();
    case 8:
      return create256Mapper();
    case 4:
      return create16Mapper();
  }
}
