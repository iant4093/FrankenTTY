import fc from 'fast-check';
import { describe, it } from 'vitest';
import { createHalfblockSerializer } from '../../src/renderer/halfblock.ts';
import { readCell, replayInto } from '../helpers/emulator.ts';

const pack = (r: number, g: number, b: number): number => (r << 16) | (g << 8) | b;

// P2c-naive: replaying serializeNaive output in a real emulator reproduces every input cell exactly.
describe('[P2c][REQ-RENDER-01] naive halfblock serializer in @xterm/headless', () => {
  const cases = fc
    .record({
      c: fc.integer({ min: 1, max: 24 }),
      r: fc.integer({ min: 1, max: 10 }),
      offsetX: fc.integer({ min: 0, max: 8 }),
      offsetY: fc.integer({ min: 0, max: 5 }),
    })
    .chain((g) =>
      fc.record({
        g: fc.constant(g),
        pixels: fc.uint8Array({ minLength: g.c * 2 * g.r * 3, maxLength: g.c * 2 * g.r * 3 }),
      }),
    );

  it('draws top pixel as foreground and bottom pixel as background of an upper half block', async () => {
    await fc.assert(
      fc.asyncProperty(cases, async ({ g, pixels }) => {
        const s = createHalfblockSerializer(g.c, g.r);
        const out = s.serializeNaive(pixels, g.offsetX, g.offsetY);
        // One extra row for the HUD, as in the real layout.
        const term = await replayInto(out, g.c + g.offsetX, g.r + g.offsetY + 1);
        try {
          for (let y = 0; y < g.r; y++) {
            for (let x = 0; x < g.c; x++) {
              const top = (2 * y * g.c + x) * 3;
              const bottom = ((2 * y + 1) * g.c + x) * 3;
              const got = readCell(term, g.offsetX + x, g.offsetY + y);
              const wantFg = pack(pixels[top] ?? 0, pixels[top + 1] ?? 0, pixels[top + 2] ?? 0);
              const wantBg = pack(pixels[bottom] ?? 0, pixels[bottom + 1] ?? 0, pixels[bottom + 2] ?? 0);
              if (got.char !== '\u2580' || got.fg !== wantFg || got.bg !== wantBg) return false;
            }
          }
          return true;
        } finally {
          term.dispose();
        }
      }),
      { numRuns: 200 },
    );
  });
});
