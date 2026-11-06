// Player: owns the frame loop and timers (REQ-SYNC-01..05, REQ-UI-01, REQ-HUD-01, REQ-PERF-01,
// REQ-TERM-02, REQ-GEO-02). Wires ingest -> renderer -> stdout, audio, the presentation clock,
// the key router, the HUD and the quality governor. It holds no escape literals: sequences come
// from renderer/sequences.ts and the terminal helpers.
//
// Timeline model. One Clock gives the media position. Each decoder starts at the clock position
// at the time it was created (`decoderStartSec`), so the frame that is due is
// `floor((clock.position() - decoderStartSec) * fps) + 1` of the current decoder. A tick takes
// every frame up to that index and renders the newest one (late frames are dropped).
// Ticks fire at the clock's frame boundaries. While paused no tick runs, so the decoder pipe
// backs up and ffmpeg waits.
//
// Audio is the master clock when present: `audio.positionSec()` (PCM written to the long-lived
// ffplay, minus what is queued, minus output latency). Start and seek go through a barrier: the
// last frame stays on screen, a new decoder and audio source start, and the clock does not run
// until the decoder has delivered its first frame and the audio source its first PCM (3 s at most).
// Then both start together and that first frame is shown, so no frame is late and dropped.
//
// The screen model is never invalidated by a seek or a mode, palette, threshold or depth change: the
// terminal shows the same thing, and a full-screen repaint is visible on terminals without
// synchronized updates (Apple Terminal). A rolling refresh rewrites a few rows per frame instead.

import { performance } from 'node:perf_hooks';
import { createClock } from '../audio/clock.ts';
import type { AudioPlayer } from '../audio/player.ts';
import { createDecoder } from '../ingest/decoder.ts';
import type { Decoder, DecoderEndInfo } from '../ingest/decoder.ts';
import type { MediaInfo } from '../ingest/media-info.ts';
import { DEFAULT_THRESHOLD, PALETTES } from '../cli/args.ts';
import type { Mode, Palette, Quality } from '../cli/args.ts';
import type { ColorDepth } from '../renderer/cells.ts';
import { computeGeometry } from '../renderer/geometry.ts';
import type { Geometry } from '../renderer/geometry.ts';
import { createGovernor } from '../renderer/governor.ts';
import type { Governor, QualitySettings } from '../renderer/governor.ts';
import { CLEAR, SGR_RESET_BYTES, SYNC_END_BYTES, writeBytes } from '../renderer/sequences.ts';
import { drawCentered } from '../term/screen.ts';
import type { Screen } from '../term/screen.ts';
import { createHud } from '../tui/hud.ts';
import type { Hud, HudState } from '../tui/hud.ts';
import { createKeyRouter } from '../tui/input.ts';
import type { KeyEvent, KeyRouter } from '../tui/input.ts';
import { createPipeline, effectiveMode } from './pipeline.ts';
import type { Pipeline } from './pipeline.ts';

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
  /** Cell builder. Default `halfblock`. Capability gates (REQ-CAP-03) are applied by the caller. */
  mode?: Mode;
  /** Default `truecolor`. */
  palette?: Palette;
  /** Output color depth. Default 24. */
  depth?: ColorDepth;
  /** Color merge threshold 0..100. Default `DEFAULT_THRESHOLD`. */
  threshold?: number;
  /** Monotonic clock in milliseconds. Default: `performance.now`. The audio player must use the same one. */
  now?: () => number;
  /** Audio output, or null/absent for silent playback (wall-clock pacing). */
  audio?: AudioPlayer | null;
  /** `--av-offset` in milliseconds, added to the video position. Default 0. */
  avOffsetMs?: number;
  /** Adaptive quality (REQ-PERF-01). Default `auto`. */
  quality?: Quality;
  /** Whether the HUD starts visible. Default true. */
  hudVisible?: boolean;
  /** UTF-8 locale available (REQ-CAP-03). Default true. Gates the mode cycle. */
  unicode?: boolean;
  /** Braille allowed (REQ-CAP-03). Default true. Gates the mode cycle. */
  braille?: boolean;
  /** Bytes read from stdin before playback started (for example `probe.passthrough`); handled as keys first. */
  initialInput?: Uint8Array;
  /**
   * Chooses the media inputs for the next segment. Called every time a video decoder starts (start,
   * seek, loop, resize, cell-cap change, paused repaint). The video decoder uses `videoArgs`; when the
   * audio source starts in the same segment (start, seek, loop) it uses `audioArgs` from the SAME call,
   * so one segment never mixes inputs. A resize or cell-cap change restarts only the video: the audio
   * source keeps running. When absent, `inputArgs` is used for video and the audio player keeps the
   * arguments it was created with.
   */
  resolveInput?: () => { videoArgs: string[]; audioArgs: string[] };
  /** Text appended to the HUD message of each seek (for example "preparing seek cache..."), or null for none. */
  seekNotice?: () => string | null;
}

export interface PlayerCounters {
  /** Frames encoded and written (non-empty output). */
  framesRendered: number;
  /** Frames encoded to an empty buffer because nothing on screen changed. Nothing was written. */
  framesUnchanged: number;
  /** Frames taken from the decoder but never shown (late, or skipped by backpressure). */
  framesDropped: number;
  /** Ticks where a frame was due but stdout could not take it. */
  ticksSkipped: number;
  /** Bytes passed to stdout.write for video frames (the HUD is not counted). */
  bytesWritten: number;
  /** Decoders started: the first one, plus one per seek, resize, loop and cell-cap change. */
  decoderStarts: number;
}

export interface PlayerState {
  paused: boolean;
  /** Media position in seconds (frozen while paused). */
  positionSec: number;
  mode: Mode;
  palette: Palette;
  hudVisible: boolean;
  /** Governor level, 0 = full quality. */
  qualityLevel: number;
  depth: ColorDepth;
  threshold: number;
  /** Active render-cell cap, or null. */
  maxCells: number | null;
  /** Current HUD message, or null. */
  message: string | null;
}

export interface Player {
  /** Plays until the end, `q` (exit code 0), Ctrl+C (130) or a decode failure (1). */
  start(): Promise<number>;
  counters(): Readonly<PlayerCounters>;
  state(): PlayerState;
  /** One-line reason when start() resolved with a decode failure, else null. */
  lastError(): string | null;
  /** Shows `text` in the HUD message slot for `ms` (default 1 s). Does nothing before start() or after the player ended. */
  showMessage(text: string, ms?: number): void;
}

const RESIZE_DEBOUNCE_MS = 150;
const MIN_CELL_ASPECT = 1;
const MAX_CELL_ASPECT = 3;
/** The seek barrier gives up waiting for the first frame and the first PCM after this long. */
const BARRIER_MAX_MS = 3000;
const BARRIER_POLL_MS = 5;
/** The governor ignores frame timings during the barrier and for this long after it. */
const GOVERNOR_MUTE_MS = 500;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
/** Seek keys pressed within this time of each other are applied as one seek (REQ-SYNC-05). */
const SEEK_COALESCE_MS = 120;
/** A seek never lands closer than this to the end of a source with a known duration. */
const SEEK_END_MARGIN_SEC = 0.5;
/** HUD messages (seek, mode, palette) stay this long. */
const MESSAGE_MS = 1000;
/** The HUD is redrawn at least this often while visible: at most 4 times per second. */
const HUD_INTERVAL_MS = 250;
const HUD_RETRY_MS = 30;
const STATS_WINDOW_MS = 1000;
/** Capacity of the telemetry ring: more than 60 fps for one window, with slack. */
const STATS_CAPACITY = 256;
/** A tick that found no frame polls again this soon, so a new decoder's first frame is not delayed a whole interval. */
const STARVED_POLL_MS = 10;
const PAUSED_POLL_MS = 10;

const MODE_ORDER: readonly Mode[] = ['halfblock', 'ascii', 'braille'];

function lastLine(text: string): string {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '');
  return lines[lines.length - 1] ?? '';
}

/** `m:ss`, or `h:mm:ss` from one hour. */
export function formatClock(sec: number): string {
  const total = Math.max(0, Math.floor(Number.isFinite(sec) ? sec : 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = s < 10 ? `0${String(s)}` : String(s);
  if (h > 0) return `${String(h)}:${m < 10 ? '0' : ''}${String(m)}:${ss}`;
  return `${String(m)}:${ss}`;
}

function depthLabel(depth: ColorDepth): HudState['colorLabel'] {
  if (depth === 24) return '24-bit';
  return depth === 8 ? '256' : '16';
}

export function createPlayer(deps: PlayerDeps): Player {
  const { stdout, stdin, screen, mediaInfo, inputArgs, isFile, fps, loop } = deps;
  const now = deps.now ?? ((): number => performance.now());
  const audio = deps.audio ?? null;
  const avOffsetMs = deps.avOffsetMs ?? 0;
  const offsetSec = avOffsetMs / 1000;
  const cellAspect = Math.min(MAX_CELL_ASPECT, Math.max(MIN_CELL_ASPECT, deps.cellAspect));
  const baseDepth = deps.depth ?? 24;
  const baseThreshold = deps.threshold ?? DEFAULT_THRESHOLD;
  const qualityEnabled = (deps.quality ?? 'auto') === 'auto';
  const unicode = deps.unicode ?? true;
  const brailleAllowed = deps.braille ?? true;

  const counters: PlayerCounters = {
    framesRendered: 0,
    framesUnchanged: 0,
    framesDropped: 0,
    ticksSkipped: 0,
    bytesWritten: 0,
    decoderStarts: 0,
  };
  let errorText: string | null = null;
  let started = false;
  /** Set by start(): shows a HUD message. Null before start() and after the player ended. */
  let notify: ((text: string, ms: number) => void) | null = null;

  // State shared between start() and the accessors below.
  let mode: Mode = deps.mode ?? 'halfblock';
  let palette: Palette = deps.palette ?? 'truecolor';
  let hudVisible = deps.hudVisible ?? true;
  let paused = false;
  let message: string | null = null;
  let curDepth: ColorDepth = baseDepth;
  let curThreshold = baseThreshold;
  let curMaxCells: number | null = null;
  let governor: Governor | null = null;
  const clock = createClock({
    now,
    offsetMs: avOffsetMs,
    ...(audio === null ? {} : { source: (): number => audio.positionSec() }),
  });
  /** False once audio failed: the wall clock takes over from the last audio position. */
  let audioUsable = audio !== null;

  /** Media position (audio time): the clock position without the A/V offset. */
  const mediaPos = (): number => Math.max(0, clock.position() - offsetSec);

  return {
    counters: () => counters,
    lastError: () => errorText,
    showMessage: (text, ms = MESSAGE_MS) => {
      notify?.(text, ms);
    },
    state: () => ({
      paused,
      positionSec: mediaPos(),
      mode,
      palette,
      hudVisible,
      qualityLevel: governor?.level() ?? 0,
      depth: curDepth,
      threshold: curThreshold,
      maxCells: curMaxCells,
      message,
    }),

    start(): Promise<number> {
      if (started) return Promise.reject(new Error('player already started'));
      started = true;

      return new Promise<number>((resolve) => {
        let finished = false;
        // Every decoder whose child process may still be alive, for exit-path kills.
        const live = new Set<Decoder>();
        let decoder: Decoder | null = null;
        let generation = 0;
        /** Clock position at which the current decoder's first frame is due. */
        let decoderStartSec = 0;
        /** Frames taken from the current decoder. */
        let shown = 0;
        let ended = false;
        let endInfo: DecoderEndInfo | null = null;

        let tickTimer: ReturnType<typeof setTimeout> | null = null;
        let resizeTimer: ReturnType<typeof setTimeout> | null = null;
        let seekTimer: ReturnType<typeof setTimeout> | null = null;
        let messageTimer: ReturnType<typeof setTimeout> | null = null;
        let pausedTimer: ReturnType<typeof setTimeout> | null = null;
        let hudRetryTimer: ReturnType<typeof setTimeout> | null = null;
        let seekAccum = 0;

        let geometry: Geometry;
        let pipeline: Pipeline | null = null;
        /** Set while the clock waits for the first frame (and PCM) of a new position. */
        let barrier: { since: number; frame: Uint8Array | null } | null = null;
        let governorMuteUntil = -Infinity;
        let termCols = DEFAULT_COLS;
        let termRows = DEFAULT_ROWS;

        // HUD: one state object and one output buffer per geometry.
        let hud: Hud = createHud(termCols);
        let hudOut: Buffer = Buffer.allocUnsafe(hud.capacity);
        let hudDirty = hudVisible;
        let lastHudAt = -Infinity;
        const hudState: HudState = {
          visible: hudVisible,
          playing: true,
          positionSec: 0,
          durationSec: mediaInfo.durationSec,
          fps: 0,
          kbPerSec: 0,
          sgrSavedPct: 0,
          qualityStep: 0,
          colorLabel: depthLabel(curDepth),
          mode,
          palette,
          message: null,
        };

        // Telemetry ring (REQ-HUD-01): one sample per presented frame, newest overwrites oldest.
        const statTime = new Float64Array(STATS_CAPACITY);
        const statBytes = new Float64Array(STATS_CAPACITY);
        const statSgr = new Float64Array(STATS_CAPACITY);
        const statNaive = new Float64Array(STATS_CAPACITY);
        let statHead = 0;
        let statCount = 0;

        /** The audio player while it is usable, else null. */
        const liveAudio = (): AudioPlayer | null => (audioUsable ? audio : null);

        /** Frame timings feed the governor only outside the barrier and its 500 ms aftermath. */
        const govRecord = (ms: number, t: number): void => {
          if (barrier === null && t >= governorMuteUntil) governor?.record(ms, t);
        };
        const govSkip = (t: number): void => {
          if (barrier === null && t >= governorMuteUntil) governor?.recordSkip(t);
        };

        const killAll = (): void => {
          for (const d of live) d.killNow();
          audio?.killNow();
        };

        const clearTimer = (t: ReturnType<typeof setTimeout> | null): null => {
          if (t !== null) clearTimeout(t);
          return null;
        };

        const finish = (code: number): void => {
          if (finished) return;
          finished = true;
          tickTimer = clearTimer(tickTimer);
          resizeTimer = clearTimer(resizeTimer);
          seekTimer = clearTimer(seekTimer);
          messageTimer = clearTimer(messageTimer);
          pausedTimer = clearTimer(pausedTimer);
          hudRetryTimer = clearTimer(hudRetryTimer);
          notify = null;
          router.dispose();
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

        const isBusy = (): boolean => stdout.writableNeedDrain || (stdout.writableLength ?? 0) > 0;

        // ---- HUD ----------------------------------------------------------------------------

        const pushStat = (t: number, bytes: number, sgr: number, naive: number): void => {
          statTime[statHead] = t;
          statBytes[statHead] = bytes;
          statSgr[statHead] = sgr;
          statNaive[statHead] = naive;
          statHead = (statHead + 1) % STATS_CAPACITY;
          if (statCount < STATS_CAPACITY) statCount++;
        };

        /** Fills hudState from the state and the last second of telemetry. */
        const refreshHudState = (t: number): void => {
          const cutoff = t - STATS_WINDOW_MS;
          let frames = 0;
          let bytes = 0;
          let sgr = 0;
          let naive = 0;
          for (let i = 0; i < statCount; i++) {
            const slot = (statHead - 1 - i + STATS_CAPACITY) % STATS_CAPACITY;
            if ((statTime[slot] as number) <= cutoff) break;
            frames++;
            bytes += statBytes[slot] as number;
            sgr += statSgr[slot] as number;
            naive += statNaive[slot] as number;
          }
          hudState.visible = hudVisible;
          hudState.playing = !paused;
          hudState.positionSec = mediaPos();
          hudState.fps = frames;
          hudState.kbPerSec = bytes / 1024;
          hudState.sgrSavedPct = naive > 0 ? Math.max(0, Math.min(100, (1 - sgr / naive) * 100)) : 0;
          hudState.qualityStep = governor?.level() ?? 0;
          hudState.colorLabel = depthLabel(curDepth);
          hudState.mode = mode;
          hudState.palette = palette;
          hudState.message = message;
        };

        const hudDue = (t: number): boolean => (hudVisible ? hudDirty || t - lastHudAt >= HUD_INTERVAL_MS : hudDirty);

        const touchHud = (): void => {
          if (hudVisible) hudDirty = true;
        };

        /** Writes the HUD row on its own (key presses, pause). Retries shortly when stdout is busy. */
        const flushHud = (): void => {
          if (finished || pipeline === null) return;
          hudRetryTimer = clearTimer(hudRetryTimer);
          if (isBusy()) {
            hudRetryTimer = setTimeout(flushHud, HUD_RETRY_MS);
            return;
          }
          const t = now();
          refreshHudState(t);
          const end = hud.render(hudState, hudOut, 0, termRows);
          stdout.write(hudOut.subarray(0, end));
          hudDirty = false;
          lastHudAt = t;
        };

        const setMessage = (text: string, ms: number = MESSAGE_MS): void => {
          message = text;
          messageTimer = clearTimer(messageTimer);
          messageTimer = setTimeout(() => {
            messageTimer = null;
            message = null;
            touchHud();
            if (paused) flushHud();
          }, ms);
          touchHud();
          if (paused) flushHud();
        };

        // ---- Geometry and quality -----------------------------------------------------------

        const onQualityChange = (settings: QualitySettings): void => {
          if (pipeline === null) return;
          curThreshold = settings.threshold;
          pipeline.setThreshold(settings.threshold);
          if (settings.depth !== curDepth) {
            curDepth = settings.depth;
            pipeline.setDepth(settings.depth);
          }
          touchHud();
          if (settings.maxCells !== curMaxCells) {
            curMaxCells = settings.maxCells;
            restartDecoder(false);
          }
        };

        /**
         * Recomputes geometry and per-geometry buffers from the current terminal size.
         * `freshQuality` also starts a new governor at full quality (terminal resize); a cell-cap
         * change keeps the running one.
         */
        const layout = (freshQuality: boolean): void => {
          termCols = stdout.columns > 0 ? Math.floor(stdout.columns) : DEFAULT_COLS;
          termRows = stdout.rows > 0 ? Math.floor(stdout.rows) : DEFAULT_ROWS;
          const base = {
            srcWidth: mediaInfo.width,
            srcHeight: mediaInfo.height,
            cols: termCols,
            rows: termRows,
            cellAspect,
          };
          const uncapped = computeGeometry(base);
          if (freshQuality) {
            curThreshold = baseThreshold;
            curDepth = baseDepth;
            curMaxCells = null;
            governor = createGovernor({
              fps,
              baseThreshold,
              baseDepth,
              baseCells: uncapped.renderCols * uncapped.renderRows,
              enabled: qualityEnabled,
            });
            governor.onChange(onQualityChange);
          }
          geometry = curMaxCells === null ? uncapped : computeGeometry({ ...base, maxCells: curMaxCells });
          hud = createHud(termCols);
          hudOut = Buffer.allocUnsafe(hud.capacity);
          if (geometry.renderCols === 0 || geometry.renderRows === 0) {
            pipeline = null;
          } else {
            // A new geometry gets a new pipeline: empty screen model, so the first frame is a full redraw.
            pipeline = createPipeline({
              cols: geometry.renderCols,
              rows: geometry.renderRows,
              offsetX: geometry.offsetX,
              offsetY: geometry.offsetY,
              mode,
              palette,
              depth: curDepth,
              threshold: curThreshold,
            });
            composite = Buffer.allocUnsafe(pipeline.outputCapacity + hud.capacity + SYNC_END_BYTES.length);
          }
          hudDirty = hudVisible;
        };
        // One frame plus the HUD row, so a tick that shows both still makes one write.
        let composite: Buffer = Buffer.allocUnsafe(0);

        const showTooSmall = (): void => {
          drawCentered(stdout, ['terminal too small'], termCols, termRows);
        };

        // ---- Decoder, ticks ------------------------------------------------------------------

        const scheduleTick = (delayMs: number): void => {
          tickTimer = clearTimer(tickTimer);
          tickTimer = setTimeout(tick, delayMs);
        };

        /** Milliseconds until the clock reaches the next frame boundary of the current decoder. */
        const delayToNextBoundary = (): number => {
          const elapsed = clock.position() - decoderStartSec;
          const next = (Math.floor(elapsed * fps) + 1) / fps;
          return Math.max(1, Math.ceil((next - elapsed) * 1000));
        };

        /** One resolution of the media inputs; see `PlayerDeps.resolveInput`. `audio` is undefined without a resolver. */
        const resolveSegment = (): { video: string[]; audio: string[] | undefined } => {
          const r = deps.resolveInput?.();
          return r === undefined ? { video: inputArgs, audio: undefined } : { video: r.videoArgs, audio: r.audioArgs };
        };

        /** Starts a decoder at `startSec` with a new generation. Needs a pipeline. */
        const startDecoder = (startSec: number, videoArgs: string[]): void => {
          generation++;
          counters.decoderStarts++;
          decoderStartSec = startSec;
          shown = 0;
          ended = false;
          endInfo = null;
          const mine = createDecoder({
            inputArgs: videoArgs,
            width: geometry.decodeWidth,
            height: geometry.decodeHeight,
            fps,
            startSec: Math.max(0, startSec),
            generation,
            isFile,
          });
          decoder = mine;
          if (barrier !== null) barrier.frame = null; // a held frame belongs to the previous decoder
          live.add(mine);
          mine.onEnd((info) => {
            if (decoder !== mine) return;
            ended = true;
            endInfo = info;
          });
          if (paused) {
            pausedTimer = clearTimer(pausedTimer);
            pausedTimer = setTimeout(pollPausedFrame, 0);
          } else {
            scheduleTick(0);
          }
        };

        const stopDecoding = (): void => {
          tickTimer = clearTimer(tickTimer);
          pausedTimer = clearTimer(pausedTimer);
          if (decoder !== null) {
            retire(decoder);
            decoder = null;
          }
        };

        /**
         * Restarts the decoder at the current clock position with a fresh layout: clears the screen and
         * rebuilds the geometry. Audio keeps playing. A terminal resize also resets the governor; a
         * cell-cap change keeps it.
         */
        function restartDecoder(freshQuality: boolean): void {
          const at = clock.position();
          stopDecoding();
          stdout.write(CLEAR);
          layout(freshQuality);
          if (pipeline === null) showTooSmall();
          else startDecoder(at, resolveSegment().video);
        }

        /**
         * Moves the whole timeline: audio source, clock and decoder. The screen keeps its last frame.
         * The clock holds at the target and, while playing, the barrier releases it (see `barrierStep`).
         */
        const seekTo = (targetSec: number): void => {
          stopDecoding();
          const segment = resolveSegment(); // one call: video and audio of this segment agree
          liveAudio()?.seek(targetSec, segment.audio);
          clock.pause();
          clock.seek(targetSec);
          if (!paused && pipeline !== null) barrier = { since: now(), frame: null };
          if (pipeline !== null) startDecoder(clock.position(), segment.video);
        };

        /** While paused: decode one frame at the current position and show it. */
        const repaintPaused = (): void => {
          if (pipeline === null) return;
          stopDecoding();
          startDecoder(clock.position(), resolveSegment().video);
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
            seekTo(0); // restarts video and audio together
            return;
          }
          finish(0);
        };

        /**
         * Renders one frame and writes it, with the HUD row appended when it is due, in a single
         * write. A frame that changed nothing is not written, but a due HUD still is.
         */
        const presentFrame = (frame: Uint8Array): void => {
          const pl = pipeline;
          if (pl === null) return;
          const t = now();
          pl.refreshRolling();
          const bytes = pl.render(frame);
          const st = pl.stats;
          pushStat(t, bytes.length, st.sgrEmitted, st.naiveSgr);

          const withHud = hudDue(t);
          if (bytes.length === 0 && !withHud) {
            counters.framesUnchanged++;
            govRecord(st.renderMs, t);
            return;
          }

          let out: Uint8Array;
          if (withHud) {
            refreshHudState(t);
            let p = 0;
            if (bytes.length > 0) {
              // Keep the HUD inside the synchronized update: frame body, HUD row, then the closing bytes.
              p = bytes.length - SGR_RESET_BYTES.length - SYNC_END_BYTES.length;
              composite.set(bytes.subarray(0, p), 0);
            }
            p = hud.render(hudState, composite, p, termRows);
            if (bytes.length > 0) p = writeBytes(composite, p, SYNC_END_BYTES);
            out = composite.subarray(0, p);
          } else {
            out = bytes;
          }

          const w0 = now();
          stdout.write(out);
          const w1 = now();
          if (withHud) {
            hudDirty = false;
            lastHudAt = t;
          }
          if (bytes.length > 0) {
            counters.framesRendered++;
            counters.bytesWritten += bytes.length;
          } else {
            counters.framesUnchanged++;
          }
          govRecord(st.renderMs + (w1 - w0), w1);
        };

        function tick(): void {
          tickTimer = null;
          const current = decoder;
          if (finished || paused || current === null) return;

          if (barrier !== null) {
            barrierStep(current);
            return;
          }

          const t = now();
          const elapsed = clock.position() - decoderStartSec;
          const due = Math.max(1, Math.floor(elapsed * fps) + 1);
          let last: Uint8Array | null = null;
          let taken = 0;
          let starved = false;
          while (shown < due) {
            const frame = current.takeOldest();
            if (frame === null) {
              starved = true;
              break;
            }
            last = frame;
            shown++;
            taken++;
          }

          if (last !== null) {
            // The encoder reuses one buffer, so never write while the stream still holds the last one.
            if (isBusy()) {
              counters.ticksSkipped++;
              counters.framesDropped += taken;
              govSkip(t);
            } else {
              counters.framesDropped += taken - 1;
              presentFrame(last);
            }
          } else if (!isBusy() && hudDue(t)) {
            flushHud();
          }

          // A governor step may have replaced the decoder (and scheduled its first tick).
          if (finished || decoder !== current) return;

          if (starved && ended) {
            handleEndOfStream(current);
            return;
          }
          scheduleTick(starved ? Math.min(STARVED_POLL_MS, delayToNextBoundary()) : delayToNextBoundary());
        }

        /**
         * One poll of the barrier: take the decoder's first frame, check the audio source, and when
         * both are ready (or after 3 s) start the clock and show that frame.
         */
        function barrierStep(current: Decoder): void {
          const b = barrier;
          if (b === null) return;
          const t = now();
          if (b.frame === null) {
            const frame = current.takeOldest();
            if (frame !== null) {
              b.frame = frame;
              shown++;
            }
          }
          const audioReady = liveAudio()?.ready() ?? true;
          if ((b.frame !== null && audioReady) || t - b.since >= BARRIER_MAX_MS) {
            releaseBarrier(current, b.frame);
            return;
          }
          if (b.frame === null && ended) {
            barrier = null;
            handleEndOfStream(current);
            return;
          }
          if (!isBusy() && hudDue(t)) flushHud();
          scheduleTick(BARRIER_POLL_MS);
        }

        /** Starts the clock and the audio at the held position and shows the first frame. */
        function releaseBarrier(current: Decoder, frame: Uint8Array | null): void {
          barrier = null;
          const t = now();
          governorMuteUntil = t + GOVERNOR_MUTE_MS;
          liveAudio()?.release();
          clock.start(mediaPos());
          if (frame !== null) {
            if (isBusy()) {
              counters.framesDropped++;
              counters.ticksSkipped++;
            } else {
              presentFrame(frame);
            }
          }
          if (decoder === current) scheduleTick(delayToNextBoundary());
        }

        /** Paused: wait for the first frame of a fresh decoder, show it, and stay paused. */
        function pollPausedFrame(): void {
          pausedTimer = null;
          const current = decoder;
          if (finished || !paused || current === null) return;
          if (isBusy()) {
            pausedTimer = setTimeout(pollPausedFrame, PAUSED_POLL_MS);
            return;
          }
          const frame = current.takeOldest();
          if (frame !== null) {
            shown++;
            touchHud();
            presentFrame(frame);
            return;
          }
          if (ended) return; // nothing to show at this position
          pausedTimer = setTimeout(pollPausedFrame, PAUSED_POLL_MS);
        }

        // ---- Resize --------------------------------------------------------------------------

        const applyResize = (): void => {
          resizeTimer = null;
          if (finished) return;
          restartDecoder(true);
        };

        function onResize(): void {
          if (finished) return;
          resizeTimer = clearTimer(resizeTimer);
          resizeTimer = setTimeout(applyResize, RESIZE_DEBOUNCE_MS);
        }

        // ---- Keys ----------------------------------------------------------------------------

        const togglePause = (): void => {
          if (!paused) {
            paused = true;
            clock.pause();
            liveAudio()?.pause();
            tickTimer = clearTimer(tickTimer);
            if (barrier !== null) {
              // Paused while waiting for the first frame: show it (or wait for it), as after a paused seek.
              const held = barrier.frame;
              barrier = null;
              if (held !== null) {
                if (!isBusy()) presentFrame(held);
              }
            }
            // Paused before the first frame appeared: show that frame, as after a paused seek.
            if (decoder !== null && shown === 0) {
              pausedTimer = clearTimer(pausedTimer);
              pausedTimer = setTimeout(pollPausedFrame, 0);
            }
            touchHud();
            if (hudVisible) flushHud();
            return;
          }
          paused = false;
          pausedTimer = clearTimer(pausedTimer);
          clock.resume();
          const player = liveAudio();
          if (player !== null) {
            player.resume();
            player.release(); // a no-op unless a seek while paused left the source held
          }
          touchHud();
          if (decoder !== null) scheduleTick(0);
          else if (hudVisible) flushHud();
        };

        const applySeek = (): void => {
          seekTimer = null;
          const delta = seekAccum;
          seekAccum = 0;
          if (finished || delta === 0) return;
          const duration = mediaInfo.durationSec;
          const ceiling = duration === null ? Infinity : Math.max(0, duration - SEEK_END_MARGIN_SEC);
          const target = Math.min(Math.max(0, mediaPos() + delta), ceiling);
          seekTo(target);
          const notice = deps.seekNotice?.() ?? null;
          setMessage(
            `\u00bb ${delta > 0 ? '+' : ''}${String(delta)}s ${formatClock(target)}${notice === null ? '' : `  ${notice}`}`,
          );
        };

        const queueSeek = (deltaSec: number): void => {
          seekAccum += deltaSec;
          seekTimer = clearTimer(seekTimer);
          seekTimer = setTimeout(applySeek, SEEK_COALESCE_MS);
        };

        const cycleMode = (): void => {
          const from = MODE_ORDER.indexOf(mode);
          for (let step = 1; step <= MODE_ORDER.length; step++) {
            const candidate = MODE_ORDER[(from + step) % MODE_ORDER.length] as Mode;
            if (effectiveMode(candidate, unicode, brailleAllowed) === candidate) {
              mode = candidate;
              break;
            }
          }
          pipeline?.setMode(mode);
          if (paused) repaintPaused();
          setMessage(`mode ${mode}`);
        };

        const cyclePalette = (): void => {
          palette = PALETTES[(PALETTES.indexOf(palette) + 1) % PALETTES.length] as Palette;
          pipeline?.setPalette(palette);
          if (paused) repaintPaused();
          setMessage(`palette ${palette}`);
        };

        const onKey = (key: KeyEvent): void => {
          if (finished) return;
          switch (key.type) {
            case 'quit':
              finish(0);
              return;
            case 'interrupt':
              finish(130);
              return;
            case 'toggle-pause':
              togglePause();
              return;
            case 'seek':
              queueSeek(key.deltaSec);
              return;
            case 'cycle-mode':
              cycleMode();
              return;
            case 'cycle-palette':
              cyclePalette();
              return;
            case 'toggle-hud':
              hudVisible = !hudVisible;
              hudDirty = true;
              flushHud();
              return;
            case 'escape':
              return;
          }
        };

        const router: KeyRouter = createKeyRouter({ onKey });

        function onData(chunk: Uint8Array | string): void {
          router.feed(typeof chunk === 'string' ? Buffer.from(chunk, 'latin1') : chunk);
        }

        // ---- Start ---------------------------------------------------------------------------

        screen.addCleanup(killAll);
        audio?.onError((text) => {
          if (finished) return;
          if (audioUsable) {
            // The wall clock continues from the last audio position; playing goes on without sound.
            audioUsable = false;
            clock.setSource(null);
          }
          setMessage(`audio: ${text}`);
        });
        stdout.on('resize', onResize);
        stdin.on('data', onData);
        stdin.resume();

        notify = setMessage;
        layout(true);
        const first = resolveSegment();
        liveAudio()?.start(0, first.audio); // held until the barrier releases
        if (pipeline === null) {
          // Nothing to wait for: play (the sound, at least) while the terminal is too small.
          liveAudio()?.release();
          clock.start(0);
          showTooSmall();
        } else {
          barrier = { since: now(), frame: null };
          startDecoder(clock.position(), first.video);
        }
        // Keys typed before playback started (during the capability probe) act as if typed now.
        if (deps.initialInput !== undefined && deps.initialInput.length > 0) router.feed(deps.initialInput);
      });
    },
  };
}
