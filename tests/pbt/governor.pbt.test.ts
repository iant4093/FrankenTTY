import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createGovernor } from '../../src/renderer/governor.ts';
import type { Governor, GovernorOptions } from '../../src/renderer/governor.ts';

const WINDOW = 1000;
const UP_AFTER = 3000;
const COOLDOWN = 1000;
/** Hysteresis of the cell-cap levels (src/renderer/governor.ts header). */
const CAP_DOWN_AFTER = 3000;
const CAP_UP_AFTER = 2000;
const CAP_UP_FRACTION = 0.75;

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

/** A reset (mode change) is drawn after a sample when its draw is below RESET_RATE of 1000. */
const RESET_RATE = 6;
const resetDraws = fc.array(fc.integer({ min: 0, max: 999 }), { minLength: 300, maxLength: 300 });

describe('[REQ-PERF-01] governor properties', () => {
  let increasesSeen = 0;
  let decreasesSeen = 0;
  let capLeavesSeen = 0;

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

  it('(c) a level increase only follows a sustained low p90 (0.5 for 3 s; out of a cap level 0.75 for 2 s)', () => {
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
            if (g.settingsAt(previous).maxCells !== null) capLeavesSeen++;
            // Leaving a cell-cap level takes less evidence than leaving a color level.
            const leftCap = g.settingsAt(previous).maxCells !== null;
            const fraction = leftCap ? CAP_UP_FRACTION : 0.5;
            const upAfter = leftCap ? CAP_UP_AFTER : UP_AFTER;
            // The streak cannot start before the cooldown ends, and must last upAfter.
            if (s.at - lastChange < COOLDOWN + upAfter) return false;
            // Every window ending in the last (upAfter - windowMs) has p90 under `fraction` of the budget.
            for (let j = i; j >= 0 && (samples[j] as Sample).at >= s.at - (upAfter - WINDOW); j--) {
              const end = (samples[j] as Sample).at;
              const inWindow: number[] = [];
              for (let k = j; k >= 0 && (samples[k] as Sample).at > end - WINDOW; k--) {
                const w = samples[k] as Sample;
                inWindow.push(w.skip ? 2 * budget : w.ms);
              }
              if (inWindow.length < 5 || !(p90Of(inWindow) < fraction * budget)) return false;
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
          // A color step needs a fresh window; a cell-cap step also needs CAP_DOWN_AFTER over budget.
          let capSteps = 0;
          for (let level = 1; level <= g.maxLevel(); level++) {
            if (g.settingsAt(level).maxCells !== null) capSteps++;
          }
          const bound = g.maxLevel() * (COOLDOWN + WINDOW) + capSteps * CAP_DOWN_AFTER;
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

  it('(c) sanity: leaving a cell-cap level at 0.75 happens in the generator', () => {
    expect(capLeavesSeen).toBeGreaterThan(20);
  });

  it('(f) a mode change never leaves maxCells set, keeps lower levels, and the next 4 samples change nothing', () => {
    let resets = 0;
    let capDrops = 0;
    fc.assert(
      fc.property(config, blocks, resetDraws, fc.boolean(), (c, bs, draws, enabled) => {
        const g = createGovernor(options(c, enabled));
        let uncappedTop = g.maxLevel();
        for (let level = 0; level <= g.maxLevel(); level++) {
          if (g.settingsAt(level).maxCells !== null) {
            uncappedTop = level - 1;
            break;
          }
        }
        const samples = expand(bs, c.fps);
        let quiet = 0; // samples still to check after a reset
        let levelAtReset = 0;
        for (let i = 0; i < samples.length; i++) {
          const s = samples[i] as Sample;
          feedSample(g, s);
          if (quiet > 0) {
            if (i > 0 && g.level() !== levelAtReset) return false;
            quiet--;
          }
          if ((draws[i % draws.length] as number) >= RESET_RATE) continue;
          const before = g.level();
          let fired = 0;
          g.onChange(() => fired++);
          g.reset(s.at);
          resets++;
          const after = g.level();
          if (g.settings().maxCells !== null) return false;
          if (after > uncappedTop) return false;
          if (before <= uncappedTop && (after !== before || fired !== 0)) return false;
          if (before > uncappedTop) {
            capDrops++;
            if (after !== uncappedTop || fired !== 1) return false;
          }
          if (!enabled && after !== 0) return false;
          levelAtReset = after;
          quiet = 4;
        }
        return true;
      }),
      { numRuns: 1000 },
    );
    expect(resets).toBeGreaterThan(1000);
    expect(capDrops).toBeGreaterThan(20);
  });

  it('(g) a cell-cap level is entered only after p90 stayed over 0.9 of the budget for the last 3 s', () => {
    let entries = 0;
    fc.assert(
      fc.property(config, blocks, resetDraws, (c, bs, draws) => {
        const budget = 1000 / c.fps;
        const g = createGovernor(options(c));
        const samples = expand(bs, c.fps);
        let previous = 0;
        // Samples before this time were ignored by the governor (cooldown after a change, or cleared by a reset).
        let acceptFrom = -Infinity;
        const valueOf = (w: Sample): number => (w.skip ? 2 * budget : w.ms);
        for (let i = 0; i < samples.length; i++) {
          const s = samples[i] as Sample;
          feedSample(g, s);
          let now = g.level();
          if (now !== previous) {
            if (now > previous && g.settingsAt(now).maxCells !== null) {
              entries++;
              // Every 1 s window ending in the last 3 s is over budget.
              for (let j = i; j >= 0 && (samples[j] as Sample).at >= s.at - CAP_DOWN_AFTER; j--) {
                const end = (samples[j] as Sample).at;
                if (end < acceptFrom) return false;
                const inWindow: number[] = [];
                for (let k = j; k >= 0 && (samples[k] as Sample).at > end - WINDOW; k--) {
                  if ((samples[k] as Sample).at < acceptFrom) break;
                  inWindow.push(valueOf(samples[k] as Sample));
                }
                if (inWindow.length < 5 || !(p90Of(inWindow) > 0.9 * budget)) return false;
              }
            }
            acceptFrom = s.at + COOLDOWN;
            previous = now;
          }
          if ((draws[i % draws.length] as number) < RESET_RATE) {
            g.reset(s.at);
            now = g.level();
            acceptFrom = now !== previous ? s.at + COOLDOWN : Math.max(acceptFrom, s.at + 0.001);
            previous = now;
          }
        }
        return true;
      }),
      { numRuns: 1000 },
    );
    expect(entries).toBeGreaterThan(20);
  });
});
