import { describe, expect, it } from 'vitest';
import { FrameAssembler, GenerationalAssembler } from '../../src/ingest/assembler.ts';

function frame(size: number, fillByte: number): Uint8Array {
  return new Uint8Array(size).fill(fillByte);
}

describe('[REQ-INGEST-06] FrameAssembler', () => {
  it('rejects bad construction arguments', () => {
    expect(() => new FrameAssembler(0)).toThrow(RangeError);
    expect(() => new FrameAssembler(1.5)).toThrow(RangeError);
    expect(() => new FrameAssembler(6, 0)).toThrow(RangeError);
  });

  it('emits exactly one frame per frameSize bytes', () => {
    const a = new FrameAssembler(6);
    expect(a.push(frame(5, 1))).toBe(0);
    expect(a.trailingBytes).toBe(5);
    expect(a.push(frame(1, 1))).toBe(1);
    expect(a.trailingBytes).toBe(0);
    expect(a.framesCompleted).toBe(1);
    expect(Array.from(a.takeOldest() ?? [])).toEqual([1, 1, 1, 1, 1, 1]);
    expect(a.takeOldest()).toBeNull();
  });

  it('splits one large chunk across frames and keeps the remainder', () => {
    const a = new FrameAssembler(4);
    const chunk = Uint8Array.from([1, 1, 1, 1, 2, 2, 2, 2, 3, 3]);
    expect(a.push(chunk)).toBe(2);
    expect(a.trailingBytes).toBe(2);
    expect(Array.from(a.takeOldest() ?? [])).toEqual([1, 1, 1, 1]);
    expect(Array.from(a.takeOldest() ?? [])).toEqual([2, 2, 2, 2]);
    a.push(Uint8Array.from([3, 3]));
    expect(Array.from(a.takeOldest() ?? [])).toEqual([3, 3, 3, 3]);
    expect(a.trailingBytes).toBe(0);
  });

  it('ignores empty chunks', () => {
    const a = new FrameAssembler(4);
    expect(a.push(new Uint8Array(0))).toBe(0);
    expect(a.trailingBytes).toBe(0);
  });

  it('reports full at capacity and bytesUntilFull accordingly', () => {
    const a = new FrameAssembler(4, 3);
    expect(a.bytesUntilFull()).toBe(12);
    a.push(frame(5, 1));
    expect(a.bytesUntilFull()).toBe(7);
    a.push(frame(7, 1));
    expect(a.isFull()).toBe(true);
    expect(a.bytesUntilFull()).toBe(0);
    expect(a.queued).toBe(3);
  });

  it('cycles through capacity + 1 buffers', () => {
    const a = new FrameAssembler(4, 2);
    const seen = new Set<Uint8Array>();
    for (let i = 0; i < 20; i++) {
      a.push(frame(4, i));
      const f = a.takeOldest();
      expect(f).not.toBeNull();
      if (f !== null) seen.add(f);
    }
    expect(seen.size).toBeLessThanOrEqual(3);
    expect(a.dropped).toBe(0);
  });

  it('keeps a taken buffer intact until the next take', () => {
    const a = new FrameAssembler(4, 2);
    a.push(frame(4, 7));
    const first = a.takeOldest();
    expect(first).not.toBeNull();
    // Fill the rest of the pool; the held buffer must not be reused yet.
    a.push(frame(8, 9));
    expect(Array.from(first ?? [])).toEqual([7, 7, 7, 7]);
    a.takeOldest();
    // After the second take, the first buffer is back in the pool.
    a.push(frame(4, 5));
    expect(a.dropped).toBe(0);
  });

  it('takeLatest returns the newest frame and counts the dropped ones', () => {
    const a = new FrameAssembler(2, 4);
    for (let i = 1; i <= 4; i++) a.push(frame(2, i));
    expect(Array.from(a.takeLatest() ?? [])).toEqual([4, 4]);
    expect(a.dropped).toBe(3);
    expect(a.queued).toBe(0);
    expect(a.takeLatest()).toBeNull();
    expect(a.framesCompleted).toBe(4);
  });

  it('drops the oldest frame when pushed past capacity', () => {
    const a = new FrameAssembler(2, 2);
    for (let i = 1; i <= 5; i++) a.push(frame(2, i));
    expect(a.dropped).toBe(3);
    expect(a.queued).toBe(2);
    expect(Array.from(a.takeOldest() ?? [])).toEqual([4, 4]);
    expect(Array.from(a.takeOldest() ?? [])).toEqual([5, 5]);
    expect(a.framesCompleted).toBe(5);
  });

  it('never corrupts frames when pushed past capacity with a partial fill', () => {
    const a = new FrameAssembler(3, 2);
    a.push(frame(3, 1));
    const held = a.takeOldest();
    a.push(frame(3, 2));
    a.push(frame(3, 3));
    a.push(frame(2, 4));
    expect(Array.from(held ?? [])).toEqual([1, 1, 1]);
    a.push(frame(1, 4));
    expect(Array.from(a.takeOldest() ?? [])).toEqual([3, 3, 3]);
    expect(Array.from(a.takeOldest() ?? [])).toEqual([4, 4, 4]);
  });

  it('reset clears frames, partial fill and counters', () => {
    const a = new FrameAssembler(4, 2);
    a.push(frame(11, 1));
    a.takeOldest();
    a.reset();
    expect(a.queued).toBe(0);
    expect(a.trailingBytes).toBe(0);
    expect(a.framesCompleted).toBe(0);
    expect(a.dropped).toBe(0);
    a.push(frame(4, 8));
    expect(Array.from(a.takeOldest() ?? [])).toEqual([8, 8, 8, 8]);
  });
});

describe('[REQ-INGEST-05] GenerationalAssembler', () => {
  it('ignores everything before start()', () => {
    const g = new GenerationalAssembler();
    g.push(0, frame(4, 1));
    expect(g.staleChunks).toBe(1);
    expect(g.takeOldest()).toBeNull();
  });

  it('drops chunks from other generations and counts them', () => {
    const g = new GenerationalAssembler();
    g.start(2, 4);
    g.push(1, frame(4, 9));
    g.push(2, frame(4, 2));
    g.push(3, frame(4, 7));
    expect(g.staleChunks).toBe(2);
    expect(g.framesCompleted).toBe(1);
    expect(Array.from(g.takeOldest() ?? [])).toEqual([2, 2, 2, 2]);
  });

  it('start() resets queued frames, partial bytes and counters', () => {
    const g = new GenerationalAssembler();
    g.start(1, 4);
    g.push(1, frame(10, 1));
    g.push(0, frame(1, 0));
    g.start(2, 4);
    expect(g.generation).toBe(2);
    expect(g.queued).toBe(0);
    expect(g.trailingBytes).toBe(0);
    expect(g.framesCompleted).toBe(0);
    expect(g.staleChunks).toBe(0);
    g.push(1, frame(4, 1));
    expect(g.staleChunks).toBe(1);
    g.push(2, frame(4, 5));
    expect(Array.from(g.takeOldest() ?? [])).toEqual([5, 5, 5, 5]);
  });

  it('accepts a new frame size', () => {
    const g = new GenerationalAssembler();
    g.start(1, 4);
    g.push(1, frame(4, 1));
    g.start(2, 6);
    g.push(2, frame(6, 3));
    expect(g.takeOldest()?.length).toBe(6);
  });
});
