// Loads the bundled JetBrains Mono (SIL OFL 1.1, see LICENSES.md) before the first frame is captured.
import { continueRender, delayRender, staticFile } from 'remotion';

let loading: Promise<void> | null = null;
let done = false;

const FACES: [string, string][] = [
  ['400', 'fonts/jetbrains-mono-latin-400-normal.woff2'],
  ['700', 'fonts/jetbrains-mono-latin-700-normal.woff2'],
];

function load(): Promise<void> {
  if (loading === null) {
    loading = Promise.all(
      FACES.map(async ([weight, file]) => {
        const face = new FontFace('JetBrains Mono', `url(${staticFile(file)}) format('woff2')`, { weight });
        await face.load();
        document.fonts.add(face);
      }),
    ).then(() => {
      done = true;
    });
  }
  return loading;
}

/** Call once at module load of the root; holds the render until the fonts are ready. */
export function ensureFonts(): void {
  if (done) return;
  const handle = delayRender('Loading JetBrains Mono');
  load().then(
    () => continueRender(handle),
    (err: unknown) => {
      // Never hang the render: log and fall back to the system monospace font.
      console.error('font load failed', err);
      continueRender(handle);
    },
  );
}
