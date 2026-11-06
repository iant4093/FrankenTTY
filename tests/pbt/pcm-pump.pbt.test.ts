import fc from 'fast-check';
import { describe, it } from 'vitest';
import { CHUNK_MS, LEAD_MS, PCM_FRAME_BYTES, PCM_RATE, createPcmPump } from '../../src/audio/player.ts';

// P9: random sequences of play / pause / resume / seek / advance-time / feed against the PCM pump with a fake
// sink. Independent of the pump's own model, the sink record must show:
//   - frames written never exceed (frames written when the run began + run time * rate + LEAD);
//   - the pump's written-ahead figure stays in [0, LEAD + one chunk];
//   - no bytes are written while paused or held;
//   - the position never decreases except across a seek, and never falls below the segment start;
//   - every byte written belongs to the current source (seek drops the old one) and arrives in order.

const LEAD_FRAMES = (LEAD_MS * PCM_RATE) / 1000;
const CHUNK_FRAMES = (CHUNK_MS * PCM_RATE) / 1000;

const opArb = fc.oneof(
  { weight: 5, arbitrary: fc.record({ op: fc.constant('advance' as const), ms: fc.integer({ min: 0, max: 80 }) }) },
  { weight: 4, arbitrary: fc.record({ op: fc.constant('feed' as const), bytes: fc.integer({ min: 1, max: 20_000 }) }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant('release' as const) }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant('pause' as const) }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant('resume' as const) }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant('seek' as const), sec: fc.integer({ min: 0, max: 600 }) }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant('end' as const) }) },
);

describe('P9 PCM pump', () => {
  it('keeps the lead bound, writes nothing while paused or held, never moves the position back, and never plays old PCM', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100 }), fc.array(opArb, { minLength: 1, maxLength: 60 }), (startSec, ops) => {
        let t = 5000;
        let segment = 0;
        /** Pattern for the byte at stream offset `i` of the current source. */
        const byteAt = (i: number): number => (i * 7 + segment * 13) & 0xff;
        let fedBytes = 0;
        let writtenBytes = 0;
        let ok = true;
        let paused = false;
        let released = false;
        // Independent run record: when the current run started and how many frames had been written then.
        let runStartT = 0;
        let runStartFrames = 0;
        let lastPosition = startSec;
        let ended = false;

        const pump = createPcmPump({
          now: () => t,
          startSec,
          sink: {
            write(chunk: Uint8Array) {
              if (paused || !released) ok = false; // nothing may be written while paused or held
              if (chunk.length % PCM_FRAME_BYTES !== 0 || chunk.length > CHUNK_FRAMES * PCM_FRAME_BYTES) ok = false;
              for (let i = 0; i < chunk.length; i++) {
                if (chunk[i] !== byteAt(writtenBytes + i)) ok = false; // old source, or out of order
              }
              writtenBytes += chunk.length;
              return true;
            },
          },
        });

        const startRun = (): void => {
          runStartT = t;
          runStartFrames = writtenBytes / PCM_FRAME_BYTES;
        };

        const check = (): void => {
          const frames = writtenBytes / PCM_FRAME_BYTES;
          if (released && !paused && frames - runStartFrames > ((t - runStartT) * PCM_RATE) / 1000 + LEAD_FRAMES + 1e-6) ok = false;
          const ahead = pump.aheadFrames();
          if (ahead < 0 || ahead > LEAD_FRAMES + CHUNK_FRAMES) ok = false;
          if (writtenBytes > fedBytes) ok = false;
          const pos = pump.positionSec();
          if (pos < lastPosition - 1e-9) ok = false;
          lastPosition = pos;
        };

        for (const o of ops) {
          switch (o.op) {
            case 'advance':
              t += o.ms;
              pump.tick();
              break;
            case 'feed': {
              if (ended) break;
              const buf = new Uint8Array(o.bytes);
              for (let i = 0; i < o.bytes; i++) buf[i] = byteAt(fedBytes + i);
              fedBytes += o.bytes;
              pump.feed(buf);
              break;
            }
            case 'release':
              if (!released) {
                released = true;
                if (!paused) startRun();
              }
              pump.release();
              break;
            case 'pause':
              paused = true;
              pump.pause();
              break;
            case 'resume':
              if (paused) {
                paused = false;
                if (released) startRun();
              }
              pump.resume();
              break;
            case 'seek':
              segment++;
              fedBytes = 0;
              writtenBytes = 0;
              released = false;
              ended = false;
              pump.seek(o.sec);
              lastPosition = o.sec; // the position may jump on a seek, and holds at the target
              if (pump.positionSec() !== o.sec || pump.aheadFrames() !== 0) ok = false;
              break;
            case 'end':
              ended = true;
              pump.endOfSource();
              break;
          }
          check();
          if (!ok) return false;
        }
        return ok;
      }),
      { numRuns: 500 },
    );
  });
});
