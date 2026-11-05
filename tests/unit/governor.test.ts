import { describe, expect, it } from 'vitest';
import { createGovernor } from '../../src/renderer/governor.ts';
import type { Governor, GovernorOptions } from '../../src/renderer/governor.ts';

const BASE: GovernorOptions = {
  fps: 30,
  baseThreshold: 8,
  baseDepth: 24,
  baseCells: 17_568, // 244x72
  enabled: true,
};
const BUDGET = 1000 / 30;
const STEP = 33; // ms between ticks in the tests

/** Feeds `frameMs` samples every STEP ms from `from` for `durationMs`. Returns the end time. */
function feed(gov: Governor, from: number, durationMs: number, frameMs: number): number {
  let t = from;
  const end = from + durationMs;
  while (t < end) {
    gov.record(frameMs, t);
    t += STEP;
  }
  return t;
}

describe('settings per level', () => {
  it('24-bit base: threshold steps, then 256-color, then cell caps', () => {
    const g = createGovernor(BASE);
    const expected = [
      { threshold: 8, depth: 24, maxCells: null },
      { threshold: 16, depth: 24, maxCells: null },
      { threshold: 24, depth: 24, maxCells: null },
      { threshold: 24, depth: 8, maxCells: null },
      { threshold: 24, depth: 8, maxCells: 14_054 },
      { threshold: 24, depth: 8, maxCells: 11_244 },
      { threshold: 24, depth: 8, maxCells: 8_995 },
      { threshold: 24, depth: 8, maxCells: 7_196 },
      { threshold: 24, depth: 8, maxCells: 5_757 },
    ];
    expect(g.maxLevel()).toBe(8);
    expected.forEach((e, level) => {
      expect(g.settingsAt(level)).toEqual(e);
    });
  });

  it('starts at level 0 with the base settings', () => {
    const g = createGovernor(BASE);
    expect(g.level()).toBe(0);
    expect(g.settings()).toEqual({ threshold: 8, depth: 24, maxCells: null });
  });

  it('skips the 256-color level when the base depth is 8', () => {
    const g = createGovernor({ ...BASE, baseDepth: 8 });
    expect(g.maxLevel()).toBe(7);
    for (let level = 0; level <= 7; level++) expect(g.settingsAt(level).depth).toBe(8);
    expect(g.settingsAt(2)).toEqual({ threshold: 24, depth: 8, maxCells: null });
    expect(g.settingsAt(3).maxCells).toBe(14_054);
  });

  it('skips the 256-color level when the base depth is 4', () => {
    const g = createGovernor({ ...BASE, baseDepth: 4 });
    expect(g.maxLevel()).toBe(7);
    for (let level = 0; level <= 7; level++) expect(g.settingsAt(level).depth).toBe(4);
    expect(g.settingsAt(3).maxCells).toBe(14_054);
  });

  it('stops adding cell levels at minCells and clamps the last one', () => {
    const g = createGovernor({ ...BASE, baseCells: 2000 });
    // 1600, 1280, 1024, then round(819.2) clamps to 960 and ends the ladder.
    expect(g.maxLevel()).toBe(7);
    expect([4, 5, 6, 7].map((l) => g.settingsAt(l).maxCells)).toEqual([1600, 1280, 1024, 960]);
  });

  it('adds one clamped cell level when the first step already crosses minCells', () => {
    const g = createGovernor({ ...BASE, baseCells: 1200 });
    expect(g.maxLevel()).toBe(4);
    expect(g.settingsAt(4).maxCells).toBe(960);
  });

  it('adds no cell levels when baseCells is at or below minCells', () => {
    expect(createGovernor({ ...BASE, baseCells: 960 }).maxLevel()).toBe(3);
    expect(createGovernor({ ...BASE, baseCells: 500 }).maxLevel()).toBe(3);
  });

  it('honors a custom minCells', () => {
    const g = createGovernor({ ...BASE, baseCells: 10_000, minCells: 9000 });
    expect(g.maxLevel()).toBe(4);
    expect(g.settingsAt(4).maxCells).toBe(9000);
  });

  it('returns a stable object per level', () => {
    const g = createGovernor(BASE);
    expect(g.settings()).toBe(g.settings());
    expect(g.settingsAt(0)).toBe(g.settings());
  });

  it('rejects an out-of-range level in settingsAt', () => {
    const g = createGovernor(BASE);
    expect(() => g.settingsAt(99)).toThrow(RangeError);
    expect(() => g.settingsAt(-1)).toThrow(RangeError);
  });

  it('never raises the threshold above 100', () => {
    const g = createGovernor({ ...BASE, baseThreshold: 95 });
    expect(g.settingsAt(2).threshold).toBe(100);
    expect(g.settingsAt(g.maxLevel()).threshold).toBe(100);
  });
});

describe('stepping down', () => {
  it('steps down once per cooldown under sustained overload, up to the floor', () => {
    const g = createGovernor(BASE);
    const changes: number[] = [];
    let now = 0;
    g.onChange(() => changes.push(now));
    for (now = 0; now < 40_000; now += STEP) g.record(100, now);
    expect(g.level()).toBe(g.maxLevel());
    expect(changes).toHaveLength(g.maxLevel());
    for (let i = 1; i < changes.length; i++) {
      expect((changes[i] as number) - (changes[i - 1] as number)).toBeGreaterThanOrEqual(1000);
    }
  });

  it('first step happens as soon as the fifth overloaded sample arrives', () => {
    const g = createGovernor(BASE);
    for (let i = 0; i < 4; i++) g.record(100, i * STEP);
    expect(g.level()).toBe(0);
    g.record(100, 4 * STEP);
    expect(g.level()).toBe(1);
  });

  it('does nothing with fewer than 5 samples in the window', () => {
    const g = createGovernor(BASE);
    for (let i = 0; i < 4; i++) g.record(10_000, i * 10);
    expect(g.level()).toBe(0);
    // Same four samples, but the first ones age out before the fifth arrives.
    const h = createGovernor(BASE);
    for (let i = 0; i < 4; i++) h.record(10_000, i * 10);
    h.record(10_000, 1500);
    expect(h.level()).toBe(0);
  });

  it('ignores samples inside the cooldown, then needs a fresh window', () => {
    const g = createGovernor(BASE);
    for (let i = 0; i < 5; i++) g.record(100, i * STEP); // level 1 at t = 132
    expect(g.level()).toBe(1);
    for (let t = 133; t < 132 + 1000; t += STEP) g.record(100, t);
    expect(g.level()).toBe(1);
    // After the cooldown the window is empty: four samples are not enough.
    for (let i = 0; i < 4; i++) g.record(100, 1132 + i * STEP);
    expect(g.level()).toBe(1);
    g.record(100, 1132 + 4 * STEP);
    expect(g.level()).toBe(2);
  });

  it('does not step down when p90 is at or under 0.9 of the budget', () => {
    const g = createGovernor(BASE);
    feed(g, 0, 10_000, 0.9 * BUDGET);
    expect(g.level()).toBe(0);
    feed(g, 10_000, 10_000, 0.8 * BUDGET);
    expect(g.level()).toBe(0);
  });

  it('tolerates a few slow outliers in the window (p90)', () => {
    const g = createGovernor(BASE);
    let t = 0;
    for (let i = 0; i < 300; i++) {
      // 8% slow, at most 3 of ~31 samples per window. With 10 or fewer samples p90 is the
      // maximum, so the first slow sample comes after the window has filled.
      g.record(i >= 12 && i % 12 === 0 ? 200 : 10, t);
      t += STEP;
    }
    expect(g.level()).toBe(0);
  });

  it('steps down when more than 10% of the window is slow', () => {
    const g = createGovernor(BASE);
    let t = 0;
    for (let i = 0; i < 60; i++) {
      g.record(i % 4 === 0 ? 200 : 10, t); // 25% slow
      t += STEP;
    }
    expect(g.level()).toBeGreaterThan(0);
  });

  it('counts skips as samples of twice the budget', () => {
    const g = createGovernor(BASE);
    for (let i = 0; i < 5; i++) g.recordSkip(i * STEP);
    expect(g.level()).toBe(1);
  });

  it('mixes skips and renders in one window', () => {
    const g = createGovernor(BASE);
    // One 224 ms render then six skips, as a 538 KB frame on a slow terminal produces.
    let t = 0;
    for (let i = 0; i < 4; i++) {
      g.record(224, t);
      t += STEP;
      for (let j = 0; j < 6; j++) {
        g.recordSkip(t);
        t += STEP;
      }
    }
    expect(g.level()).toBeGreaterThan(0);
  });
});

describe('stepping up', () => {
  function overloaded(): { g: Governor; now: number } {
    const g = createGovernor(BASE);
    let now = 0;
    // Drive to level 3.
    while (g.level() < 3) {
      g.record(100, now);
      now += STEP;
    }
    return { g, now };
  }

  it('steps up one level after upAfterMs of fast samples, then waits again', () => {
    const { g, now } = overloaded();
    const changes: number[] = [];
    let t = now;
    g.onChange(() => changes.push(t));
    for (; t < now + 30_000; t += STEP) g.record(5, t);
    expect(g.level()).toBe(0);
    expect(changes).toHaveLength(3);
    expect(changes[0] as number).toBeGreaterThanOrEqual(now + 3000);
    for (let i = 1; i < changes.length; i++) {
      expect((changes[i] as number) - (changes[i - 1] as number)).toBeGreaterThanOrEqual(3000);
    }
  });

  it('does not step up before upAfterMs has elapsed', () => {
    const { g, now } = overloaded();
    feed(g, now, 2900, 5);
    expect(g.level()).toBe(3);
  });

  it('does not step up when p90 sits between 0.5 and 0.9 of the budget', () => {
    const { g, now } = overloaded();
    feed(g, now, 20_000, 0.7 * BUDGET);
    expect(g.level()).toBe(3);
  });

  it('a slow burst restarts the upAfterMs streak', () => {
    const { g, now } = overloaded();
    let t = feed(g, now, 2500, 5);
    expect(g.level()).toBe(3);
    // 700 ms of mid-range samples (not slow enough to step down) break the streak.
    t = feed(g, t, 700, 0.7 * BUDGET);
    expect(g.level()).toBe(3);
    const restart = t;
    t = feed(g, t, 2800, 5);
    expect(g.level()).toBe(3);
    feed(g, t, 1500, 5);
    expect(g.level()).toBe(2);
    expect(t).toBeGreaterThanOrEqual(restart);
  });

  it('a long silence restarts the streak', () => {
    const { g, now } = overloaded();
    let t = feed(g, now, 2500, 5);
    t += 5000; // paused: no samples
    t = feed(g, t, 2800, 5);
    expect(g.level()).toBe(3);
    feed(g, t, 1500, 5);
    expect(g.level()).toBe(2);
  });

  it('stays at level 0 when already fast', () => {
    const g = createGovernor(BASE);
    feed(g, 0, 20_000, 1);
    expect(g.level()).toBe(0);
  });
});

describe('enabled = false (--quality max)', () => {
  it('stays at level 0 under overload', () => {
    const g = createGovernor({ ...BASE, enabled: false });
    for (let t = 0; t < 20_000; t += STEP) {
      g.record(500, t);
      g.recordSkip(t + 1);
    }
    expect(g.level()).toBe(0);
    expect(g.settings()).toEqual({ threshold: 8, depth: 24, maxCells: null });
  });

  it('never calls onChange', () => {
    const g = createGovernor({ ...BASE, enabled: false });
    let calls = 0;
    g.onChange(() => calls++);
    feed(g, 0, 10_000, 500);
    expect(calls).toBe(0);
  });
});

describe('onChange', () => {
  it('fires once per level change with the new settings and level', () => {
    const g = createGovernor(BASE);
    const seen: { level: number; threshold: number }[] = [];
    g.onChange((s, level) => seen.push({ level, threshold: s.threshold }));
    feed(g, 0, 3000, 100);
    expect(seen).toEqual([
      { level: 1, threshold: 16 },
      { level: 2, threshold: 24 },
      { level: 3, threshold: 24 },
    ]);
  });

  it('does not fire at the floor or when nothing changes', () => {
    const g = createGovernor({ ...BASE, baseCells: 500 });
    let calls = 0;
    g.onChange(() => calls++);
    feed(g, 0, 30_000, 100);
    expect(calls).toBe(3);
    expect(g.level()).toBe(3);
  });

  it('supports several listeners', () => {
    const g = createGovernor(BASE);
    let a = 0;
    let b = 0;
    g.onChange(() => a++);
    g.onChange(() => b++);
    feed(g, 0, 300, 100);
    expect([a, b]).toEqual([1, 1]);
  });
});

describe('input hygiene', () => {
  it('ignores non-finite samples', () => {
    const g = createGovernor(BASE);
    for (let i = 0; i < 20; i++) g.record(Number.NaN, i * STEP);
    for (let i = 0; i < 20; i++) g.record(Number.POSITIVE_INFINITY, i * STEP);
    expect(g.level()).toBe(0);
  });

  it('survives a very long run with bounded state', () => {
    const g = createGovernor(BASE);
    let t = 0;
    for (let i = 0; i < 200_000; i++) {
      g.record(i % 7 === 0 ? 40 : 3, t);
      t += 1;
    }
    expect(g.level()).toBeGreaterThanOrEqual(0);
  });

  it('treats a timestamp that runs backwards as the previous one', () => {
    const g = createGovernor(BASE);
    for (let i = 0; i < 4; i++) g.record(100, 1000);
    g.record(100, 0);
    expect(g.level()).toBe(1);
  });
});

describe('simulation: Apple Terminal, mandelbrot 244x72', () => {
  // docs/EVIDENCE.md, Wave 3 bench sweep: mandelbrot at 244x72 (17,568 cells) writes 538 KB/frame
  // at threshold 0, 246 KB at threshold 8, and 79 KB at 256-color threshold 8. Wave 0 (Apple
  // Terminal sweep): throughput on color-heavy content is 2.1 MB/s, so 2.4 MB/s is a mild
  // assumption. The 174 KB level-2 figure is the threshold-16 row of the same sweep.
  // Level 0 here is the 538 KB row (threshold 0); the governor's level 1 maps to 246 KB.
  const BYTES_PER_LEVEL = [538_000, 246_000, 174_000, 79_000];
  const THROUGHPUT = 2_400_000; // bytes per second
  const OVERHEAD_MS = 0.4;
  const CELLS = 17_568;

  function bytesAt(gov: Governor, level: number): number {
    if (level < BYTES_PER_LEVEL.length) return BYTES_PER_LEVEL[level] as number;
    const cap = gov.settingsAt(level).maxCells ?? CELLS;
    return (BYTES_PER_LEVEL[3] as number) * (cap / CELLS);
  }

  function run(gov: Governor, seconds: number) {
    const budget = 1000 / 30;
    let busyUntil = 0;
    let rendered = 0;
    let tail = 0;
    const tailFrom = (seconds - 10) * 1000;
    const levelAtSecond: number[] = [];
    for (let t = 0; t < seconds * 1000; t += budget) {
      if (busyUntil > t) {
        gov.recordSkip(t);
      } else {
        const frameMs = OVERHEAD_MS + (bytesAt(gov, gov.level()) / THROUGHPUT) * 1000;
        gov.record(frameMs, t);
        busyUntil = t + frameMs;
        rendered++;
        if (t >= tailFrom) tail++;
      }
      if (levelAtSecond.length < Math.floor(t / 1000) + 1) levelAtSecond.push(gov.level());
    }
    return { rendered, fps: tail / 10, levelAtSecond };
  }

  it('settles at a level that holds 30 fps', () => {
    const g = createGovernor(BASE);
    const { fps, levelAtSecond } = run(g, 60);
    // Level 3 (79 KB) takes 33.3 ms per frame, a hair over 0.9 of the budget, so the governor
    // goes one more step to 14,054 cells (63 KB, 26.7 ms) and stays there.
    expect(g.level()).toBe(4);
    expect(g.settings().maxCells).toBe(14_054);
    expect(fps).toBeGreaterThanOrEqual(29.5);
    expect(levelAtSecond.at(-1)).toBe(4);
    // Settled within 10 s: 4 steps at ~1 s each plus window fills.
    expect(levelAtSecond[10]).toBe(4);
    console.log(
      `governor simulation: settles at level ${g.level()} (${g.settings().maxCells} cells, depth ${g.settings().depth}), ` +
        `${fps.toFixed(1)} fps over the last 10 s`,
    );
  });

  it('without the governor the same terminal delivers under 5 fps', () => {
    const g = createGovernor({ ...BASE, enabled: false });
    const { fps } = run(g, 30);
    expect(g.level()).toBe(0);
    expect(fps).toBeLessThan(5);
  });
});
