import React from 'react';
import { useCurrentFrame, useVideoConfig } from 'remotion';
import { computeWindowLayout } from '../lib/layout.ts';
import { AMBER, CELL_FONT_PX, FONT_FAMILY } from '../lib/theme.ts';
import { DEFAULT_BG, DEFAULT_FG, css } from './draw.ts';
import { typed } from './ui.tsx';
import { WindowFrame } from './WindowFrame.tsx';

/**
 * An empty shell window where the command is typed, then Enter. Same window size as the replay that follows
 * (same layout arguments), so the cut to the recording is invisible. Not terminal output: it is a drawn prompt.
 */
export const TypedIntro: React.FC<{ command: string; title: string; cols: number; rows: number; maxCols: number; maxRows: number; band?: number }> = ({
  command,
  title,
  cols,
  rows,
  maxCols,
  maxRows,
  band = 100,
}) => {
  const frame = useCurrentFrame();
  const { width, height, fps } = useVideoConfig();
  const layout = computeWindowLayout({ width, height, band, maxCols, maxRows, cols, rows, maxScale: 1 });
  const typeStart = Math.round(0.15 * fps);
  const perChar = Math.max(1, Math.round(fps / 40));
  const count = (frame - typeStart) / perChar;
  const text = typed(command, count);
  const blink = Math.floor(frame / (fps / 2)) % 2 === 0;
  const font = CELL_FONT_PX * layout.scale;
  const done = count >= command.length;
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <WindowFrame layout={layout} title={title}>
        <div style={{ width: layout.termW, height: layout.termH, background: css(DEFAULT_BG), position: 'relative' }}>
          <div style={{ position: 'absolute', left: 12 * layout.scale, top: 3 * layout.scale, fontFamily: FONT_FAMILY, fontSize: font, lineHeight: `${String(24 * layout.scale)}px`, color: css(DEFAULT_FG), whiteSpace: 'pre' }}>
            <span style={{ color: AMBER }}>$ </span>
            {text}
            <span style={{ display: 'inline-block', width: 12 * layout.scale, height: 24 * layout.scale, verticalAlign: 'top', background: blink || !done ? css(DEFAULT_FG) : 'transparent', marginLeft: 1 }} />
          </div>
        </div>
      </WindowFrame>
    </div>
  );
};
