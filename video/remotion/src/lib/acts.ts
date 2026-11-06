// Minimum visual time per act and how each act is cut into segments. Pure; shared by
// calculateMetadata (total length) and the act components (segment lengths).
//
// Terminal replays are "fixed" segments: they always play at real speed (REQ-VID-03, unedited output).
// Extra time from a long narration goes to "flex" segments (title cards, diagrams, typed commands).
import { allocateFrames, secondsToFrames } from './timing.ts';
import type { ActId } from './timing.ts';

export interface SessionMeta {
  durationSec: number;
  cols: number;
  rows: number;
  /** Largest size the terminal has during the session (after resize events). */
  maxCols: number;
  maxRows: number;
  title: string;
  fixture: boolean;
}

export interface Seg {
  key: string;
  /** Natural length in seconds. */
  sec: number;
  /** 0 = fixed length; otherwise the share of any extra time this segment takes. */
  flex: number;
}

export const ACT1 = { cursorSec: 1.5, tailSec: 0.5, titleSec: 4 };
export const ACT2 = { cellSec: 12, compareSec: 11, chartSec: 11 };
export const ACT3 = { introSec: 1.2, tailSec: 0.4, scenes: ['act3-modes', 'act3-seek-pause', 'act3-resize'] as const };
export const ACT4 = { stagesSec: [8, 8, 9, 7, 8] as const };
export const CLOSING_SEC = 5;

type Sessions = Record<string, { durationSec: number } | undefined>;

function duration(sessions: Sessions, name: string): number {
  const s = sessions[name];
  if (s === undefined) throw new Error(`missing session: ${name}`);
  return s.durationSec;
}

export function segmentsOf(sessions: Sessions): Record<ActId, Seg[]> {
  return {
    act1: [
      { key: 'cursor', sec: ACT1.cursorSec, flex: 0.3 },
      { key: 'replay', sec: duration(sessions, 'act1-mandelbrot') + ACT1.tailSec, flex: 0 },
      { key: 'title', sec: ACT1.titleSec, flex: 1 },
    ],
    act2: [
      { key: 'cell', sec: ACT2.cellSec, flex: 1 },
      { key: 'compare', sec: ACT2.compareSec, flex: 1 },
      { key: 'chart', sec: ACT2.chartSec, flex: 1 },
    ],
    act3: ACT3.scenes.flatMap((name) => [
      { key: `${name}:intro`, sec: ACT3.introSec, flex: 1 },
      { key: name, sec: duration(sessions, name) + ACT3.tailSec, flex: 0 },
    ]),
    act4: ACT4.stagesSec.map((sec, i) => ({ key: `stage${String(i + 1)}`, sec, flex: 1 })),
    closing: [{ key: 'closing', sec: CLOSING_SEC, flex: 1 }],
  };
}

export function minVisualSeconds(sessions: Sessions): Record<ActId, number> {
  const seg = segmentsOf(sessions);
  const sum = (a: Seg[]): number => a.reduce((x, s) => x + s.sec, 0);
  return { act1: sum(seg.act1), act2: sum(seg.act2), act3: sum(seg.act3), act4: sum(seg.act4), closing: sum(seg.closing) };
}

export interface PlannedSegment {
  key: string;
  from: number;
  frames: number;
}

/** Fits segments into `totalFrames`: natural lengths first, then the extra time over the flex segments. */
export function planSegments(totalFrames: number, segs: readonly Seg[]): PlannedSegment[] {
  const natural = segs.map((s) => secondsToFrames(s.sec));
  const naturalSum = natural.reduce((a, b) => a + b, 0);
  let frames: number[];
  if (totalFrames < naturalSum) {
    frames = allocateFrames(totalFrames, natural);
  } else {
    const slack = totalFrames - naturalSum;
    frames = [...natural];
    const flexTotal = segs.reduce((a, s) => a + s.flex, 0);
    if (slack > 0 && flexTotal > 0) {
      const extra = allocateFrames(slack, segs.map((s) => s.flex));
      frames = frames.map((f, i) => f + (extra[i] ?? 0));
    } else if (slack > 0) {
      const last = frames.length - 1;
      frames[last] = (frames[last] ?? 0) + slack;
    }
  }
  let from = 0;
  return segs.map((s, i) => {
    const f = frames[i] ?? 0;
    const planned = { key: s.key, from, frames: f };
    from += f;
    return planned;
  });
}
