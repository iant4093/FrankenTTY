import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createClock } from '../../src/audio/clock.ts';

type Op =
  | { kind: 'start'; sec: number }
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'seek'; sec: number }
  | { kind: 'advance'; ms: number }
  | { kind: 'anchor'; delta: number | null };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ kind: fc.constant('start' as const), sec: fc.integer({ min: -10, max: 7200 }) }),
  fc.constant({ kind: 'pause' as const }),
  fc.constant({ kind: 'resume' as const }),
  fc.record({ kind: fc.constant('seek' as const), sec: fc.integer({ min: -10, max: 7200 }) }),
  fc.record({ kind: fc.constant('advance' as const), ms: fc.integer({ min: 0, max: 20_000 }) }),
  fc.record({ kind: fc.constant('anchor' as const), delta: fc.option(fc.integer({ min: -2000, max: 2000 }), { nil: null }) }),
);

/** Reference model: explicit state machine with the same documented semantics. */
class Model {
  t = 0;
  offsetSec: number;
  paused = true;
  base = 0;
  anchorAt = 0;
  frozen = 0;
  constructor(offsetMs: number) {
    this.offsetSec = offsetMs / 1000;
  }
  raw(): number {
    return this.paused ? this.frozen : this.base + Math.max(0, this.t - this.anchorAt) / 1000;
  }
  position(): number {
    return Math.max(0, this.raw() + this.offsetSec);
  }
}

describe('[P8][REQ-SYNC-01][REQ-SYNC-02][REQ-SYNC-03] clock matches a reference model', () => {
  it('position() follows the model, is never negative, and only moves when it should', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -3000, max: 3000 }),
        fc.array(opArb, { minLength: 1, maxLength: 60 }),
        (offsetMs, ops) => {
          let now = 5000;
          const clock = createClock({ now: () => now, offsetMs });
          const model = new Model(offsetMs);
          model.t = now;

          for (const op of ops) {
            const before = clock.position();
            const wasPaused = clock.isPaused();
            let moved = false; // seek, start or anchor may change the position discontinuously

            switch (op.kind) {
              case 'start':
                clock.start(op.sec);
                model.base = Math.max(0, op.sec);
                model.anchorAt = model.t;
                model.paused = false;
                moved = true;
                break;
              case 'pause':
                clock.pause();
                if (!model.paused) {
                  model.frozen = model.raw();
                  model.paused = true;
                }
                break;
              case 'resume':
                clock.resume();
                if (model.paused) {
                  model.base = model.frozen;
                  model.anchorAt = model.t;
                  model.paused = false;
                }
                break;
              case 'seek':
                clock.seek(op.sec);
                if (model.paused) {
                  model.frozen = Math.max(0, op.sec);
                } else {
                  model.base = Math.max(0, op.sec);
                  model.anchorAt = model.t;
                }
                moved = true;
                break;
              case 'advance':
                now += op.ms;
                model.t = now;
                break;
              case 'anchor': {
                if (op.delta === null) clock.anchor();
                else clock.anchor(now + op.delta);
                if (!model.paused) model.anchorAt = op.delta === null ? model.t : model.t + op.delta;
                moved = true;
                break;
              }
            }

            const pos = clock.position();
            expect(Math.abs(pos - model.position())).toBeLessThan(1e-9);
            expect(pos).toBeGreaterThanOrEqual(0);
            expect(clock.isPaused()).toBe(model.paused);

            if (!moved) {
              if (wasPaused && clock.isPaused() && op.kind !== 'resume') {
                // Frozen: nothing but seek/start changes a paused position.
                expect(pos).toBe(before);
              }
              if (!wasPaused && !clock.isPaused() && op.kind === 'advance') {
                expect(pos).toBeGreaterThanOrEqual(before);
              }
              if (op.kind === 'pause' || op.kind === 'resume') {
                expect(Math.abs(pos - before)).toBeLessThan(1e-9);
              }
            }
          }
        },
      ),
      { numRuns: 1000 },
    );
  });

  it('running position never decreases while only time passes', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -3000, max: 3000 }),
        fc.integer({ min: 0, max: 7200 }),
        fc.array(fc.integer({ min: 0, max: 5000 }), { minLength: 1, maxLength: 50 }),
        (offsetMs, startSec, steps) => {
          let now = 0;
          const clock = createClock({ now: () => now, offsetMs });
          clock.start(startSec);
          let prev = clock.position();
          for (const ms of steps) {
            now += ms;
            const p = clock.position();
            expect(p).toBeGreaterThanOrEqual(prev);
            prev = p;
          }
        },
      ),
      { numRuns: 1000 },
    );
  });
});
