import React from 'react';
import { AbsoluteFill, Audio, Sequence, staticFile } from 'remotion';
import { Act1 } from './acts/Act1.tsx';
import { Act2 } from './acts/Act2.tsx';
import { Act3 } from './acts/Act3.tsx';
import { Act4 } from './acts/Act4.tsx';
import { Closing } from './acts/Closing.tsx';
import { ensureFonts } from './components/fonts.ts';
import type { DemoProps } from './lib/data.ts';
import { BG } from './lib/theme.ts';
import { musicGain, narrationWindows } from './lib/timing.ts';
import type { ActId } from './lib/timing.ts';

ensureFonts();

export const FrankenTTYDemo: React.FC<DemoProps> = ({ data, timeline }) => {
  const windows = narrationWindows(timeline);
  const view: Record<ActId, React.FC<{ data: typeof data; frames: number }>> = { act1: Act1, act2: Act2, act3: Act3, act4: Act4, closing: Closing };
  return (
    <AbsoluteFill style={{ background: BG }}>
      {timeline.acts.map((act) => {
        const View = view[act.id];
        return (
          <Sequence key={act.id} from={act.from} durationInFrames={act.frames} name={act.id}>
            <View data={data} frames={act.frames} />
          </Sequence>
        );
      })}
      {timeline.acts
        .filter((a) => a.narrationFrames > 0)
        .map((act) => (
          <Sequence key={`narration-${act.id}`} from={act.from} durationInFrames={act.narrationFrames + 30} name={`narration ${act.id}`}>
            <Audio src={staticFile(`narration/${act.id}.wav`)} />
          </Sequence>
        ))}
      <Audio src={staticFile('music/bed.wav')} volume={(f) => musicGain(f, windows)} />
    </AbsoluteFill>
  );
};
