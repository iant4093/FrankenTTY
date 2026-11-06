import assert from 'node:assert/strict';
import { test } from 'node:test';
import { minVisualSeconds, planSegments, segmentsOf } from '../src/lib/acts.ts';
import {
  ACT_IDS,
  FPS,
  MUSIC_BASE_DB,
  MUSIC_DUCK_DB,
  actFrames,
  allocateFrames,
  buildTimeline,
  dbToGain,
  duckAmount,
  musicGain,
  narrationWindows,
  secondsToFrames,
} from '../src/lib/timing.ts';

const sessions = {
  'act1-mandelbrot': { durationSec: 10 },
  'act2-cell': { durationSec: 6 },
  'act3-modes': { durationSec: 18.5 },
  'act3-seek-pause': { durationSec: 14 },
  'act3-resize': { durationSec: 9 },
};

test('REQ-VID-06: frames = ceil(seconds x 30)', () => {
  assert.equal(secondsToFrames(1), 30);
  assert.equal(secondsToFrames(1.01), 31);
  assert.equal(secondsToFrames(0.001), 1);
  assert.equal(secondsToFrames(0), 0);
  assert.equal(secondsToFrames(20.3), 609);
});

test('float noise does not add a frame (13.2 s is exactly 396 frames)', () => {
  assert.equal(12.4 + 0.8, 13.200000000000001);
  assert.equal(secondsToFrames(12.4 + 0.8), 396);
});

test('secondsToFrames rejects negative and non-finite input', () => {
  assert.throws(() => secondsToFrames(-1), RangeError);
  assert.throws(() => secondsToFrames(Number.NaN), RangeError);
  assert.throws(() => secondsToFrames(Number.POSITIVE_INFINITY), RangeError);
});

test('act duration is the larger of narration + 0.8 s and the minimum visual time', () => {
  assert.equal(actFrames(20, 10), Math.ceil(20.8 * FPS));
  assert.equal(actFrames(5, 30), 30 * 30);
  assert.equal(actFrames(undefined, 5), 150);
});

test('narration never gets cut: every act with narration has at least narration + 0.8 s', () => {
  const durations = { act1: 20.3, act2: 36, act3: 37.8, act4: 44.3 };
  const tl = buildTimeline(durations, minVisualSeconds(sessions));
  for (const act of tl.acts) {
    const n = durations[act.id as keyof typeof durations];
    if (n !== undefined) assert.ok(act.frames >= secondsToFrames(n + 0.8), act.id);
  }
});

test('timeline: acts are back to back, in order, and sum to the total', () => {
  const tl = buildTimeline({ act1: 20.3, act2: 36, act3: 37.8, act4: 44.3, closing: 3 }, minVisualSeconds(sessions));
  assert.deepEqual(tl.acts.map((a) => a.id), [...ACT_IDS]);
  let at = 0;
  for (const a of tl.acts) {
    assert.equal(a.from, at);
    at += a.frames;
  }
  assert.equal(tl.totalFrames, at);
});

test('with the real minimums the total lands in the 120-175 s window of REQ-VID-01', () => {
  const tl = buildTimeline({ act1: 20.3, act2: 36, act3: 37.8, act4: 44.3 }, minVisualSeconds(sessions));
  const sec = tl.totalFrames / FPS;
  assert.ok(sec >= 120 && sec <= 175, String(sec));
});

test('an act without narration uses its minimum visual time', () => {
  const tl = buildTimeline({}, minVisualSeconds(sessions));
  const mins = minVisualSeconds(sessions);
  for (const a of tl.acts) {
    assert.equal(a.frames, secondsToFrames(mins[a.id]));
    assert.equal(a.narrationFrames, 0);
  }
});

test('segments: sessions are fixed-length, everything else flexes', () => {
  const seg = segmentsOf(sessions);
  assert.equal(seg.act1[1]?.sec, 10.5);
  assert.equal(seg.act1[1]?.flex, 0);
  assert.deepEqual(seg.act3.map((s) => s.flex), [1, 0, 1, 0, 1, 0]);
  assert.equal(seg.act3[1]?.sec, 18.9);
  assert.throws(() => segmentsOf({}), /missing session/);
});

test('planSegments: fixed replays keep their natural frames, flex segments absorb the slack', () => {
  const segs = segmentsOf(sessions).act1;
  const natural = minVisualSeconds(sessions).act1;
  const total = secondsToFrames(natural) + 90;
  const plan = planSegments(total, segs);
  assert.equal(plan.reduce((a, p) => a + p.frames, 0), total);
  assert.equal(plan[1]?.frames, secondsToFrames(10.5));
  assert.equal((plan[0]?.frames ?? 0) + (plan[2]?.frames ?? 0), secondsToFrames(1.5) + secondsToFrames(4) + 90);
  assert.ok((plan[2]?.frames ?? 0) - secondsToFrames(4) >= 3 * ((plan[0]?.frames ?? 0) - secondsToFrames(1.5)) - 4);
  assert.equal(plan[0]?.from, 0);
  assert.equal(plan[1]?.from, plan[0]?.frames);
});

test('planSegments: segments are contiguous and sum to the total for every act', () => {
  const segsByAct = segmentsOf(sessions);
  for (const id of ACT_IDS) {
    for (const extra of [0, 1, 77, 400]) {
      const total = secondsToFrames(minVisualSeconds(sessions)[id]) + extra;
      const plan = planSegments(total, segsByAct[id]);
      let at = 0;
      for (const p of plan) {
        assert.equal(p.from, at);
        at += p.frames;
      }
      assert.equal(at, total, `${id} +${String(extra)}`);
    }
  }
});

test('planSegments: shorter than natural scales down instead of failing', () => {
  const plan = planSegments(60, segmentsOf(sessions).act2);
  assert.equal(plan.reduce((a, p) => a + p.frames, 0), 60);
});

test('planSegments: no flex segment puts the slack on the last one', () => {
  const plan = planSegments(100, [{ key: 'a', sec: 1, flex: 0 }, { key: 'b', sec: 1, flex: 0 }]);
  assert.deepEqual(plan.map((p) => p.frames), [30, 70]);
});

test('allocateFrames: integers that sum to the total and follow the weights', () => {
  for (const [total, weights] of [
    [100, [1, 1, 1]],
    [900, [18.9, 14.4, 9.4]],
    [7, [1, 1, 1, 1]],
    [0, [1, 2]],
    [1, [5, 5, 5]],
  ] as [number, number[]][]) {
    const parts = allocateFrames(total, weights);
    assert.equal(parts.length, weights.length);
    assert.equal(parts.reduce((a, b) => a + b, 0), total);
    for (const p of parts) assert.ok(Number.isInteger(p) && p >= 0);
  }
  assert.deepEqual(allocateFrames(10, [1, 4]), [2, 8]);
  assert.throws(() => allocateFrames(10, [0, 0]), RangeError);
});

test('narration windows start at the act start and last the narration length', () => {
  const tl = buildTimeline({ act1: 20, act3: 30 }, minVisualSeconds(sessions));
  const w = narrationWindows(tl);
  assert.equal(w.length, 2);
  assert.equal(w[0]?.from, 0);
  assert.equal(w[0]?.to, 600);
  assert.equal(w[1]?.from, tl.acts[2]?.from);
});

test('music: -18 dB without narration, -24 dB while narration plays, smooth ramps in between', () => {
  const windows = [{ from: 100, to: 200 }];
  assert.ok(Math.abs(musicGain(0, windows) - dbToGain(MUSIC_BASE_DB)) < 1e-12);
  assert.ok(Math.abs(musicGain(150, windows) - dbToGain(MUSIC_BASE_DB + MUSIC_DUCK_DB)) < 1e-12);
  assert.equal(duckAmount(100, windows), 1);
  assert.equal(duckAmount(200, windows), 1);
  const mid = duckAmount(95, windows);
  assert.ok(mid > 0 && mid < 1);
  assert.ok(musicGain(95, windows) < musicGain(0, windows));
  assert.ok(musicGain(95, windows) > musicGain(150, windows));
  assert.equal(duckAmount(1000, windows), 0);
});

test('ducking is monotone on the ramp-in and ramp-out', () => {
  const windows = [{ from: 100, to: 200 }];
  let prev = -1;
  for (let f = 80; f <= 100; f++) {
    const d = duckAmount(f, windows);
    assert.ok(d >= prev);
    prev = d;
  }
  prev = 2;
  for (let f = 200; f <= 220; f++) {
    const d = duckAmount(f, windows);
    assert.ok(d <= prev);
    prev = d;
  }
});
