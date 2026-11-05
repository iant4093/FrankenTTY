// Stand-in for a Chocolatey or Scoop `ffmpeg.exe` shim: starts the real ffmpeg as a child that
// shares this process's stdout pipe, and does NOT forward signals. Killing only this process
// leaves the real ffmpeg running with the pipe open.
//
// Usage: node ffmpeg-shim.ts <pidFile> <ffmpeg args...>
// The real ffmpeg's pid is written to <pidFile> right after it starts.

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const [pidFile, ...ffmpegArgs] = process.argv.slice(2);
if (pidFile === undefined) {
  process.stderr.write('usage: ffmpeg-shim <pidFile> <ffmpeg args...>\n');
  process.exit(2);
}

const real = spawn('ffmpeg', ffmpegArgs, { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
writeFileSync(pidFile, String(real.pid ?? ''));
real.on('error', () => {
  process.exit(127);
});
real.on('exit', (code) => {
  process.exit(code ?? 1);
});
