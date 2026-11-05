import fc from 'fast-check';
import { describe, it } from 'vitest';
import { MODES, PALETTES } from '../../src/cli/args.ts';
import type { Mode, Palette } from '../../src/cli/args.ts';
import { createPipeline } from '../../src/player/pipeline.ts';
import { feed, readCell, replayInto } from '../helpers/emulator.ts';

// P8: the pipeline's deltas, invalidations and mode/palette switches always leave the emulator showing
// exactly what a fresh pipeline draws for the final frame (threshold 0, 24-bit).

const stepArb = fc.oneof(
  fc.record({ op: fc.constant('render' as const), edits: fc.array(fc.tuple(fc.nat(), fc.integer({ min: 0, max: 255 })), { maxLength: 12 }) }),
  fc.record({ op: fc.constant('mode' as const), mode: fc.constantFrom<Mode>(...MODES) }),
  fc.record({ op: fc.constant('palette' as const), palette: fc.constantFrom<Palette>(...PALETTES) }),
  fc.record({ op: fc.constant('invalidate' as const) }),
);

const caseArb = fc.record({
  cols: fc.integer({ min: 1, max: 6 }),
  rows: fc.integer({ min: 1, max: 4 }),
  offsetX: fc.integer({ min: 0, max: 3 }),
  offsetY: fc.integer({ min: 0, max: 2 }),
  mode: fc.constantFrom<Mode>(...MODES),
  palette: fc.constantFrom<Palette>(...PALETTES),
  seed: fc.array(fc.integer({ min: 0, max: 255 }), { minLength: 1, maxLength: 16 }),
  steps: fc.array(stepArb, { minLength: 1, maxLength: 8 }),
});

describe('P8 pipeline', () => {
  it('after any sequence of renders, mode/palette switches and invalidations, the emulator equals a fresh full render', async () => {
    await fc.assert(
      fc.asyncProperty(caseArb, async (c) => {
        const width = c.cols * 2;
        const height = c.rows * 4;
        const base = { cols: c.cols, rows: c.rows, offsetX: c.offsetX, offsetY: c.offsetY, depth: 24 as const, threshold: 0 };
        const pixels = new Uint8Array(width * height * 3);
        for (let i = 0; i < pixels.length; i++) pixels[i] = c.seed[i % c.seed.length] ?? 0;
        // Break the periodic pattern so neighbouring cells differ.
        for (let i = 0; i < pixels.length; i += 7) pixels[i] = (pixels[i] ?? 0) ^ ((i * 31) & 255);

        const live = createPipeline({ ...base, mode: c.mode, palette: c.palette });
        const cols = c.cols + c.offsetX;
        const rows = c.rows + c.offsetY + 1;
        const live0 = live.render(pixels);
        const term = await replayInto(Buffer.from(live0), cols, rows);
        const refTerm = await replayInto('', cols, rows);
        try {
          for (const step of c.steps) {
            if (step.op === 'render') {
              for (const [at, value] of step.edits) pixels[at % pixels.length] = value;
              await feed(term, Buffer.from(live.render(pixels)));
            } else if (step.op === 'mode') {
              live.setMode(step.mode);
            } else if (step.op === 'palette') {
              live.setPalette(step.palette);
            } else {
              live.invalidate();
            }
          }
          await feed(term, Buffer.from(live.render(pixels)));

          const ref = createPipeline({ ...base, mode: live.mode, palette: live.palette });
          await feed(refTerm, Buffer.from(ref.render(pixels)));

          for (let y = 0; y < c.rows; y++) {
            for (let x = 0; x < c.cols; x++) {
              const got = readCell(term, c.offsetX + x, c.offsetY + y);
              const want = readCell(refTerm, c.offsetX + x, c.offsetY + y);
              const space = (ch: string): boolean => ch === '' || ch === ' ';
              if (space(got.char) !== space(want.char)) return false;
              if (!space(got.char) && (got.char !== want.char || got.fg !== want.fg)) return false;
              if (got.bg !== want.bg) return false;
            }
          }
          return true;
        } finally {
          term.dispose();
          refTerm.dispose();
        }
      }),
      { numRuns: 200 },
    );
  });
});
