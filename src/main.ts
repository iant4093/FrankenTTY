import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { release } from 'node:os';
import { HELP_TEXT, VERSION, parseArgs } from './cli/args.ts';
import type { Options } from './cli/args.ts';
import {
  describeCapabilities,
  detectColorDepth,
  detectUnicode,
  installCommand,
  resolveCellAspect,
  runProbe,
} from './term/capabilities.ts';
import { createScreen, drawCentered, installExitTraps } from './term/screen.ts';

const TOOL_CHECK_TIMEOUT_MS = 5000;
const KEY_Q = 0x71;
const KEY_CTRL_C = 0x03;

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

/** Exit code requested by a key byte: 0 for q, 130 for Ctrl+C, null otherwise. */
function quitCode(bytes: Uint8Array): number | null {
  for (const b of bytes) {
    if (b === KEY_CTRL_C) return 130;
    if (b === KEY_Q) return 0;
  }
  return null;
}

function waitForQuit(initial: Uint8Array): Promise<number> {
  return new Promise((resolve) => {
    const early = quitCode(initial);
    if (early !== null) {
      resolve(early);
      return;
    }
    process.stdin.on('data', (chunk: Uint8Array) => {
      const code = quitCode(chunk);
      if (code !== null) resolve(code);
    });
    process.stdin.resume();
  });
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

  const screen = createScreen(process.stdout, process.stdin);
  installExitTraps(screen);
  screen.enter();

  const probe = await runProbe(process.stdin, process.stdout);
  const { unicode, braille } = detectUnicode(process.env, process.platform);
  const cols = process.stdout.columns;
  const rows = process.stdout.rows;
  const lines = describeCapabilities({
    colorDepth: detectColorDepth(
      process.env,
      process.platform,
      release(),
      process.stdout.getColorDepth(),
      options.color,
    ),
    sync2026: probe.sync2026,
    cellAspect: resolveCellAspect(options.cellAspect, probe.cellAspect),
    unicode,
    braille,
    cols,
    rows,
  });
  drawCentered(process.stdout, ['FrankenTTY', '', ...lines, '', 'press q to quit'], cols, rows);

  const code = await waitForQuit(probe.passthrough);
  screen.restore();
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
