// Minimal PNG encoder for the screenshot script: 8-bit RGB, no interlace, filter 0 on every row.
// Zero dependencies: node:zlib for deflate, a table-driven CRC-32 for chunk checksums.

import { deflateSync } from 'node:zlib';

export const PNG_SIGNATURE: Uint8Array = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (IEEE 802.3, the PNG polynomial) of `data`. `crc32("123456789")` is 0xCBF43926. */
export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    c = (CRC_TABLE[(c ^ (data[i] ?? 0)) & 0xff] ?? 0) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** One chunk: 4-byte big-endian length, 4-byte type, data, CRC-32 over type + data. */
export function pngChunk(type: string, data: Uint8Array): Buffer {
  if (type.length !== 4) throw new RangeError(`PNG chunk type must be 4 characters, got "${type}"`);
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  out.set(data, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** Encodes `width` x `height` RGB24 pixels (`width * height * 3` bytes, row-major) as a PNG file. */
export function encodePng(width: number, height: number, rgb: Uint8Array): Buffer {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new RangeError(`PNG size must be positive integers, got ${String(width)}x${String(height)}`);
  }
  const stride = width * 3;
  if (rgb.length !== stride * height) {
    throw new RangeError(`PNG pixel data must be ${String(stride * height)} bytes, got ${String(rgb.length)}`);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter method: adaptive (we always pick filter 0)
  ihdr[12] = 0; // interlace: none

  // Each scanline is prefixed by its filter type byte (0 = none).
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(rgb.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }

  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 6 })),
    pngChunk('IEND', new Uint8Array(0)),
  ]);
}
