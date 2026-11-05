import fc from 'fast-check';
import { describe, it, expect } from 'vitest';
import { ProbeParser } from '../../src/term/capabilities.ts';
import type { ProbeResult } from '../../src/term/capabilities.ts';

const ESC = '\x1b';

type Kind = 'sync' | 'cell' | 'window' | 'da1';

interface ReplyToken {
  type: 'reply';
  kind: Kind;
  ps: number;
  w: number;
  h: number;
}
interface KeyToken {
  type: 'key';
  byte: number;
}
type Token = ReplyToken | KeyToken;

function replyBytes(t: ReplyToken): number[] {
  let text: string;
  switch (t.kind) {
    case 'sync':
      text = `${ESC}[?2026;${t.ps}$y`;
      break;
    case 'cell':
      text = `${ESC}[6;${t.h};${t.w}t`;
      break;
    case 'window':
      text = `${ESC}[4;${t.h};${t.w}t`;
      break;
    case 'da1':
      text = `${ESC}[?62;22c`;
      break;
  }
  return Array.from(Buffer.from(text, 'latin1'));
}

function tokenBytes(t: Token): number[] {
  return t.type === 'key' ? [t.byte] : replyBytes(t);
}

const keyByteArb = fc.integer({ min: 0, max: 255 }).filter((b) => b !== 0x1b);

/** A random subset of reply types, in random order, with random keys inserted between them. */
const tokensArb: fc.Arbitrary<Token[]> = fc
  .record({
    kinds: fc.shuffledSubarray(['sync', 'cell', 'window', 'da1'] as const),
    ps: fc.integer({ min: 0, max: 4 }),
    w: fc.integer({ min: 1, max: 9999 }),
    h: fc.integer({ min: 1, max: 9999 }),
    keys: fc.array(fc.record({ byte: keyByteArb, slot: fc.nat() }), { maxLength: 12 }),
  })
  .map(({ kinds, ps, w, h, keys }) => {
    const tokens: Token[] = kinds.map((kind) => ({ type: 'reply', kind, ps, w, h }));
    for (const key of keys) {
      tokens.splice(key.slot % (tokens.length + 1), 0, { type: 'key', byte: key.byte });
    }
    return tokens;
  });

function splitAt(bytes: Uint8Array, cuts: number[]): Uint8Array[] {
  const points = [...new Set(cuts.map((c) => c % (bytes.length + 1)))].sort((a, b) => a - b);
  const chunks: Uint8Array[] = [];
  let start = 0;
  for (const p of points) {
    chunks.push(bytes.subarray(start, p));
    start = p;
  }
  chunks.push(bytes.subarray(start));
  return chunks;
}

function parseChunks(chunks: Uint8Array[]): ProbeResult {
  const parser = new ProbeParser();
  for (const chunk of chunks) parser.feed(chunk);
  return parser.result();
}

describe('P7: probe parser', () => {
  it('any interleaving and split of reply bytes yields the canonical result', () => {
    fc.assert(
      fc.property(tokensArb, fc.array(fc.nat(), { maxLength: 10 }), (tokens, cuts) => {
        const all = Uint8Array.from(tokens.flatMap(tokenBytes));
        const canonical = parseChunks([all]);
        const split = parseChunks(splitAt(all, cuts));
        expect(split).toEqual(canonical);

        // Passthrough is exactly the key bytes, in order.
        const keys = tokens.flatMap((t) => (t.type === 'key' ? [t.byte] : []));
        expect(Array.from(canonical.passthrough)).toEqual(keys);

        // Decoded values match what was sent.
        const replies = tokens.filter((t): t is ReplyToken => t.type === 'reply');
        const sync = replies.find((t) => t.kind === 'sync');
        const cell = replies.find((t) => t.kind === 'cell');
        const win = replies.find((t) => t.kind === 'window');
        const expectedSync =
          sync === undefined ? 'unknown' : sync.ps === 0 || sync.ps === 4 ? 'unsupported' : 'supported';
        expect(canonical.sync2026).toBe(expectedSync);
        expect(canonical.cellPx).toEqual(cell === undefined ? null : { w: cell.w, h: cell.h });
        expect(canonical.windowPx).toEqual(win === undefined ? null : { w: win.w, h: win.h });
        expect(canonical.done).toBe(replies.some((t) => t.kind === 'da1'));
        expect(canonical.replied).toBe(replies.length > 0);
      }),
      { numRuns: 1000 },
    );
  });

  const interestingByte = fc.constantFrom(
    0x1b, 0x5b, 0x3f, 0x3b, 0x24, 0x79, 0x74, 0x63, 0x30, 0x31, 0x32, 0x34, 0x36, 0x20, 0x00, 0x7f, 0xff,
  );
  const garbageArb = fc.oneof(
    fc.uint8Array({ maxLength: 300 }),
    fc.array(interestingByte, { maxLength: 300 }).map((a) => Uint8Array.from(a)),
  );

  it('never throws on arbitrary bytes and never invents bytes', () => {
    fc.assert(
      fc.property(garbageArb, fc.array(fc.nat(), { maxLength: 10 }), (bytes, cuts) => {
        const parser = new ProbeParser();
        for (const chunk of splitAt(bytes, cuts)) parser.feed(chunk);
        const r = parser.result();
        expect(r.passthrough.length).toBeLessThanOrEqual(bytes.length);
        expect(['supported', 'unsupported', 'unknown']).toContain(r.sync2026);
        // Chunking does not change the outcome for garbage either.
        expect(r).toEqual(parseChunks([bytes]));
      }),
      { numRuns: 1000 },
    );
  });
});
