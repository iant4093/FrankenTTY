import fc from 'fast-check';
import { describe, it } from 'vitest';
import { MODES, PALETTES } from '../../src/cli/args.ts';
import { createMapper } from '../../src/renderer/color-depth.ts';
import type { Emulator } from '../helpers/emulator.ts';
import type { Mode, Palette } from '../../src/cli/args.ts';
import { createPipeline } from '../../src/player/pipeline.ts';
import { feed, readCell, replayInto } from '../helpers/emulator.ts';

// P8: the pipeline's deltas, invalidations, row refreshes and mode/palette switches (which keep the screen
// model) always leave the emulator showing exactly what a fresh pipeline draws for the final frame
// (threshold 0, 24-bit).

const stepArb = fc.oneof(
  fc.record({ op: fc.constant('render' as const), edits: fc.array(fc.tuple(fc.nat(), fc.integer({ min: 0, max: 255 })), { maxLength: 12 }) }),
  fc.record({ op: fc.constant('mode' as const), mode: fc.constantFrom<Mode>(...MODES) }),
  fc.record({ op: fc.constant('palette' as const), palette: fc.constantFrom<Palette>(...PALETTES) }),
  fc.record({ op: fc.constant('invalidate' as const) }),
  fc.record({ op: fc.constant('refresh' as const) }),
  fc.record({ op: fc.constant('rows' as const), start: fc.nat({ max: 5 }), count: fc.nat({ max: 5 }) }),
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
            } else if (step.op === 'refresh') {
              live.refreshRolling();
            } else if (step.op === 'rows') {
              live.invalidateRows(step.start, step.count);
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

// P8b: setDepth() and setThreshold() keep the screen model: with the pixels unchanged, a second render with
// no setter in between writes nothing, and every write uses the current depth's sequences.
describe('P8b pipeline quality setters', () => {
  const opArb = fc.oneof(
    fc.record({ op: fc.constant('depth' as const), depth: fc.constantFrom(24 as const, 8 as const, 4 as const) }),
    fc.record({ op: fc.constant('threshold' as const), threshold: fc.integer({ min: 0, max: 100 }) }),
    fc.record({ op: fc.constant('render' as const) }),
  );

  it('a repeated identical frame is empty unless a setter ran; writes never exceed the grid; sequences match the depth', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 6 }),
        fc.integer({ min: 1, max: 4 }),
        fc.constantFrom<Mode>(...MODES),
        fc.array(fc.integer({ min: 0, max: 255 }), { minLength: 1, maxLength: 16 }),
        fc.array(opArb, { minLength: 1, maxLength: 10 }),
        (cols, rows, mode, seed, ops) => {
          const pixels = new Uint8Array(cols * 2 * rows * 4 * 3);
          for (let i = 0; i < pixels.length; i++) pixels[i] = (seed[i % seed.length] ?? 0) ^ ((i * 13) & 255);
          const p = createPipeline({ cols, rows, offsetX: 0, offsetY: 0, mode, palette: 'truecolor', depth: 24, threshold: 0 });
          p.render(pixels);
          let setterRan = false;
          for (const o of ops) {
            if (o.op === 'depth') {
              if (o.depth !== p.depth) setterRan = true;
              p.setDepth(o.depth);
              if (p.depth !== o.depth) return false;
            } else if (o.op === 'threshold') {
              if (o.threshold !== p.threshold) setterRan = true;
              p.setThreshold(o.threshold);
              if (p.threshold !== o.threshold) return false;
            } else {
              const out = p.render(pixels);
              if (p.stats.cellsWritten > cols * rows) return false;
              const text = Buffer.from(out).toString('latin1');
              if (/\x1b\[[\d;]*[34]8;2;/.test(text) && p.depth !== 24) return false;
              if (/\x1b\[[\d;]*[34]8;5;/.test(text) && p.depth !== 8) return false;
              if (!setterRan && out.length !== 0) return false; // same pixels, same depth, same threshold
              setterRan = false;
            }
          }
          return true;
        },
      ),
      { numRuns: 300 },
    );
  });
});

/** RGB the emulator shows for a cell color, whether it is a 24-bit or a palette color at `depth`. */
function shownRgb(term: Emulator, x: number, y: number, which: 'fg' | 'bg', depth: 24 | 8 | 4): number | null {
  const cell = term.buffer.active.getLine(y)?.getCell(x);
  if (cell === undefined) return null;
  const rgb = which === 'fg' ? cell.isFgRGB() : cell.isBgRGB();
  const pal = which === 'fg' ? cell.isFgPalette() : cell.isBgPalette();
  const value = which === 'fg' ? cell.getFgColor() : cell.getBgColor();
  if (rgb) return value;
  return pal ? createMapper(depth).toRgb(value) : null;
}

// P8c: switching the color depth keeps the screen model, in RGB. With threshold 0, after any sequence of depth
// switches and renders, the emulator shows the same colors as a fresh pipeline at the final depth.
describe('P8c pipeline depth switches', () => {
  const stepArb = fc.oneof(
    fc.record({ op: fc.constant('depth' as const), depth: fc.constantFrom(24 as const, 8 as const, 4 as const) }),
    fc.record({ op: fc.constant('render' as const), edits: fc.array(fc.tuple(fc.nat(), fc.integer({ min: 0, max: 255 })), { maxLength: 12 }) }),
  );

  it('the emulator equals a fresh pipeline at the final depth', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 5 }),
        fc.integer({ min: 1, max: 4 }),
        fc.constantFrom<Mode>(...MODES),
        fc.array(fc.integer({ min: 0, max: 255 }), { minLength: 1, maxLength: 16 }),
        fc.array(stepArb, { minLength: 1, maxLength: 8 }),
        async (cols, rows, mode, seed, steps) => {
          const pixels = new Uint8Array(cols * 2 * rows * 4 * 3);
          for (let i = 0; i < pixels.length; i++) pixels[i] = (seed[i % seed.length] ?? 0) ^ ((i * 13) & 255);
          const base = { cols, rows, offsetX: 0, offsetY: 0, mode, palette: 'truecolor' as const, threshold: 0 };
          const live = createPipeline({ ...base, depth: 24 });
          const term = await replayInto(Buffer.from(live.render(pixels)), cols, rows + 1);
          const refTerm = await replayInto('', cols, rows + 1);
          try {
            for (const step of steps) {
              if (step.op === 'depth') {
                live.setDepth(step.depth);
              } else {
                for (const [at, value] of step.edits) pixels[at % pixels.length] = value;
                await feed(term, Buffer.from(live.render(pixels)));
              }
            }
            await feed(term, Buffer.from(live.render(pixels)));
            const depth = live.depth;
            const ref = createPipeline({ ...base, depth });
            await feed(refTerm, Buffer.from(ref.render(pixels)));
            for (let y = 0; y < rows; y++) {
              for (let x = 0; x < cols; x++) {
                const got = term.buffer.active.getLine(y)?.getCell(x);
                const want = refTerm.buffer.active.getLine(y)?.getCell(x);
                const space = (ch: string | undefined): boolean => ch === undefined || ch === '' || ch === ' ';
                if (space(got?.getChars()) !== space(want?.getChars())) return false;
                if (shownRgb(term, x, y, 'bg', depth) !== shownRgb(refTerm, x, y, 'bg', depth)) return false;
                if (!space(got?.getChars())) {
                  if (got?.getChars() !== want?.getChars()) return false;
                  if (shownRgb(term, x, y, 'fg', depth) !== shownRgb(refTerm, x, y, 'fg', depth)) return false;
                }
              }
            }
            return true;
          } finally {
            term.dispose();
            refTerm.dispose();
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
