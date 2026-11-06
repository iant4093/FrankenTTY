import { describe, expect, it } from 'vitest';
import {
  ANSI16_RGB,
  create16Mapper,
  create256Mapper,
  createMapper,
  createTrueColorMapper,
} from '../../src/renderer/color-depth.ts';

describe('[REQ-RENDER-08] createTrueColorMapper', () => {
  it('is the identity at depth 24', () => {
    const m = createTrueColorMapper();
    expect(m.depth).toBe(24);
    for (const c of [0, 0xffffff, 0x123456]) {
      expect(m.map(c)).toBe(c);
      expect(m.toRgb(c)).toBe(c);
    }
  });
});

describe('[REQ-RENDER-08] create256Mapper', () => {
  const m = create256Mapper();

  it('has depth 8', () => {
    expect(m.depth).toBe(8);
  });

  it('maps known colors', () => {
    expect(m.map(0xff0000)).toBe(196);
    expect(m.map(0x00ff00)).toBe(46);
    expect(m.map(0x0000ff)).toBe(21);
    expect(m.map(0x808080)).toBe(244);
    expect(m.map(0x000000)).toBe(16);
    expect(m.map(0xffffff)).toBe(231);
  });

  it('prefers the gray ramp for mid grays and the cube for saturated colors', () => {
    expect(m.map(0x121212)).toBe(233);
    expect(m.map(0xeeeeee)).toBe(255);
    expect(m.map(0xff8700)).toBe(208);
  });

  it('returns xterm default RGB for indices', () => {
    expect(m.toRgb(16)).toBe(0x000000);
    expect(m.toRgb(21)).toBe(0x0000ff);
    expect(m.toRgb(196)).toBe(0xff0000);
    expect(m.toRgb(231)).toBe(0xffffff);
    expect(m.toRgb(232)).toBe(0x080808);
    expect(m.toRgb(244)).toBe(0x808080);
    expect(m.toRgb(255)).toBe(0xeeeeee);
    expect(m.toRgb(9)).toBe(0xff0000);
  });

  it('covers the cube levels 0, 95, 135, 175, 215, 255', () => {
    expect(m.toRgb(16 + 36 + 6 + 1)).toBe(0x5f5f5f);
    expect(m.toRgb(16 + 2 * 36 + 2 * 6 + 2)).toBe(0x878787);
    expect(m.toRgb(16 + 3 * 36 + 3 * 6 + 3)).toBe(0xafafaf);
    expect(m.toRgb(16 + 4 * 36 + 4 * 6 + 4)).toBe(0xd7d7d7);
  });
});

describe('[REQ-RENDER-08] create16Mapper', () => {
  const m = create16Mapper();

  it('has depth 4', () => {
    expect(m.depth).toBe(4);
  });

  it('maps known colors', () => {
    expect(m.map(0x000000)).toBe(0);
    expect(m.map(0xff0000)).toBe(9);
    expect(m.map(0x00ff00)).toBe(10);
    expect(m.map(0xffff00)).toBe(11);
    expect(m.map(0xff00ff)).toBe(13);
    expect(m.map(0x00ffff)).toBe(14);
    expect(m.map(0xffffff)).toBe(15);
    expect(m.map(0x7f7f7f)).toBe(8);
    expect(m.map(0xcd0000)).toBe(1);
  });

  it('round-trips every ANSI color', () => {
    for (let i = 0; i < 16; i++) {
      expect(m.toRgb(i)).toBe(ANSI16_RGB[i]);
      expect(m.map(m.toRgb(i))).toBe(i);
    }
  });
});

describe('[REQ-RENDER-08] createMapper', () => {
  it('returns the mapper for each depth', () => {
    expect(createMapper(24).depth).toBe(24);
    expect(createMapper(8).depth).toBe(8);
    expect(createMapper(4).depth).toBe(4);
    expect(createMapper(8).map(0xff0000)).toBe(196);
    expect(createMapper(4).map(0xff0000)).toBe(9);
  });
});
