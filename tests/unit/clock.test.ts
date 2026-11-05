import { describe, expect, it } from 'vitest';
import { createClock } from '../../src/audio/clock.ts';

function fakeNow(): { now: () => number; advance: (ms: number) => void; set: (ms: number) => void } {
  let t = 1000;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
    set: (ms) => {
      t = ms;
    },
  };
}

describe('createClock', () => {
  it('starts paused at 0', () => {
    const t = fakeNow();
    const clock = createClock({ now: t.now });
    expect(clock.isPaused()).toBe(true);
    expect(clock.position()).toBe(0);
    t.advance(5000);
    expect(clock.position()).toBe(0);
  });

  it('runs from the start position', () => {
    const t = fakeNow();
    const clock = createClock({ now: t.now });
    clock.start(10);
    expect(clock.isPaused()).toBe(false);
    expect(clock.position()).toBe(10);
    t.advance(1500);
    expect(clock.position()).toBeCloseTo(11.5, 12);
  });

  it('freezes on pause and continues on resume', () => {
    const t = fakeNow();
    const clock = createClock({ now: t.now });
    clock.start(2);
    t.advance(1000);
    clock.pause();
    expect(clock.isPaused()).toBe(true);
    t.advance(10_000);
    expect(clock.position()).toBeCloseTo(3, 12);
    clock.resume();
    expect(clock.isPaused()).toBe(false);
    t.advance(500);
    expect(clock.position()).toBeCloseTo(3.5, 12);
  });

  it('pause and resume are idempotent', () => {
    const t = fakeNow();
    const clock = createClock({ now: t.now });
    clock.start(0);
    t.advance(1000);
    clock.pause();
    t.advance(1000);
    clock.pause();
    expect(clock.position()).toBeCloseTo(1, 12);
    clock.resume();
    t.advance(1000);
    clock.resume();
    expect(clock.position()).toBeCloseTo(2, 12);
  });

  it('seeks while running and keeps running', () => {
    const t = fakeNow();
    const clock = createClock({ now: t.now });
    clock.start(0);
    t.advance(3000);
    clock.seek(40);
    expect(clock.position()).toBe(40);
    t.advance(250);
    expect(clock.position()).toBeCloseTo(40.25, 12);
  });

  it('seeks while paused and stays paused', () => {
    const t = fakeNow();
    const clock = createClock({ now: t.now });
    clock.start(5);
    clock.pause();
    clock.seek(20);
    t.advance(4000);
    expect(clock.isPaused()).toBe(true);
    expect(clock.position()).toBe(20);
    clock.resume();
    t.advance(1000);
    expect(clock.position()).toBeCloseTo(21, 12);
  });

  it('clamps negative seek and start to 0', () => {
    const t = fakeNow();
    const clock = createClock({ now: t.now });
    clock.start(-4);
    expect(clock.position()).toBe(0);
    clock.seek(-10);
    expect(clock.position()).toBe(0);
  });

  it('anchor places the base position at the given time', () => {
    const t = fakeNow();
    const clock = createClock({ now: t.now });
    clock.start(30);
    t.advance(300); // audio only began 300 ms later
    clock.anchor(t.now());
    expect(clock.position()).toBe(30);
    t.advance(1000);
    expect(clock.position()).toBeCloseTo(31, 12);
  });

  it('anchor defaults to now', () => {
    const t = fakeNow();
    const clock = createClock({ now: t.now });
    clock.start(1);
    t.advance(700);
    clock.anchor();
    expect(clock.position()).toBe(1);
  });

  it('anchor in the future holds the position until that time', () => {
    const t = fakeNow();
    const clock = createClock({ now: t.now });
    clock.start(8);
    clock.anchor(t.now() + 400);
    t.advance(200);
    expect(clock.position()).toBe(8);
    t.advance(400);
    expect(clock.position()).toBeCloseTo(8.2, 12);
  });

  it('anchor has no effect while paused', () => {
    const t = fakeNow();
    const clock = createClock({ now: t.now });
    clock.start(4);
    t.advance(1000);
    clock.pause();
    clock.anchor(t.now() - 5000);
    expect(clock.position()).toBeCloseTo(5, 12);
    clock.resume();
    expect(clock.position()).toBeCloseTo(5, 12);
  });

  it('applies the A/V offset as a constant shift', () => {
    const t = fakeNow();
    const clock = createClock({ now: t.now, offsetMs: 250 });
    clock.start(10);
    expect(clock.position()).toBeCloseTo(10.25, 12);
    t.advance(1000);
    clock.pause();
    clock.resume();
    clock.pause();
    clock.resume();
    // Repeated pause/resume must not add the offset again.
    expect(clock.position()).toBeCloseTo(11.25, 12);
  });

  it('never reports a negative position, even with a negative offset', () => {
    const t = fakeNow();
    const clock = createClock({ now: t.now, offsetMs: -500 });
    clock.start(0);
    expect(clock.position()).toBe(0);
    t.advance(200);
    expect(clock.position()).toBe(0);
    t.advance(1300);
    expect(clock.position()).toBeCloseTo(1, 12);
  });

  it('does not move backward when now() does not advance', () => {
    const t = fakeNow();
    const clock = createClock({ now: t.now });
    clock.start(3);
    const a = clock.position();
    t.set(t.now() - 50); // a misbehaving time source
    expect(clock.position()).toBeGreaterThanOrEqual(a);
  });

  it('is monotonic while running', () => {
    const t = fakeNow();
    const clock = createClock({ now: t.now });
    clock.start(0);
    let prev = clock.position();
    for (let i = 0; i < 200; i++) {
      t.advance(i % 7);
      const p = clock.position();
      expect(p).toBeGreaterThanOrEqual(prev);
      prev = p;
    }
  });

  it('rejects non-finite input', () => {
    const clock = createClock();
    expect(() => {
      clock.start(Number.NaN);
    }).toThrow(RangeError);
    expect(() => {
      clock.seek(Number.POSITIVE_INFINITY);
    }).toThrow(RangeError);
    expect(() => {
      clock.anchor(Number.NaN);
    }).toThrow(RangeError);
    expect(() => createClock({ offsetMs: Number.NaN })).toThrow(RangeError);
  });

  it('uses performance.now by default', async () => {
    const clock = createClock();
    clock.start(0);
    await new Promise((r) => setTimeout(r, 30));
    const p = clock.position();
    expect(p).toBeGreaterThan(0.015);
    expect(p).toBeLessThan(1);
  });
});
