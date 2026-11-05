import { describe, expect, it } from 'vitest';
import { computeGeometry } from '../../src/renderer/geometry.ts';

describe('computeGeometry', () => {
  it('fits 1920x1080 in 80x24 at a=2.0 (width-limited, HUD row reserved)', () => {
    const g = computeGeometry({ srcWidth: 1920, srcHeight: 1080, cols: 80, rows: 24 });
    expect(g).toEqual({
      renderCols: 80,
      renderRows: 23,
      offsetX: 0,
      offsetY: 0,
      halfblockWidth: 80,
      halfblockHeight: 46,
      decodeWidth: 160,
      decodeHeight: 92,
      availCols: 80,
      availRows: 23,
    });
  });

  it('fits 4:3 in 175x50 at a=2.016 (height-limited, pillarboxed)', () => {
    const g = computeGeometry({
      srcWidth: 640,
      srcHeight: 480,
      cols: 175,
      rows: 50,
      cellAspect: 2.016,
    });
    expect(g.availRows).toBe(49);
    expect(g.renderRows).toBe(49);
    expect(g.renderCols).toBe(132);
    expect(g.offsetX).toBe(21);
    expect(g.offsetY).toBe(0);
    expect(g.decodeWidth).toBe(264);
    expect(g.decodeHeight).toBe(196);
  });

  it('handles a 1x7680 source as a one-column strip', () => {
    const g = computeGeometry({ srcWidth: 1, srcHeight: 7680, cols: 80, rows: 24 });
    expect(g.renderCols).toBe(1);
    expect(g.renderRows).toBe(23);
    expect(g.offsetX).toBe(39);
    expect(g.offsetY).toBe(0);
  });

  it('handles a 7680x1 source as a one-row strip', () => {
    const g = computeGeometry({ srcWidth: 7680, srcHeight: 1, cols: 80, rows: 24 });
    expect(g.renderCols).toBe(80);
    expect(g.renderRows).toBe(1);
    expect(g.offsetX).toBe(0);
    expect(g.offsetY).toBe(11);
  });

  it('caps cells at 4200 on 244x73 and keeps the aspect', () => {
    const g = computeGeometry({
      srcWidth: 1920,
      srcHeight: 1080,
      cols: 244,
      rows: 73,
      maxCells: 4200,
    });
    expect(g.renderCols * g.renderRows).toBeLessThanOrEqual(4200);
    expect(g.renderCols).toBe(121);
    expect(g.renderRows).toBe(34);
    expect(g.offsetX).toBe(61);
    expect(g.offsetY).toBe(19);
    // Physical aspect within 2% of 16:9.
    const aspect = g.renderCols / (g.renderRows * 2);
    expect(Math.abs(aspect - 16 / 9) / (16 / 9)).toBeLessThan(0.02);
  });

  it('leaves the geometry unchanged when maxCells is not exceeded', () => {
    const base = computeGeometry({ srcWidth: 1920, srcHeight: 1080, cols: 80, rows: 24 });
    const capped = computeGeometry({
      srcWidth: 1920,
      srcHeight: 1080,
      cols: 80,
      rows: 24,
      maxCells: 100000,
    });
    expect(capped).toEqual(base);
  });

  it('reduces to a single cell when maxCells is 1', () => {
    const g = computeGeometry({
      srcWidth: 1920,
      srcHeight: 1080,
      cols: 80,
      rows: 24,
      maxCells: 1,
    });
    expect(g.renderCols).toBe(1);
    expect(g.renderRows).toBe(1);
  });

  it('returns an all-zero render area when only the HUD row fits', () => {
    const g = computeGeometry({ srcWidth: 1920, srcHeight: 1080, cols: 80, rows: 1 });
    expect(g).toEqual({
      renderCols: 0,
      renderRows: 0,
      offsetX: 0,
      offsetY: 0,
      halfblockWidth: 0,
      halfblockHeight: 0,
      decodeWidth: 0,
      decodeHeight: 0,
      availCols: 80,
      availRows: 0,
    });
  });

  it('honors hudRows = 0', () => {
    const g = computeGeometry({
      srcWidth: 1920,
      srcHeight: 1080,
      cols: 80,
      rows: 1,
      hudRows: 0,
    });
    expect(g.availRows).toBe(1);
    expect(g.renderRows).toBe(1);
  });

  it('centers with the extra cell on the right/bottom', () => {
    const g = computeGeometry({ srcWidth: 1, srcHeight: 1, cols: 40, rows: 12, cellAspect: 2 });
    // availRows 11, square source: c = round(11 * 2) = 22, r = 11.
    expect(g.renderCols).toBe(22);
    expect(g.renderRows).toBe(11);
    expect(g.offsetX).toBe(9);
    expect(g.offsetY).toBe(0);
  });

  describe('RangeError', () => {
    const ok = { srcWidth: 16, srcHeight: 9, cols: 80, rows: 24 };
    it.each([
      ['srcWidth 0', { srcWidth: 0 }],
      ['srcWidth fractional', { srcWidth: 1.5 }],
      ['srcWidth NaN', { srcWidth: Number.NaN }],
      ['srcHeight 0', { srcHeight: 0 }],
      ['srcHeight negative', { srcHeight: -3 }],
      ['cols 0', { cols: 0 }],
      ['cols fractional', { cols: 80.5 }],
      ['rows 0', { rows: 0 }],
      ['rows Infinity', { rows: Number.POSITIVE_INFINITY }],
      ['cellAspect 0.99', { cellAspect: 0.99 }],
      ['cellAspect 3.01', { cellAspect: 3.01 }],
      ['cellAspect NaN', { cellAspect: Number.NaN }],
      ['maxCells 0', { maxCells: 0 }],
      ['maxCells fractional', { maxCells: 10.5 }],
      ['hudRows negative', { hudRows: -1 }],
    ])('rejects %s', (_name, patch) => {
      expect(() => computeGeometry({ ...ok, ...patch })).toThrow(RangeError);
    });

    it('accepts the cellAspect bounds 1 and 3', () => {
      expect(() => computeGeometry({ ...ok, cellAspect: 1 })).not.toThrow();
      expect(() => computeGeometry({ ...ok, cellAspect: 3 })).not.toThrow();
    });
  });
});
