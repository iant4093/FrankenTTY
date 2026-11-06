import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { killTree, killTreeSync, taskkillArgs } from '../../src/ingest/kill-tree.ts';

function sleeper(): ReturnType<typeof spawn> {
  return spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true });
}

function exited(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve) => child.once('exit', () => resolve()));
}

describe('[REQ-TERM-03][REQ-PLAT-01] taskkillArgs', () => {
  it('kills the pid and its descendants, forcefully', () => {
    expect(taskkillArgs(1234)).toEqual(['/pid', '1234', '/T', '/F']);
  });
});

describe('[REQ-TERM-03][REQ-PLAT-01] killTreeSync', () => {
  it('kills a running process', async () => {
    const child = sleeper();
    const done = exited(child);
    killTreeSync(child.pid);
    await done;
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });

  it('ignores undefined, invalid and already-dead pids', async () => {
    expect(() => {
      killTreeSync(undefined);
      killTreeSync(0);
      killTreeSync(-5);
      killTreeSync(1.5);
      killTreeSync(NaN);
    }).not.toThrow();
    const child = sleeper();
    const done = exited(child);
    killTreeSync(child.pid);
    await done;
    expect(() => killTreeSync(child.pid)).not.toThrow();
  });
});

describe('[REQ-TERM-03][REQ-PLAT-01] killTree', () => {
  it('kills a running process and resolves', async () => {
    const child = sleeper();
    const done = exited(child);
    await killTree(child.pid, 'SIGKILL');
    await done;
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });

  it('resolves for undefined and dead pids', async () => {
    await expect(killTree(undefined)).resolves.toBeUndefined();
    const child = sleeper();
    const done = exited(child);
    await killTree(child.pid);
    await done;
    await expect(killTree(child.pid)).resolves.toBeUndefined();
  });
});
