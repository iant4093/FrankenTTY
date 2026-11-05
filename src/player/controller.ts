// Player: owns the frame loop and timers (REQ-SYNC-02, REQ-TERM-02, REQ-GEO-02).
// Wires ingest -> renderer -> stdout. It holds no escape literals: sequences come from
// renderer/sequences.ts and the terminal helpers.

import { performance } from 'node:perf_hooks';
import { createDecoder } from '../ingest/decoder.ts';
import type { Decoder, DecoderEndInfo } from '../ingest/decoder.ts';
import type { MediaInfo } from '../ingest/media-info.ts';
import { downsampleHalfblock } from '../renderer/downsample.ts';
import { computeGeometry } from '../renderer/geometry.ts';
import type { Geometry } from '../renderer/geometry.ts';
import { createHalfblockSerializer } from '../renderer/halfblock.ts';
import type { HalfblockSerializer } from '../renderer/halfblock.ts';
import { CLEAR } from '../renderer/sequences.ts';
import { drawCentered } from '../term/screen.ts';
import type { Screen } from '../term/screen.ts';

export interface PlayerStdout {
  readonly columns: number;
  readonly rows: number;
  /** True after a write returned false and before 'drain'. */
  readonly writableNeedDrain: boolean;
  /** Bytes queued inside the stream. Optional: when present, a non-empty queue also skips a frame. */
  readonly writableLength?: number;
  write(data: Uint8Array | string): unknown;
  on(event: 'resize', listener: () => void): unknown;
  removeListener(event: 'resize', listener: () => void): unknown;
}

export interface PlayerStdin {
  on(event: 'data', listener: (chunk: Uint8Array | string) => void): unknown;
  removeListener(event: 'data', listener: (chunk: Uint8Array | string) => void): unknown;
  resume(): unknown;
}

export interface PlayerDeps {
  stdout: PlayerStdout;
  stdin: PlayerStdin;
  screen: Screen;
  mediaInfo: MediaInfo;
  /** ffmpeg input arguments, for example `['-i', path]` or `['-f', 'lavfi', '-i', filter]`. */
  inputArgs: string[];
  isFile: boolean;
  fps: number;
  /** Cell height / width. Clamped to [1, 3] before geometry is computed. */
  cellAspect: number;
  loop: boolean;
  /** Monotonic clock in milliseconds. Default: `performance.now`. */
  now?: () => number;
}

export interface PlayerCounters {
  /** Frames serialized and written. */
  framesRendered: number;
  /** Frames taken from the decoder but never shown (late, or skipped by backpressure). */
  framesDropped: number;
  /** Ticks where a frame was due but stdout could not take it. */
  ticksSkipped: number;
  /** Bytes passed to stdout.write for video frames. */
  bytesWritten: number;
}

export interface Player {
  /** Plays until the end, `q` (exit code 0), Ctrl+C (130) or a decode failure (1). */
  start(): Promise<number>;
  counters(): Readonly<PlayerCounters>;
  /** One-line reason when start() resolved with a decode failure, else null. */
  lastError(): string | null;
}

const KEY_Q = 0x71;
const KEY_CTRL_C = 0x03;
const RESIZE_DEBOUNCE_MS = 150;
const MIN_CELL_ASPECT = 1;
const MAX_CELL_ASPECT = 3;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

function lastLine(text: string): string {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '');
  return lines[lines.length - 1] ?? '';
}

export function createPlayer(deps: PlayerDeps): Player {
  const { stdout, stdin, screen, mediaInfo, inputArgs, isFile, fps, loop } = deps;
  const now = deps.now ?? ((): number => performance.now());
  const intervalMs = 1000 / fps;
  const cellAspect = Math.min(MAX_CELL_ASPECT, Math.max(MIN_CELL_ASPECT, deps.cellAspect));

  const counters: PlayerCounters = { framesRendered: 0, framesDropped: 0, ticksSkipped: 0, bytesWritten: 0 };
  let errorText: string | null = null;
  let started = false;

  return {
    counters: () => counters,
    lastError: () => errorText,

    start(): Promise<number> {
      if (started) return Promise.reject(new Error('player already started'));
      started = true;

      return new Promise<number>((resolve) => {
        let finished = false;
        // Every decoder whose child process may still be alive, for exit-path kills.
        const live = new Set<Decoder>();
        let decoder: Decoder | null = null;
        let generation = 0;
        // Position bookkeeping: position = baseSec + shown / fps.
        let baseSec = 0;
        let shown = 0;
        let anchor = 0;
        let tickIndex = 0;
        let ended = false;
        let endInfo: DecoderEndInfo | null = null;
        let tickTimer: ReturnType<typeof setTimeout> | null = null;
        let resizeTimer: ReturnType<typeof setTimeout> | null = null;

        let geometry: Geometry;
        let serializer: HalfblockSerializer | null = null;
        let halfblockPixels = new Uint8Array(0);

        const position = (): number => baseSec + shown / fps;

        const killAll = (): void => {
          for (const d of live) d.killNow();
        };

        const finish = (code: number): void => {
          if (finished) return;
          finished = true;
          if (tickTimer !== null) clearTimeout(tickTimer);
          if (resizeTimer !== null) clearTimeout(resizeTimer);
          tickTimer = null;
          resizeTimer = null;
          stdout.removeListener('resize', onResize);
          stdin.removeListener('data', onData);
          killAll();
          resolve(code);
        };

        const retire = (d: Decoder): void => {
          void d.stop().then(() => {
            live.delete(d);
          });
        };

        /** Recomputes geometry and per-geometry buffers from the current terminal size. */
        const layout = (): void => {
          const cols = stdout.columns > 0 ? Math.floor(stdout.columns) : DEFAULT_COLS;
          const rows = stdout.rows > 0 ? Math.floor(stdout.rows) : DEFAULT_ROWS;
          geometry = computeGeometry({
            srcWidth: mediaInfo.width,
            srcHeight: mediaInfo.height,
            cols,
            rows,
            cellAspect,
          });
          if (geometry.renderCols === 0 || geometry.renderRows === 0) {
            serializer = null;
            halfblockPixels = new Uint8Array(0);
          } else {
            serializer = createHalfblockSerializer(geometry.renderCols, geometry.renderRows);
            halfblockPixels = new Uint8Array(geometry.halfblockWidth * geometry.halfblockHeight * 3);
          }
        };

        const showTooSmall = (): void => {
          const cols = stdout.columns > 0 ? Math.floor(stdout.columns) : DEFAULT_COLS;
          const rows = stdout.rows > 0 ? Math.floor(stdout.rows) : DEFAULT_ROWS;
          drawCentered(stdout, ['terminal too small'], cols, rows);
        };

        const scheduleTick = (): void => {
          const delay = Math.max(0, Math.ceil(anchor + tickIndex * intervalMs - now()));
          tickTimer = setTimeout(tick, delay);
        };

        /** Starts a decoder at `startSec` with a new generation and re-anchors the clock. */
        const begin = (startSec: number): void => {
          generation++;
          baseSec = startSec;
          shown = 0;
          tickIndex = 0;
          ended = false;
          endInfo = null;
          const mine = createDecoder({
            inputArgs,
            width: geometry.decodeWidth,
            height: geometry.decodeHeight,
            fps,
            startSec,
            generation,
            isFile,
          });
          decoder = mine;
          live.add(mine);
          mine.onEnd((info) => {
            if (decoder !== mine) return;
            ended = true;
            endInfo = info;
          });
          anchor = now();
          scheduleTick();
        };

        const handleEndOfStream = (current: Decoder): void => {
          const info: DecoderEndInfo | null = endInfo;
          const decoded = current.stats().framesCompleted;
          if (info !== null && info.code !== 0 && decoded === 0) {
            const detail = lastLine(info.stderrTail);
            errorText = detail === '' ? `ffmpeg exited with code ${String(info.code)}` : `ffmpeg: ${detail}`;
            finish(1);
            return;
          }
          if (loop && decoded > 0) {
            retire(current);
            begin(0);
            return;
          }
          finish(0);
        };

        const render = (frame: Uint8Array): void => {
          if (serializer === null) return;
          downsampleHalfblock(frame, geometry.decodeWidth, geometry.decodeHeight, halfblockPixels);
          const bytes = serializer.serializeNaive(halfblockPixels, geometry.offsetX, geometry.offsetY);
          stdout.write(bytes);
          counters.framesRendered++;
          counters.bytesWritten += bytes.length;
        };

        function tick(): void {
          tickTimer = null;
          const current = decoder;
          if (finished || current === null) return;

          // Tick n shows at least frame n + 1; a late tick catches up to the wall clock.
          const due = Math.max(tickIndex + 1, Math.floor(((now() - anchor) * fps) / 1000) + 1);
          let last: Uint8Array | null = null;
          let taken = 0;
          let drained = false;
          while (shown < due) {
            const frame = current.takeOldest();
            if (frame === null) {
              drained = true;
              break;
            }
            last = frame;
            shown++;
            taken++;
          }

          if (last !== null) {
            // The serializer reuses one buffer, so never write while the stream still holds the last one.
            if (stdout.writableNeedDrain || (stdout.writableLength ?? 0) > 0) {
              counters.ticksSkipped++;
              counters.framesDropped += taken;
            } else {
              render(last);
              counters.framesDropped += taken - 1;
            }
          }

          if (drained && ended) {
            handleEndOfStream(current);
            return;
          }
          tickIndex++;
          scheduleTick();
        }

        const applyResize = (): void => {
          resizeTimer = null;
          if (finished) return;
          const resumeAt = position();
          if (tickTimer !== null) clearTimeout(tickTimer);
          tickTimer = null;
          if (decoder !== null) {
            retire(decoder);
            decoder = null;
          }
          stdout.write(CLEAR);
          layout();
          if (serializer === null) {
            baseSec = resumeAt;
            shown = 0;
            showTooSmall();
          } else {
            begin(resumeAt);
          }
        };

        function onResize(): void {
          if (finished) return;
          if (resizeTimer !== null) clearTimeout(resizeTimer);
          resizeTimer = setTimeout(applyResize, RESIZE_DEBOUNCE_MS);
        }

        function onData(chunk: Uint8Array | string): void {
          const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'latin1') : chunk;
          for (const b of bytes) {
            if (b === KEY_CTRL_C) {
              finish(130);
              return;
            }
            if (b === KEY_Q) {
              finish(0);
              return;
            }
          }
        }

        screen.addCleanup(killAll);
        stdout.on('resize', onResize);
        stdin.on('data', onData);
        stdin.resume();

        layout();
        if (serializer === null) showTooSmall();
        else begin(0);
      });
    },
  };
}
