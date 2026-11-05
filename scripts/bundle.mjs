// Bundles src/main.ts into dist/frankentty.cjs for the npm package and SEA binaries.
import { chmodSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outfile = path.join(root, 'dist', 'frankentty.cjs');

try {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const version = pkg.version;
  if (typeof version !== 'string' || version === '') {
    throw new Error('package.json has no version string');
  }

  await build({
    entryPoints: [path.join(root, 'src', 'main.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    banner: { js: '#!/usr/bin/env node' },
    define: { __FRANKENTTY_VERSION__: JSON.stringify(version) },
    minify: false,
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'warning',
  });

  if (process.platform !== 'win32') chmodSync(outfile, 0o755);

  const kb = (statSync(outfile).size / 1024).toFixed(1);
  console.log(`bundle: dist/frankentty.cjs (${kb} KB, version ${version})`);
} catch (err) {
  console.error(`bundle: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
