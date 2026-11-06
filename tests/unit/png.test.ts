import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { PNG_SIGNATURE, crc32, encodePng, pngChunk } from '../../scripts/lib/png.ts';

describe('crc32', () => {
  it('matches the standard check value for "123456789"', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });

  it('is 0 for empty input', () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe('pngChunk', () => {
  it('writes the well-known IEND chunk', () => {
    const iend = pngChunk('IEND', new Uint8Array(0));
    expect([...iend]).toEqual([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
  });

  it('rejects a type that is not 4 characters', () => {
    expect(() => pngChunk('IDA', new Uint8Array(0))).toThrow(RangeError);
  });
});

describe('encodePng', () => {
  const pixels = Uint8Array.from([
    255, 0, 0, 0, 255, 0, 0, 0, 255,
    255, 255, 0, 0, 255, 255, 12, 34, 56,
  ]);

  it('starts with the PNG signature and a valid IHDR', () => {
    const png = encodePng(3, 2, pixels);
    expect([...png.subarray(0, 8)]).toEqual([...PNG_SIGNATURE]);
    expect(png.readUInt32BE(8)).toBe(13);
    expect(png.toString('latin1', 12, 16)).toBe('IHDR');
    expect(png.readUInt32BE(16)).toBe(3);
    expect(png.readUInt32BE(20)).toBe(2);
    expect(png[24]).toBe(8);
    expect(png[25]).toBe(2);
    expect(png[26]).toBe(0);
    expect(png[27]).toBe(0);
    expect(png[28]).toBe(0);
    expect(png.readUInt32BE(29)).toBe(crc32(png.subarray(12, 29)));
  });

  it('ends with IEND and stores filtered rows that inflate back to the input', () => {
    const png = encodePng(3, 2, pixels);
    expect([...png.subarray(png.length - 12)]).toEqual([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
    const idatLen = png.readUInt32BE(33);
    expect(png.toString('latin1', 37, 41)).toBe('IDAT');
    const raw = inflateSync(png.subarray(41, 41 + idatLen));
    expect(raw.length).toBe(2 * (1 + 9));
    expect(raw[0]).toBe(0);
    expect(raw[10]).toBe(0);
    expect([...raw.subarray(1, 10)]).toEqual([...pixels.subarray(0, 9)]);
    expect([...raw.subarray(11, 20)]).toEqual([...pixels.subarray(9, 18)]);
  });

  it('rejects mismatched pixel data and bad sizes', () => {
    expect(() => encodePng(3, 2, new Uint8Array(17))).toThrow(RangeError);
    expect(() => encodePng(0, 2, new Uint8Array(0))).toThrow(RangeError);
  });

  it('round-trips through ffmpeg for a 3x2 image', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'frankentty-png-'));
    try {
      const file = path.join(dir, 'x.png');
      writeFileSync(file, encodePng(3, 2, pixels));
      const r = spawnSync(
        'ffmpeg',
        ['-hide_banner', '-loglevel', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
        { maxBuffer: 1 << 20 },
      );
      expect(r.status).toBe(0);
      expect([...r.stdout]).toEqual([...pixels]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
