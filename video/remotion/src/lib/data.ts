// Shape of public/data/data.json (written by scripts/prebuild.mjs).
import type { SessionMeta } from './acts.ts';
import type { Timeline } from './timing.ts';

export interface TreeNode {
  name: string;
  children?: TreeNode[];
}

export interface DemoData {
  manifest: { sessions: Record<string, SessionMeta>; narrationFixture: boolean; musicFixture: boolean };
  sweep: {
    file: string;
    source: string;
    cols: number;
    rows: number;
    threshold: number;
    naiveSgr: number;
    sgr: number;
    savingsPct: number;
    perDemo: { name: string; savingsPct: number; label: number; sgrPerFrame: number; naiveSgrPerFrame: number }[];
  };
  apple: { file: string; mbMin: number; mbMax: number; text: string };
  pbt: {
    file: string;
    property: string;
    source: string;
    terminal: string;
    cellAspect: string;
    maxCells: string;
    result: string;
    boundWas: string;
    boundNow: string;
    error: string;
    runs: string | null;
  };
  briefs: { id: string; wave: number; title: string }[];
  hook: { line: string; source: string; real: boolean };
  ci: { file: string; jobs: { id: string; name: string; tiles: string[] }[] };
  kiroTree: TreeNode[];
  kiro: { agents: { name: string; model: string }[]; hooks: string[] };
  mcp: {
    tool: string;
    arguments: Record<string, unknown>;
    grid: string;
    cols: number;
    rows: number;
    stats: Record<string, number>;
    topBackgrounds: { color: string; count: number }[];
    live: boolean;
  };
  install: { command: string; file: string };
  release: string;
  repoUrl: string;
}

export interface DemoProps extends Record<string, unknown> {
  data: DemoData;
  timeline: Timeline;
}
