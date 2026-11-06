import { describe, expect, it } from 'vitest';
import { createPipeline, effectiveMode } from '../../src/player/pipeline.ts';
import type { PipelineOptions } from '../../src/player/pipeline.ts';
import { ASCII_RAMP } from '../../src/renderer/ascii.ts';
import { AMBER_RAMP } from '../../src/renderer/palette.ts';
import { SGR_RESET, SYNC_BEGIN, SYNC_END } from '../../src/renderer/sequences.ts';
import { readCell, replayInto } from '../helpers/emulator.ts';

const COLS = 8;
const ROWS = 4;

function options(over: Partial<PipelineOptions> = {}): PipelineOptions {
  return {
    cols: COLS,
    rows: ROWS,
    offsetX: 2,
    offsetY: 1,
    mode: 'halfblock',
    palette: 'truecolor',
    depth: 24,
    threshold: 0,
    ...over,
  };
}

/** A decode-resolution frame (2c x 4r) with a diagonal gradient in every channel. */
function frame(seed = 0): Uint8Array {
  const w = COLS * 2;
  const h = ROWS * 4;
  const px = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      px[i] = (x * 15 + seed) & 255;
      px[i + 1] = (y * 8 + seed * 3) & 255;
      px[i + 2] = ((x + y) * 7) & 255;
    }
  }
  return px;
}

function text(buf: Uint8Array): string {
  return Buffer.from(buf).toString('utf8');
}

describe('[REQ-RENDER-04][REQ-RENDER-05] createPipeline', () => {
  it('exposes the decode resolution 2c x 4r', () => {
    const p = createPipeline(options());
    expect(p.decodeWidth).toBe(COLS * 2);
    expect(p.decodeHeight).toBe(ROWS * 4);
    expect(p.cols).toBe(COLS);
    expect(p.rows).toBe(ROWS);
  });

  it('renders a first frame inside sync framing and fills the stats', () => {
    const p = createPipeline(options());
    const out = p.render(frame());
    expect(text(out).startsWith(SYNC_BEGIN)).toBe(true);
    expect(p.stats.bytes).toBe(out.length);
    expect(p.stats.cellsWritten).toBe(COLS * ROWS);
    expect(p.stats.naiveBytes).toBeGreaterThan(0);
    expect(p.stats.naiveSgr).toBe(2 * COLS * ROWS);
    expect(p.stats.renderMs).toBeGreaterThanOrEqual(0);
  });

  it('returns an empty buffer for an identical second frame', () => {
    const p = createPipeline(options());
    const f = frame();
    expect(p.render(f).length).toBeGreaterThan(0);
    const second = p.render(f);
    expect(second.length).toBe(0);
    expect(p.stats.bytes).toBe(0);
    expect(p.stats.cellsWritten).toBe(0);
    expect(p.stats.cellsSkipped).toBe(COLS * ROWS);
  });

  it('writes only the changed cells for a slightly different second frame', () => {
    const p = createPipeline(options());
    const f = frame();
    const first = p.render(f).length;
    const g = f.slice();
    g[0] = (g[0] ?? 0) ^ 0xff; // one pixel in the top-left cell
    const second = p.render(g);
    expect(second.length).toBeGreaterThan(0);
    expect(second.length).toBeLessThan(first);
    expect(p.stats.cellsWritten).toBeLessThan(COLS * ROWS);
  });

  it('invalidate() makes the next identical frame a full redraw', () => {
    const p = createPipeline(options());
    const f = frame();
    const first = p.render(f).length;
    expect(p.render(f).length).toBe(0);
    p.invalidate();
    expect(p.render(f).length).toBe(first);
  });

  it('setMode() keeps geometry and the screen model, and switches the glyphs', () => {
    const p = createPipeline(options());
    const f = frame();
    p.render(f);
    expect(p.render(f).length).toBe(0);

    p.setMode('ascii');
    expect(p.mode).toBe('ascii');
    expect(p.decodeWidth).toBe(COLS * 2);
    expect(p.decodeHeight).toBe(ROWS * 4);
    const ascii = p.render(f);
    expect(ascii.length).toBeGreaterThan(0);
    expect(p.stats.cellsWritten).toBeLessThanOrEqual(COLS * ROWS);
    expect(text(ascii)).not.toContain('\u2580');
    expect(p.render(f).length).toBe(0);

    p.setMode('braille');
    expect(p.mode).toBe('braille');
    expect(p.render(f).length).toBeGreaterThan(0);
    expect(p.render(f).length).toBe(0);

    p.setMode('halfblock');
    expect(p.render(f).length).toBeGreaterThan(0);
    expect(p.render(f).length).toBe(0);
  });

  it('setMode() back to the same mode and setPalette() to the same palette write nothing for the same picture', () => {
    const p = createPipeline(options());
    const f = frame();
    p.render(f);
    p.setMode('halfblock');
    p.setPalette('truecolor');
    expect(p.render(f).length).toBe(0);
    expect(p.stats.cellsWritten).toBe(0);
    expect(p.stats.cellsWritten).toBeLessThan(COLS * ROWS);
  });

  it('setPalette() keeps the screen model and changes the colors', () => {
    const p = createPipeline(options());
    const f = frame();
    const plain = Buffer.from(p.render(f));
    expect(p.render(f).length).toBe(0);

    p.setPalette('amber');
    expect(p.palette).toBe('amber');
    const amber = p.render(f);
    expect(amber.length).toBeGreaterThan(0);
    expect(p.stats.cellsWritten).toBeLessThanOrEqual(COLS * ROWS);
    expect(Buffer.from(amber).equals(plain)).toBe(false);
    expect(p.render(f).length).toBe(0);
  });

  it('invalidateRows() rewrites exactly those rows', () => {
    const p = createPipeline(options());
    const f = frame();
    p.render(f);
    p.invalidateRows(1, 2);
    p.render(f);
    expect(p.stats.cellsWritten).toBe(2 * COLS);
    // Clipped to the area; negative and empty ranges do nothing.
    p.invalidateRows(ROWS - 1, 10);
    p.render(f);
    expect(p.stats.cellsWritten).toBe(COLS);
    p.invalidateRows(0, 0);
    p.invalidateRows(ROWS, 3);
    expect(p.render(f).length).toBe(0);
  });

  it('refreshRolling() marks ceil(rows / 60) rows per call and wraps around', () => {
    const rows = 7;
    const cols = 3;
    const p = createPipeline(options({ cols, rows }));
    const f = new Uint8Array(cols * 2 * rows * 4 * 3).fill(90);
    p.render(f);
    const seen: number[] = [];
    for (let i = 0; i < 2 * rows; i++) {
      p.refreshRolling();
      const out = text(p.render(f));
      expect(p.stats.cellsWritten).toBe(cols); // 1 row per call at 7 rows
      const row = /\x1b\[(\d+);\d+H/.exec(out);
      seen.push(Number(row?.[1]) - 1 - 1); // 1-based screen row, minus the 1-row offset
    }
    expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6, 0, 1, 2, 3, 4, 5, 6]);
  });

  it('over 60 frames of a static picture every row of a 60-row area is rewritten exactly once, and nothing else', () => {
    const cols = 4;
    const rows = 60;
    const p = createPipeline(options({ cols, rows, offsetX: 0, offsetY: 0 }));
    const f = new Uint8Array(cols * 2 * rows * 4 * 3).fill(120);
    p.render(f);
    const counts = new Array<number>(rows).fill(0);
    for (let i = 0; i < 60; i++) {
      p.refreshRolling();
      const out = text(p.render(f));
      const moves = [...out.matchAll(/\x1b\[(\d+);\d+H/g)];
      expect(moves).toHaveLength(1);
      expect(p.stats.cellsWritten).toBe(cols);
      const row = Number(moves[0]?.[1]) - 1;
      counts[row] = (counts[row] ?? 0) + 1;
    }
    expect(counts.every((n) => n === 1)).toBe(true);
  });

  it('with 120 rows the rolling refresh rewrites two rows per frame and covers the area in 60 frames', () => {
    const cols = 2;
    const rows = 120;
    const p = createPipeline(options({ cols, rows, offsetX: 0, offsetY: 0 }));
    const f = new Uint8Array(cols * 2 * rows * 4 * 3).fill(30);
    p.render(f);
    let written = 0;
    for (let i = 0; i < 60; i++) {
      p.refreshRolling();
      p.render(f);
      expect(p.stats.cellsWritten).toBe(2 * cols);
      written += p.stats.cellsWritten;
    }
    expect(written).toBe(rows * cols);
  });

  it('draws the render area at its offsets and nowhere else', async () => {
    const p = createPipeline(options({ offsetX: 3, offsetY: 2 }));
    const out = Buffer.from(p.render(frame()));
    const term = await replayInto(out, 20, 12);
    try {
      for (let y = 0; y < 12; y++) {
        for (let x = 0; x < 20; x++) {
          const inside = x >= 3 && x < 3 + COLS && y >= 2 && y < 2 + ROWS;
          const c = readCell(term, x, y);
          if (inside) expect(c.bg).not.toBeNull();
          else expect(c.char === '' || c.char === ' ').toBe(true);
          if (!inside) expect(c.bg).toBeNull();
        }
      }
    } finally {
      term.dispose();
    }
  });

  it('[REQ-RENDER-06] braille mode draws Braille glyphs or spaces; ascii mode draws ramp characters', async () => {
    const braille = createPipeline(options({ mode: 'braille', offsetX: 0, offsetY: 0 }));
    const bTerm = await replayInto(Buffer.from(braille.render(frame())), COLS, ROWS);
    const ascii = createPipeline(options({ mode: 'ascii', offsetX: 0, offsetY: 0 }));
    const aTerm = await replayInto(Buffer.from(ascii.render(frame())), COLS, ROWS);
    try {
      let brailleCells = 0;
      for (let y = 0; y < ROWS; y++) {
        for (let x = 0; x < COLS; x++) {
          const b = readCell(bTerm, x, y).char;
          const cp = b === '' ? 0x20 : (b.codePointAt(0) ?? 0);
          expect(cp === 0x20 || (cp >= 0x2800 && cp <= 0x28ff)).toBe(true);
          if (cp >= 0x2800) brailleCells++;
          const a = readCell(aTerm, x, y).char;
          expect(a === '' ? ' ' : a).toSatisfy((ch: string) => ASCII_RAMP.includes(ch));
        }
      }
      expect(brailleCells).toBeGreaterThan(0);
    } finally {
      bTerm.dispose();
      aTerm.dispose();
    }
  });

  it('[REQ-PAL-01] amber palette output uses only ramp entries', async () => {
    const p = createPipeline(options({ palette: 'amber', offsetX: 0, offsetY: 0 }));
    const term = await replayInto(Buffer.from(p.render(frame())), COLS, ROWS);
    try {
      for (let y = 0; y < ROWS; y++) {
        for (let x = 0; x < COLS; x++) {
          const c = readCell(term, x, y);
          expect(AMBER_RAMP).toContain(c.bg);
          if (c.char === '\u2580') expect(AMBER_RAMP).toContain(c.fg);
        }
      }
    } finally {
      term.dispose();
    }
  });

  it('a higher threshold never writes more SGRs for the same first frame', () => {
    const f = frame();
    const lossless = createPipeline(options({ threshold: 0 }));
    lossless.render(f);
    const lossy = createPipeline(options({ threshold: 40 }));
    lossy.render(f);
    expect(lossy.stats.sgrEmitted).toBeLessThanOrEqual(lossless.stats.sgrEmitted);
  });

  it('[REQ-RENDER-08] depth 8 and 4 emit shorter first frames than depth 24', () => {
    const f = frame();
    const sizes = ([24, 8, 4] as const).map((depth) => createPipeline(options({ depth })).render(f).length);
    expect(sizes[1]).toBeLessThan(sizes[0] ?? 0);
    expect(sizes[2]).toBeLessThan(sizes[1] ?? 0);
  });

  it('setThreshold() applies from the next render and keeps the screen model valid', () => {
    const f = frame();
    const p = createPipeline(options({ threshold: 0 }));
    const lossless = p.render(f).length;
    const sgr0 = p.stats.sgrEmitted;
    expect(p.threshold).toBe(0);
    p.setThreshold(60);
    expect(p.threshold).toBe(60);
    // No invalidation: the screen model stays valid. The half-block builder merges more cells now,
    // so the first render may write the changed ones, and the next identical frame writes nothing.
    p.render(f);
    expect(p.render(f).length).toBe(0);
    p.invalidate();
    p.render(f);
    expect(p.stats.sgrEmitted).toBeLessThan(sgr0);
    expect(lossless).toBeGreaterThan(0);
  });

  it('[REQ-RENDER-08] setDepth() switches the mapper and keeps the screen model', () => {
    const f = frame();
    const p = createPipeline(options());
    const rgb = text(p.render(f));
    expect(rgb).toMatch(/\x1b\[[\d;]*[34]8;2;/);
    expect(p.render(f).length).toBe(0);

    p.setDepth(8);
    expect(p.depth).toBe(8);
    const indexed = text(p.render(f));
    // Cells shown in 24-bit that differ from the 256-color choice are rewritten; none is written twice.
    expect(p.stats.cellsWritten).toBeGreaterThan(0);
    expect(p.stats.cellsWritten).toBeLessThanOrEqual(COLS * ROWS);
    expect(indexed).toMatch(/\x1b\[[\d;]*[34]8;5;\d+/);
    expect(indexed).not.toMatch(/\x1b\[[\d;]*[34]8;2;/);
    expect(p.render(f).length).toBe(0);

    p.setDepth(4);
    expect(p.depth).toBe(4);
    expect(p.render(f).length).toBeGreaterThan(0);
    expect(p.stats.cellsWritten).toBeLessThanOrEqual(COLS * ROWS);
    expect(p.render(f).length).toBe(0);
    // Same depth again is a no-op: nothing to redraw.
    p.setDepth(4);
    expect(p.render(f).length).toBe(0);
  });

  it('setDepth() compares the screen model in RGB: a 24-bit value that equals an index numerically is not "the same color"', () => {
    // Half-block cells where top and bottom are equal are solid (space, background only): one RGB color per cell.
    const solid = (r: number, g: number, b: number): Uint8Array => {
      const px = new Uint8Array(COLS * 2 * ROWS * 4 * 3);
      for (let i = 0; i < px.length; i += 3) {
        px[i] = r;
        px[i + 1] = g;
        px[i + 2] = b;
      }
      return px;
    };
    // 0x0000C4 is the number 196 = the 256-color index of 0xFF0000. A model compared as indexes would call them equal.
    const p = createPipeline(options());
    p.render(solid(0x00, 0x00, 0xc4));
    p.setDepth(8);
    const red = text(p.render(solid(0xff, 0x00, 0x00)));
    expect(p.stats.cellsWritten).toBe(COLS * ROWS);
    expect(red).toContain('48;5;196');
  });

  it('setDepth() leaves cells alone whose 24-bit color is exactly the 256-color choice', () => {
    // 95,135,175 is on the xterm 6x6x6 cube (index 16 + 36*1 + 6*2 + 3 = 67).
    const px = new Uint8Array(COLS * 2 * ROWS * 4 * 3);
    for (let i = 0; i < px.length; i += 3) {
      px[i] = 95;
      px[i + 1] = 135;
      px[i + 2] = 175;
    }
    const p = createPipeline(options());
    p.render(px);
    p.setDepth(8);
    expect(p.render(px).length).toBe(0);
    expect(p.stats.cellsWritten).toBe(0);
    expect(p.stats.cellsWritten).toBeLessThan(COLS * ROWS);
  });

  it('reports the encoder capacity as the largest possible output', () => {
    const p = createPipeline(options());
    expect(p.outputCapacity).toBeGreaterThanOrEqual(p.render(frame()).length);
  });

  it('rejects a frame of the wrong size', () => {
    const p = createPipeline(options());
    expect(() => p.render(new Uint8Array(10))).toThrow();
  });
});

describe('[REQ-RENDER-07] pipeline output buffer', () => {
  it('every render() result is a view into one ArrayBuffer at one offset, within outputCapacity', () => {
    const p = createPipeline(options());
    const first = p.render(frame(0));
    expect(first.length).toBeGreaterThan(0);
    for (let i = 1; i <= 40; i++) {
      if (i % 10 === 0) p.invalidate();
      const out = p.render(frame(i % 3));
      expect(out.buffer).toBe(first.buffer);
      expect(out.byteOffset).toBe(first.byteOffset);
      expect(out.length).toBeLessThanOrEqual(p.outputCapacity);
    }
  });
});

describe('[REQ-RENDER-04] frame framing', () => {
  it('every non-empty render() is one SYNC_BEGIN ... SGR_RESET SYNC_END unit, including after setters and invalidation', () => {
    const p = createPipeline(options());
    for (let i = 0; i < 12; i++) {
      if (i === 4) p.setMode('ascii');
      if (i === 8) p.invalidate();
      const t = text(p.render(frame(i)));
      expect(t.startsWith(SYNC_BEGIN)).toBe(true);
      expect(t.endsWith(SGR_RESET + SYNC_END)).toBe(true);
      expect(t.split(SYNC_BEGIN)).toHaveLength(2);
      expect(t.split(SYNC_END)).toHaveLength(2);
    }
  });
});

describe('[REQ-CAP-03] effectiveMode', () => {
  it('forces ascii without a UTF-8 locale', () => {
    for (const mode of ['halfblock', 'ascii', 'braille'] as const) {
      expect(effectiveMode(mode, false, false)).toBe('ascii');
    }
  });

  it('falls back from braille to halfblock when Braille is unsupported', () => {
    expect(effectiveMode('braille', true, false)).toBe('halfblock');
    expect(effectiveMode('braille', true, true)).toBe('braille');
  });

  it('keeps halfblock and ascii on a UTF-8 terminal', () => {
    expect(effectiveMode('halfblock', true, false)).toBe('halfblock');
    expect(effectiveMode('ascii', true, false)).toBe('ascii');
  });
});
