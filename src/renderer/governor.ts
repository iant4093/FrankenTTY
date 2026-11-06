// Adaptive quality governor (REQ-PERF-01, design.md section 5).
//
// Pure state machine: no timers, no I/O. Time comes only from the `atMs` arguments. The player
// feeds it one sample per tick (render + write ms, or a skip when stdout was still busy) and reads
// back the quality settings to use. Memory is bounded by a fixed ring buffer.
//
// Levels are cumulative and numbered contiguously:
//   threshold +8, threshold +16, [256-color when the base depth is 24], then up to five render-cell
//   caps of base * 0.8^k (k = 1..5), the last one clamped to `minCells`.
// When the base depth is already 8 or 4 the 256-color step does not exist, so the cell caps move
// up one level number.
//
// Hysteresis. Color levels (no cell cap) change the bytes per frame and nothing else, so they are
// cheap to enter and leave. Cell-cap levels change the geometry: the picture gets smaller, the
// decoder restarts and the screen is cleared. They need stronger evidence, in both directions:
//
//                       color levels (0..depth step)      cap levels (maxCells set)
//   step down (L -> L+1)  p90 > 0.9 x budget, window 1 s    p90 > 0.9 x budget at every sample for 3 s
//   step up   (L -> L-1)  p90 < 0.5 x budget for 3 s        p90 < 0.75 x budget for 2 s
//
// "Step down into or within cap levels" means the target level L+1 is a cap level. "Step up out of a
// cap level" means the current level L is a cap level. The p90 is over the last 1 s of samples in
// both cases. Every level change starts a 1 s cooldown and an empty window, so each cap step takes at
// least 1 s + 3 s of fresh samples.
//
// A mode or palette change calls `reset()`: the sample window and both streaks are cleared and a cap
// is dropped at once (down to the depth step at most), because the new mode has a different cost and
// has to be measured from scratch.

export type ColorDepth = 24 | 8 | 4;

export interface GovernorOptions {
  fps: number;
  baseThreshold: number;
  baseDepth: ColorDepth;
  baseCells: number;
  enabled: boolean;
  /** Smallest render area (cells) the governor will ask for. Default 960 (40x24). */
  minCells?: number;
  /** Sliding window for the p90 estimate. Default 1000. */
  windowMs?: number;
  /** p90 must stay under half the budget this long before a step up. Default 3000. */
  upAfterMs?: number;
  /** Minimum time between level changes; samples inside it are ignored. Default 1000. */
  cooldownMs?: number;
  /** p90 must stay over budget this long before a step down INTO or WITHIN the cell-cap levels. Default 3000. */
  capDownAfterMs?: number;
  /** p90 must stay under 0.75 of the budget this long before a step up OUT OF a cell-cap level. Default 2000. */
  capUpAfterMs?: number;
}

export interface QualitySettings {
  readonly threshold: number;
  readonly depth: ColorDepth;
  /** Render-cell cap, or null for "no cap". */
  readonly maxCells: number | null;
}

export type GovernorListener = (settings: QualitySettings, level: number) => void;

export interface Governor {
  /** One sample per rendered frame: render + write time. */
  record(frameMs: number, atMs: number): void;
  /** A tick where stdout was still busy. Counts as a sample of twice the frame budget. */
  recordSkip(atMs: number): void;
  /** 0 = full quality. */
  level(): number;
  /** Highest level this governor can reach. */
  maxLevel(): number;
  /** Settings for the current level. The returned object is stable per level. */
  settings(): QualitySettings;
  /** Settings for any level in [0, maxLevel()]. */
  settingsAt(level: number): QualitySettings;
  /**
   * The mode or palette changed: forget the samples and the streaks, and drop any cell cap at once
   * (to the last level without a cap, the depth step at most). Levels below that stay. A level
   * change made here fires onChange and starts the cooldown like any other.
   */
  reset(atMs: number): void;
  /** Fires only when the level changes. May jump several levels when it comes from `reset`. */
  onChange(cb: GovernorListener): void;
}

export const DEFAULT_MIN_CELLS = 960;
export const THRESHOLD_STEP = 8;
export const MAX_THRESHOLD = 100;
export const CELL_SCALE = 0.8;
export const MAX_CELL_STEPS = 5;

const MIN_SAMPLES = 5;
const DOWN_FRACTION = 0.9;
const UP_FRACTION = 0.5;
/** Step-up threshold out of a cell-cap level (see the hysteresis table above). */
export const CAP_UP_FRACTION = 0.75;
const SKIP_BUDGETS = 2;

function buildLevels(
  baseThreshold: number,
  baseDepth: ColorDepth,
  baseCells: number,
  minCells: number,
): QualitySettings[] {
  const clampT = (t: number): number => Math.min(t, Math.max(MAX_THRESHOLD, baseThreshold));
  const levels: QualitySettings[] = [];
  let depth: ColorDepth = baseDepth;
  let threshold = baseThreshold;
  let maxCells: number | null = null;
  const push = (): void => {
    levels.push(Object.freeze({ threshold, depth, maxCells }));
  };
  push();
  threshold = clampT(baseThreshold + THRESHOLD_STEP);
  push();
  threshold = clampT(baseThreshold + 2 * THRESHOLD_STEP);
  push();
  if (baseDepth === 24) {
    depth = 8;
    push();
  }
  let previous = baseCells;
  for (let k = 1; k <= MAX_CELL_STEPS; k++) {
    if (previous <= minCells) break;
    const scaled = Math.round(baseCells * CELL_SCALE ** k);
    maxCells = Math.max(scaled, minCells);
    previous = maxCells;
    push();
  }
  return levels;
}

export function createGovernor(options: GovernorOptions): Governor {
  const { fps, baseThreshold, baseDepth, baseCells, enabled } = options;
  const minCells = options.minCells ?? DEFAULT_MIN_CELLS;
  const windowMs = options.windowMs ?? 1000;
  const upAfterMs = options.upAfterMs ?? 3000;
  const cooldownMs = options.cooldownMs ?? 1000;
  const capDownAfterMs = options.capDownAfterMs ?? 3000;
  const capUpAfterMs = options.capUpAfterMs ?? 2000;

  const budget = 1000 / fps;
  const downAbove = DOWN_FRACTION * budget;
  const upBelow = UP_FRACTION * budget;
  const capUpBelow = CAP_UP_FRACTION * budget;
  const skipSample = SKIP_BUDGETS * budget;

  const levels = buildLevels(baseThreshold, baseDepth, baseCells, minCells);
  const top = levels.length - 1;
  const firstCap = levels.findIndex((l) => l.maxCells !== null);
  /** The last level without a cell cap. */
  const uncappedTop = firstCap === -1 ? top : firstCap - 1;

  const capacity = Math.max(MIN_SAMPLES, Math.ceil((fps * windowMs) / 1000) * 2);
  const times = new Float64Array(capacity);
  const values = new Float64Array(capacity);
  const scratch = new Float64Array(capacity);
  let tail = 0; // index of the oldest sample
  let count = 0;

  let current = 0;
  let lastChangeAt = -Infinity;
  let lastSampleAt = -Infinity;
  let underSince = Number.NaN; // NaN = no low-p90 streak running
  let overSince = Number.NaN; // NaN = no over-budget streak running
  const listeners: GovernorListener[] = [];

  function clearWindow(): void {
    tail = 0;
    count = 0;
  }

  function push(frameMs: number, atMs: number): void {
    if (count === capacity) {
      tail = (tail + 1) % capacity;
      count--;
    }
    const slot = (tail + count) % capacity;
    times[slot] = atMs;
    values[slot] = frameMs;
    count++;
  }

  function prune(atMs: number): void {
    const cutoff = atMs - windowMs;
    while (count > 0 && (times[tail] as number) <= cutoff) {
      tail = (tail + 1) % capacity;
      count--;
    }
  }

  /** Nearest-rank p90 of the window, by insertion sort into the scratch buffer. */
  function p90(): number {
    for (let i = 0; i < count; i++) {
      const v = values[(tail + i) % capacity] as number;
      let j = i - 1;
      while (j >= 0 && (scratch[j] as number) > v) {
        scratch[j + 1] = scratch[j] as number;
        j--;
      }
      scratch[j + 1] = v;
    }
    return scratch[Math.ceil(0.9 * count) - 1] as number;
  }

  function change(to: number, atMs: number): void {
    current = to;
    lastChangeAt = atMs;
    underSince = Number.NaN;
    overSince = Number.NaN;
    clearWindow();
    const s = levels[current] as QualitySettings;
    for (const cb of listeners) cb(s, current);
  }

  function sample(frameMs: number, atMs: number): void {
    if (!enabled || !Number.isFinite(frameMs) || !Number.isFinite(atMs)) return;
    if (atMs < lastSampleAt) atMs = lastSampleAt; // time never runs backwards
    lastSampleAt = atMs;
    if (atMs - lastChangeAt < cooldownMs) return;

    push(frameMs < 0 ? 0 : frameMs, atMs);
    prune(atMs);
    if (count < MIN_SAMPLES) {
      underSince = Number.NaN;
      overSince = Number.NaN;
      return;
    }
    const p = p90();
    if (p > downAbove) {
      underSince = Number.NaN;
      if (Number.isNaN(overSince)) overSince = atMs;
      if (current < top) {
        const intoCap = (levels[current + 1] as QualitySettings).maxCells !== null;
        if (!intoCap || atMs - overSince >= capDownAfterMs) change(current + 1, atMs);
      }
      return;
    }
    overSince = Number.NaN;
    const inCap = (levels[current] as QualitySettings).maxCells !== null;
    if (p < (inCap ? capUpBelow : upBelow)) {
      if (Number.isNaN(underSince)) underSince = atMs;
      if (current > 0 && atMs - underSince >= (inCap ? capUpAfterMs : upAfterMs)) change(current - 1, atMs);
    } else {
      underSince = Number.NaN;
    }
  }

  return {
    record(frameMs, atMs) {
      sample(frameMs, atMs);
    },
    recordSkip(atMs) {
      sample(skipSample, atMs);
    },
    level: () => current,
    maxLevel: () => top,
    settings: () => levels[current] as QualitySettings,
    reset(atMs) {
      if (!enabled) return;
      const at = Number.isFinite(atMs) && atMs > lastSampleAt ? atMs : lastSampleAt;
      lastSampleAt = at;
      underSince = Number.NaN;
      overSince = Number.NaN;
      clearWindow();
      if (current > uncappedTop) change(uncappedTop, at);
    },
    settingsAt(level) {
      const s = levels[level];
      if (s === undefined) throw new RangeError(`governor level ${level} out of range 0..${top}`);
      return s;
    },
    onChange(cb) {
      listeners.push(cb);
    },
  };
}
