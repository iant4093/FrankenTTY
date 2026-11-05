import { readFileSync } from 'node:fs';

/** Injected by scripts/bundle.mjs via esbuild `define`. Undefined when running from source. */
declare const __FRANKENTTY_VERSION__: string | undefined;

function readPackageVersion(): string {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    const version = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof version === 'string' ? version : 'unknown';
  } catch {
    return 'unknown';
  }
}

function resolveVersion(): string {
  if (typeof __FRANKENTTY_VERSION__ !== 'undefined') return __FRANKENTTY_VERSION__;
  return readPackageVersion();
}

export const VERSION: string = resolveVersion();
