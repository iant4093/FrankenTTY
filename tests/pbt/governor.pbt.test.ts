import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createGovernor } from '../../src/renderer/governor.ts';
import type { Governor, GovernorOptions } from '../../src/renderer/governor.ts';

const WINDOW = 1000;
const UP_AFTER = 3000;
const COOLDOWN = 1000;

const config = fc.record({
  fps: fc.integer({ min: 10, max: 60 }),
  baseThreshold: fc.integer({ min: 0, max: 60 }),
  baseDepth: fc.constantFrom(24 as const, 8 as const, 4 as const),
  baseCells: fc.integer({ min: 100, max: 40_000 }),
  minCells: fc.integer({ min: 200, max: 3000 }),
});
interface Config {
  fps: number;
  baseThreshold: number;
  baseDepth: 24 | 8 | 4;
  baseCells: number;
  minCells: number;
}

function options(c: Config, enabled = true): GovernorOptions {
  return { ...c, enabled };
}

/** Smallest gap that keeps a 1 s window under the ring capacity (2 * fps), largest is 100 ms. */
function minGap(fps: number): number {
  return Math.floor(500 / fps) + 1;
}

function gapFrom(g: number, fps: number): number {
  const m = minGap(fps);
  return m + Math.floor((g / 1000) * (100 - m));
}

type Mode = 'slow' | 'fast' | 'mixed';
interface Block {
  mode: Mode;
  len: number;
  seed: [number, number][];
}
const block: fc.Arbitrary<Block> = fc.record({
  mode: fc.constantFrom<Mode>('slow', 'fast', 'fast', 'mixed'),
  len: fc.integer({ min: 1, max: 300 }),
  seed: fc.array(fc.tuple(fc.integer({ min: 0, max: 1000 }), fc.integer({ min: 0, max: 1000 })), {
    minLength: 1,
    maxLength: 16,
  }),
});

interface Sample {
  at: number;
  ms: number;
  skip: boolean;
}

function expand(blocks: Block[], fps: number): Sample[] {
  const budget = 1000 / fps;
  const out: Sample[] = [];
  let t = 0;
  for (const b of blocks) {
    for (let i = 0; i < b.len; i++) {
      const [g, f] = b.seed[i % b.seed.length] as [number, number];
      t += gapFrom(g, fps);
      const u = f / 1000;
      let factor: number;
      if (b.mode === 'slow') factor = 1.5 + u * 2.5;
      else if (b.mode === 'fast') factor = u * 0.45;
      else factor = u * 4;
      const skip = b.mode === 'slow' && f % 7 === 0;
      out.push({ at: t, ms: factor * budget, skip });
    }
  }
  return out;
}

function feedSample(gov: Governor, s: Sample): void {
  if (s.skip) gov.recordSkip(s.at);
  else gov.record(s.ms, s.at);
}

function p90Of(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(0.9 * sorted.length) - 1] as number;
}

const blocks = fc.array(block, { minLength: 1, maxLength: 20 });

describe('governor properties', () => {
  let increasesSeen = 0;
  let decreasesSeen = 0;

  it('(a) level stays in [0, maxLevel]; disabled stays at 0', () => {
    fc.assert(
      fc.property(config, blocks, fc.boolean(), (c, bs, enabled) => {
        const g = createGovernor(options(c, enabled));
        for (const s of expand(bs, c.fps)) {
          feedSample(g, s);
          const l = g.level();
          if (!Number.isInteger(l) || l < 0 || l > g.maxLevel()) return false;
          if (!enabled && l !== 0) return false;
        }
        return true;
      }),
      { numRuns: 1000 },
    );
  });

  it('(b) no two level changes are closer than cooldownMs', () => {
    fc.assert(
      fc.property(config, blocks, (c, bs) => {
        const g = createGovernor(options(c));
        let previous = g.level();
        let lastChange = -Infinity;
        for (const s of expand(bs, c.fps)) {
          feedSample(g, s);
          if (g.level() !== previous) {
            if (s.at - lastChange < COOLDOWN) return false;
            lastChange = s.at;
            previous = g.level();
          }
        }
        return true;
      }),
      { numRuns: 1000 },
    );
  });

  it('(c) a level increase only follows upAfterMs of sustained low p90', () => {
    fc.assert(
      fc.property(config, blocks, (c, bs) => {
        const budget = 1000 / c.fps;
        const g = createGovernor(options(c));
        const samples = expand(bs, c.fps);
        let previous = g.level();
        let lastChange = -Infinity;
        for (let i = 0; i < samples.length; i++) {
          const s = samples[i] as Sample;
          feedSample(g, s);
          const now = g.level();
          if (now === previous) continue;
          if (now > previous) {
            lastChange = s.at;
          } else {
            increasesSeen++;
            // The streak cannot start before the cooldown ends, and must last upAfterMs.
            if (s.at - lastChange < COOLDOWN + UP_AFTER) return false;
            // Every window ending in the last (upAfterMs - windowMs) has p90 under half the budget.
            for (let j = i; j >= 0 && (samples[j] as Sample).at >= s.at - (UP_AFTER - WINDOW); j--) {
              const end = (samples[j] as Sample).at;
              const inWindow: number[] = [];
              for (let k = j; k >= 0 && (samples[k] as Sample).at > end - WINDOW; k--) {
                const w = samples[k] as Sample;
                inWindow.push(w.skip ? 2 * budget : w.ms);
              }
              if (inWindow.length < 5 || !(p90Of(inWindow) < 0.5 * budget)) return false;
            }
            lastChange = s.at;
            decreasesSeen++;
          }
          previous = now;
        }
        return true;
      }),
      { numRuns: 1000 },
    );
  });

  it('(c) sanity: the generator exercised level increases', () => {
    expect(increasesSeen).toBeGreaterThan(100);
    expect(decreasesSeen).toBe(increasesSeen);
  });

  it('(d) under constant overload the level never increases and reaches maxLevel in time', () => {
    fc.assert(
      fc.property(
        config,
        fc.array(
          fc.tuple(fc.integer({ min: 0, max: 1000 }), fc.integer({ min: 0, max: 1000 }), fc.boolean()),
          { minLength: 1, maxLength: 64 },
        ),
        (c, seed) => {
          const budget = 1000 / c.fps;
          const g = createGovernor(options(c));
          const bound = g.maxLevel() * (COOLDOWN + WINDOW);
          let t = 0;
          let i = 0;
          let previous = 0;
          let reachedBy = Infinity;
          while (t <= bound + 2000) {
            const [gap, factor, skip] = seed[i++ % seed.length] as [number, number, boolean];
            t += gapFrom(gap, c.fps);
            if (skip) g.recordSkip(t);
            else g.record((2.001 + (factor / 1000) * 4) * budget, t);
            const l = g.level();
            if (l < previous) return false;
            previous = l;
            if (l === g.maxLevel() && reachedBy === Infinity) reachedBy = t;
          }
          return reachedBy <= bound;
        },
      ),
      { numRuns: 1000 },
    );
  });

  it('(e) settings are monotonic in level and respect minCells', () => {
    fc.assert(
      fc.property(config, (c) => {
        const g = createGovernor(options(c));
        let cells = Infinity;
        let threshold = -Infinity;
        for (let level = 0; level <= g.maxLevel(); level++) {
          const s = g.settingsAt(level);
          if (s.threshold < threshold) return false;
          threshold = s.threshold;
          if (s.maxCells !== null) {
            if (s.maxCells > cells || s.maxCells < c.minCells) return false;
            cells = s.maxCells;
          } else if (cells !== Infinity) {
            return false; // a cap never goes away again
          }
        }
        return g.settingsAt(0).threshold === c.baseThreshold && g.settingsAt(0).maxCells === null;
      }),
      { numRuns: 1000 },
    );
  });

  it('(e) onChange fires exactly once per level change, by one level, with matching settings', () => {
    fc.assert(
      fc.property(config, blocks, (c, bs) => {
        const g = createGovernor(options(c));
        const calls: { level: number; same: boolean }[] = [];
        g.onChange((s, level) => calls.push({ level, same: s === g.settings() }));
        let previous = 0;
        let expected = 0;
        for (const s of expand(bs, c.fps)) {
          const before = calls.length;
          feedSample(g, s);
          const now = g.level();
          if (now !== previous) {
            expected++;
            if (Math.abs(now - previous) !== 1) return false;
            if (calls.length !== before + 1) return false;
            const call = calls[calls.length - 1];
            if (call === undefined || call.level !== now || !call.same) return false;
          } else if (calls.length !== before) {
            return false;
          }
          previous = now;
        }
        return calls.length === expected;
      }),
      { numRuns: 1000 },
    );
  });
});
