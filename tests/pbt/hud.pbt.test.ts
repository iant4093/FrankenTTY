import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MODES, PALETTES } from '../../src/cli/args.ts';
import { createHud, type HudState } from '../../src/tui/hud.ts';

const numberArb = fc.oneof(
  fc.double({ min: -100, max: 10_000_000, noNaN: false }),
  fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, 59.999, 3600, 1e12),
);

const stateArb: fc.Arbitrary<HudState> = fc.record({
  visible: fc.boolean(),
  playing: fc.boolean(),
  positionSec: numberArb,
  durationSec: fc.oneof(fc.constant(null), numberArb),
  fps: numberArb,
  kbPerSec: numberArb,
  sgrSavedPct: numberArb,
  qualityStep: numberArb,
  colorLabel: fc.constantFrom('24-bit' as const, '256' as const, '16' as const),
  mode: fc.constantFrom(...MODES),
  palette: fc.constantFrom(...PALETTES),
  message: fc.oneof(fc.constant(null), fc.string({ unit: 'binary', maxLength: 120 })),
});

const ESC = '\x1b';

describe('HUD property', () => {
  it('visible text is exactly cols columns, free of stray control bytes, and within capacity', () => {
    fc.assert(
      fc.property(
        stateArb.filter((s) => s.visible),
        fc.integer({ min: 1, max: 400 }),
        fc.integer({ min: 1, max: 500 }),
        fc.nat({ max: 64 }),
        (state, cols, row, offset) => {
          const hud = createHud(cols);
          const out = Buffer.alloc(offset + hud.capacity + 8, 0xee);
          const end = hud.render(state, out, offset, row);

          expect(end - offset).toBeLessThanOrEqual(hud.capacity);
          expect(out[end]).toBe(0xee); // nothing written past the returned offset
          for (let i = 0; i < offset; i++) expect(out[i]).toBe(0xee);

          const raw = out.subarray(offset, end).toString('utf8');
          const head = `${ESC}[${row};1H${ESC}[0;37;40m`;
          const tail = `${ESC}[0m`;
          expect(raw.startsWith(head)).toBe(true);
          expect(raw.endsWith(tail)).toBe(true);

          const text = raw.slice(head.length, raw.length - tail.length);
          const glyphs = [...text];
          expect(glyphs).toHaveLength(cols);
          expect(text).not.toContain('\ufffd'); // valid UTF-8, no split glyphs
          for (const glyph of glyphs) {
            const cp = glyph.codePointAt(0) ?? 0;
            expect(cp >= 0x20 && cp !== 0x7f && !(cp >= 0x80 && cp < 0xa0)).toBe(true);
          }
        },
      ),
      { numRuns: 1000 },
    );
  });

  it('hidden form is always CUP, reset, erase-line', () => {
    fc.assert(
      fc.property(stateArb, fc.integer({ min: 1, max: 400 }), fc.integer({ min: 1, max: 500 }), (state, cols, row) => {
        const hud = createHud(cols);
        const out = Buffer.alloc(hud.capacity);
        const end = hud.render({ ...state, visible: false }, out, 0, row);
        expect(out.subarray(0, end).toString('latin1')).toBe(`${ESC}[${row};1H${ESC}[0m${ESC}[2K`);
        expect(end).toBeLessThanOrEqual(hud.capacity);
      }),
      { numRuns: 1000 },
    );
  });
});
