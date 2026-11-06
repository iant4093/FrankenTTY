// PCM pump (task 4.6): pacing against a fake sink and a fake clock. No processes, no timers.

import { describe, expect, it } from 'vitest';
import {
  CHUNK_MS,
  LEAD_MS,
  OUTPUT_LATENCY_MS,
  PCM_FRAME_BYTES,
  PCM_RATE,
  QUEUE_HIGH_BYTES,
  createPcmPump,
} from '../../src/audio/player.ts';
import type { PcmPump } from '../../src/audio/player.ts';

const LEAD_FRAMES = (LEAD_MS * PCM_RATE) / 1000;
const CHUNK_FRAMES = (CHUNK_MS * PCM_RATE) / 1000;
const CHUNK_BYTES = CHUNK_FRAMES * PCM_FRAME_BYTES;

class FakeSink {
  writes: { t: number; bytes: Uint8Array }[] = [];
  writableLength = 0;
  private clock: { t: number };
  constructor(clock: { t: number }) {
    this.clock = clock;
  }
  write(chunk: Uint8Array): boolean {
    this.writes.push({ t: this.clock.t, bytes: Uint8Array.from(chunk) });
    return true;
  }
  get frames(): number {
    return this.writes.reduce((n, w) => n + w.bytes.length / PCM_FRAME_BYTES, 0);
  }
  get bytes(): number {
    return this.writes.reduce((n, w) => n + w.bytes.length, 0);
  }
}

function rig(opts: { startSec?: number; outputLatencyMs?: number } = {}) {
  const clock = { t: 1000 };
  const sink = new FakeSink(clock);
  const pump = createPcmPump({ sink, now: () => clock.t, ...opts });
  /** Advances simulated time in 10 ms steps, ticking the pump at each. */
  const run = (ms: number, step = 10): void => {
    for (let done = 0; done < ms; done += step) {
      clock.t += Math.min(step, ms - done);
      pump.tick();
    }
  };
  return { clock, sink, pump, run };
}

/** `ms` of PCM (frames * 4 bytes), filled with `fill`. */
function pcm(ms: number, fill = 1): Uint8Array {
  return new Uint8Array(Math.round((ms * PCM_RATE) / 1000) * PCM_FRAME_BYTES).fill(fill);
}

function fed(pump: PcmPump, ms: number, fill = 1): void {
  pump.feed(pcm(ms, fill));
}

describe('[REQ-SYNC-04] constants', () => {
  it('are the documented values', () => {
    expect(LEAD_MS).toBe(120);
    expect(CHUNK_MS).toBe(20);
    expect(OUTPUT_LATENCY_MS).toBe(100);
    expect(CHUNK_BYTES).toBe(3840);
  });
});

describe('[REQ-SYNC-04][REQ-SYNC-03] createPcmPump', () => {
  it('holds before release(): nothing is written, the position stays at the segment start', () => {
    const { pump, sink, run } = rig({ startSec: 12 });
    fed(pump, 500);
    run(500);
    expect(sink.writes).toHaveLength(0);
    expect(pump.positionSec()).toBe(12);
    expect(pump.aheadFrames()).toBe(0);
  });

  it('ready() needs one full chunk, or the end of the source', () => {
    const { pump } = rig();
    expect(pump.ready()).toBe(false);
    pump.feed(new Uint8Array(CHUNK_BYTES - 4));
    expect(pump.ready()).toBe(false);
    pump.feed(new Uint8Array(4));
    expect(pump.ready()).toBe(true);
    const other = rig().pump;
    other.endOfSource();
    expect(other.ready()).toBe(true);
  });

  it('wantsMore() turns false when the queue holds QUEUE_HIGH_BYTES and true again as it drains', () => {
    const { pump, run } = rig();
    expect(pump.wantsMore()).toBe(true);
    pump.feed(new Uint8Array(QUEUE_HIGH_BYTES));
    expect(pump.wantsMore()).toBe(false);
    pump.release();
    run(100);
    expect(pump.wantsMore()).toBe(true);
  });

  it('writes LEAD_MS up front on the first tick after release, then paces to real time', () => {
    const { pump, sink, run, clock } = rig();
    fed(pump, 2000);
    pump.release();
    pump.tick();
    expect(sink.frames).toBe(LEAD_FRAMES);
    expect(sink.writes.every((w) => w.bytes.length === CHUNK_BYTES)).toBe(true);

    const t0 = clock.t;
    run(1000);
    const ideal = LEAD_FRAMES + ((clock.t - t0) * PCM_RATE) / 1000;
    // Within one chunk of "lead + real time".
    expect(sink.frames).toBeLessThanOrEqual(ideal);
    expect(sink.frames).toBeGreaterThan(ideal - CHUNK_FRAMES);
  });

  it('never has more than LEAD_MS written ahead of the clock, at any tick', () => {
    const { pump, sink, run, clock } = rig();
    fed(pump, 3000);
    pump.release();
    const start = clock.t;
    for (let i = 0; i < 250; i++) {
      run(10);
      const played = ((clock.t - start) * PCM_RATE) / 1000;
      expect(sink.frames - played).toBeLessThanOrEqual(LEAD_FRAMES + 1e-6);
      expect(pump.aheadFrames()).toBeLessThanOrEqual(LEAD_FRAMES);
    }
    expect(pump.stats.aheadMaxFrames).toBeLessThanOrEqual(LEAD_FRAMES);
    expect(pump.stats.aheadMinFrames).toBeGreaterThanOrEqual(LEAD_FRAMES - CHUNK_FRAMES);
    expect(pump.stats.underruns).toBe(0);
  });

  it('derives the position from the frames written: media time written, minus the lead still queued, minus the latency', () => {
    const { pump, run } = rig({ startSec: 5 });
    fed(pump, 5000);
    pump.release();
    pump.tick(); // the first write starts the device clock
    run(1000);
    const written = pump.stats.bytesWritten / PCM_FRAME_BYTES;
    const expected = 5 + (written - pump.aheadFrames()) / PCM_RATE - OUTPUT_LATENCY_MS / 1000;
    expect(pump.positionSec()).toBeCloseTo(expected, 9);
    // And in real terms: 1 s after release the audible position is 1 s - latency.
    expect(pump.positionSec()).toBeCloseTo(5 + 1 - OUTPUT_LATENCY_MS / 1000, 6);
  });

  it('holds the position for the output latency after release, then it runs', () => {
    const { pump, run } = rig({ startSec: 3 });
    fed(pump, 1000);
    pump.release();
    pump.tick();
    run(50);
    expect(pump.positionSec()).toBe(3);
    run(100);
    expect(pump.positionSec()).toBeCloseTo(3.05, 6);
  });

  it('pause stops writing at once and freezes the position; resume continues from the same place', () => {
    const { pump, sink, run } = rig();
    fed(pump, 5000);
    pump.release();
    run(500);
    const writesBefore = sink.writes.length;
    pump.pause();
    const frozen = pump.positionSec();
    run(1000);
    expect(sink.writes).toHaveLength(writesBefore);
    expect(pump.positionSec()).toBe(frozen);
    expect(pump.aheadFrames()).toBe(0);

    pump.resume();
    expect(pump.positionSec()).toBe(frozen);
    run(300);
    expect(sink.writes.length).toBeGreaterThan(writesBefore);
    expect(pump.positionSec()).toBeGreaterThan(frozen + 0.15);
    // A resumed pump has again at most LEAD_MS ahead of what it counts as played.
    expect(pump.aheadFrames()).toBeLessThanOrEqual(LEAD_FRAMES);
  });

  it('the frozen position of a pause is where the device ends up: the media time written, minus the latency', () => {
    const { pump, run } = rig();
    fed(pump, 5000);
    pump.release();
    run(500);
    pump.pause();
    const written = pump.stats.bytesWritten / PCM_FRAME_BYTES;
    expect(pump.positionSec()).toBeCloseTo(written / PCM_RATE - OUTPUT_LATENCY_MS / 1000, 9);
  });

  it('resume does not release a held segment', () => {
    const { pump, sink, run } = rig();
    pump.pause();
    fed(pump, 500);
    pump.resume();
    run(200);
    expect(sink.writes).toHaveLength(0);
    pump.release();
    run(50);
    expect(sink.writes.length).toBeGreaterThan(0);
  });

  it('release() while paused starts the writing at resume()', () => {
    const { pump, sink, run } = rig();
    fed(pump, 500);
    pump.pause();
    pump.release();
    run(200);
    expect(sink.writes).toHaveLength(0);
    pump.resume();
    run(10);
    expect(sink.writes.length).toBeGreaterThan(0);
  });

  it('seek drops queued and written-ahead PCM of the old source and holds at the new position', () => {
    const { pump, sink, run } = rig();
    fed(pump, 3000, 0xaa);
    pump.release();
    run(300);
    const before = sink.writes.length;
    pump.seek(40);
    expect(pump.positionSec()).toBe(40);
    expect(pump.aheadFrames()).toBe(0);
    expect(pump.ready()).toBe(false);
    run(300);
    expect(sink.writes).toHaveLength(before); // held: nothing, in particular no old bytes

    fed(pump, 1000, 0x55);
    expect(pump.ready()).toBe(true);
    pump.release();
    pump.tick();
    run(500);
    const after = sink.writes.slice(before);
    expect(after.length).toBeGreaterThan(0);
    for (const w of after) expect(w.bytes.every((b) => b === 0x55)).toBe(true);
    expect(pump.positionSec()).toBeCloseTo(40 + 0.5 - OUTPUT_LATENCY_MS / 1000, 6);
  });

  it('seek while paused keeps the pause and holds; resume + release then start the new segment', () => {
    const { pump, sink, run } = rig();
    fed(pump, 1000);
    pump.release();
    run(200);
    pump.pause();
    const n = sink.writes.length;
    pump.seek(9);
    expect(pump.positionSec()).toBe(9);
    fed(pump, 500, 7);
    run(300);
    expect(sink.writes).toHaveLength(n);
    pump.resume();
    pump.release();
    run(100);
    expect(sink.writes.length).toBeGreaterThan(n);
    expect(pump.positionSec()).toBeGreaterThanOrEqual(9);
  });

  it('an underrun stalls the position at the written PCM, counts it, and the lead bound holds again afterwards', () => {
    const { pump, sink, run } = rig();
    fed(pump, 100);
    pump.release();
    run(600); // 100 ms of PCM played out, then silence
    expect(pump.stats.underruns).toBeGreaterThanOrEqual(1);
    const stalled = pump.positionSec();
    expect(stalled).toBeCloseTo(0.1 - OUTPUT_LATENCY_MS / 1000, 6);
    run(200);
    expect(pump.positionSec()).toBe(stalled);

    fed(pump, 2000, 3);
    const framesBefore = sink.frames;
    run(10);
    // New data after a dry spell is written as a fresh LEAD_MS burst, not all at once.
    expect(sink.frames - framesBefore).toBeLessThanOrEqual(LEAD_FRAMES);
    expect(pump.aheadFrames()).toBeLessThanOrEqual(LEAD_FRAMES);
    run(500);
    expect(pump.positionSec()).toBeGreaterThan(stalled + 0.3);
  });

  it('after the end of the source and the last write, the position keeps running and finished() is true', () => {
    const { pump, sink, run } = rig();
    fed(pump, 200);
    pump.endOfSource();
    pump.release();
    run(100); // 120 ms ahead + 100 ms of play covers all 200 ms
    expect(sink.frames).toBe((200 * PCM_RATE) / 1000);
    expect(pump.finished()).toBe(true);
    const a = pump.positionSec();
    run(500);
    expect(pump.positionSec()).toBeGreaterThan(a + 0.4);
  });

  it('pausing after the end of the source keeps the position where time has taken it, and resume continues from there', () => {
    const { pump, run } = rig();
    fed(pump, 100);
    pump.endOfSource();
    pump.release();
    run(600); // all written, 500 ms of silence after it
    const before = pump.positionSec();
    expect(before).toBeGreaterThan(0.4);
    pump.pause();
    expect(pump.positionSec()).toBeGreaterThanOrEqual(before);
    const frozen = pump.positionSec();
    run(300);
    expect(pump.positionSec()).toBe(frozen);
    pump.resume();
    run(200);
    expect(pump.positionSec()).toBeGreaterThan(frozen + 0.15);
    expect(pump.positionSec()).toBeLessThan(frozen + 0.25);
  });

  it('is not finished while PCM is queued, or before the source ends', () => {
    const { pump, run } = rig();
    fed(pump, 500);
    pump.release();
    run(10);
    expect(pump.finished()).toBe(false);
    pump.endOfSource();
    expect(pump.finished()).toBe(false); // 380 ms still queued behind the lead
    run(600);
    expect(pump.finished()).toBe(true);
  });

  it('waits for a full chunk before writing, but flushes a short tail once the source ended', () => {
    const { pump, sink, run } = rig();
    pump.feed(new Uint8Array(1000));
    pump.release();
    run(100);
    expect(sink.writes).toHaveLength(0);
    pump.endOfSource();
    run(10);
    expect(sink.bytes).toBe(1000);
  });

  it('drops a trailing partial frame at the end of the source', () => {
    const { pump, sink, run } = rig();
    pump.feed(new Uint8Array(CHUNK_BYTES + 3));
    pump.endOfSource();
    pump.release();
    run(100);
    expect(sink.bytes).toBe(CHUNK_BYTES);
    expect(sink.bytes % PCM_FRAME_BYTES).toBe(0);
    expect(pump.finished()).toBe(true);
  });

  it('writes frame-aligned chunks that reproduce the source bytes, whatever the buffer sizes', () => {
    const { pump, sink, run } = rig();
    const sizes = [1, 3, 5000, 7, 4093, 11, 20000, 2, 6001];
    let total = 0;
    for (const n of sizes) {
      const buf = new Uint8Array(n);
      for (let i = 0; i < n; i++) buf[i] = (total + i) % 251;
      pump.feed(buf);
      total += n;
    }
    pump.endOfSource();
    pump.release();
    run(2000);
    const whole = total - (total % PCM_FRAME_BYTES);
    expect(sink.bytes).toBe(whole);
    let at = 0;
    for (const w of sink.writes) {
      expect(w.bytes.length % PCM_FRAME_BYTES).toBe(0);
      for (const b of w.bytes) expect(b).toBe((at++) % 251);
    }
  });

  it('waits while the sink has queued bytes, and counts it', () => {
    const { pump, sink, run } = rig();
    fed(pump, 1000);
    pump.release();
    run(10);
    const n = sink.writes.length;
    sink.writableLength = 5000;
    run(200);
    expect(sink.writes).toHaveLength(n);
    expect(pump.stats.sinkBusy).toBeGreaterThan(0);
    sink.writableLength = 0;
    run(10);
    expect(sink.writes.length).toBeGreaterThan(n);
  });

  it('rejects a bad latency and a non-finite seek', () => {
    expect(() => createPcmPump({ sink: { write: () => undefined }, now: () => 0, outputLatencyMs: -1 })).toThrow(RangeError);
    expect(() => {
      rig().pump.seek(Number.NaN);
    }).toThrow(RangeError);
  });

  it('honours a custom output latency', () => {
    const { pump, run } = rig({ outputLatencyMs: 0 });
    fed(pump, 1000);
    pump.release();
    pump.tick();
    run(500);
    expect(pump.positionSec()).toBeCloseTo(0.5, 6);
  });
});
