import React from 'react';
import { AbsoluteFill } from 'remotion';
import { useFade, useSpring } from '../components/ui.tsx';
import type { DemoData } from '../lib/data.ts';
import { AMBER, AMBER_HOT, BG, FONT_FAMILY, GREEN, TEXT, TEXT_DIM } from '../lib/theme.ts';

export const Closing: React.FC<{ data: DemoData; frames: number }> = ({ data, frames }) => {
  const fade = useFade(frames, 14, 20);
  const a = useSpring(0, { damping: 16 });
  const b = useSpring(12);
  const c = useSpring(26, { damping: 12 });
  return (
    <AbsoluteFill style={{ background: BG, opacity: fade, alignItems: 'center', justifyContent: 'center', fontFamily: FONT_FAMILY }}>
      <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(ellipse at 50% 50%, rgba(255,176,0,0.10), transparent 62%)' }} />
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 120, fontWeight: 700, color: AMBER, letterSpacing: -3, opacity: a, transform: `scale(${String(0.9 + 0.1 * a)})`, textShadow: '0 0 50px rgba(255,176,0,0.4)' }}>
          FrankenTTY
        </div>
        <div style={{ fontSize: 46, color: AMBER_HOT, marginTop: 30, opacity: b, transform: `translateY(${String((1 - b) * 16)}px)` }}>{data.repoUrl}</div>
        <div style={{ marginTop: 46, display: 'flex', gap: 24, justifyContent: 'center', opacity: c, transform: `scale(${String(0.7 + 0.3 * c)})` }}>
          <div style={{ padding: '10px 26px', borderRadius: 36, border: `2px solid ${TEXT_DIM}`, color: TEXT, fontSize: 28, fontWeight: 700 }}>MIT</div>
          <div style={{ padding: '10px 26px', borderRadius: 36, border: `2px solid ${GREEN}`, color: GREEN, fontSize: 28, fontWeight: 700 }}>Built with Kiro</div>
        </div>
      </div>
    </AbsoluteFill>
  );
};
