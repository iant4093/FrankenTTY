// Renders the README screenshots from FrankenTTY's real output. Run: `node scripts/render-screenshots.ts`.
//
// For each shot: decode one frame with the real decoder from a lavfi demo, run it through the real
// render pipeline (120x35 terminal, HUD row hidden, so a 120x34 render area), replay the bytes into
// @xterm/headless, rasterize the emulator's cell buffer (8x16 px per cell), frame it like a terminal
// window, and write docs/screenshots/<name>.webp. Nothing is captured from a screen.

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import xterm from '@xterm/headless';
import { DEFAULT_THRESHOLD } from '../src/cli/args.ts';
import type { Mode, Palette } from '../src/cli/args.ts';
import { createDecoder } from '../src/ingest/decoder.ts';
import type { Decoder, DecoderEndInfo } from '../src/ingest/decoder.ts';
import { demoVideoInputArgs, getDemo } from '../src/ingest/demo.ts';
import type { DemoName } from '../src/ingest/demo.ts';
import { createPipeline } from '../src/player/pipeline.ts';
import { create256Mapper } from '../src/renderer/color-depth.ts';
import { computeGeometry } from '../src/renderer/geometry.ts';
import { AUTOWRAP_OFF } from '../src/renderer/sequences.ts';
import { encodePng } from './lib/png.ts';
import { CELL_H, CELL_W, createRaster, drawCell, frameWindow } from './lib/raster.ts';
import type { Raster } from './lib/raster.ts';

// @xterm/headless is CommonJS: take the class from the default export.
const { Terminal } = xterm;

const TERM_COLS = 120;
const TERM_ROWS = 35;
/** The bottom terminal row belongs to the HUD, which is hidden in screenshots. */
const HUD_ROWS = 1;
const FPS = 30;
const MAX_BYTES = 300 * 1024;
const DEFAULT_FG = 0xcccccc;
const DEFAULT_BG = 0x000000;
const DECODE_TIMEOUT_MS = 90_000;

interface Shot {
  name: string;
  demo: DemoName;
  atSec: number;
  mode: Mode;
  palette: Palette;
}

const SHOTS: readonly Shot[] = [
  { name: 'halfblock', demo: 'mandelbrot', atSec: 20, mode: 'halfblock', palette: 'truecolor' },
  { name: 'braille', demo: 'life', atSec: 8, mode: 'braille', palette: 'truecolor' },
  { name: 'ascii', demo: 'mandelbrot', atSec: 12, mode: 'ascii', palette: 'truecolor' },
  { name: 'amber', demo: 'mandelbrot', atSec: 40, mode: 'halfblock', palette: 'amber' },
];

/** Decodes the frame at `atSec` of a demo with the real decoder. Returns a copy of the RGB24 pixels. */
async function decodeFrame(demo: DemoName, atSec: number, width: number, height: number): Promise<Uint8Array> {
  const decoder: Decoder = createDecoder({
    inputArgs: demoVideoInputArgs(getDemo(demo)),
    width,
    height,
    fps: FPS,
    startSec: atSec,
    generation: 1,
    isFile: false,
  });
  const onExit = (): void => decoder.killNow();
  process.on('exit', onExit);
  const state: { end: DecoderEndInfo | null } = { end: null };
  decoder.onEnd((info) => {
    state.end = info;
  });
  try {
    const deadline = Date.now() + DECODE_TIMEOUT_MS;
    for (;;) {
      const frame = decoder.takeOldest();
      if (frame !== null) return Uint8Array.from(frame);
      if (state.end !== null) {
        throw new Error(`ffmpeg produced no frame for ${demo} at ${String(atSec)} s: ${state.end.stderrTail.trim()}`);
      }
      if (Date.now() > deadline) throw new Error(`timed out decoding ${demo} at ${String(atSec)} s`);
      await delay(20);
    }
  } finally {
    await decoder.stop();
    process.off('exit', onExit);
  }
}

function writeAndWait(term: InstanceType<typeof Terminal>, data: string | Uint8Array): Promise<void> {
  return new Promise<void>((resolve) => {
    if (typeof data === 'string') term.write(data, resolve);
    else term.write(data, resolve);
  });
}

/** Renders one shot into the emulator and returns its cell buffer as a raster. */
async function renderShot(shot: Shot): Promise<Raster> {
  const geometry = computeGeometry({
    srcWidth: getDemo(shot.demo).width,
    srcHeight: getDemo(shot.demo).height,
    cols: TERM_COLS,
    rows: TERM_ROWS,
    hudRows: HUD_ROWS,
  });
  const pixels = await decodeFrame(shot.demo, shot.atSec, geometry.decodeWidth, geometry.decodeHeight);

  const pipeline = createPipeline({
    cols: geometry.renderCols,
    rows: geometry.renderRows,
    offsetX: geometry.offsetX,
    offsetY: geometry.offsetY,
    mode: shot.mode,
    palette: shot.palette,
    depth: 24,
    threshold: DEFAULT_THRESHOLD,
  });
  const bytes = pipeline.render(pixels);

  const termRows = TERM_ROWS - HUD_ROWS;
  const term = new Terminal({ cols: TERM_COLS, rows: termRows, allowProposedApi: true });
  try {
    await writeAndWait(term, AUTOWRAP_OFF);
    await writeAndWait(term, bytes);

    const mapper = create256Mapper();
    const raster = createRaster(TERM_COLS * CELL_W, termRows * CELL_H, DEFAULT_BG);
    for (let y = 0; y < termRows; y++) {
      const line = term.buffer.active.getLine(y);
      if (line === undefined) continue;
      for (let x = 0; x < TERM_COLS; x++) {
        const cell = line.getCell(x);
        if (cell === undefined) continue;
        const chars = cell.getChars();
        const codePoint = chars === '' ? 0x20 : (chars.codePointAt(0) ?? 0x20);
        let fg = cell.isFgRGB() ? cell.getFgColor() : cell.isFgPalette() ? mapper.toRgb(cell.getFgColor()) : DEFAULT_FG;
        let bg = cell.isBgRGB() ? cell.getBgColor() : cell.isBgPalette() ? mapper.toRgb(cell.getBgColor()) : DEFAULT_BG;
        if (cell.isInverse() !== 0) [fg, bg] = [bg, fg];
        drawCell(raster, x, y, codePoint, fg, bg);
      }
    }
    return raster;
  } finally {
    term.dispose();
  }
}

/** True when this ffmpeg build has the libwebp encoder. */
function ffmpegHasLibwebp(): boolean {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' });
  return r.status === 0 && /\blibwebp\b/.test(r.stdout);
}

type WebpTool = 'ffmpeg' | 'cwebp';

function pickWebpTool(): WebpTool {
  if (ffmpegHasLibwebp()) return 'ffmpeg';
  const probe = spawnSync('cwebp', ['-version'], { encoding: 'utf8' });
  if (probe.error === undefined && probe.status === 0) return 'cwebp';
  throw new Error('no WebP encoder: need an ffmpeg built with libwebp, or cwebp (macOS: brew install webp)');
}

function encodeWebp(tool: WebpTool, pngPath: string, webpPath: string, quality: number): void {
  const q = String(quality);
  const r =
    tool === 'ffmpeg'
      ? spawnSync(
          'ffmpeg',
          ['-hide_banner', '-loglevel', 'error', '-y', '-i', pngPath, '-c:v', 'libwebp', '-lossless', '0', '-q:v', q, webpPath],
          { encoding: 'utf8' },
        )
      : spawnSync('cwebp', ['-quiet', '-q', q, '-m', '6', pngPath, '-o', webpPath], { encoding: 'utf8' });
  if (r.error !== undefined || r.status !== 0) {
    throw new Error(`${tool} failed (${String(r.status)}): ${r.error?.message ?? r.stderr.trim()}`);
  }
}

async function main(): Promise<void> {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const outDir = path.join(root, 'docs', 'screenshots');
  mkdirSync(outDir, { recursive: true });
  const tool = pickWebpTool();
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'frankentty-shots-'));
  let failed = false;
  try {
    for (const shot of SHOTS) {
      const framed = frameWindow(await renderShot(shot));
      const pngPath = path.join(tmp, `${shot.name}.png`);
      writeFileSync(pngPath, encodePng(framed.width, framed.height, framed.data));

      const webpPath = path.join(outDir, `${shot.name}.webp`);
      let quality = 90;
      let size = 0;
      for (;;) {
        encodeWebp(tool, pngPath, webpPath, quality);
        size = statSync(webpPath).size;
        if (size <= MAX_BYTES || quality <= 40) break;
        quality -= 5;
      }
      const kb = (size / 1024).toFixed(1);
      console.log(`${path.relative(root, webpPath)}: ${String(framed.width)}x${String(framed.height)}, q${String(quality)}, ${kb} KB`);
      if (size > MAX_BYTES) {
        console.error(`${shot.name}.webp is ${kb} KB, over the 300 KB limit even at q${String(quality)}`);
        failed = true;
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  if (failed) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
