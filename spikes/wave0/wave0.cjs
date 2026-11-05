'use strict';
// Wave 0 throwaway spike (S1 throughput, S4 capability probe, S7 SEA runtime).
// Not production code. Usage: wave0 [probe|fps|all] [--seconds N] [--out FILE]
// Writes a JSON result file and restores the terminal on every exit path.

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const args = process.argv.slice(2);
const cmd = args.find((a) => !a.startsWith('--')) || 'all';
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const SECONDS = Number(opt('seconds', '4'));
const KEY_SECONDS = Number(opt('key-seconds', '8'));

const out = process.stdout;
const inp = process.stdin;
const ESC = '\x1b';
const result = {
  spike: 'wave0',
  started: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  osRelease: os.release(),
  node: process.version,
  sea: (() => { try { return require('node:sea').isSea(); } catch { return false; } })(),
  env: Object.fromEntries(
    ['TERM', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'COLORTERM', 'WT_SESSION', 'WT_PROFILE_ID',
      'LANG', 'LC_ALL', 'LC_CTYPE', 'TMUX', 'ConEmuANSI', 'VSCODE_PID', 'SESSIONNAME']
      .map((k) => [k, process.env[k] ?? null]),
  ),
};

if (!out.isTTY || !inp.isTTY) {
  console.error('wave0: stdout and stdin must be a terminal.');
  process.exit(1);
}

result.isTTY = true;
result.size = { cols: out.columns, rows: out.rows };
result.colorDepth = out.getColorDepth();

// ---------- terminal lifecycle ----------
let restored = true;
function enter() {
  inp.setRawMode(true);
  inp.resume();
  out.write(`${ESC}[?1049h${ESC}[?25l${ESC}[?7l${ESC}[2J`);
  restored = false;
}
function restore() {
  if (restored) return;
  restored = true;
  try { out.write(`${ESC}[?2026l${ESC}[0m${ESC}[?7h${ESC}[?25h${ESC}[?1049l`); } catch {}
  try { inp.setRawMode(false); } catch {}
  inp.pause();
}
function finish(code) {
  restore();
  const file = opt('out', `wave0-${process.platform}-${(process.env.TERM_PROGRAM || (process.env.WT_SESSION ? 'WindowsTerminal' : 'unknown')).replace(/[^\w.-]/g, '_')}.json`);
  result.finished = new Date().toISOString();
  try {
    fs.writeFileSync(file, JSON.stringify(result, null, 2));
    console.log(`wave0: wrote ${path.resolve(file)}`);
  } catch (e) { console.error(`wave0: could not write ${file}: ${e.message}`); }
  console.log(JSON.stringify(summary(), null, 2));
  process.exit(code);
}
function summary() {
  return {
    term: result.env.TERM_PROGRAM || result.env.TERM,
    colorDepth: result.colorDepth,
    size: result.size,
    sync2026: result.probe?.sync2026 ?? null,
    cellPx: result.probe?.cellPx ?? null,
    keys: result.keys?.decoded ?? null,
    resizeEvents: result.keys?.resizeEvents ?? null,
    sweep: result.sweep?.map((r) => `${r.cols}x${r.rows} ${r.content} ${r.enc}: ${r.fps} fps, ${r.kbPerFrame} KB/f`) ?? null,
    fps: result.fps?.map((r) => ({ mode: r.mode, fps: r.fps, kbPerFrame: r.kbPerFrame, mbPerSec: r.mbPerSec, writeMsAvg: r.writeMsAvg })) ?? null,
  };
}
process.on('SIGINT', () => { result.exit = 'SIGINT'; finish(130); });
process.on('SIGTERM', () => { result.exit = 'SIGTERM'; finish(143); });
process.on('uncaughtException', (e) => { result.error = String(e && e.stack || e); finish(1); });

// ---------- input helper ----------
let inputBuf = '';
const inputWaiters = [];
inp.on('data', (d) => {
  const s = d.toString('latin1');
  if (s.includes('\x03') && !captureKeys) { result.exit = 'ctrl-c byte'; finish(130); return; }
  inputBuf += s;
  for (const w of inputWaiters.splice(0)) w();
});
let captureKeys = false;
const esc = (s) => s.replace(/[\x00-\x1f\x7f-\xff]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- S4 capability probe ----------
async function probe() {
  inputBuf = '';
  const t0 = performance.now();
  // DECRQM 2026, cell size (16t), window px (14t), then DA1 as a sentinel every terminal answers.
  out.write(`${ESC}[?2026$p${ESC}[16t${ESC}[14t${ESC}[c`);
  let daMs = null;
  const deadline = t0 + 1500;
  while (performance.now() < deadline) {
    if (/\x1b\[\?[\d;]*c/.test(inputBuf)) { daMs = +(performance.now() - t0).toFixed(1); break; }
    await new Promise((r) => { inputWaiters.push(r); setTimeout(r, 20); });
  }
  await sleep(50); // collect stragglers that arrive after DA1
  const raw = inputBuf;
  const m2026 = raw.match(/\x1b\[\?2026;(\d)\$y/);
  const m16 = raw.match(/\x1b\[6;(\d+);(\d+)t/);
  const m14 = raw.match(/\x1b\[4;(\d+);(\d+)t/);
  const sync = m2026 ? { 0: 'not recognized', 1: 'set', 2: 'reset (supported)', 3: 'permanently set', 4: 'permanently reset' }[m2026[1]] : 'no reply';
  result.probe = {
    raw: esc(raw),
    da1Ms: daMs,
    sync2026: sync,
    cellPx: m16 ? { h: +m16[1], w: +m16[2], aspect: +(m16[1] / m16[2]).toFixed(3) } : null,
    windowPx: m14 ? { h: +m14[1], w: +m14[2] } : null,
  };
  if (!m16 && m14) {
    const h = +m14[1] / out.rows, w = +m14[2] / out.columns;
    result.probe.cellPxDerived = { h: +h.toFixed(2), w: +w.toFixed(2), aspect: +(h / w).toFixed(3) };
  }
}

// ---------- glyph sample + key/resize capture ----------
async function keys() {
  const lines = [
    'FrankenTTY wave0 probe. Glyph check:',
    `  half-block 24-bit: ${ESC}[38;2;255;80;0m${ESC}[48;2;0;120;255m\u2580\u2580\u2580\u2580${ESC}[0m   256: ${ESC}[38;5;202m${ESC}[48;5;27m\u2580\u2580\u2580\u2580${ESC}[0m   16: ${ESC}[91m${ESC}[44m\u2580\u2580\u2580\u2580${ESC}[0m`,
    `  braille: \u28FF\u28B8\u2847\u2836\u281B\u28E4   ascii ramp: @%#*+=-:. `,
    '',
    `Press: Left, Right, Shift+Left, Shift+Right, Space, then q.  (auto-continues in ${KEY_SECONDS}s)`,
    'Resize the window now too, if you can.',
  ];
  out.write(`${ESC}[H${ESC}[2J` + lines.map((l, i) => `${ESC}[${i + 2};3H${l}`).join(''));
  inputBuf = '';
  captureKeys = true;
  const resizes = [];
  const onResize = () => resizes.push({ t: +performance.now().toFixed(0), cols: out.columns, rows: out.rows });
  out.on('resize', onResize);
  const end = performance.now() + KEY_SECONDS * 1000;
  while (performance.now() < end && !inputBuf.endsWith('q')) {
    await new Promise((r) => { inputWaiters.push(r); setTimeout(r, 50); });
  }
  out.off('resize', onResize);
  captureKeys = false;
  const raw = inputBuf;
  const table = [
    ['\x1b[1;2D', 'Shift+Left'], ['\x1b[1;2C', 'Shift+Right'], ['\x1b[D', 'Left'], ['\x1b[C', 'Right'],
    ['\x1bOD', 'Left(app)'], ['\x1bOC', 'Right(app)'], ['\x1b[2D', 'Shift+Left(old)'], ['\x1b[2C', 'Shift+Right(old)'],
    [' ', 'Space'], ['q', 'q'], ['\x03', 'Ctrl+C'],
  ];
  const decoded = [];
  let rest = raw;
  outer: while (rest.length) {
    for (const [seq, name] of table) if (rest.startsWith(seq)) { decoded.push(name); rest = rest.slice(seq.length); continue outer; }
    decoded.push(`?${esc(rest[0])}`); rest = rest.slice(1);
  }
  result.keys = { raw: esc(raw), decoded, resizeEvents: resizes, finalSize: { cols: out.columns, rows: out.rows } };
  result.size = { cols: out.columns, rows: out.rows };
}

// ---------- S1 throughput ----------
const DEC = Array.from({ length: 256 }, (_, i) => String(i));
function makeSynth(w, h) {
  const SIN = new Float32Array(1024);
  for (let i = 0; i < 1024; i++) SIN[i] = Math.sin((i / 1024) * Math.PI * 2);
  const s = (x) => SIN[((x * 162.97) | 0) & 1023];
  const pal = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    pal[i * 3] = (128 + 127 * Math.sin(i * 0.0245)) | 0;
    pal[i * 3 + 1] = (128 + 127 * Math.sin(i * 0.0245 + 2.1)) | 0;
    pal[i * 3 + 2] = (128 + 127 * Math.sin(i * 0.0245 + 4.2)) | 0;
  }
  const buf = new Uint8Array(w * h * 3);
  return (t) => {
    let o = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const v = s(x * 0.06 + t) + s(y * 0.09 + t * 1.3) + s((x + y) * 0.04 + t * 0.7);
        const k = (((v + 3) / 6) * 255) | 0;
        buf[o++] = pal[k * 3]; buf[o++] = pal[k * 3 + 1]; buf[o++] = pal[k * 3 + 2];
      }
    }
    return buf;
  };
}
function serialize(px, w, rowsCells, mode) {
  const parts = [`${ESC}[?2026h`];
  for (let r = 0; r < rowsCells; r++) {
    parts.push(`${ESC}[${r + 1};1H`);
    let pf = -1, pb = -1;
    const top = r * 2 * w * 3, bot = (r * 2 + 1) * w * 3;
    for (let x = 0; x < w; x++) {
      const a = top + x * 3, b = bot + x * 3;
      const f = (px[a] << 16) | (px[a + 1] << 8) | px[a + 2];
      const g = (px[b] << 16) | (px[b + 1] << 8) | px[b + 2];
      if (mode === 'naive') {
        parts.push(`${ESC}[38;2;${DEC[px[a]]};${DEC[px[a + 1]]};${DEC[px[a + 2]]}m${ESC}[48;2;${DEC[px[b]]};${DEC[px[b + 1]]};${DEC[px[b + 2]]}m\u2580`);
      } else {
        if (f === g) {
          if (g !== pb) { parts.push(`${ESC}[48;2;${DEC[px[b]]};${DEC[px[b + 1]]};${DEC[px[b + 2]]}m`); pb = g; }
          parts.push(' ');
        } else {
          if (f !== pf) { parts.push(`${ESC}[38;2;${DEC[px[a]]};${DEC[px[a + 1]]};${DEC[px[a + 2]]}m`); pf = f; }
          if (g !== pb) { parts.push(`${ESC}[48;2;${DEC[px[b]]};${DEC[px[b + 1]]};${DEC[px[b + 2]]}m`); pb = g; }
          parts.push('\u2580');
        }
      }
    }
  }
  parts.push(`${ESC}[0m${ESC}[?2026l`);
  return Buffer.from(parts.join(''), 'utf8');
}
const writeAsync = (buf) => new Promise((r) => out.write(buf, r));
async function fps() {
  result.fps = [];
  for (const mode of ['naive', 'rle']) {
    const w = out.columns, rowsCells = out.rows - 1, h = rowsCells * 2;
    const synth = makeSynth(w, h);
    let frames = 0, bytes = 0, serMs = 0, writeMs = 0, maxWrite = 0;
    const t0 = performance.now();
    while (performance.now() - t0 < SECONDS * 1000) {
      const s0 = performance.now();
      const px = synth(frames * 0.08);
      const buf = serialize(px, w, rowsCells, mode);
      const s1 = performance.now();
      await writeAsync(buf);
      const s2 = performance.now();
      serMs += s1 - s0; writeMs += s2 - s1; maxWrite = Math.max(maxWrite, s2 - s1);
      bytes += buf.length; frames++;
      if (frames % 2 === 0) await new Promise(setImmediate); // let input/signals through
    }
    const secs = (performance.now() - t0) / 1000;
    result.fps.push({
      mode, cols: w, rowsCells, seconds: +secs.toFixed(2), frames,
      fps: +(frames / secs).toFixed(1),
      kbPerFrame: +(bytes / frames / 1024).toFixed(1),
      mbPerSec: +(bytes / secs / 1048576).toFixed(2),
      serializeMsAvg: +(serMs / frames).toFixed(2),
      writeMsAvg: +(writeMs / frames).toFixed(2),
      writeMsMax: +maxWrite.toFixed(1),
    });
  }
}

// ---------- S1b sweep: size x color encoding x content ----------
function makeBars(w, h) {
  const buf = new Uint8Array(w * h * 3);
  const cols = [[235, 235, 235], [235, 235, 16], [16, 235, 235], [16, 235, 16], [235, 16, 235], [235, 16, 16], [16, 16, 235], [16, 16, 16]];
  return (t) => {
    let o = 0;
    const shift = (t * 10) | 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let c = cols[(((x * 8) / w) | 0) % 8];
        if (y > h * 0.7) c = (((x + shift) >> 2) & 1) ? cols[0] : cols[7]; // moving checker strip
        buf[o++] = c[0]; buf[o++] = c[1]; buf[o++] = c[2];
      }
    }
    return buf;
  };
}
const cube = (v) => (v < 48 ? 0 : v < 115 ? 1 : ((v - 35) / 40) | 0);
function serializeEnc(px, w, rowsCells, enc) {
  const parts = [`${ESC}[?2026h`];
  const q = enc === 'rle24q' ? 0xf0 : 0xff; // 4-bit-per-channel quantize as a cheap stand-in for a ΔE threshold
  for (let r = 0; r < rowsCells; r++) {
    parts.push(`${ESC}[${r + 1};1H`);
    let pf = -1, pb = -1;
    const top = r * 2 * w * 3, bot = (r * 2 + 1) * w * 3;
    for (let x = 0; x < w; x++) {
      const a = top + x * 3, b = bot + x * 3;
      let f, g, fs, gs;
      if (enc === 'rle256') {
        f = 16 + 36 * cube(px[a]) + 6 * cube(px[a + 1]) + cube(px[a + 2]);
        g = 16 + 36 * cube(px[b]) + 6 * cube(px[b + 1]) + cube(px[b + 2]);
        fs = () => `${ESC}[38;5;${f}m`; gs = () => `${ESC}[48;5;${g}m`;
      } else {
        const fr = px[a] & q, fg = px[a + 1] & q, fb = px[a + 2] & q, br = px[b] & q, bg = px[b + 1] & q, bb = px[b + 2] & q;
        f = (fr << 16) | (fg << 8) | fb; g = (br << 16) | (bg << 8) | bb;
        fs = () => `${ESC}[38;2;${DEC[fr]};${DEC[fg]};${DEC[fb]}m`; gs = () => `${ESC}[48;2;${DEC[br]};${DEC[bg]};${DEC[bb]}m`;
      }
      if (f === g) { if (g !== pb) { parts.push(gs()); pb = g; } parts.push(' '); }
      else { if (f !== pf) { parts.push(fs()); pf = f; } if (g !== pb) { parts.push(gs()); pb = g; } parts.push('\u2580'); }
    }
  }
  parts.push(`${ESC}[0m${ESC}[?2026l`);
  return Buffer.from(parts.join(''), 'utf8');
}
async function sweep() {
  result.sweep = [];
  const per = Number(opt('per', '1.5'));
  const maxC = out.columns, maxR = out.rows - 1;
  const sizes = [[80, 23], [120, 35], [maxC, maxR]].filter(([c, r]) => c <= maxC && r <= maxR);
  for (const [c, r] of sizes) for (const content of ['plasma', 'bars']) for (const enc of ['rle24', 'rle24q', 'rle256']) {
    out.write(`${ESC}[0m${ESC}[2J`);
    const synth = content === 'plasma' ? makeSynth(c, r * 2) : makeBars(c, r * 2);
    let frames = 0, bytes = 0;
    const t0 = performance.now();
    while (performance.now() - t0 < per * 1000) {
      const buf = serializeEnc(synth(frames * 0.08), c, r, enc);
      await writeAsync(buf);
      bytes += buf.length; frames++;
      await new Promise(setImmediate);
    }
    const secs = (performance.now() - t0) / 1000;
    result.sweep.push({ cols: c, rows: r, content, enc, fps: +(frames / secs).toFixed(1), kbPerFrame: +(bytes / frames / 1024).toFixed(1), mbPerSec: +(bytes / secs / 1048576).toFixed(2) });
  }
}

(async () => {
  enter();
  if (cmd === 'sweep') { await sweep(); result.exit = 'normal'; finish(0); return; }
  if (cmd === 'probe' || cmd === 'all') { await probe(); await keys(); }
  if (cmd === 'fps' || cmd === 'all') await fps();
  result.exit = 'normal';
  finish(0);
})();
