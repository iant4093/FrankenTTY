import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createKeyRouter, MAX_PENDING_BYTES, type KeyEvent } from '../../src/tui/input.ts';

/** One key press: its byte encoding and the event it must produce (null = ignored noise). */
interface Token {
  bytes: number[];
  expected: KeyEvent | null;
}

function str(text: string, expected: KeyEvent | null): Token {
  return { bytes: [...Buffer.from(text, 'utf8')], expected };
}

const SEEK_L5: KeyEvent = { type: 'seek', deltaSec: -5 };
const SEEK_R5: KeyEvent = { type: 'seek', deltaSec: 5 };
const SEEK_L30: KeyEvent = { type: 'seek', deltaSec: -30 };
const SEEK_R30: KeyEvent = { type: 'seek', deltaSec: 30 };

const supportedTokens: Token[] = [
  str(' ', { type: 'toggle-pause' }),
  str('q', { type: 'quit' }),
  str('Q', { type: 'quit' }),
  str('\x03', { type: 'interrupt' }),
  str('m', { type: 'cycle-mode' }),
  str('M', { type: 'cycle-mode' }),
  str('c', { type: 'cycle-palette' }),
  str('C', { type: 'cycle-palette' }),
  str('i', { type: 'toggle-hud' }),
  str('I', { type: 'toggle-hud' }),
  str('\x1b[D', SEEK_L5),
  str('\x1bOD', SEEK_L5),
  str('\x1b[1;1D', SEEK_L5),
  str('\x1b[C', SEEK_R5),
  str('\x1bOC', SEEK_R5),
  str('\x1b[1;1C', SEEK_R5),
  str('\x1b[1;2D', SEEK_L30),
  str('\x1b[2D', SEEK_L30),
  str('\x1b[1;2C', SEEK_R30),
  str('\x1b[2C', SEEK_R30),
];

const supportedArb = fc.constantFrom(...supportedTokens);

// Unknown CSI: parameters 0x30-0x3F, intermediates 0x20-0x2F, final 0x40-0x7E except C and D.
const unknownCsiArb: fc.Arbitrary<Token> = fc
  .tuple(
    fc.array(fc.integer({ min: 0x30, max: 0x3f }), { maxLength: 8 }),
    fc.array(fc.integer({ min: 0x20, max: 0x2f }), { maxLength: 2 }),
    fc.integer({ min: 0x40, max: 0x7e }).filter((b) => b !== 0x43 && b !== 0x44),
  )
  .map(([params, inter, final]) => ({ bytes: [0x1b, 0x5b, ...params, ...inter, final], expected: null }));

// Arrow finals with parameters that are not mapped (Alt, Ctrl, other counts), plus unknown SS3.
const unmappedArrowArb: Token[] = [
  str('\x1b[1;3C', null),
  str('\x1b[1;5D', null),
  str('\x1b[5C', null),
  str('\x1b[3D', null),
  str('\x1b[1C', null),
  str('\x1b[1;2;3C', null),
  str('\x1bO2C', null),
  str('\x1bOA', null),
  str('\x1bOP', null),
];

const unmappedArb = fc.constantFrom(...unmappedArrowArb);

const utf8Arb: fc.Arbitrary<Token> = fc
  .integer({ min: 0x80, max: 0x10ffff })
  .filter((cp) => cp < 0xd800 || cp > 0xdfff)
  .map((cp) => str(String.fromCodePoint(cp), null));

const ignoredAsciiArb: fc.Arbitrary<Token> = fc
  .constantFrom(...'abdefghjklnoprstuvwxyz0123456789\t\r\n'.split(''))
  .map((ch) => str(ch, null));

const tokenArb: fc.Arbitrary<Token> = fc.oneof(
  { arbitrary: supportedArb, weight: 5 },
  { arbitrary: unknownCsiArb, weight: 2 },
  { arbitrary: unmappedArb, weight: 1 },
  { arbitrary: utf8Arb, weight: 2 },
  { arbitrary: ignoredAsciiArb, weight: 1 },
);

function chunkAt(data: Uint8Array, cuts: number[]): Uint8Array[] {
  const points = [...new Set(cuts.map((c) => c % (data.length + 1)))].sort((a, b) => a - b);
  const chunks: Uint8Array[] = [];
  let from = 0;
  for (const point of points) {
    chunks.push(data.subarray(from, point));
    from = point;
  }
  chunks.push(data.subarray(from));
  return chunks;
}

function makeRouter(events: KeyEvent[]) {
  return createKeyRouter({
    onKey: (key) => events.push(key),
    // Timers are never needed: flush() delivers a trailing ESC.
    setTimer: () => 0,
    clearTimer: () => undefined,
  });
}

describe('P5: any split of a key byte stream yields the same key events', () => {
  it('matches the expected events for random key streams split at random points', () => {
    fc.assert(
      fc.property(
        fc.array(tokenArb, { maxLength: 40 }),
        fc.boolean(),
        fc.array(fc.nat({ max: 10_000 }), { maxLength: 30 }),
        (tokens, trailingEsc, cuts) => {
          const stream: number[] = [];
          const expected: KeyEvent[] = [];
          for (const token of tokens) {
            stream.push(...token.bytes);
            if (token.expected !== null) expected.push(token.expected);
          }
          if (trailingEsc) {
            stream.push(0x1b);
            expected.push({ type: 'escape' });
          }
          const data = Uint8Array.from(stream);

          const events: KeyEvent[] = [];
          const router = makeRouter(events);
          for (const chunk of chunkAt(data, cuts)) router.feed(chunk);
          router.flush();
          expect(events).toEqual(expected);

          // Same result as one chunk and as one byte per chunk.
          const whole: KeyEvent[] = [];
          const wholeRouter = makeRouter(whole);
          wholeRouter.feed(data);
          wholeRouter.flush();
          expect(whole).toEqual(expected);

          const single: KeyEvent[] = [];
          const singleRouter = makeRouter(single);
          for (const b of data) singleRouter.feed(Uint8Array.of(b));
          singleRouter.flush();
          expect(single).toEqual(expected);
        },
      ),
      { numRuns: 1000 },
    );
  });
});

describe('P5b: arbitrary bytes never throw and the pending buffer stays bounded', () => {
  it('holds for random byte streams, fed one byte at a time and in chunks', () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ maxLength: 400 }),
        fc.array(fc.nat({ max: 400 }), { maxLength: 20 }),
        (data, cuts) => {
          const router = makeRouter([]);
          for (const b of data) {
            router.feed(Uint8Array.of(b));
            expect(router.pendingLength()).toBeLessThanOrEqual(MAX_PENDING_BYTES);
          }
          router.flush();

          const chunked = makeRouter([]);
          for (const chunk of chunkAt(data, cuts)) {
            chunked.feed(chunk);
            expect(chunked.pendingLength()).toBeLessThanOrEqual(MAX_PENDING_BYTES);
          }
          chunked.flush();
          chunked.dispose();
        },
      ),
      { numRuns: 1000 },
    );
  });

  it('holds for streams biased toward escape sequences', () => {
    const byteArb = fc.oneof(
      fc.constantFrom(0x1b, 0x5b, 0x4f, 0x3b, 0x31, 0x32, 0x43, 0x44, 0x71, 0x03, 0xe2, 0x82),
      fc.integer({ min: 0, max: 255 }),
    );
    fc.assert(
      fc.property(fc.array(byteArb, { maxLength: 300 }), (stream) => {
        const router = makeRouter([]);
        for (const b of stream) {
          router.feed(Uint8Array.of(b));
          expect(router.pendingLength()).toBeLessThanOrEqual(MAX_PENDING_BYTES);
        }
        router.flush();
      }),
      { numRuns: 1000 },
    );
  });
});
