// Writes a Node single-executable-application config for `node --build-sea`.
// Usage: node scripts/sea-config.mjs <config.json> <main.cjs> <output> <node-executable>
// Used by scripts/build-release.sh. Paths are made absolute; JSON is built by JSON.stringify,
// so no path is ever interpolated into a shell string or hand-written JSON.
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const [configPath, main, output, executable] = process.argv.slice(2);
if (!configPath || !main || !output || !executable) {
  console.error('usage: sea-config.mjs <config.json> <main.cjs> <output> <node-executable>');
  process.exit(2);
}

const config = {
  main: path.resolve(main),
  output: path.resolve(output),
  executable: path.resolve(executable),
  disableExperimentalSEAWarning: true,
  // Both must be false for cross-target builds (docs/EVIDENCE.md S7).
  useCodeCache: false,
  useSnapshot: false,
};

writeFileSync(path.resolve(configPath), `${JSON.stringify(config, null, 2)}\n`);
