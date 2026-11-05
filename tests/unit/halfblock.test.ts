import { describe, expect, it } from 'vitest';
import { createHalfblockSerializer } from '../../src/renderer/halfblock.ts';
import {
  SGR_RESET,
  SYNC_BEGIN,
  SYNC_END,
  UPPER_HALF_BLOCK,
  cursorPosition,
  writeByteDecimal,
} from '../../src/renderer/sequences.ts';

const CSI = '\x1b[';

function cell(top: number[], bottom: number[]): string {
  return `${CSI}38;2;${top.join(';')}m${CSI}48;2;${bottom.join(';')}m${UPPER_HALF_BLOCK}`;
}

describe('createHalfblockSerializer', () => {
  it('writes exact bytes for a 2x1 cell grid', () => {
    // 2 columns x 1 row of cells = 2 x 2 pixels. Row 0 is the top row, row 1 the bottom row.
    const pixels = Uint8Array.from([
      10, 20, 30, /**/ 0, 0, 255,
      40, 50, 60, /**/ 255, 128, 7,
    ]);
    const s = createHalfblockSerializer(2, 1);
    const out = s.serializeNaive(pixels, 0, 0).toString('utf8');
    expect(out).toBe(
      SYNC_BEGIN +
        cursorPosition(1, 1) +
        cell([10, 20, 30], [40, 50, 60]) +
        cell([0, 0, 255], [255, 128, 7]) +
        SGR_RESET +
        SYNC_END,
    );
  });

  it('puts the offsets in the cursor move of every row (1-based)', () => {
    const s = createHalfblockSerializer(1, 2);
    const out = s.serializeNaive(new Uint8Array(1 * 4 * 3), 5, 3).toString('utf8');
    expect(out).toContain(cursorPosition(4, 6));
    expect(out).toContain(cursorPosition(5, 6));
    expect(out).not.toContain(cursorPosition(1, 1));
  });

  it('starts with SYNC_BEGIN and ends with SGR_RESET + SYNC_END', () => {
    const s = createHalfblockSerializer(3, 2);
    const out = s.serializeNaive(new Uint8Array(3 * 4 * 3).fill(9), 1, 1).toString('utf8');
    expect(out.startsWith(SYNC_BEGIN)).toBe(true);
    expect(out.endsWith(SGR_RESET + SYNC_END)).toBe(true);
  });

  it('allocates 41*c*r + 12*r + 64 bytes', () => {
    expect(createHalfblockSerializer(10, 5).capacity).toBe(41 * 50 + 60 + 64);
  });

  it('never exceeds capacity for all-255 pixels at the largest offsets', () => {
    for (const [c, r] of [[1, 1], [3, 2], [80, 23], [200, 60]] as const) {
      const s = createHalfblockSerializer(c, r);
      const out = s.serializeNaive(new Uint8Array(c * r * 2 * 3).fill(255), 9000, 9000 - r);
      expect(out.length).toBeLessThanOrEqual(s.capacity);
      // All cells have 3-digit channels, so the cell part is exactly 41 bytes each.
      expect(out.length).toBeGreaterThanOrEqual(41 * c * r);
    }
  });

  it('returns a view into one reused buffer (no copy)', () => {
    const s = createHalfblockSerializer(2, 2);
    const a = s.serializeNaive(new Uint8Array(2 * 4 * 3), 0, 0);
    const b = s.serializeNaive(new Uint8Array(2 * 4 * 3).fill(1), 0, 0);
    expect(a.buffer).toBe(b.buffer);
    expect(a.byteOffset).toBe(b.byteOffset);
  });

  it('rejects bad geometry, short pixel arrays and bad offsets', () => {
    expect(() => createHalfblockSerializer(0, 1)).toThrow(RangeError);
    expect(() => createHalfblockSerializer(1, 0)).toThrow(RangeError);
    expect(() => createHalfblockSerializer(1.5, 1)).toThrow(RangeError);
    const s = createHalfblockSerializer(2, 2);
    expect(() => s.serializeNaive(new Uint8Array(2 * 4 * 3 - 1), 0, 0)).toThrow(RangeError);
    const ok = new Uint8Array(2 * 4 * 3);
    expect(() => s.serializeNaive(ok, -1, 0)).toThrow(RangeError);
    expect(() => s.serializeNaive(ok, 0, -1)).toThrow(RangeError);
    expect(() => s.serializeNaive(ok, 0.5, 0)).toThrow(RangeError);
    expect(() => s.serializeNaive(ok, 10_000, 0)).toThrow(RangeError);
    expect(() => s.serializeNaive(ok, 0, 10_000)).toThrow(RangeError);
  });
});

describe('writeByteDecimal', () => {
  it('matches String(v) for every value 0..255', () => {
    const buf = new Uint8Array(4);
    for (let v = 0; v < 256; v++) {
      buf.fill(0);
      const end = writeByteDecimal(buf, 0, v);
      expect(Buffer.from(buf.subarray(0, end)).toString('latin1')).toBe(String(v));
      expect(buf[end] ?? 0).toBe(0);
    }
  });
});
