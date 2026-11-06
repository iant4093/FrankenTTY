import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  badgesOf,
  buildOps,
  chunkCountAt,
  countAtOrBefore,
  eventResize,
  keyCapText,
  maxSize,
  sizeAt,
  validateSession,
} from '../src/lib/session.ts';
import type { Session } from '../src/lib/session.ts';
import { computeWindowLayout } from '../src/lib/layout.ts';
import { replayTime } from '../src/components/replay-time.ts';

function session(extra: Partial<Session> = {}): Session {
  return {
    version: 1,
    cols: 100,
    rows: 30,
    fps: 30,
    durationSec: 5,
    title: 't',
    command: ['frankentty'],
    env: {},
    events: [],
    chunks: [
      { t: 0.1, b64: 'AA==' },
      { t: 0.5, b64: 'AQ==' },
      { t: 0.5, b64: 'Ag==' },
      { t: 2, b64: 'Aw==' },
    ],
    ...extra,
  };
}

test('chunkCountAt: all chunks with t <= time', () => {
  const c = session().chunks;
  assert.equal(chunkCountAt(c, -1), 0);
  assert.equal(chunkCountAt(c, 0), 0);
  assert.equal(chunkCountAt(c, 0.1), 1);
  assert.equal(chunkCountAt(c, 0.49), 1);
  assert.equal(chunkCountAt(c, 0.5), 3);
  assert.equal(chunkCountAt(c, 1.99), 3);
  assert.equal(chunkCountAt(c, 2), 4);
  assert.equal(chunkCountAt(c, 99), 4);
  assert.equal(chunkCountAt([], 5), 0);
});

test('chunkCountAt matches a linear scan for every frame time', () => {
  const chunks = Array.from({ length: 200 }, (_, i) => ({ t: Math.round(i * 37.3) / 1000 }));
  for (let frame = 0; frame < 300; frame++) {
    const t = frame / 30;
    assert.equal(chunkCountAt(chunks, t), chunks.filter((c) => c.t <= t).length, `frame ${String(frame)}`);
  }
  assert.equal(countAtOrBefore(chunks, 1), chunks.filter((c) => c.t <= 1).length);
});

test('replayTime maps frames to session time with start, speed and freeze', () => {
  assert.equal(replayTime(0, 30, 0, 1, undefined), 0);
  assert.equal(replayTime(30, 30, 2, 1, undefined), 3);
  assert.equal(replayTime(30, 30, 0, 0.5, undefined), 0.5);
  assert.equal(replayTime(300, 30, 0, 1, 4), 4);
});

test('validateSession accepts the 6.A format and rejects malformed input', () => {
  assert.doesNotThrow(() => validateSession(session()));
  assert.throws(() => validateSession(null), TypeError);
  assert.throws(() => validateSession({ ...session(), version: 2 }), /version/);
  assert.throws(() => validateSession({ ...session(), chunks: [{ t: 1, b64: 'AA==' }, { t: 0.5, b64: 'AA==' }] }), /decrease/);
  assert.throws(() => validateSession({ ...session(), cols: 'x' }), /cols/);
});

test('key caps: arrows, shift arrows, space, letters', () => {
  assert.equal(keyCapText('m'), 'm');
  assert.equal(keyCapText('\u001b[C'), '→');
  assert.equal(keyCapText('\u001b[D'), '←');
  assert.equal(keyCapText('\u001b[1;2D'), '⇧←');
  assert.equal(keyCapText('\u001b[1;2C'), '⇧→');
  assert.equal(keyCapText(' '), 'Space');
  assert.equal(keyCapText('q'), 'q');
  assert.equal(keyCapText(''), '');
});

test('badges come from key events in time order; resizes show as label-only badges', () => {
  const s = session({
    events: [
      { t: 3, keys: ' ', label: 'pause' },
      { t: 1, keys: 'm', label: 'mode' },
      { t: 2, keys: '', label: 'resize 160x45' },
    ],
  });
  const b = badgesOf(s);
  assert.deepEqual(b.map((x) => x.cap), ['m', '', 'Space']);
  assert.deepEqual(b.map((x) => x.index), [0, 0, 0]);
});

test('badge index counts earlier presses of the same key (pause, then resume)', () => {
  const s = session({
    events: [
      { t: 1, keys: ' ', label: '' },
      { t: 2, keys: 'm', label: '' },
      { t: 3, keys: ' ', label: '' },
    ],
  });
  assert.deepEqual(badgesOf(s).map((b) => b.index), [0, 0, 1]);
});

test('resize events: explicit field or "resize CxR" label on a key-less event', () => {
  assert.deepEqual(eventResize({ t: 1, keys: '', label: 'x', resize: [120, 40] }), [120, 40]);
  assert.deepEqual(eventResize({ t: 1, keys: '', label: 'resize 160x45' }), [160, 45]);
  assert.deepEqual(eventResize({ t: 1, keys: '', label: 'Resize to 160 × 45' }), [160, 45]);
  assert.equal(eventResize({ t: 1, keys: 'm', label: 'resize 160x45' }), null);
  assert.equal(eventResize({ t: 1, keys: '', label: 'nothing' }), null);
});

test('sizeAt and maxSize follow resize events', () => {
  const s = session({ events: [{ t: 4, keys: '', label: 'resize 160x45' }] });
  assert.deepEqual(sizeAt(s, 3.99), { cols: 100, rows: 30 });
  assert.deepEqual(sizeAt(s, 4), { cols: 160, rows: 45 });
  assert.deepEqual(maxSize(s), { cols: 160, rows: 45 });
});

test('buildOps interleaves resizes and chunks in time order', () => {
  const s = session({ events: [{ t: 0.5, keys: '', label: 'resize 160x45' }] });
  const ops = buildOps(s);
  assert.equal(ops.length, 5);
  assert.deepEqual(ops.map((o) => o.kind), ['chunk', 'resize', 'chunk', 'chunk', 'chunk']);
  for (let i = 1; i < ops.length; i++) assert.ok((ops[i]?.t ?? 0) >= (ops[i - 1]?.t ?? 0));
});

test('window layout: 160x45 fits 1920x1080 with room for the badge band', () => {
  const l = computeWindowLayout({ width: 1920, height: 1080, band: 100, maxCols: 160, maxRows: 45, cols: 160, rows: 45, maxScale: 1 });
  assert.ok(l.scale < 1 && l.scale > 0.7);
  assert.ok(l.left >= 0 && l.top >= 0);
  assert.ok(l.left + l.windowW <= 1920);
  assert.ok(l.top + l.windowH <= 1080 - 100);
});

test('window layout: a smaller terminal keeps the scale of the largest size', () => {
  const big = computeWindowLayout({ width: 1920, height: 1080, band: 100, maxCols: 160, maxRows: 45, cols: 160, rows: 45, maxScale: 1 });
  const small = computeWindowLayout({ width: 1920, height: 1080, band: 100, maxCols: 160, maxRows: 45, cols: 100, rows: 30, maxScale: 1 });
  assert.equal(small.scale, big.scale);
  assert.ok(small.windowW < big.windowW);
});
