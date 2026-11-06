import React from 'react';
import { interpolate, spring, useVideoConfig } from 'remotion';
import { AMBER, FONT_FAMILY, PANEL, PANEL_BORDER, TEXT, TEXT_DIM } from '../lib/theme.ts';

export const BADGE_SECONDS = 1.2;

/** Keycap with a spring pop-in and a short fade-out. `age` is seconds since the key was pressed. */
export const KeyBadge: React.FC<{ cap: string; label: string; age: number; caption?: string }> = ({ cap, label, age, caption }) => {
  const { fps } = useVideoConfig();
  const pop = spring({ frame: Math.max(0, age * fps), fps, config: { damping: 11, stiffness: 180, mass: 0.7 } });
  const opacity = interpolate(age, [0, 0.05, BADGE_SECONDS - 0.25, BADGE_SECONDS], [0, 1, 1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const wide = cap.length > 1;
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        opacity,
        transform: `scale(${String(0.4 + 0.6 * pop)}) translateY(${String((1 - pop) * 18)}px)`,
        transformOrigin: 'right bottom',
      }}
    >
      <div style={{ textAlign: 'right' }}>
        {caption !== undefined ? (
          <div style={{ fontFamily: FONT_FAMILY, fontSize: 30, fontWeight: 700, color: AMBER }}>{caption}</div>
        ) : null}
        {label !== '' ? <div style={{ fontFamily: FONT_FAMILY, fontSize: 20, color: TEXT_DIM }}>{label}</div> : null}
      </div>
      {cap === '' ? null : <div
        style={{
          minWidth: wide ? 110 : 64,
          height: 64,
          padding: '0 18px',
          boxSizing: 'border-box',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: FONT_FAMILY,
          fontWeight: 700,
          fontSize: 32,
          color: TEXT,
          background: `linear-gradient(180deg, #2c2c3a, ${PANEL})`,
          border: `2px solid ${PANEL_BORDER}`,
          borderBottom: '6px solid #0a0a10',
          borderRadius: 12,
          boxShadow: '0 6px 18px rgba(0,0,0,0.5)',
        }}
      >
        {cap}
      </div>}
    </div>
  );
};
