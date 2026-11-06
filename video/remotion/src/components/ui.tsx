import React from 'react';
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { AMBER, FONT_FAMILY, TEXT, TEXT_DIM } from '../lib/theme.ts';

/** 0 -> 1 over `frames`, starting at `delay`. */
export function useProgress(delay: number, frames: number): number {
  const frame = useCurrentFrame();
  return interpolate(frame, [delay, delay + frames], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
}

/** Spring 0 -> 1 starting at `delay` (frames). */
export function useSpring(delay = 0, config: { damping?: number; stiffness?: number; mass?: number } = {}): number {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return spring({ frame: frame - delay, fps, config: { damping: 14, stiffness: 120, mass: 0.8, ...config } });
}

/** Opacity that fades in over `inF` frames and out over `outF` frames at the end of a segment of `total` frames. */
export function useFade(total: number, inF = 12, outF = 12): number {
  const frame = useCurrentFrame();
  return interpolate(frame, [0, inF, Math.max(inF + 1, total - outF), Math.max(inF + 2, total)], [0, 1, 1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
}

export const Heading: React.FC<{ children: React.ReactNode; sub?: React.ReactNode; style?: React.CSSProperties }> = ({ children, sub, style }) => (
  <div style={{ fontFamily: FONT_FAMILY, ...style }}>
    <div style={{ fontSize: 54, fontWeight: 700, color: TEXT, letterSpacing: -1 }}>{children}</div>
    {sub !== undefined ? <div style={{ fontSize: 26, color: TEXT_DIM, marginTop: 8 }}>{sub}</div> : null}
  </div>
);

/** Small source line under a chart or card: the file the numbers came from. */
export const Source: React.FC<{ children: React.ReactNode; style?: React.CSSProperties }> = ({ children, style }) => (
  <div style={{ fontFamily: FONT_FAMILY, fontSize: 17, color: TEXT_DIM, ...style }}>
    <span style={{ color: AMBER }}>source </span>
    {children}
  </div>
);

export function formatInt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/** First `n` characters of `text` (typewriter). */
export function typed(text: string, n: number): string {
  return text.slice(0, Math.max(0, Math.floor(n)));
}
