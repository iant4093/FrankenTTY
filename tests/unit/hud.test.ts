import { describe, expect, it } from 'vitest';
import { createHud, type HudState } from '../../src/tui/hud.ts';

const ESC = '\x1b';
const STYLE = `${ESC}[0;37;40m`;
const RESET = `${ESC}[0m`;

function sample(overrides: Partial<HudState> = {}): HudState {
  return {
    visible: true,
    playing: true,
    positionSec: 12.9,
    durationSec: 60,
    fps: 30,
    kbPerSec: 412,
    sgrSavedPct: 75,
    qualityStep: 0,
    colorLabel: '24-bit',
    mode: 'halfblock',
    palette: 'truecolor',
    message: null,
    ...overrides,
  };
}

function renderText(cols: number, state: HudState, row = 24, prefix = 0): string {
  const hud = createHud(cols);
  const out = Buffer.alloc(prefix + hud.capacity + 16, 0xff);
  const end = hud.render(state, out, prefix, row);
  expect(end).toBeGreaterThanOrEqual(prefix);
  expect(end - prefix).toBeLessThanOrEqual(hud.capacity);
  // Bytes outside the written range are untouched.
  expect(out[end]).toBe(0xff);
  return out.subarray(prefix, end).toString('utf8');
}

/** Visible text between the HUD style and the final reset. */
function visibleText(cols: number, state: HudState, row = 24): string {
  const raw = renderText(cols, state, row);
  const head = `${ESC}[${row};1H${STYLE}`;
  expect(raw.startsWith(head)).toBe(true);
  expect(raw.endsWith(RESET)).toBe(true);
  return raw.slice(head.length, raw.length - RESET.length);
}

const FULL = '▶ 0:12 / 1:00  30.0 fps  412 KB/s  -75% SGR  Q0 24-bit  halfblock truecolor  space ←/→ m c i q';

describe('[REQ-HUD-01] HUD visible layout', () => {
  it('renders the exact bytes for a sample state at 100 columns', () => {
    const raw = renderText(100, sample(), 35);
    expect(raw).toBe(`${ESC}[35;1H${STYLE}${FULL.padEnd(100, ' ')}${RESET}`);
  });

  it('pads to exactly cols columns', () => {
    expect([...visibleText(100, sample())]).toHaveLength(100);
  });

  it('fits exactly when cols equals the text width', () => {
    const width = [...FULL].length;
    expect(visibleText(width, sample())).toBe(FULL);
  });

  it('truncates from the right at 20 columns', () => {
    const text = visibleText(20, sample());
    expect(text).toBe('▶ 0:12 / 1:00  30.0 ');
    expect([...text]).toHaveLength(20);
  });

  it('renders a single column', () => {
    expect(visibleText(1, sample())).toBe('▶');
  });

  it('shows the pause glyph when paused', () => {
    expect(visibleText(30, sample({ playing: false })).startsWith('⏸ 0:12 / 1:00')).toBe(true);
  });

  it('writes at the given offset and returns the new offset', () => {
    const raw = renderText(30, sample(), 5, 7);
    expect(raw.startsWith(`${ESC}[5;1H${STYLE}`)).toBe(true);
  });

  it('shows duration as --:-- when unknown', () => {
    expect(visibleText(40, sample({ durationSec: null })).startsWith('▶ 0:12 / --:--  30.0 fps')).toBe(true);
  });

  it('formats times of an hour or more as h:mm:ss', () => {
    const text = visibleText(60, sample({ positionSec: 3661, durationSec: 7325 }));
    expect(text.startsWith('▶ 1:01:01 / 2:02:05  30.0 fps')).toBe(true);
  });

  it('formats minute and second boundaries', () => {
    const t = (pos: number, dur: number | null) =>
      visibleText(40, sample({ positionSec: pos, durationSec: dur })).split('  ')[0];
    expect(t(0, 0)).toBe('▶ 0:00 / 0:00');
    expect(t(59.99, 600)).toBe('▶ 0:59 / 10:00');
    expect(t(3599, 3600)).toBe('▶ 59:59 / 1:00:00');
  });

  it('formats fps with one decimal and the other numbers as integers', () => {
    const text = visibleText(100, sample({ fps: 29.96, kbPerSec: 1234.6, sgrSavedPct: 99.5, qualityStep: 3, colorLabel: '256' }));
    expect(text).toContain('30.0 fps  1235 KB/s  -100% SGR  Q3 256  ');
  });

  it('shows mode and palette names', () => {
    const text = visibleText(100, sample({ mode: 'braille', palette: 'dmg', colorLabel: '16' }));
    expect(text).toContain('Q0 16  braille dmg  space ←/→ m c i q');
  });

  it('clamps non-finite and negative numbers', () => {
    const text = visibleText(
      100,
      sample({ positionSec: Number.NaN, durationSec: -4, fps: Number.POSITIVE_INFINITY, kbPerSec: -1, sgrSavedPct: Number.NaN }),
    );
    expect(text.startsWith('▶ 0:00 / 0:00  9999.9 fps  0 KB/s  -0% SGR')).toBe(true);
  });
});

describe('[REQ-HUD-01][REQ-SYNC-05] HUD message form', () => {
  it('replaces everything after the time', () => {
    const text = visibleText(40, sample({ positionSec: 17, message: '» +5s' }));
    expect(text).toBe('▶ 0:17 / 1:00  » +5s'.padEnd(40, ' '));
  });

  it('truncates a long message', () => {
    const text = visibleText(24, sample({ positionSec: 17, message: '» a very long message indeed' }));
    expect(text).toBe('▶ 0:17 / 1:00  » a very ');
  });

  it('replaces control bytes and unsupported characters with ?', () => {
    const text = visibleText(30, sample({ message: 'a\x1b[2Jb\nc日🎬' }));
    expect(text).toBe('▶ 0:12 / 1:00  a?[2Jb?c???'.padEnd(30, ' '));
  });

  it('accepts an empty message', () => {
    expect(visibleText(20, sample({ message: '' }))).toBe('▶ 0:12 / 1:00       ');
  });
});

describe('[REQ-GEO-02] HUD hidden form', () => {
  it('moves to the row, resets attributes and erases the line', () => {
    expect(renderText(100, sample({ visible: false }), 35)).toBe(`${ESC}[35;1H${RESET}${ESC}[2K`);
  });

  it('is the same for any width', () => {
    expect(renderText(1, sample({ visible: false }), 2)).toBe(`${ESC}[2;1H${RESET}${ESC}[2K`);
  });
});

describe('HUD construction', () => {
  it('capacity grows with width and bounds the output', () => {
    const small = createHud(10);
    const large = createHud(200);
    expect(large.capacity).toBeGreaterThan(small.capacity);
    const out = Buffer.alloc(large.capacity);
    expect(large.render(sample(), out, 0, 100)).toBeLessThanOrEqual(large.capacity);
  });

  it('treats invalid widths as one column', () => {
    expect(createHud(0).capacity).toBe(createHud(1).capacity);
    expect(createHud(Number.NaN).capacity).toBe(createHud(1).capacity);
  });

  it('renders repeatedly into the same buffer with identical results', () => {
    const hud = createHud(50);
    const out = Buffer.alloc(hud.capacity);
    const a = hud.render(sample(), out, 0, 10);
    const first = Buffer.from(out.subarray(0, a));
    const b = hud.render(sample(), out, 0, 10);
    expect(b).toBe(a);
    expect(out.subarray(0, b).equals(first)).toBe(true);
  });
});
