import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { cancelRender, continueRender, delayRender, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { computeWindowLayout, TITLE_BAR_H } from '../lib/layout.ts';
import { badgesOf, maxSize, sizeAt } from '../lib/session.ts';
import type { Session } from '../lib/session.ts';
import { DEFAULT_BG, css, drawTerminal } from './draw.ts';
import { BADGE_SECONDS, KeyBadge } from './KeyBadge.tsx';
import { WindowFrame } from './WindowFrame.tsx';
import { getEngine, loadSession } from './replay-engine.ts';
import { replayTime } from './replay-time.ts';

export interface TerminalReplayProps {
  /** Scene name: loads public/sessions/<session>.json. */
  session: string;
  /** Session time (s) shown at frame 0 of this component. */
  startAt?: number;
  /** Session seconds per video second. */
  speed?: number;
  /** Session time (s) at which the picture stops changing. */
  freezeAt?: number;
  /** Container size; defaults to the composition size. */
  width?: number;
  height?: number;
  /** Room kept free below the window for key badges and captions. */
  band?: number;
  maxScale?: number;
  showBadges?: boolean;
  /** Caption by keycap text (a list is used per press: first press, second press, ...). Falls back to the event label. */
  captions?: Record<string, string | string[]>;
  /** Replaces the default engine key (use when two replays of one session are on screen). */
  engineKey?: string;
  /** Hide the window frame and draw only the terminal. */
  bare?: boolean;
  opacity?: number;
}

export const TerminalReplay: React.FC<TerminalReplayProps> = (props) => {
  const { session: name, startAt = 0, speed = 1, freezeAt, band = 100, maxScale = 1, showBadges = true, captions, bare = false } = props;
  const frame = useCurrentFrame();
  const config = useVideoConfig();
  const width = props.width ?? config.width;
  const height = props.height ?? config.height;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loadHandle] = useState(() => delayRender(`Loading session ${name}`));

  useEffect(() => {
    loadSession(staticFile(`sessions/${name}.json`)).then(
      (s) => {
        setSession(s);
        continueRender(loadHandle);
      },
      (e: unknown) => cancelRender(e),
    );
  }, [name, loadHandle]);

  const t = replayTime(frame, config.fps, startAt, speed, freezeAt);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (session === null || canvas === null) return;
    const handle = delayRender(`Replay ${name} at frame ${String(frame)}`);
    const engine = getEngine(props.engineKey ?? name, session);
    engine.advanceTo(t).then(
      () => {
        drawTerminal(canvas, engine.term);
        continueRender(handle);
      },
      (e: unknown) => cancelRender(e),
    );
  }, [session, name, t, frame, props.engineKey]);

  if (session === null) return null;

  const max = maxSize(session);
  const size = sizeAt(session, t);
  const layout = computeWindowLayout({
    width,
    height,
    band,
    maxCols: max.cols,
    maxRows: max.rows,
    cols: size.cols,
    rows: size.rows,
    maxScale,
  });
  const badges = showBadges ? badgesOf(session).filter((b) => t >= b.t && (t - b.t) / speed < BADGE_SECONDS) : [];

  const terminal = (
    <canvas
      ref={canvasRef}
      style={{ display: 'block', width: layout.termW, height: layout.termH, imageRendering: layout.scale > 1 ? 'pixelated' : 'auto', background: css(DEFAULT_BG) }}
    />
  );

  return (
    <div style={{ position: 'absolute', left: 0, top: 0, width, height, opacity: props.opacity ?? 1 }}>
      {bare ? (
        <div style={{ position: 'absolute', left: layout.left, top: layout.top + TITLE_BAR_H }}>{terminal}</div>
      ) : (
        <WindowFrame layout={layout} title={session.title}>
          {terminal}
        </WindowFrame>
      )}
      <div style={{ position: 'absolute', right: 56, bottom: 14, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 10 }}>
        {badges.map((b) => {
          const c = captions?.[b.cap];
          const caption = Array.isArray(c) ? (c[b.index] ?? c.at(-1)) : c;
          return (
            <KeyBadge key={`${String(b.t)}-${b.cap}`} cap={b.cap} label={caption === undefined ? '' : b.label} caption={caption ?? b.label} age={(t - b.t) / speed} />
          );
        })}
      </div>
    </div>
  );
};
