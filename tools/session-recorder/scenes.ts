// Scenes for the demo video (video/script.md). Dev tooling: never imported by src/, not shipped.
//
// `command` holds the arguments after `frankentty`; the recorder runs `node src/main.ts <command>`.
// Event times are seconds since the process was spawned. Keys are the raw bytes a terminal sends.

export interface SessionEvent {
  /** Seconds since spawn. */
  t: number;
  /** Raw bytes written to the PTY, as a JS string (empty for a resize event). */
  keys: string;
  label: string;
  /** New terminal size [cols, rows]; present only on resize events. */
  resize?: [number, number];
}

export interface SceneSpec {
  name: string;
  title: string;
  command: string[];
  cols: number;
  rows: number;
  /** Planned length. A `q` is added at this time unless the events already contain one. */
  durationSec: number;
  events: SessionEvent[];
}

// Input bytes. These are keys going *to* FrankenTTY, not output sequences.
const KEY_ESC = String.fromCharCode(0x1b);
export const KEY_RIGHT = `${KEY_ESC}[C`;
export const KEY_LEFT = `${KEY_ESC}[D`;
export const KEY_SHIFT_LEFT = `${KEY_ESC}[1;2D`;
export const KEY_SHIFT_RIGHT = `${KEY_ESC}[1;2C`;

const key = (t: number, keys: string, label: string): SessionEvent => ({ t, keys, label });

export const SCENES: readonly SceneSpec[] = [
  {
    name: 'act1-mandelbrot',
    title: 'Act I: Mandelbrot demo plays',
    command: ['--demo', 'mandelbrot'],
    cols: 160,
    rows: 45,
    durationSec: 10,
    events: [key(10, 'q', 'quit')],
  },
  {
    name: 'act3-modes',
    title: 'Act III: render modes and palettes',
    command: ['--demo', 'mandelbrot'],
    cols: 160,
    rows: 45,
    durationSec: 18.5,
    events: [
      key(2, 'm', 'ASCII'),
      key(5, 'm', 'Braille'),
      key(8, 'm', 'half-block'),
      key(10, 'c', 'amber'),
      key(12, 'c', 'green'),
      key(14, 'c', 'DMG'),
      key(16, 'c', 'TrueColor'),
      key(18.5, 'q', 'quit'),
    ],
  },
  {
    name: 'act3-seek-pause',
    title: 'Act III: seek, pause, HUD',
    command: ['--demo', 'testsrc2'],
    cols: 160,
    rows: 45,
    durationSec: 14,
    events: [
      key(2, KEY_RIGHT, 'seek +5 s'),
      key(3.5, KEY_RIGHT, 'seek +5 s'),
      key(5, ' ', 'pause'),
      key(7, ' ', 'resume'),
      key(9, KEY_SHIFT_LEFT, 'seek -30 s'),
      key(11, 'i', 'HUD off'),
      key(12.5, 'i', 'HUD on'),
      key(14, 'q', 'quit'),
    ],
  },
  {
    name: 'act3-resize',
    title: 'Act III: window resize',
    command: ['--demo', 'gradients'],
    cols: 100,
    rows: 30,
    durationSec: 9,
    events: [
      { t: 4, keys: '', label: 'resize to 160x45', resize: [160, 45] },
      key(9, 'q', 'quit'),
    ],
  },
  {
    name: 'act2-cell',
    title: 'Act II: two pixels per cell',
    command: ['--demo', 'life', '--mode', 'halfblock'],
    cols: 40,
    rows: 12,
    durationSec: 6,
    events: [key(6, 'q', 'quit')],
  },
];

export const SCENE_NAMES: readonly string[] = SCENES.map((s) => s.name);

export function getScene(name: string): SceneSpec {
  const scene = SCENES.find((s) => s.name === name);
  if (scene === undefined) throw new RangeError(`Unknown scene "${name}". Allowed: ${SCENE_NAMES.join(', ')}`);
  return scene;
}
