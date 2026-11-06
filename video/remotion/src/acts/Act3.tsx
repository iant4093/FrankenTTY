import React from 'react';
import { AbsoluteFill, Sequence } from 'remotion';
import { TerminalReplay } from '../components/TerminalReplay.tsx';
import { TypedIntro } from '../components/TypedIntro.tsx';
import { ACT3, planSegments, segmentsOf } from '../lib/acts.ts';
import type { DemoData } from '../lib/data.ts';
import { BG, TEXT } from '../lib/theme.ts';

/** Captions by keycap. "seek 0.2 s" is the measured key-to-frame latency (docs/EVIDENCE.md, tasks 4.6-4.10). */
export const ACT3_CAPTIONS: Record<string, string | string[]> = {
  m: 'mode',
  c: 'palette',
  '→': 'seek 0.2 s',
  '←': 'seek 0.2 s',
  '⇧←': 'seek 0.2 s',
  '⇧→': 'seek 0.2 s',
  Space: ['pause', 'resume'],
  i: 'HUD',
  q: 'quit',
  '': 'quality governor',
};

export const Act3: React.FC<{ data: DemoData; frames: number }> = ({ data, frames }) => {
  const plan = planSegments(frames, segmentsOf(data.manifest.sessions).act3);
  return (
    <AbsoluteFill style={{ background: BG, color: TEXT }}>
      {plan.map((seg) => {
        const intro = seg.key.endsWith(':intro');
        const scene = intro ? seg.key.slice(0, -':intro'.length) : seg.key;
        if (!(ACT3.scenes as readonly string[]).includes(scene)) throw new Error(`unknown act3 segment ${seg.key}`);
        const meta = data.manifest.sessions[scene];
        if (meta === undefined) throw new Error(`missing session ${scene}`);
        return (
          <Sequence key={seg.key} from={seg.from} durationInFrames={seg.frames}>
            {intro ? (
              <TypedIntro command={meta.title} title={meta.title} cols={meta.cols} rows={meta.rows} maxCols={meta.maxCols} maxRows={meta.maxRows} />
            ) : (
              <TerminalReplay session={scene} captions={ACT3_CAPTIONS} />
            )}
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
