import React from 'react';
import { TITLE_BAR_H } from '../lib/layout.ts';
import type { WindowLayout } from '../lib/layout.ts';
import { FONT_FAMILY, MAC_GREEN, RED, TEXT_DIM, YELLOW } from '../lib/theme.ts';
import { DEFAULT_BG, css } from './draw.ts';

/** Dark window with a title bar, three dots, rounded corners and a soft shadow. */
export const WindowFrame: React.FC<{ layout: WindowLayout; title: string; children: React.ReactNode }> = ({ layout, title, children }) => (
  <div
    style={{
      position: 'absolute',
      left: layout.left,
      top: layout.top,
      width: layout.windowW,
      borderRadius: 14,
      overflow: 'hidden',
      background: css(DEFAULT_BG),
      border: '1px solid #34343f',
      boxShadow: '0 30px 80px rgba(0,0,0,0.65), 0 0 0 1px rgba(255,255,255,0.03)',
    }}
  >
    <div
      style={{
        height: TITLE_BAR_H,
        display: 'flex',
        alignItems: 'center',
        padding: '0 18px',
        background: 'linear-gradient(180deg, #2b2b35, #1f1f27)',
        borderBottom: '1px solid #101015',
        position: 'relative',
      }}
    >
      {[RED, YELLOW, MAC_GREEN].map((c) => (
        <div key={c} style={{ width: 14, height: 14, borderRadius: 7, background: c, marginRight: 9 }} />
      ))}
      <div style={{ position: 'absolute', left: 0, right: 0, textAlign: 'center', fontFamily: FONT_FAMILY, fontSize: 17, color: TEXT_DIM }}>{title}</div>
    </div>
    {children}
  </div>
);
