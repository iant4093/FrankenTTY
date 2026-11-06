/* eslint-disable no-console -- command line tool */
// Writes small stand-ins for the 6.A session recordings, using the real player in a PTY (tests/helpers/pty_run.py).
// Output: fixtures/sessions/*.json (marked "fixture": true), fixtures/narration/durations.json,
// fixtures/mcp-snapshot.json (a real call to the MCP server). Re-run only when the session format changes.
//
//   node scripts/make-fixtures.mjs [scene ...]

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mcpSnapshot } from './prebuild.mjs';

const project = path.resolve(import.meta.dirname, '..');
const repo = path.resolve(project, '../..');
const KEYS = { m: '6d', c: '63', i: '69', q: '71', space: '20', right: '1b5b43', shiftLeft: '1b5b313b3244' };
const CAP = { m: 'm', c: 'c', i: 'i', q: 'q', space: ' ', right: '\u001b[C', shiftLeft: '\u001b[1;2D' };

// at = seconds after spawn.
const SCENES = {
  'act1-mandelbrot': {
    args: ['--demo', 'mandelbrot', '--fps', '5'],
    cols: 160,
    rows: 45,
    title: 'frankentty --demo mandelbrot',
    keys: [[4.5, 'q', 'quit']],
    duration: 5.5,
  },
  'act2-cell': {
    args: ['--demo', 'life', '--mode', 'halfblock', '--fps', '6'],
    cols: 40,
    rows: 12,
    title: 'frankentty --demo life',
    keys: [[4.5, 'q', 'quit']],
    duration: 5.5,
  },
  'act3-modes': {
    args: ['--demo', 'gradients', '--fps', '5'],
    cols: 160,
    rows: 45,
    title: 'frankentty --demo gradients',
    keys: [[1.5, 'm', 'cycle mode'], [3, 'm', 'cycle mode'], [4.5, 'c', 'cycle palette'], [6, 'c', 'cycle palette'], [7.5, 'q', 'quit']],
    duration: 8.5,
  },
  'act3-seek-pause': {
    args: ['--demo', 'testsrc2', '--fps', '5'],
    cols: 160,
    rows: 45,
    title: 'frankentty --demo testsrc2',
    keys: [[1.5, 'right', 'seek +5 s'], [3, 'space', 'pause'], [4.5, 'space', 'resume'], [5.5, 'shiftLeft', 'seek -30 s'], [7, 'i', 'toggle HUD'], [8, 'q', 'quit']],
    duration: 9,
  },
  'act3-resize': {
    args: ['--demo', 'gradients', '--fps', '5'],
    cols: 100,
    rows: 30,
    title: 'frankentty --demo gradients',
    keys: [[5.5, 'q', 'quit']],
    resize: [[2.5, 160, 45]],
    duration: 6.5,
  },
};

function record(name, scene) {
  const events = [
    ...scene.keys.map(([at, k]) => ({ at, hex: KEYS[k] })),
    ...(scene.resize ?? []).map(([at, c, r]) => ({ at, resize: [c, r] })),
  ];
  const spec = {
    cmd: [process.execPath, path.join(repo, 'src/main.ts'), ...scene.args],
    cwd: repo,
    cols: scene.cols,
    rows: scene.rows,
    timeout: scene.duration + 20,
    env: {
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      LANG: 'en_US.UTF-8',
      SDL_AUDIODRIVER: 'dummy',
      FRANKENTTY_CACHE_DIR: path.join(tmpdir(), 'frankentty-video-fixtures'),
    },
    events,
  };
  const r = spawnSync('python3', [path.join(repo, 'tests/helpers/pty_run.py'), JSON.stringify(spec)], { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`${name}: pty_run failed: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  if (out.timedOut) throw new Error(`${name}: timed out`);
  const session = {
    version: 1,
    cols: scene.cols,
    rows: scene.rows,
    fps: 30,
    durationSec: Math.round(Math.max(...out.chunks.map((c) => c.t), scene.duration) * 100) / 100,
    title: scene.title,
    command: ['frankentty', ...scene.args],
    env: { TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: 'en_US.UTF-8' },
    events: [
      ...scene.keys.map(([t, k, label]) => ({ t, keys: CAP[k], label })),
      ...(scene.resize ?? []).map(([t, c, r]) => ({ t, keys: '', label: `resize ${String(c)}x${String(r)}`, resize: [c, r] })),
    ].sort((a, b) => a.t - b.t),
    chunks: out.chunks,
    fixture: true,
  };
  mkdirSync(path.join(project, 'fixtures/sessions'), { recursive: true });
  const file = path.join(project, 'fixtures/sessions', `${name}.json`);
  writeFileSync(file, JSON.stringify(session));
  const bytes = out.chunks.reduce((a, c) => a + Buffer.from(c.b64, 'base64').length, 0);
  console.log(`${name}: exit ${String(out.exitCode)}, ${String(out.chunks.length)} chunks, ${String(bytes)} bytes, ${String(session.durationSec)} s`);
}

const wanted = process.argv.slice(2);
for (const [name, scene] of Object.entries(SCENES)) if (wanted.length === 0 || wanted.includes(name)) record(name, scene);

if (wanted.length === 0) {
  mkdirSync(path.join(project, 'fixtures/narration'), { recursive: true });
  // Narration seconds at about 130 words per minute for the 44 / 78 / 82 / 96 word blocks in video/script.md.
  writeFileSync(
    path.join(project, 'fixtures/narration/durations.json'),
    `${JSON.stringify({ _fixture: true, act1: 20.3, act2: 36, act3: 37.8, act4: 44.3 }, null, 1)}\n`,
  );
  const snap = await mcpSnapshot();
  if (!snap.live) throw new Error('MCP server did not answer; cannot write a real fixture');
  const rest = { ...snap };
  delete rest.live;
  writeFileSync(path.join(project, 'fixtures/mcp-snapshot.json'), `${JSON.stringify(rest, null, 1)}\n`);
  console.log('wrote fixtures/narration/durations.json and fixtures/mcp-snapshot.json');
}
