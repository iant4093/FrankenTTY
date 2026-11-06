import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { FrameAssembler, GenerationalAssembler } from '../../src/ingest/assembler.ts';

// frameSize is a multiple of 3 in [3, 3*64*48], like an rgb24 frame.
const frameSizeArb = fc.integer({ min: 1, max: 64 * 48 }).map((n) => n * 3);

/** Splits `total` bytes into chunk lengths in [1, maxChunk] driven by a stream of random sizes. */
function splitLengths(total: number, sizes: number[], maxChunk: number): number[] {
  const out: number[] = [];
  let left = total;
  let i = 0;
  while (left > 0) {
    const raw = sizes[i % sizes.length] ?? 1;
    i++;
    const len = Math.min(left, 1 + (raw % maxChunk));
    out.push(len);
    left -= len;
  }
  return out;
}

function constantFrame(size: number, index: number): Uint8Array {
  return new Uint8Array(size).fill(index % 251);
}

describe('[P4a][REQ-INGEST-06] any chunking of k frames yields exactly those k frames', () => {
  it('holds for random frame contents and chunk sizes', () => {
    fc.assert(
      fc.property(
        frameSizeArb,
        fc.integer({ min: 1, max: 12 }),
        fc.infiniteStream(fc.nat({ max: 1_000_000 })),
        fc.integer({ min: 0, max: 2 ** 31 - 1 }),
        (frameSize, k, sizeStream, seed) => {
          // Deterministic pseudo-random content from the seed (cheaper than generating 150 KB arrays).
          const frames: Uint8Array[] = [];
          let s = seed >>> 0;
          for (let f = 0; f < k; f++) {
            const data = new Uint8Array(frameSize);
            for (let i = 0; i < frameSize; i++) {
              s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
              data[i] = s >>> 24;
            }
            frames.push(data);
          }
          const stream = new Uint8Array(frameSize * k);
          frames.forEach((fr, i) => stream.set(fr, i * frameSize));

          const sizes: number[] = [];
          const it = sizeStream[Symbol.iterator]();
          for (let i = 0; i < 16; i++) sizes.push(it.next().value as number);

          const a = new FrameAssembler(frameSize);
          const got: Uint8Array[] = [];
          let offset = 0;
          for (const len of splitLengths(stream.length, sizes, 3 * frameSize)) {
            a.push(stream.subarray(offset, offset + len));
            offset += len;
            for (let f = a.takeOldest(); f !== null; f = a.takeOldest()) got.push(f.slice());
          }

          expect(got.length).toBe(k);
          for (let i = 0; i < k; i++) expect(got[i]).toEqual(frames[i]);
          expect(a.trailingBytes).toBe(0);
          expect(a.dropped).toBe(0);
          expect(a.framesCompleted).toBe(k);
        },
      ),
      { numRuns: 1000 },
    );
  });
});

describe('[P4b][REQ-INGEST-05] stale generations never produce frames', () => {
  it('only generation g frames appear and staleChunks counts the rest', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 40 }).map((n) => n * 3),
        fc.integer({ min: 1, max: 8 }),
        fc.array(fc.boolean(), { minLength: 1, maxLength: 60 }),
        fc.infiniteStream(fc.nat({ max: 1_000_000 })),
        fc.integer({ min: 1, max: 1000 }),
        (frameSize, k, staleFlags, sizeStream, g) => {
          const stream = new Uint8Array(frameSize * k);
          for (let f = 0; f < k; f++) stream.fill(f + 1, f * frameSize, (f + 1) * frameSize);

          const sizes: number[] = [];
          const it = sizeStream[Symbol.iterator]();
          for (let i = 0; i < 16; i++) sizes.push(it.next().value as number);

          const asm = new GenerationalAssembler();
          asm.start(g, frameSize);

          let staleSent = 0;
          let flagIdx = 0;
          const got: Uint8Array[] = [];
          let offset = 0;
          const pushStale = (): void => {
            // Stale chunk: all 0xEE bytes so any leak is visible, from g-1 or a newer id.
            const gen = flagIdx % 2 === 0 ? g - 1 : g + 1;
            asm.push(gen, new Uint8Array(1 + (flagIdx % 7)).fill(0xee));
            staleSent++;
          };
          for (const len of splitLengths(stream.length, sizes, 3 * frameSize)) {
            const flag = staleFlags[flagIdx % staleFlags.length] ?? false;
            if (flag) pushStale();
            flagIdx++;
            asm.push(g, stream.subarray(offset, offset + len));
            offset += len;
            if (!flag) pushStale();
            for (let f = asm.takeOldest(); f !== null; f = asm.takeOldest()) got.push(f.slice());
          }

          expect(got.length).toBe(k);
          for (let i = 0; i < k; i++) {
            expect(got[i]?.every((b) => b === i + 1)).toBe(true);
          }
          expect(asm.staleChunks).toBe(staleSent);
          expect(asm.trailingBytes).toBe(0);
        },
      ),
      { numRuns: 1000 },
    );
  });
});

describe('[P4c][REQ-INGEST-06] a sometimes-consumer never sees a corrupted frame', () => {
  it('framesCompleted = taken + dropped + queued, and every taken frame is uniform', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 30 }).map((n) => n * 3),
        fc.integer({ min: 1, max: 6 }),
        fc.integer({ min: 1, max: 40 }),
        fc.array(fc.tuple(fc.integer({ min: 1, max: 400 }), fc.integer({ min: 0, max: 3 })), {
          minLength: 1,
          maxLength: 200,
        }),
        (frameSize, capacity, k, steps) => {
          // k <= 40 < 251, so the constant byte identifies the frame index uniquely.
          const stream = new Uint8Array(frameSize * k);
          for (let f = 0; f < k; f++) stream.set(constantFrame(frameSize, f), f * frameSize);

          const a = new FrameAssembler(frameSize, capacity);
          let taken = 0;
          let offset = 0;
          let previous = -1;
          // The most recently taken buffer must stay intact until the next take*.
          let held: { buf: Uint8Array; value: number } | null = null;

          const assertHeldIntact = (): void => {
            if (held === null) return;
            const { buf, value } = held;
            expect(buf.every((b) => b === value)).toBe(true);
          };
          const accept = (f: Uint8Array | null): void => {
            if (f === null) return;
            taken++;
            const value = f[0] ?? -1;
            expect(f.every((b) => b === value)).toBe(true);
            expect(value).toBeGreaterThan(previous);
            previous = value;
            held = { buf: f, value };
          };

          for (const [rawLen, action] of steps) {
            if (offset < stream.length) {
              const len = Math.min(rawLen, stream.length - offset);
              a.push(stream.subarray(offset, offset + len));
              offset += len;
            }
            assertHeldIntact();
            if (action === 1) accept(a.takeOldest());
            else if (action === 2) accept(a.takeLatest());
            expect(a.framesCompleted).toBe(taken + a.dropped + a.queued);
            expect(a.queued).toBeLessThanOrEqual(capacity);
            assertHeldIntact();
          }
          for (let f = a.takeOldest(); f !== null; f = a.takeOldest()) accept(f);
          expect(a.queued).toBe(0);
          expect(a.framesCompleted).toBe(taken + a.dropped);
        },
      ),
      { numRuns: 500 },
    );
  });
});
