import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { release } from 'node:os';
import { performance } from 'node:perf_hooks';
import { BenchError, formatBenchJson, formatBenchText, runBench } from './bench/bench.ts';
import { formatSeekJson, formatSeekText, runSeekTest } from './bench/seek-test.ts';
import { DEFAULT_BENCH_SIZE, DEFAULT_THRESHOLD, HELP_TEXT, VERSION, parseArgs } from './cli/args.ts';
import type { Options } from './cli/args.ts';
import { createAudioPlayer } from './audio/player.ts';
import { demoAudioInputArgs, demoMetadata, demoVideoInputArgs, getDemo } from './ingest/demo.ts';
import { ensureDemoCache } from './ingest/demo-cache.ts';
import type { MediaInfo } from './ingest/media-info.ts';
import { ProbeError, probe as probeInput } from './ingest/probe.ts';
import { createPlayer } from './player/controller.ts';
import { effectiveMode } from './player/pipeline.ts';
import { DEFAULT_CELL_ASPECT } from './renderer/geometry.ts';
import { detectColorDepth, detectUnicode, installCommand, resolveCellAspect, runProbe } from './term/capabilities.ts';
import { createScreen, installExitTraps } from './term/screen.ts';

const TOOL_CHECK_TIMEOUT_MS = 5000;
/** HUD message when the demo seek cache finishes while playing. */
const CACHE_READY_MESSAGE = 'seek cache ready';
const CACHE_READY_MESSAGE_MS = 1500;
/** Appended to the HUD message of a seek while the cache is still being built. ASCII: the HUD has no ellipsis glyph. */
const CACHE_PENDING_NOTICE = 'preparing seek cache...';

/**
 * Directory of the demo seek cache. `FRANKENTTY_CACHE_DIR` overrides the default
 * (`<tmpdir>/frankentty-cache`); tests use it to keep their caches apart from the user's.
 */
function cacheDirFromEnv(): string | undefined {
  const dir = process.env.FRANKENTTY_CACHE_DIR;
  return dir === undefined || dir === '' ? undefined : dir;
}

/** One time source for the clock, the audio player and the frame loop. */
function monotonicNow(): number {
  return performance.now();
}

/** Runs `<tool> -version` with an argv array and no shell. */
function toolAvailable(tool: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(tool, ['-version'], { stdio: 'ignore', windowsHide: true });
    const timer = setTimeout(() => {
      child.kill();
      resolve(false);
    }, TOOL_CHECK_TIMEOUT_MS);
    child.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

function readOsRelease(): string | null {
  try {
    return readFileSync('/etc/os-release', 'utf8');
  } catch {
    return null;
  }
}

interface Media {
  info: MediaInfo;
  inputArgs: string[];
  /** ffmpeg input arguments for the audio decoder. */
  audioInputArgs: string[];
}

/** Resolves what to play before the terminal is touched. Throws ProbeError for bad inputs. */
async function resolveMedia(options: Options): Promise<Media> {
  if (options.demo !== null) {
    const src = getDemo(options.demo);
    return { info: demoMetadata(src), inputArgs: demoVideoInputArgs(src), audioInputArgs: demoAudioInputArgs(src) };
  }
  const input = options.input;
  if (input === null) throw new ProbeError('no input given');
  return { info: await probeInput(input), inputArgs: ['-i', input], audioInputArgs: ['-i', input] };
}

/** Prints the install hint and returns 1 when ffmpeg or ffprobe is missing (REQ-PREREQ-01); else returns null. */
async function missingToolsExit(): Promise<number | null> {
  const [hasFfmpeg, hasFfprobe] = await Promise.all([toolAvailable('ffmpeg'), toolAvailable('ffprobe')]);
  if (hasFfmpeg && hasFfprobe) return null;
  const missing = [hasFfmpeg ? null : 'ffmpeg', hasFfprobe ? null : 'ffprobe'].filter((t) => t !== null);
  console.error(
    `frankentty: ${missing.join(' and ')} not found on PATH. Install FFmpeg with: ${installCommand(process.platform, readOsRelease())}`,
  );
  return 1;
}

/** Node's color depth for stdout; 1 (no color) when stdout is not a TTY. */
function nodeColorDepth(): number {
  return typeof process.stdout.getColorDepth === 'function' ? process.stdout.getColorDepth() : 1;
}

/** `--bench`: headless, no TTY. Prints the report to stdout; any failure is one stderr line and exit 1. */
async function runBenchCommand(options: Options): Promise<number> {
  const missing = await missingToolsExit();
  if (missing !== null) return missing;
  try {
    const media = await resolveMedia(options);
    const size = options.size ?? DEFAULT_BENCH_SIZE;
    if (options.seekTest) {
      const cacheDir = cacheDirFromEnv();
      const seekReport = await runSeekTest({
        source: options.demo ?? options.input ?? '',
        media: media.info,
        inputArgs: media.inputArgs,
        isFile: media.info.source === 'file',
        demo: options.demo === null ? null : getDemo(options.demo),
        ...(cacheDir === undefined ? {} : { cacheDir }),
        cols: size.cols,
        rows: size.rows,
        fps: options.fps,
        cellAspect: options.cellAspect ?? DEFAULT_CELL_ASPECT,
      });
      process.stdout.write(options.json ? formatSeekJson(seekReport) : formatSeekText(seekReport));
      return 0;
    }
    const report = await runBench({
      source: options.demo ?? options.input ?? '',
      media: media.info,
      inputArgs: media.inputArgs,
      isFile: media.info.source === 'file',
      frames: options.frames ?? 300,
      cols: size.cols,
      rows: size.rows,
      fps: options.fps,
      cellAspect: options.cellAspect ?? DEFAULT_CELL_ASPECT,
      mode: options.mode,
      palette: options.palette,
      // Benchmarks do not depend on the environment: `auto` means truecolor here.
      depth: options.color === 'auto' ? 24 : detectColorDepth({}, process.platform, '', 1, options.color),
      threshold: options.threshold ?? DEFAULT_THRESHOLD,
    });
    process.stdout.write(options.json ? formatBenchJson(report) : formatBenchText(report));
    return 0;
  } catch (err) {
    if (!(err instanceof ProbeError) && !(err instanceof BenchError)) throw err;
    console.error(`frankentty: ${err.message.split('\n')[0]}`);
    return 1;
  }
}

/** Returns an exit code for early exits. The interactive path exits the process itself. */
async function run(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    console.error(`frankentty: ${parsed.message}`);
    return 2;
  }
  const options: Options = parsed.options;

  if (options.help) {
    process.stdout.write(HELP_TEXT);
    return 0;
  }
  if (options.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (options.bench) return runBenchCommand(options);

  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    console.error('frankentty: stdin and stdout must be a terminal; use --bench for headless runs');
    return 1;
  }

  const [missing, hasFfplay] = await Promise.all([missingToolsExit(), toolAvailable('ffplay')]);
  if (missing !== null) return missing;

  let media: Media;
  try {
    media = await resolveMedia(options);
  } catch (err) {
    if (!(err instanceof ProbeError)) throw err;
    console.error(`frankentty: ${err.message.split('\n')[0]}`);
    return 1;
  }

  // Audio plays when the source has it, ffplay exists and the user did not opt out (REQ-PREREQ-01).
  if (media.info.hasAudio && !options.noAudio && !hasFfplay) {
    console.error('frankentty: warning: ffplay not found on PATH, playing without audio');
  }
  const useAudio = media.info.hasAudio && !options.noAudio && hasFfplay;

  const screen = createScreen(process.stdout, process.stdin);
  installExitTraps(screen);
  screen.enter();

  // Demo seek cache: lavfi cannot seek, so a demo is rendered once into a seekable file in the background.
  // Segments that start after it is ready (seek, loop, resize) read the file; the first one may still be lavfi.
  let cacheReady = false;
  let cachePath = '';
  let cacheFailed = false;
  let announceReady: (() => void) | null = null;
  if (options.demo !== null) {
    const cacheDir = cacheDirFromEnv();
    const cache = ensureDemoCache(getDemo(options.demo), {
      ...(cacheDir === undefined ? {} : { dir: cacheDir }),
      onReady: (file) => {
        const wasReady = cacheReady;
        cacheReady = true;
        cachePath = file;
        if (!wasReady) announceReady?.();
      },
      onError: () => {
        cacheFailed = true; // silent: playback continues on lavfi
      },
    });
    // Killed with the other children on every exit path (q, signals, crashes).
    screen.addCleanup(cache.cancel);
    if (cache.entry.ready) {
      cacheReady = true;
      cachePath = cache.entry.path;
    }
  }

  let code: number;
  let failure: string | null;
  try {
    const probe = await runProbe(process.stdin, process.stdout);
    const unicode = detectUnicode(process.env, process.platform);
    const audio = useAudio ? createAudioPlayer({ inputArgs: media.audioInputArgs, now: monotonicNow }) : null;
    const player = createPlayer({
      stdout: process.stdout,
      stdin: process.stdin,
      screen,
      mediaInfo: media.info,
      inputArgs: media.inputArgs,
      isFile: media.info.source === 'file',
      fps: options.fps,
      cellAspect: resolveCellAspect(options.cellAspect, probe.cellAspect).value,
      loop: options.loop,
      // REQ-CAP-03: no UTF-8 locale -> ASCII only; no Braille support -> half-block, silently.
      mode: effectiveMode(options.mode, unicode.unicode, unicode.braille),
      unicode: unicode.unicode,
      braille: unicode.braille,
      palette: options.palette,
      depth: detectColorDepth(process.env, process.platform, release(), nodeColorDepth(), options.color),
      threshold: options.threshold ?? DEFAULT_THRESHOLD,
      now: monotonicNow,
      audio,
      avOffsetMs: options.avOffset,
      quality: options.quality,
      // Keys typed during the capability probe are not lost.
      initialInput: probe.passthrough,
      ...(options.demo === null
        ? {}
        : {
            // One call per segment: video and audio of a segment both come from the cache or both from lavfi.
            resolveInput: () =>
              cacheReady
                ? { videoArgs: ['-i', cachePath], audioArgs: ['-i', cachePath] }
                : { videoArgs: media.inputArgs, audioArgs: media.audioInputArgs },
            seekNotice: () => (cacheReady || cacheFailed ? null : CACHE_PENDING_NOTICE),
          }),
    });
    // Only a cache that becomes ready during playback is announced; one found at start-up is not news.
    announceReady = () => player.showMessage(CACHE_READY_MESSAGE, CACHE_READY_MESSAGE_MS);
    code = await player.start();
    failure = player.lastError();
  } catch (err) {
    // The screen is active, so restore it and leave: a resumed raw stdin would keep the process alive.
    failure = (err instanceof Error ? err.message : String(err)).split('\n')[0] ?? 'unexpected error';
    code = 1;
  }
  screen.restore();
  if (failure !== null) console.error(`frankentty: ${failure}`);
  process.exit(code);
}

run(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`frankentty: ${message.split('\n')[0]}`);
    process.exitCode = 1;
  },
);
