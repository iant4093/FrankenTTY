import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { HELP_TEXT, VERSION, parseArgs } from './cli/args.ts';
import type { Options } from './cli/args.ts';
import { demoMetadata, demoVideoInputArgs, getDemo } from './ingest/demo.ts';
import type { MediaInfo } from './ingest/media-info.ts';
import { ProbeError, probe as probeInput } from './ingest/probe.ts';
import { createPlayer } from './player/controller.ts';
import { installCommand, resolveCellAspect, runProbe } from './term/capabilities.ts';
import { createScreen, installExitTraps } from './term/screen.ts';

const TOOL_CHECK_TIMEOUT_MS = 5000;

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
}

/** Resolves what to play before the terminal is touched. Throws ProbeError for bad inputs. */
async function resolveMedia(options: Options): Promise<Media> {
  if (options.demo !== null) {
    const src = getDemo(options.demo);
    return { info: demoMetadata(src), inputArgs: demoVideoInputArgs(src) };
  }
  const input = options.input;
  if (input === null) throw new ProbeError('no input given');
  return { info: await probeInput(input), inputArgs: ['-i', input] };
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
  if (options.bench) {
    process.stdout.write('bench: not implemented yet\n');
    return 0;
  }

  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    console.error('frankentty: stdin and stdout must be a terminal; use --bench for headless runs');
    return 1;
  }

  const [hasFfmpeg, hasFfprobe, hasFfplay] = await Promise.all([
    toolAvailable('ffmpeg'),
    toolAvailable('ffprobe'),
    toolAvailable('ffplay'),
  ]);
  if (!hasFfmpeg || !hasFfprobe) {
    const missing = [hasFfmpeg ? null : 'ffmpeg', hasFfprobe ? null : 'ffprobe'].filter((t) => t !== null);
    console.error(
      `frankentty: ${missing.join(' and ')} not found on PATH. Install FFmpeg with: ${installCommand(process.platform, readOsRelease())}`,
    );
    return 1;
  }
  if (!hasFfplay && !options.noAudio) {
    console.error('frankentty: warning: ffplay not found on PATH, playing without audio');
  }

  let media: Media;
  try {
    media = await resolveMedia(options);
  } catch (err) {
    if (!(err instanceof ProbeError)) throw err;
    console.error(`frankentty: ${err.message.split('\n')[0]}`);
    return 1;
  }

  const screen = createScreen(process.stdout, process.stdin);
  installExitTraps(screen);
  screen.enter();

  const probe = await runProbe(process.stdin, process.stdout);
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
  });
  const code = await player.start();
  screen.restore();
  const failure = player.lastError();
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
