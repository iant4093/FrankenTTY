// Palettes (REQ-PAL-01). Pure: no I/O. A palette maps a packed 0xRRGGBB color to another packed color.
//
// amber, green and dmg are fixed ramps. apply(rgb) picks the ramp entry whose own luma is closest to
// the luma of the input, through a 256-entry table built once at creation. Because every ramp entry
// maps to itself (its luma is closest to itself) and ramp lumas are strictly increasing, applying a
// palette twice equals applying it once, and output luma never decreases when input luma rises.
//
// A phosphor's peak is darker than white (amber peak luma 179, green 196, DMG 168), so inputs
// brighter than the peak clip to the peak entry. That is the cost of exact idempotence.

import type { Palette } from '../cli/args.ts';
import type { CellGrid } from './cells.ts';
import { lumaPacked } from './luma.ts';

/** Same order as `PALETTES` in src/cli/args.ts (a unit test asserts this). */
export const PALETTE_NAMES = ['truecolor', 'amber', 'green', 'dmg'] as const satisfies readonly Palette[];

export type PaletteName = (typeof PALETTE_NAMES)[number];

export interface PaletteMap {
  readonly name: PaletteName;
  /** Maps a packed 0xRRGGBB color. Result channels are integers in [0, 255]. */
  apply(rgb: number): number;
  /** Maps `fg` and `bg` of every cell in place. */
  applyGrid(grid: CellGrid): void;
}

/** 1978 VT100 amber phosphor: 16 steps from tinted near-black to #FFB000. */
export const AMBER_RAMP: readonly number[] = [
  0x140800, 0x241300, 0x331e00, 0x432a00, 0x533500, 0x624000, 0x724b00, 0x825600,
  0x916200, 0xa16d00, 0xb17800, 0xc08300, 0xd08e00, 0xe09a00, 0xefa500, 0xffb000,
];

/** P1 green phosphor: 16 steps from tinted near-black to #33FF33. */
export const GREEN_RAMP: readonly number[] = [
  0x041004, 0x072007, 0x0a300a, 0x0d400d, 0x115011, 0x146014, 0x177017, 0x1a801a,
  0x1d8f1d, 0x209f20, 0x23af23, 0x26bf26, 0x2acf2a, 0x2ddf2d, 0x30ef30, 0x33ff33,
];

/** Game Boy (DMG) LCD shades, darkest to lightest. */
export const DMG_RAMP: readonly number[] = [0x0f380f, 0x306230, 0x8bac0f, 0x9bbc0f];

/**
 * Builds a 256-entry luma -> color table. Each luma maps to the ramp entry with the nearest own
 * luma (ties go to the darker entry). Ramp lumas must be strictly increasing.
 */
function buildLumaTable(ramp: readonly number[]): Uint32Array {
  const lumas = ramp.map((c) => lumaPacked(c));
  for (let i = 1; i < lumas.length; i++) {
    if ((lumas[i] ?? 0) <= (lumas[i - 1] ?? 0)) {
      throw new RangeError('palette ramp lumas must be strictly increasing');
    }
  }
  const table = new Uint32Array(256);
  let k = 0;
  for (let y = 0; y < 256; y++) {
    while (k + 1 < ramp.length && Math.abs((lumas[k + 1] ?? 0) - y) < Math.abs((lumas[k] ?? 0) - y)) k++;
    table[y] = ramp[k] ?? 0;
  }
  return table;
}

function createRampPalette(name: PaletteName, ramp: readonly number[]): PaletteMap {
  const table = buildLumaTable(ramp);
  return {
    name,
    apply(rgb: number): number {
      return table[lumaPacked(rgb)] ?? 0;
    },
    applyGrid(grid: CellGrid): void {
      const { fg, bg } = grid;
      for (let i = 0; i < fg.length; i++) {
        fg[i] = table[lumaPacked(fg[i] ?? 0)] ?? 0;
        bg[i] = table[lumaPacked(bg[i] ?? 0)] ?? 0;
      }
    },
  };
}

function createIdentityPalette(): PaletteMap {
  return {
    name: 'truecolor',
    apply(rgb: number): number {
      return rgb & 0xffffff;
    },
    applyGrid(grid: CellGrid): void {
      const { fg, bg } = grid;
      for (let i = 0; i < fg.length; i++) {
        fg[i] = (fg[i] ?? 0) & 0xffffff;
        bg[i] = (bg[i] ?? 0) & 0xffffff;
      }
    },
  };
}

export function createPalette(name: PaletteName): PaletteMap {
  switch (name) {
    case 'truecolor':
      return createIdentityPalette();
    case 'amber':
      return createRampPalette('amber', AMBER_RAMP);
    case 'green':
      return createRampPalette('green', GREEN_RAMP);
    case 'dmg':
      return createRampPalette('dmg', DMG_RAMP);
  }
}
