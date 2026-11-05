import { describe, expect, it } from 'vitest';
import { createPipeline, effectiveMode } from '../../src/player/pipeline.ts';
import type { PipelineOptions } from '../../src/player/pipeline.ts';
import { ASCII_RAMP } from '../../src/renderer/ascii.ts';
import { AMBER_RAMP } from '../../src/renderer/palette.ts';
import { SYNC_BEGIN } from '../../src/renderer/sequences.ts';
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

describe('createPipeline', () => {
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

  it('setMode() invalidates, keeps geometry and switches the glyphs', () => {
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
    expect(p.stats.cellsWritten).toBe(COLS * ROWS);
    expect(p.render(f).length).toBe(0);

    p.setMode('braille');
    expect(p.mode).toBe('braille');
    expect(p.render(f).length).toBeGreaterThan(0);
    expect(p.stats.cellsWritten).toBe(COLS * ROWS);

    p.setMode('halfblock');
    expect(p.render(f).length).toBeGreaterThan(0);
    expect(p.stats.cellsWritten).toBe(COLS * ROWS);
  });

  it('setPalette() invalidates and changes the colors', () => {
    const p = createPipeline(options());
    const f = frame();
    const plain = Buffer.from(p.render(f));
    expect(p.render(f).length).toBe(0);

    p.setPalette('amber');
    expect(p.palette).toBe('amber');
    const amber = p.render(f);
    expect(amber.length).toBeGreaterThan(0);
    expect(p.stats.cellsWritten).toBe(COLS * ROWS);
    expect(Buffer.from(amber).equals(plain)).toBe(false);
    expect(p.render(f).length).toBe(0);
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

  it('braille mode draws Braille glyphs or spaces; ascii mode draws ramp characters', async () => {
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

  it('amber palette output uses only ramp entries', async () => {
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

  it('depth 8 and 4 emit shorter first frames than depth 24', () => {
    const f = frame();
    const sizes = ([24, 8, 4] as const).map((depth) => createPipeline(options({ depth })).render(f).length);
    expect(sizes[1]).toBeLessThan(sizes[0] ?? 0);
    expect(sizes[2]).toBeLessThan(sizes[1] ?? 0);
  });

  it('rejects a frame of the wrong size', () => {
    const p = createPipeline(options());
    expect(() => p.render(new Uint8Array(10))).toThrow();
  });
});

describe('effectiveMode (REQ-CAP-03)', () => {
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
