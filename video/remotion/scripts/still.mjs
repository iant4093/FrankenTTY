/* eslint-disable no-console -- command line tool */
// Renders review stills.
//   npm run still -- --frame 900 [--out ../build/still.png]     one frame
//   npm run stills                                               the three review stills (Act II, III, IV)
//   node scripts/still.mjs --all                                 every scene, for a visual check
// Frames are computed from the same timeline math the composition uses.

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { minVisualSeconds, planSegments, segmentsOf } from '../src/lib/acts.ts';
import { buildTimeline } from '../src/lib/timing.ts';

const project = path.resolve(import.meta.dirname, '..');
const pub = path.join(project, 'public');
const outDir = path.resolve(project, '../build/stills');

const data = JSON.parse(readFileSync(path.join(pub, 'data/data.json'), 'utf8'));
const durations = JSON.parse(readFileSync(path.join(pub, 'narration/durations.json'), 'utf8'));
const seconds = Object.fromEntries(Object.entries(durations).filter(([, v]) => typeof v === 'number'));
const timeline = buildTimeline(seconds, minVisualSeconds(data.manifest.sessions));
const segs = segmentsOf(data.manifest.sessions);

/** Absolute frame at `fraction` through segment `key` of act `id`. */
function at(id, key, fraction) {
  const act = timeline.acts.find((a) => a.id === id);
  const plan = planSegments(act.frames, segs[id]);
  const seg = plan.find((p) => p.key === key);
  return act.from + seg.from + Math.floor(seg.frames * fraction);
}

const SHOTS = {
  'act1-replay': () => at('act1', 'replay', 0.5),
  'act1-title': () => at('act1', 'title', 0.7),
  'act2-cell-zoom': () => at('act2', 'cell', 0.4),
  'act2-cell-split': () => at('act2', 'cell', 0.92),
  'act2-compare': () => at('act2', 'compare', 0.8),
  'act2-chart': () => at('act2', 'chart', 0.85),
  'act3-modes': () => at('act3', 'act3-modes', 0.22),
  'act3-seek': () => at('act3', 'act3-seek-pause', 0.2),
  'act3-resize': () => at('act3', 'act3-resize', 0.2),
  'act4-tree': () => at('act4', 'stage1', 0.8),
  'act4-worktrees': () => at('act4', 'stage2', 0.9),
  'act4-hook': () => at('act4', 'stage3', 0.9),
  'act4-mcp': () => at('act4', 'stage4', 0.9),
  'act4-ci': () => at('act4', 'stage5', 0.95),
  closing: () => at('closing', 'closing', 0.6),
};
const REVIEW = ['act2-compare', 'act3-modes', 'act4-hook'];

function render(frame, out) {
  mkdirSync(path.dirname(out), { recursive: true });
  const r = spawnSync('npx', ['remotion', 'still', 'src/index.ts', 'FrankenTTYDemo', out, `--frame=${String(frame)}`], { cwd: project, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
  console.log(`still: frame ${String(frame)} -> ${out}`);
}

const args = process.argv.slice(2);
const val = (k) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};
if (args.includes('--all') || args.includes('--review')) {
  const names = args.includes('--all') ? Object.keys(SHOTS) : REVIEW;
  const only = val('--only');
  for (const n of names) if (only === undefined || only === n) render(SHOTS[n](), path.join(outDir, `${n}.png`));
} else if (val('--frame') !== undefined) {
  render(Number(val('--frame')), path.resolve(project, val('--out') ?? '../build/still.png'));
} else {
  console.error('usage: still.mjs --frame N [--out file] | --review | --all [--only name]');
  process.exit(2);
}
