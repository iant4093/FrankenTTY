import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AbsoluteFill, Easing, Sequence, cancelRender, continueRender, delayRender, interpolate, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { cellBg, cellFg, css } from '../components/draw.ts';
import { getEngine, loadSession } from '../components/replay-engine.ts';
import { TerminalReplay } from '../components/TerminalReplay.tsx';
import { Heading, Source, formatInt, typed, useFade, useProgress, useSpring } from '../components/ui.tsx';
import { planSegments, segmentsOf } from '../lib/acts.ts';
import type { DemoData } from '../lib/data.ts';
import { cellCenter, computeWindowLayout } from '../lib/layout.ts';
import { AMBER, AMBER_DIM, AMBER_HOT, BG, CELL_H, FONT_FAMILY, GREEN, PANEL, PANEL_BORDER, TEXT, TEXT_DIM } from '../lib/theme.ts';

// ---------------------------------------------------------------------------
// (a) One cell = two pixels
// ---------------------------------------------------------------------------

interface CellProbe {
  x: number;
  y: number;
  fg: number;
  bg: number;
}

const hex = (rgb: number): string => `#${rgb.toString(16).padStart(6, '0')}`;
const rgbOf = (rgb: number): [number, number, number] => [(rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255];

function spread(rgb: number): number {
  const [r, g, b] = rgbOf(rgb);
  return Math.max(r, g, b) - Math.min(r, g, b);
}

/** Replays the real session to `tSec` and picks a half-block cell with strong, colorful contrast. */
function useCellProbe(name: string, tSec: number): CellProbe | null {
  const [probe, setProbe] = useState<CellProbe | null>(null);
  const [handle] = useState(() => delayRender(`Probing a cell of ${name}`));
  useEffect(() => {
    (async () => {
      const session = await loadSession(staticFile(`sessions/${name}.json`));
      const engine = getEngine(`probe:${name}`, session);
      await engine.advanceTo(tSec);
      const buffer = engine.term.buffer.active;
      const cell = buffer.getNullCell();
      let best: CellProbe | null = null;
      let bestScore = -1;
      for (let y = 0; y < engine.rows - 1; y++) {
        const line = buffer.getLine(y);
        for (let x = 0; x < engine.cols; x++) {
          const c = line?.getCell(x, cell);
          if (c === undefined || c.getChars() !== '▀' || !c.isFgRGB() || !c.isBgRGB()) continue;
          const fg = cellFg(c);
          const bg = cellBg(c);
          const dist = Math.abs(((fg >> 16) & 255) - ((bg >> 16) & 255)) + Math.abs(((fg >> 8) & 255) - ((bg >> 8) & 255)) + Math.abs((fg & 255) - (bg & 255));
          // Colorful pairs first: both colors need some saturation; ties keep the first cell found.
          const score = Math.min(spread(fg), spread(bg), 120) * 1000 + dist;
          if (score > bestScore) {
            bestScore = score;
            best = { x, y, fg, bg };
          }
        }
      }
      if (best === null) throw new Error(`no half-block cell found in ${name} at ${String(tSec)} s`);
      setProbe(best);
      continueRender(handle);
    })().catch((e: unknown) => cancelRender(e));
  }, [name, tSec, handle]);
  return probe;
}

const ZOOM_CELL_PX = 480;

const CellScene: React.FC<{ data: DemoData; total: number }> = ({ data, total }) => {
  const frame = useCurrentFrame();
  const { width, height, fps } = useVideoConfig();
  const meta = data.manifest.sessions['act2-cell'];
  if (meta === undefined) throw new Error('missing act2-cell');
  const freezeAt = Math.min(3, meta.durationSec * 0.55);
  const probe = useCellProbe('act2-cell', freezeAt);
  const p1 = Math.round(0.3 * total);
  const zoomEnd = Math.round(0.52 * total);
  const swapEnd = Math.round(0.58 * total);
  const speed = freezeAt / (p1 / fps);
  const band = 100;
  const maxScale = 2.4;
  const layout = computeWindowLayout({ width, height, band, maxCols: meta.maxCols, maxRows: meta.maxRows, cols: meta.cols, rows: meta.rows, maxScale });
  const fade = useFade(total, 8, 10);

  if (probe === null) return null;

  const c = cellCenter(layout, probe.x, probe.y);
  const Z = ZOOM_CELL_PX / (CELL_H * layout.scale);
  const finalPos = { x: 560, y: 500 };
  const e = interpolate(frame, [p1, zoomEnd], [0, 1], { easing: Easing.inOut(Easing.cubic), extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const z = Math.pow(Z, e);
  const tx = c.x + (finalPos.x - c.x) * e - c.x * z;
  const ty = c.y + (finalPos.y - c.y) * e - c.y * z;
  const swap = interpolate(frame, [zoomEnd, swapEnd], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const highlight = interpolate(frame, [Math.round(0.2 * total), p1], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const cellW = (layout.scale * 12);
  const cellH = layout.scale * CELL_H;

  return (
    <AbsoluteFill style={{ opacity: fade }}>
      <AbsoluteFill style={{ opacity: 1 - swap }}>
        <div style={{ position: 'absolute', inset: 0, transformOrigin: '0 0', transform: `translate(${String(tx)}px, ${String(ty)}px) scale(${String(z)})` }}>
          <TerminalReplay session="act2-cell" freezeAt={freezeAt} speed={speed} showBadges={false} maxScale={maxScale} band={band} />
          <div
            style={{
              position: 'absolute',
              left: c.x - cellW / 2 - 2,
              top: c.y - cellH / 2 - 2,
              width: cellW + 4,
              height: cellH + 4,
              border: `${String(2 / z)}px solid ${AMBER}`,
              opacity: highlight,
              boxShadow: `0 0 ${String(14 / z)}px ${AMBER}`,
            }}
          />
        </div>
      </AbsoluteFill>
      <div style={{ position: 'absolute', left: 60, top: 40, opacity: 1 - interpolate(frame, [p1, p1 + 10], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }) }}>
        <Heading sub="every character cell is two pixels tall">One terminal cell</Heading>
      </div>
      <SplitDiagram probe={probe} total={total} start={swapEnd} swap={swap} finalPos={finalPos} meta={meta} freezeAt={freezeAt} />
    </AbsoluteFill>
  );
};

const SplitDiagram: React.FC<{
  probe: CellProbe;
  total: number;
  start: number;
  swap: number;
  finalPos: { x: number; y: number };
  meta: { cols: number; rows: number };
  freezeAt: number;
}> = ({ probe, total, start, swap, finalPos, freezeAt }) => {
  const frame = useCurrentFrame();
  const local = Math.max(0, frame - start);
  const move = useSpring(start, { damping: 18, stiffness: 80 });
  const split = useSpring(start + 12, { damping: 12, stiffness: 120 });
  const labels = useSpring(start + 26);
  const cellX = finalPos.x + (260 - finalPos.x) * move;
  const W = 240;
  const H = ZOOM_CELL_PX;
  const gap = 34 * split;
  const fg = rgbOf(probe.fg);
  const bg = rgbOf(probe.bg);
  const fgSeq = `ESC[38;2;${String(fg[0])};${String(fg[1])};${String(fg[2])}m`;
  const bgSeq = `ESC[48;2;${String(bg[0])};${String(bg[1])};${String(bg[2])}m`;
  const full = fgSeq + bgSeq + '▀';
  const typeStart = start + 44;
  const n = (frame - typeStart) / 0.9;
  const shown = typed(full, n);
  const fgShown = shown.slice(0, fgSeq.length);
  const bgShown = shown.slice(fgSeq.length, fgSeq.length + bgSeq.length);
  const glyphShown = shown.slice(fgSeq.length + bgSeq.length);
  const done = n >= full.length;
  const blink = Math.floor(frame / 15) % 2 === 0;
  const outFade = interpolate(frame, [total - 10, total], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  if (swap <= 0) return null;
  return (
    <AbsoluteFill style={{ opacity: swap * outFade, fontFamily: FONT_FAMILY }}>
      <div style={{ position: 'absolute', left: 60, top: 40 }}>
        <Heading sub="top pixel = foreground, bottom pixel = background">The half block ▀</Heading>
      </div>
      <div style={{ position: 'absolute', left: cellX - W / 2, top: finalPos.y - H / 2 + 40 }}>
        <div style={{ width: W, height: H / 2, background: hex(probe.fg), transform: `translateY(${String(-gap / 2)}px)`, boxShadow: `0 0 40px ${hex(probe.fg)}55` }} />
        <div style={{ width: W, height: H / 2, background: hex(probe.bg), transform: `translateY(${String(gap / 2)}px)`, boxShadow: `0 0 40px ${hex(probe.bg)}55` }} />
      </div>
      <div style={{ position: 'absolute', left: cellX + W / 2 + 40, top: finalPos.y - H / 2 + 40 - gap / 2 + 40, opacity: labels, transform: `translateX(${String((1 - labels) * -20)}px)` }}>
        <div style={{ fontSize: 32, color: TEXT }}>
          top pixel <span style={{ color: AMBER }}>→ foreground</span>
        </div>
        <div style={{ fontSize: 22, color: TEXT_DIM, marginTop: 6 }}>{`${hex(probe.fg)}  rgb(${fg.join(', ')})`}</div>
      </div>
      <div style={{ position: 'absolute', left: cellX + W / 2 + 40, top: finalPos.y + H / 2 + 40 + gap / 2 - 130, opacity: labels, transform: `translateX(${String((1 - labels) * -20)}px)` }}>
        <div style={{ fontSize: 32, color: TEXT }}>
          bottom pixel <span style={{ color: GREEN }}>→ background</span>
        </div>
        <div style={{ fontSize: 22, color: TEXT_DIM, marginTop: 6 }}>{`${hex(probe.bg)}  rgb(${bg.join(', ')})`}</div>
      </div>
      <div
        style={{
          position: 'absolute',
          left: 960,
          top: 330,
          width: 880,
          background: PANEL,
          border: `1px solid ${PANEL_BORDER}`,
          borderRadius: 14,
          padding: '28px 34px',
          opacity: interpolate(local, [30, 44], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }),
        }}
      >
        <div style={{ fontSize: 20, color: TEXT_DIM, marginBottom: 14 }}>
          the bytes for cell ({probe.x}, {probe.y}) in the recording
        </div>
        <div style={{ fontSize: 30, lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-all', minHeight: 100 }}>
          <span style={{ color: AMBER }}>{fgShown}</span>
          <span style={{ color: GREEN }}>{bgShown}</span>
          <span style={{ background: hex(probe.bg), color: hex(probe.fg), padding: '0 4px' }}>{glyphShown}</span>
          <span style={{ display: 'inline-block', width: 16, height: 30, verticalAlign: 'middle', background: blink || !done ? AMBER : 'transparent' }} />
        </div>
        <div style={{ fontSize: 20, color: TEXT_DIM, marginTop: 16 }}>
          <span style={{ color: AMBER }}>38;2;r;g;b</span> sets the foreground, <span style={{ color: GREEN }}>48;2;r;g;b</span> the background
        </div>
      </div>
      <Source style={{ position: 'absolute', left: 60, bottom: 36 }}>
        {`video/sessions/act2-cell.json, cell colors read from the terminal state at ${freezeAt.toFixed(1)} s`}
      </Source>
    </AbsoluteFill>
  );
};

// ---------------------------------------------------------------------------
// (b) Naive vs FrankenTTY, per frame
// ---------------------------------------------------------------------------

const GRID_COLS = 120;
const GRID_ROWS = 34;
const PX_W = 7;
const PX_H = 7;

/** Escape-time Mandelbrot at 120x68 pixels (two pixels per cell), colored from the amber/green ramps. */
function mandelbrotPixels(): Uint32Array {
  const w = GRID_COLS;
  const h = GRID_ROWS * 2;
  const out = new Uint32Array(w * h);
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const cr = -2.2 + (px / w) * 3.2;
      const ci = -1.0 + (py / h) * 2.0;
      let zr = 0;
      let zi = 0;
      let i = 0;
      while (i < 48 && zr * zr + zi * zi <= 4) {
        const t = zr * zr - zi * zi + cr;
        zi = 2 * zr * zi + ci;
        zr = t;
        i++;
      }
      const k = i === 48 ? 0 : i / 48;
      const r = Math.round(255 * Math.min(1, k * 2.2));
      const g = Math.round(255 * Math.min(1, Math.max(0, k * 1.6 - 0.1)));
      const b = Math.round(255 * Math.min(1, 0.25 + k * 0.9 * (1 - k) * 3));
      out[py * w + px] = i === 48 ? 0x101018 : (r << 16) | (g << 8) | b;
    }
  }
  return out;
}

function hash32(a: number, b: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x7f4a7c15, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return h >>> 0;
}

const PixelGrid: React.FC<{ pixels: Uint32Array; allLit: boolean; litFraction: number; epoch: number; visible: number }> = ({ pixels, allLit, litFraction, epoch, visible }) => {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useLayoutEffect(() => {
    const canvas = ref.current;
    if (canvas === null) return;
    const ctx = canvas.getContext('2d');
    if (ctx === null) return;
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const limit = litFraction * 4294967296;
    for (let py = 0; py < GRID_ROWS * 2; py++) {
      for (let px = 0; px < GRID_COLS; px++) {
        const slot = py * GRID_COLS + px;
        const rgb = pixels[slot] ?? 0;
        // Reveal the grid from the top as `visible` goes 0 -> 1.
        if (py / (GRID_ROWS * 2) > visible) continue;
        const lit = allLit || hash32(slot, epoch) < limit;
        const x = px * PX_W;
        const y = py * PX_H;
        ctx.globalAlpha = lit ? 1 : 0.22;
        ctx.fillStyle = css(rgb);
        ctx.fillRect(x, y, PX_W, PX_H);
        if (lit) {
          ctx.globalAlpha = 0.95;
          ctx.strokeStyle = AMBER;
          ctx.lineWidth = 1;
          ctx.strokeRect(x + 0.5, y + 0.5, PX_W - 1, PX_H - 1);
        }
      }
    }
    ctx.globalAlpha = 1;
  });
  return <canvas ref={ref} width={GRID_COLS * PX_W} height={GRID_ROWS * 2 * PX_H} style={{ display: 'block', border: `1px solid ${PANEL_BORDER}` }} />;
};

const CompareScene: React.FC<{ data: DemoData; total: number }> = ({ data, total }) => {
  const frame = useCurrentFrame();
  const s = data.sweep;
  const pixels = useMemo(() => mandelbrotPixels(), []);
  const fade = useFade(total, 10, 10);
  const reveal = useProgress(Math.round(0.04 * total), Math.round(0.12 * total));
  const count = useProgress(Math.round(0.18 * total), Math.round(0.4 * total));
  const savings = useSpring(Math.round(0.62 * total), { damping: 10 });
  const epoch = Math.floor(frame / 8);
  const frac = s.sgr / s.naiveSgr;
  const ease = Easing.out(Easing.cubic)(count);
  return (
    <AbsoluteFill style={{ opacity: fade, fontFamily: FONT_FAMILY }}>
      <div style={{ position: 'absolute', left: 90, top: 40 }}>
        <Heading sub={`${s.source} · ${String(s.cols)}×${String(s.rows)} cells · color threshold ${String(s.threshold)} · per frame`}>Color codes per frame</Heading>
      </div>
      {[
        { x: 90, title: 'naive encoder', sub: 'every cell, two color codes', lit: true, n: s.naiveSgr, color: AMBER },
        { x: 990, title: 'FrankenTTY', sub: 'changed cells only, colors reused', lit: false, n: s.sgr, color: GREEN },
      ].map((p) => (
        <div key={p.title} style={{ position: 'absolute', left: p.x, top: 210 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', width: GRID_COLS * PX_W, marginBottom: 14 }}>
            <div style={{ fontSize: 34, fontWeight: 700, color: p.color }}>{p.title}</div>
            <div style={{ fontSize: 20, color: TEXT_DIM }}>{p.sub}</div>
          </div>
          <PixelGrid pixels={pixels} allLit={p.lit} litFraction={frac} epoch={epoch} visible={reveal} />
          <div style={{ marginTop: 22, display: 'flex', alignItems: 'baseline', gap: 16 }}>
            <div style={{ fontSize: 96, fontWeight: 700, color: p.color, fontVariantNumeric: 'tabular-nums' }}>{formatInt(p.n * ease)}</div>
            <div style={{ fontSize: 24, color: TEXT_DIM }}>color codes</div>
          </div>
        </div>
      ))}
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: 940,
          textAlign: 'center',
          fontSize: 44,
          fontWeight: 700,
          color: AMBER_HOT,
          opacity: savings,
          transform: `scale(${String(0.7 + 0.3 * savings)})`,
        }}
      >
        {`${String(Math.round(s.savingsPct))}% fewer color codes`}
      </div>
      <Source style={{ position: 'absolute', left: 90, bottom: 24 }}>
        {`${s.file}, average of 150 frames. The pixel grid is an illustration; the counts are measured.`}
      </Source>
    </AbsoluteFill>
  );
};

// ---------------------------------------------------------------------------
// (c) Savings per demo and the Apple Terminal budget
// ---------------------------------------------------------------------------

const ChartScene: React.FC<{ data: DemoData; total: number }> = ({ data, total }) => {
  const fade = useFade(total, 10, 10);
  const right = useSpring(Math.round(0.45 * total), { damping: 16 });
  const { sweep, apple } = data;
  return (
    <AbsoluteFill style={{ opacity: fade, fontFamily: FONT_FAMILY }}>
      <div style={{ position: 'absolute', left: 90, top: 40 }}>
        <Heading sub={`default settings · ${String(sweep.cols)}×${String(sweep.rows)} · threshold ${String(sweep.threshold)}`}>Color codes saved per demo</Heading>
      </div>
      <div style={{ position: 'absolute', left: 90, top: 320, width: 1000 }}>
        {sweep.perDemo.map((d, i) => (
          <Bar key={d.name} name={d.name} pct={d.savingsPct} label={d.label} delay={Math.round(0.06 * total) + i * 8} color={i % 2 === 0 ? AMBER : GREEN} />
        ))}
        <Source style={{ marginTop: 26 }}>{sweep.file}</Source>
      </div>
      <div
        style={{
          position: 'absolute',
          left: 1160,
          top: 340,
          width: 720,
          opacity: right,
          transform: `translateX(${String((1 - right) * 40)}px)`,
        }}
      >
        <div style={{ fontSize: 28, color: TEXT_DIM }}>Apple Terminal accepts about</div>
        <div style={{ fontSize: 92, fontWeight: 700, color: AMBER, lineHeight: 1.15, whiteSpace: 'nowrap', textShadow: '0 0 40px rgba(255,176,0,0.4)' }}>{`${apple.text} MB/s`}</div>
        <div style={{ fontSize: 28, color: TEXT, marginTop: 20, lineHeight: 1.4 }}>
          The cost is the number of color changes, not the number of bytes.
        </div>
        <Source style={{ marginTop: 30 }}>{apple.file}</Source>
      </div>
    </AbsoluteFill>
  );
};

const Bar: React.FC<{ name: string; pct: number; label: number; delay: number; color: string }> = ({ name, pct, label, delay, color }) => {
  const p = useSpring(delay, { damping: 18, stiffness: 90 });
  const maxW = 700;
  return (
    <div style={{ display: 'flex', alignItems: 'center', height: 78 }}>
      <div style={{ width: 190, fontSize: 28, color: TEXT }}>{name}</div>
      <div style={{ width: maxW, height: 46, background: PANEL, borderRadius: 8, overflow: 'hidden', border: `1px solid ${PANEL_BORDER}` }}>
        <div style={{ width: (maxW * pct * p) / 100, height: '100%', background: `linear-gradient(90deg, ${AMBER_DIM}, ${color})`, borderRadius: 8 }} />
      </div>
      <div style={{ width: 110, textAlign: 'right', fontSize: 40, fontWeight: 700, color, opacity: Math.min(1, p * 1.5), fontVariantNumeric: 'tabular-nums' }}>{`${String(label)}%`}</div>
    </div>
  );
};

// ---------------------------------------------------------------------------

export const Act2: React.FC<{ data: DemoData; frames: number }> = ({ data, frames }) => {
  const plan = planSegments(frames, segmentsOf(data.manifest.sessions).act2);
  const [cell, compare, chart] = plan;
  if (cell === undefined || compare === undefined || chart === undefined) throw new Error('act2 plan');
  return (
    <AbsoluteFill style={{ background: BG, color: TEXT }}>
      <Sequence from={cell.from} durationInFrames={cell.frames}>
        <CellScene data={data} total={cell.frames} />
      </Sequence>
      <Sequence from={compare.from} durationInFrames={compare.frames}>
        <CompareScene data={data} total={compare.frames} />
      </Sequence>
      <Sequence from={chart.from} durationInFrames={chart.frames}>
        <ChartScene data={data} total={chart.frames} />
      </Sequence>
    </AbsoluteFill>
  );
};
