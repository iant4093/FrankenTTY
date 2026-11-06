import React from 'react';
import { AbsoluteFill, Sequence, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import { TerminalReplay } from '../components/TerminalReplay.tsx';
import { useFade, useSpring } from '../components/ui.tsx';
import { planSegments, segmentsOf } from '../lib/acts.ts';
import type { DemoData } from '../lib/data.ts';
import { AMBER, AMBER_DIM, AMBER_HOT, BG, FONT_FAMILY, GREEN, TEXT, TEXT_DIM } from '../lib/theme.ts';

const Cursor: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const on = Math.floor(frame / (fps / 2)) % 2 === 0;
  return (
    <AbsoluteFill style={{ background: '#000' }}>
      <div style={{ position: 'absolute', left: 96, top: 96, width: 24, height: 48, background: on ? '#d8d8d8' : 'transparent' }} />
    </AbsoluteFill>
  );
};

const TitleCard: React.FC<{ total: number }> = ({ total }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const title = useSpring(0, { damping: 16, stiffness: 90 });
  const sub = useSpring(14);
  const badge = useSpring(30, { damping: 12 });
  const fade = useFade(total, 6, 10);
  const glow = 0.55 + 0.15 * Math.sin((frame / fps) * 2.2);
  return (
    <AbsoluteFill style={{ background: BG, opacity: fade, alignItems: 'center', justifyContent: 'center' }}>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: `radial-gradient(ellipse at 50% 45%, rgba(255,176,0,${String(0.13 * glow)}), transparent 60%)`,
        }}
      />
      <div style={{ textAlign: 'center', fontFamily: FONT_FAMILY }}>
        <div
          style={{
            fontSize: 150,
            fontWeight: 700,
            letterSpacing: -4,
            color: AMBER,
            textShadow: `0 0 40px rgba(255,176,0,${String(glow)}), 0 0 90px rgba(255,176,0,0.25)`,
            transform: `scale(${String(0.88 + 0.12 * title)})`,
            opacity: title,
          }}
        >
          FrankenTTY
        </div>
        <div
          style={{
            fontSize: 38,
            color: AMBER_HOT,
            marginTop: 18,
            opacity: sub,
            transform: `translateY(${String((1 - sub) * 20)}px)`,
          }}
        >
          video over 50-year-old escape codes
        </div>
        <div
          style={{
            display: 'inline-block',
            marginTop: 54,
            padding: '12px 28px',
            borderRadius: 40,
            border: `2px solid ${GREEN}`,
            color: GREEN,
            fontSize: 26,
            fontWeight: 700,
            letterSpacing: 1,
            opacity: badge,
            transform: `scale(${String(0.6 + 0.4 * badge)})`,
            boxShadow: '0 0 24px rgba(51,255,51,0.25)',
          }}
        >
          Kiroween 2026 · Frankenstein
        </div>
      </div>
      <div style={{ position: 'absolute', bottom: 40, fontFamily: FONT_FAMILY, fontSize: 18, color: TEXT_DIM, opacity: 0.7 }}>
        <span style={{ color: AMBER_DIM }}>{'ESC [ 3 8 ; 2 ; r ; g ; b m'}</span>
      </div>
    </AbsoluteFill>
  );
};

export const Act1: React.FC<{ data: DemoData; frames: number }> = ({ data, frames }) => {
  const plan = planSegments(frames, segmentsOf(data.manifest.sessions).act1);
  const [cursor, replay, title] = plan;
  if (cursor === undefined || replay === undefined || title === undefined) throw new Error('act1 plan');
  return (
    <AbsoluteFill style={{ background: BG, color: TEXT }}>
      <Sequence from={cursor.from} durationInFrames={cursor.frames}>
        <Cursor />
      </Sequence>
      <Sequence from={replay.from} durationInFrames={replay.frames}>
        <ReplayFade total={replay.frames} />
      </Sequence>
      <Sequence from={title.from} durationInFrames={title.frames}>
        <TitleCard total={title.frames} />
      </Sequence>
    </AbsoluteFill>
  );
};

const ReplayFade: React.FC<{ total: number }> = ({ total }) => {
  const frame = useCurrentFrame();
  const out = interpolate(frame, [total - 8, total], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return (
    <AbsoluteFill style={{ background: '#000', opacity: out }}>
      <TerminalReplay session="act1-mandelbrot" showBadges={false} />
    </AbsoluteFill>
  );
};
