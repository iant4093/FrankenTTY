import React from 'react';
import { Composition, staticFile } from 'remotion';
import type { CalculateMetadataFunction } from 'remotion';
import { FrankenTTYDemo } from './FrankenTTYDemo.tsx';
import { minVisualSeconds } from './lib/acts.ts';
import type { DemoData, DemoProps } from './lib/data.ts';
import { FPS, HEIGHT, WIDTH, buildTimeline } from './lib/timing.ts';

async function fetchJson<T>(file: string): Promise<T> {
  const res = await fetch(staticFile(file));
  if (!res.ok) throw new Error(`cannot load ${file}: HTTP ${String(res.status)} (run npm run prebuild)`);
  return (await res.json()) as T;
}

/** Act lengths come from narration/durations.json and the session lengths (REQ-VID-06). */
const calculateMetadata: CalculateMetadataFunction<DemoProps> = async () => {
  const [data, durations] = await Promise.all([fetchJson<DemoData>('data/data.json'), fetchJson<Record<string, unknown>>('narration/durations.json')]);
  const seconds: Record<string, number> = {};
  for (const [k, v] of Object.entries(durations)) if (typeof v === 'number') seconds[k] = v;
  const timeline = buildTimeline(seconds, minVisualSeconds(data.manifest.sessions));
  return { durationInFrames: timeline.totalFrames, props: { data, timeline } };
};

const placeholder = { data: undefined, timeline: { acts: [], totalFrames: 1 } } as unknown as DemoProps;

export const Root: React.FC = () => (
  <Composition
    id="FrankenTTYDemo"
    component={FrankenTTYDemo}
    width={WIDTH}
    height={HEIGHT}
    fps={FPS}
    durationInFrames={1}
    defaultProps={placeholder}
    calculateMetadata={calculateMetadata}
  />
);
