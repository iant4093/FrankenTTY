/* eslint-disable no-console -- command line tool */
// Prebuild: gathers everything the composition reads, so rendering needs no repo access.
//
//   public/fonts/*.woff2        JetBrains Mono (SIL OFL 1.1) copied from node_modules
//   public/sessions/<scene>.json  real recordings (6.A) from ../sessions, else fixtures/
//   public/narration/*.wav, durations.json  real narration (6.C) from ../build/narration, else fixture tones
//   public/music/bed.wav        real bed (6.C) from ../build/music, else a fixture tone
//   public/data/data.json       numbers and trees parsed from the repo (evidence, .kiro, ci.yml, briefs, MCP)
//
// Every number on screen is read from docs/evidence/** or docs/EVIDENCE.md here, never typed into a component.
// Fixtures are marked ("fixture": true / "_fixture": true) so a real input always replaces them.

import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { maxSize } from '../src/lib/session.ts';

const here = import.meta.dirname;
const project = path.resolve(here, '..');
const repo = path.resolve(project, '../..');
const pub = path.join(project, 'public');

export const SCENES = ['act1-mandelbrot', 'act2-cell', 'act3-modes', 'act3-seek-pause', 'act3-resize'];
export const ACTS = ['act1', 'act2', 'act3', 'act4', 'closing'];

const log = (msg) => console.log(`prebuild: ${msg}`);
const warn = (msg) => console.warn(`prebuild: WARNING ${msg}`);

function mkdir(p) {
  mkdirSync(p, { recursive: true });
}

function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

// ---------------------------------------------------------------------------
// Fonts
// ---------------------------------------------------------------------------

function copyFonts() {
  const src = path.join(project, 'node_modules/@fontsource/jetbrains-mono/files');
  mkdir(path.join(pub, 'fonts'));
  for (const weight of ['400', '700']) {
    const name = `jetbrains-mono-latin-${weight}-normal.woff2`;
    copyFileSync(path.join(src, name), path.join(pub, 'fonts', name));
  }
}

// ---------------------------------------------------------------------------
// Sessions, narration, music: real inputs first, fixtures second
// ---------------------------------------------------------------------------

function readSessionFile(base) {
  if (existsSync(`${base}.json`)) return readFileSync(`${base}.json`, 'utf8');
  if (existsSync(`${base}.json.gz`)) return gunzipSync(readFileSync(`${base}.json.gz`)).toString('utf8');
  return null;
}

function isFixtureFile(p) {
  try {
    return readJson(p).fixture === true;
  } catch {
    return false;
  }
}

function prepareSessions() {
  mkdir(path.join(pub, 'sessions'));
  const sessions = {};
  for (const scene of SCENES) {
    const target = path.join(pub, 'sessions', `${scene}.json`);
    const real = readSessionFile(path.join(repo, 'video/sessions', scene));
    let text;
    if (real !== null) {
      // A real recording always wins over whatever is in public/ unless public/ already has a real one.
      if (!existsSync(target) || isFixtureFile(target) || readFileSync(target, 'utf8') !== real) {
        writeFileSync(target, real);
      }
      text = real;
    } else if (existsSync(target) && !isFixtureFile(target)) {
      text = readFileSync(target, 'utf8');
    } else {
      const fixture = path.join(project, 'fixtures/sessions', `${scene}.json`);
      if (!existsSync(fixture)) throw new Error(`no session for ${scene}: run scripts/make-fixtures.mjs or record with 6.A`);
      copyFileSync(fixture, target);
      text = readFileSync(target, 'utf8');
    }
    const s = JSON.parse(text);
    if (s.fixture === true) warn(`using FIXTURE session for ${scene}`);
    const max = maxSize(s);
    sessions[scene] = { durationSec: s.durationSec, cols: s.cols, rows: s.rows, maxCols: max.cols, maxRows: max.rows, title: s.title, fixture: s.fixture === true };
  }
  return sessions;
}

/** 16-bit mono WAV with a quiet sine, for fixture narration and music. */
function toneWav(seconds, freq, amp, rate = 8000) {
  const n = Math.ceil(seconds * rate);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    // Gentle on/off every 0.5 s so ducking is audible when you listen to a fixture render.
    const gate = Math.floor((i / rate) * 2) % 2 === 0 ? 1 : 0.35;
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * amp * gate * 32767), 44 + i * 2);
  }
  return buf;
}

function prepareAudio() {
  mkdir(path.join(pub, 'narration'));
  mkdir(path.join(pub, 'music'));
  const realDir = path.join(repo, 'video/build/narration');
  const realDurations = path.join(realDir, 'durations.json');
  const target = path.join(pub, 'narration/durations.json');
  let fixtureNarration = false;

  if (existsSync(realDurations)) {
    const d = readJson(realDurations);
    // Only the act files are needed here; build.sh copies the rest.
    for (const act of ACTS) {
      const wav = path.join(realDir, `${act}.wav`);
      if (existsSync(wav)) copyFileSync(wav, path.join(pub, 'narration', `${act}.wav`));
    }
    writeFileSync(target, JSON.stringify(d));
  } else if (existsSync(target) && readJson(target)._fixture !== true) {
    // build.sh already copied real narration into public/.
  } else {
    fixtureNarration = true;
    const d = readJson(path.join(project, 'fixtures/narration/durations.json'));
    writeFileSync(target, JSON.stringify(d));
    for (const act of ACTS) {
      if (typeof d[act] !== 'number') continue;
      writeFileSync(path.join(pub, 'narration', `${act}.wav`), toneWav(d[act], 220 + 40 * ACTS.indexOf(act), 0.2));
    }
    warn('using FIXTURE narration (sine tones)');
  }

  const bedTarget = path.join(pub, 'music/bed.wav');
  const bedMarker = path.join(pub, 'music/bed.fixture.json');
  const realBed = path.join(repo, 'video/build/music/bed.wav');
  // The marker holds the size of the fixture tone we wrote; a different size means build.sh copied a real bed.
  const markedFixture = existsSync(bedMarker) && existsSync(bedTarget) && readJson(bedMarker).size === statSync(bedTarget).size;
  let fixtureMusic = false;
  if (existsSync(realBed)) {
    copyFileSync(realBed, bedTarget);
  } else if (!existsSync(bedTarget) || markedFixture) {
    fixtureMusic = true;
    const total = Object.entries(readJson(target))
      .filter(([k, v]) => ACTS.includes(k) && typeof v === 'number')
      .reduce((a, [, v]) => a + v + 0.8, 0);
    const wav = toneWav(total + 20, 110, 0.5);
    writeFileSync(bedTarget, wav);
    writeFileSync(bedMarker, JSON.stringify({ size: wav.length }));
    warn('using FIXTURE music bed (sine tone)');
  }
  const d = readJson(target);
  const durations = {};
  for (const [k, v] of Object.entries(d)) if (typeof v === 'number') durations[k] = v;
  return { durations, fixtureNarration: d._fixture === true || fixtureNarration, fixtureMusic };
}

// ---------------------------------------------------------------------------
// Evidence: numbers parsed from files
// ---------------------------------------------------------------------------

function parseSweep() {
  const file = 'docs/evidence/wave3/sweep.jsonl';
  const rows = readFileSync(path.join(repo, file), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l));
  const defaults = rows.filter(
    (r) => r.cols === 120 && r.rows === 35 && r.mode === 'halfblock' && r.palette === 'truecolor' && r.depth === 'truecolor' && r.threshold === 8,
  );
  const names = ['mandelbrot', 'life', 'cellauto', 'gradients', 'testsrc2'];
  const perDemo = names.map((name) => {
    const r = defaults.find((x) => x.source === name);
    if (r === undefined) throw new Error(`sweep.jsonl has no default row for ${name}`);
    return { name, savingsPct: r.sgrSavingsPct, label: Math.round(r.sgrSavingsPct), sgrPerFrame: r.sgrPerFrame, naiveSgrPerFrame: r.naiveSgrPerFrame };
  });
  const m = perDemo[0];
  return {
    file,
    source: 'mandelbrot',
    cols: 120,
    rows: 35,
    threshold: 8,
    naiveSgr: m.naiveSgrPerFrame,
    sgr: m.sgrPerFrame,
    savingsPct: m.savingsPct,
    perDemo,
  };
}

function parseApple() {
  const file = 'docs/evidence/wave0/wave0-apple-terminal.json';
  const d = readJson(path.join(repo, file));
  const rates = d.fps.map((r) => r.mbPerSec);
  const lo = Math.min(...rates);
  const hi = Math.max(...rates);
  return { file, mbMin: lo, mbMax: hi, text: `${lo.toFixed(1)}–${hi.toFixed(1)}` };
}

function parsePbt() {
  const file = 'docs/EVIDENCE.md';
  const text = readFileSync(path.join(repo, file), 'utf8').replace(/\s+/g, ' ');
  const m = /source (\d+)×(\d+) in a (\d+)×(\d+) terminal, cell aspect ([\d.]+), maxCells ([\d,]+) → (\d+)×(\d+)/.exec(text);
  const was = /written in brief 1\.3 as `([^`]+)`/.exec(text);
  const now = /corrected to `([^`]+)`/.exec(text);
  const err = /relative aspect error ≈ `([^`]+)`/.exec(text);
  if (m === null || was === null || now === null || err === null) throw new Error('EVIDENCE.md: P1f counterexample text not found');
  return {
    file,
    property: 'P1f',
    source: `${m[1]}×${m[2]}`,
    terminal: `${m[3]}×${m[4]}`,
    cellAspect: m[5],
    maxCells: m[6],
    result: `${m[7]}×${m[8]}`,
    boundWas: was[1],
    boundNow: now[1],
    error: err[1],
    runs: /Properties P1a–P1e at 10,000 runs, P1f at ([\d,]+)/.exec(text)?.[1] ?? null,
  };
}

function parseBriefs() {
  return ['3.1', '3.2', '3.3'].map((id) => {
    const first = readFileSync(path.join(repo, `docs/briefs/${id}.md`), 'utf8').split('\n')[0] ?? '';
    const m = /^TASK ([\d.]+) \(Wave (\d+)\) — (.*)$/.exec(first);
    if (m === null) throw new Error(`docs/briefs/${id}.md: unexpected first line`);
    let title = m[3];
    const colon = title.indexOf(':');
    if (colon > 0) title = title.slice(0, colon);
    title = title.replace(/\.$/, '');
    return { id, wave: Number(m[2]), title };
  });
}

function parseHook() {
  const logPath = path.join(repo, 'build/hooks/hooks.log');
  if (existsSync(logPath)) {
    const lines = readFileSync(logPath, 'utf8').split('\n').filter((l) => /gate-turn .*BLOCK/.test(l));
    const last = lines.at(-1);
    if (last !== undefined) return { line: last, source: 'build/hooks/hooks.log', real: true };
  }
  return {
    line: 'gate-turn session=builder-sonnet BLOCK 1/3',
    source: 'format from scripts/hooks/gate-turn.sh; Stop hook fires with --v3 (docs/EVIDENCE.md, S5)',
    real: false,
  };
}

function parseCi() {
  const file = '.github/workflows/ci.yml';
  const lines = readFileSync(path.join(repo, file), 'utf8').split('\n');
  const jobs = [];
  let inJobs = false;
  let cur = null;
  for (const line of lines) {
    if (/^jobs:/.test(line)) {
      inJobs = true;
      continue;
    }
    if (!inJobs) continue;
    const job = /^ {2}([a-z][a-z0-9-]*):\s*$/.exec(line);
    if (job !== null) {
      cur = { id: job[1], name: job[1], os: [], assets: [] };
      jobs.push(cur);
      continue;
    }
    if (cur === null) continue;
    const name = /^ {4}name: (.*)$/.exec(line);
    if (name !== null) cur.name = name[1];
    const os = /^ {8}os: \[(.*)\]/.exec(line);
    if (os !== null) cur.os = os[1].split(',').map((s) => s.trim());
    const asset = /asset: ([\w.-]+)/.exec(line);
    if (asset !== null && /runner:/.test(line)) cur.assets.push(asset[1]);
  }
  const shortOs = (s) => s.replace('-latest', '');
  const shortAsset = (s) => s.replace(/^frankentty-/, '').replace(/\.(tar\.gz|zip)$/, '');
  return {
    file,
    jobs: jobs.map((j) => {
      let tiles;
      if (j.name.includes('${{ matrix.os }}') && j.os.length > 0) tiles = j.os.map((o) => j.name.replace('${{ matrix.os }}', shortOs(o)));
      else if (j.name.includes('${{ matrix.asset }}') && j.assets.length > 0) tiles = j.assets.map((a) => j.name.replace('${{ matrix.asset }}', shortAsset(a)));
      else tiles = [j.name];
      return { id: j.id, name: j.name, tiles };
    }),
  };
}

function walk(dir, depth) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    if (name === '.DS_Store' || name === 'node_modules') continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push({ name, children: depth > 0 ? walk(full, depth - 1) : [] });
    else out.push({ name });
  }
  return out;
}

function kiroTree() {
  const tree = walk(path.join(repo, '.kiro'), 3);
  const withoutBackups = (nodes) =>
    nodes.filter((n) => !n.name.endsWith('.bak')).map((n) => (n.children === undefined ? n : { ...n, children: withoutBackups(n.children) }));
  return withoutBackups(tree);
}

function kiroSummary() {
  const agentsDir = path.join(repo, '.kiro/agents');
  const agents = readdirSync(agentsDir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => {
      const j = readJson(path.join(agentsDir, f));
      return { name: j.name, model: j.model };
    });
  const hooksDir = path.join(repo, '.kiro/hooks');
  const hooks = readdirSync(hooksDir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .flatMap((f) => (readJson(path.join(hooksDir, f)).hooks ?? []).map((h) => h.name));
  return { agents, hooks };
}

function parseInstall() {
  const readme = readFileSync(path.join(repo, 'README.md'), 'utf8');
  const m = /^(curl -fsSL \S+install\.sh \| sh)$/m.exec(readme);
  if (m === null) throw new Error('README.md: install command not found');
  return { command: m[1], file: 'README.md' };
}

/** Calls the real MCP server (tools/frankentty-mcp) for one snapshot. Falls back to the committed fixture. */
export function mcpSnapshot() {
  const args = { demo: 'testsrc2', atSec: 1, size: '40x12' };
  const fixture = path.join(project, 'fixtures/mcp-snapshot.json');
  return new Promise((resolve) => {
    const fallback = (why) => {
      warn(`MCP snapshot from fixture (${why})`);
      resolve({ ...readJson(fixture), live: false });
    };
    if (!existsSync(path.join(repo, 'tools/frankentty-mcp/server.ts')) || !existsSync(path.join(repo, 'node_modules/@xterm/headless'))) {
      fallback('server or its dependencies are missing');
      return;
    }
    const child = spawn(process.execPath, ['tools/frankentty-mcp/server.ts'], { cwd: repo, stdio: ['pipe', 'pipe', 'ignore'] });
    let buf = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (value === null) fallback('call failed');
      else resolve({ ...value, live: true });
    };
    const timer = setTimeout(() => finish(null), 20_000);
    child.on('error', () => finish(null));
    child.on('exit', () => finish(null));
    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 1) {
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'frankentty_render_snapshot', arguments: args } })}\n`);
        } else if (msg.id === 2) {
          const s = msg.result?.structuredContent;
          if (msg.result?.isError || s === undefined) finish(null);
          else finish({ tool: 'frankentty_render_snapshot', arguments: args, grid: s.grid, cols: s.cols, rows: s.rows, stats: s.stats, topBackgrounds: s.topBackgrounds });
        }
      }
    });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'frankentty-video', version: '0' } } })}\n`,
    );
  });
}

// ---------------------------------------------------------------------------

export async function main() {
  mkdir(pub);
  mkdir(path.join(pub, 'data'));
  copyFonts();
  const sessions = prepareSessions();
  const audio = prepareAudio();
  const data = {
    manifest: { sessions, narrationFixture: audio.fixtureNarration, musicFixture: audio.fixtureMusic },
    sweep: parseSweep(),
    apple: parseApple(),
    pbt: parsePbt(),
    briefs: parseBriefs(),
    hook: parseHook(),
    ci: parseCi(),
    kiroTree: kiroTree(),
    mcp: await mcpSnapshot(),
    kiro: kiroSummary(),
    install: parseInstall(),
    release: 'v0.1.x',
    repoUrl: 'github.com/iant4093/FrankenTTY',
  };
  writeFileSync(path.join(pub, 'data/data.json'), `${JSON.stringify(data, null, 1)}\n`);
  writeFileSync(path.join(pub, 'kiro-tree.json'), `${JSON.stringify(data.kiroTree, null, 1)}\n`);
  log(`wrote public/data/data.json (${Object.keys(sessions).length} sessions, narration ${audio.fixtureNarration ? 'FIXTURE' : 'real'}, music ${audio.fixtureMusic ? 'FIXTURE' : 'real'}, MCP ${data.mcp.live ? 'live' : 'fixture'})`);
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === import.meta.filename) {
  main().catch((err) => {
    console.error(`prebuild: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
