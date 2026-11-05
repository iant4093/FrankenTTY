// Kills a child process and, on Windows, everything it started.
//
// Chocolatey and Scoop install `ffmpeg.exe` as a shim that starts the real ffmpeg as a child
// and shares its stdout pipe. Killing only the shim leaves the real ffmpeg running with the
// pipe open. `taskkill /T /F` ends the whole tree. Elsewhere ffmpeg is spawned directly, so a
// plain signal reaches it.

import { spawn, spawnSync } from 'node:child_process';

const isWindows = (): boolean => process.platform === 'win32';

/** Pure: argv for `taskkill` that force-kills `pid` and its descendants. */
export function taskkillArgs(pid: number): string[] {
  return ['/pid', String(pid), '/T', '/F'];
}

function validPid(pid: number | undefined): pid is number {
  return pid !== undefined && Number.isInteger(pid) && pid > 0;
}

function signalPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // The process is already gone.
  }
}

/**
 * Synchronous kill for exit paths. Windows: `taskkill /T /F` (always forceful, whatever the
 * signal). Other platforms: sends `signal` (default SIGKILL). Never throws; ignores
 * taskkill's output and exit code.
 */
export function killTreeSync(pid: number | undefined, signal: NodeJS.Signals = 'SIGKILL'): void {
  if (!validPid(pid)) return;
  if (!isWindows()) {
    signalPid(pid, signal);
    return;
  }
  const result = spawnSync('taskkill', taskkillArgs(pid), { stdio: 'ignore', windowsHide: true });
  // taskkill itself could not run (not on PATH): fall back to killing the one process.
  if (result.error !== undefined) signalPid(pid, 'SIGKILL');
}

/**
 * Asynchronous kill. Resolves once the signal was sent, or on Windows once `taskkill` has
 * finished. Does not wait for the target to exit. Never rejects.
 */
export function killTree(pid: number | undefined, signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
  if (!validPid(pid)) return Promise.resolve();
  if (!isWindows()) {
    signalPid(pid, signal);
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const killer = spawn('taskkill', taskkillArgs(pid), { stdio: 'ignore', windowsHide: true });
    killer.once('error', () => {
      signalPid(pid, 'SIGKILL');
      resolve();
    });
    killer.once('close', () => {
      resolve();
    });
  });
}
