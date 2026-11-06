// Timing math for the demo video (REQ-VID-06). Pure functions, no React, no Remotion imports,
// so `node --test` can run them. Local imports use the .ts extension (Node type stripping).

export const FPS = 30;
export const WIDTH = 1920;
export const HEIGHT = 1080;

/** Silence after each narration block before the act may end. */
export const NARRATION_TAIL_SEC = 0.8;

export const ACT_IDS = ['act1', 'act2', 'act3', 'act4', 'closing'] as const;
export type ActId = (typeof ACT_IDS)[number];

/** Floating point noise guard: 13.2 * 30 is 396.00000000000006, which Math.ceil would round up to 397. */
const EPSILON = 1e-6;

/** frames = ceil(seconds x fps), per REQ-VID-06. */
export function secondsToFrames(seconds: number, fps: number = FPS): number {
  if (!Number.isFinite(seconds) || seconds < 0) throw new RangeError(`bad duration: ${String(seconds)}`);
  return Math.max(0, Math.ceil(seconds * fps - EPSILON)) + 0;
}

/** An act lasts max(narration + tail, minimum visual time), in frames. */
export function actFrames(narrationSec: number | undefined, minVisualSec: number, fps: number = FPS): number {
  const visual = secondsToFrames(minVisualSec, fps);
  if (narrationSec === undefined) return visual;
  return Math.max(secondsToFrames(narrationSec + NARRATION_TAIL_SEC, fps), visual);
}

export interface ActTiming {
  id: ActId;
  /** First frame of the act in the composition. */
  from: number;
  frames: number;
  /** Narration length in frames (0 when the act has no narration). */
  narrationFrames: number;
}

export interface Timeline {
  acts: ActTiming[];
  totalFrames: number;
}

/** Narration seconds per act (durations.json), minimum visual seconds per act. Both keyed by act id. */
export function buildTimeline(
  durations: Partial<Record<string, number>>,
  minVisualSec: Record<ActId, number>,
  fps: number = FPS,
): Timeline {
  const acts: ActTiming[] = [];
  let from = 0;
  for (const id of ACT_IDS) {
    const narration = durations[id];
    const narrationSec = typeof narration === 'number' && narration > 0 ? narration : undefined;
    const frames = actFrames(narrationSec, minVisualSec[id], fps);
    acts.push({
      id,
      from,
      frames,
      narrationFrames: narrationSec === undefined ? 0 : secondsToFrames(narrationSec, fps),
    });
    from += frames;
  }
  return { acts, totalFrames: from };
}

/**
 * Splits `total` frames over segments in proportion to `weights` (largest remainder method).
 * The parts are integers and sum to exactly `total`.
 */
export function allocateFrames(total: number, weights: readonly number[]): number[] {
  if (weights.length === 0) return [];
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!(sum > 0)) throw new RangeError('weights must sum to more than 0');
  const exact = weights.map((w) => (w / sum) * total);
  const parts = exact.map((x) => Math.floor(x));
  let left = total - parts.reduce((a, b) => a + b, 0);
  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; left > 0; k = (k + 1) % order.length) {
    const entry = order[k];
    if (entry === undefined) break;
    parts[entry.i] = (parts[entry.i] ?? 0) + 1;
    left--;
  }
  return parts;
}

export interface FrameWindow {
  from: number;
  to: number;
}

/** Narration windows in composition frames, one per act that has narration. */
export function narrationWindows(timeline: Timeline): FrameWindow[] {
  return timeline.acts
    .filter((a) => a.narrationFrames > 0)
    .map((a) => ({ from: a.from, to: a.from + a.narrationFrames }));
}

/** Music bed gain: -18 dB relative to full scale, minus 6 dB more while narration plays. */
export const MUSIC_BASE_DB = -18;
export const MUSIC_DUCK_DB = -6;
export const DUCK_RAMP_FRAMES = 9;

export function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

/** 0 = no narration, 1 = fully ducked; ramps over DUCK_RAMP_FRAMES at both edges of each window. */
export function duckAmount(frame: number, windows: readonly FrameWindow[], ramp: number = DUCK_RAMP_FRAMES): number {
  let amount = 0;
  for (const w of windows) {
    let a: number;
    if (frame < w.from - ramp || frame > w.to + ramp) continue;
    if (frame < w.from) a = (frame - (w.from - ramp)) / ramp;
    else if (frame > w.to) a = 1 - (frame - w.to) / ramp;
    else a = 1;
    if (a > amount) amount = a;
  }
  return amount;
}

/** Linear gain for the music bed at a composition frame. */
export function musicGain(frame: number, windows: readonly FrameWindow[]): number {
  const db = MUSIC_BASE_DB + MUSIC_DUCK_DB * duckAmount(frame, windows);
  return dbToGain(db);
}
