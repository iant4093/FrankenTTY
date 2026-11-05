import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  ALT_OFF,
  ALT_ON,
  AUTOWRAP_OFF,
  AUTOWRAP_ON,
  CLEAR,
  CURSOR_HIDE,
  CURSOR_SHOW,
  RESTORE_SEQUENCE,
  SGR_RESET,
  SYNC_END,
  cursorPosition,
  writeCursorPosition,
  writeDecimal,
} from '../../src/renderer/sequences.ts';
import { createScreen, drawCentered, installExitTraps } from '../../src/term/screen.ts';
import type { TrapHost } from '../../src/term/screen.ts';

function fakeStreams() {
  const writes: string[] = [];
  const rawModes: boolean[] = [];
  return {
    writes,
    rawModes,
    stdout: { write: (data: string) => writes.push(data) },
    stdin: { setRawMode: (mode: boolean) => rawModes.push(mode) },
  };
}

describe('sequences', () => {
  it('builds RESTORE_SEQUENCE in the required order', () => {
    expect(RESTORE_SEQUENCE).toBe(SYNC_END + SGR_RESET + AUTOWRAP_ON + CURSOR_SHOW + ALT_OFF);
    expect(RESTORE_SEQUENCE).toBe('\x1b[?2026l\x1b[0m\x1b[?7h\x1b[?25h\x1b[?1049l');
  });

  it('writes the cursor position as a string and as bytes', () => {
    const buf = new Uint8Array(32);
    const end = writeCursorPosition(buf, 3, 12, 345);
    expect(Buffer.from(buf.subarray(3, end)).toString('latin1')).toBe(cursorPosition(12, 345));
    expect(cursorPosition(1, 1)).toBe('\x1b[1;1H');
  });

  it('writeDecimal matches String() for edge values', () => {
    for (const v of [0, 9, 10, 99, 100, 255, 999, 1000, 65535, 123456789]) {
      const buf = new Uint8Array(12);
      const end = writeDecimal(buf, 1, v);
      expect(Buffer.from(buf.subarray(1, end)).toString('latin1')).toBe(String(v));
    }
  });
});

describe('createScreen', () => {
  it('enter writes the startup sequences and enables raw mode', () => {
    const s = fakeStreams();
    const screen = createScreen(s.stdout, s.stdin);
    expect(screen.isActive).toBe(false);
    screen.enter();
    expect(screen.isActive).toBe(true);
    expect(s.writes).toEqual([ALT_ON + CURSOR_HIDE + AUTOWRAP_OFF + CLEAR]);
    expect(s.rawModes).toEqual([true]);
  });

  it('enter twice writes once', () => {
    const s = fakeStreams();
    const screen = createScreen(s.stdout, s.stdin);
    screen.enter();
    screen.enter();
    expect(s.writes).toHaveLength(1);
  });

  it('restore writes RESTORE_SEQUENCE, disables raw mode and runs cleanups once', () => {
    const s = fakeStreams();
    const screen = createScreen(s.stdout, s.stdin);
    const order: string[] = [];
    screen.addCleanup(() => order.push('a'));
    screen.addCleanup(() => {
      throw new Error('boom');
    });
    screen.addCleanup(() => order.push('b'));
    screen.enter();
    screen.restore();
    screen.restore();
    screen.restore();
    expect(screen.isActive).toBe(false);
    expect(s.writes).toEqual([ALT_ON + CURSOR_HIDE + AUTOWRAP_OFF + CLEAR, RESTORE_SEQUENCE]);
    expect(s.rawModes).toEqual([true, false]);
    expect(order).toEqual(['a', 'b']);
  });

  it('restore before enter leaves the terminal alone but still runs cleanups', () => {
    const s = fakeStreams();
    const screen = createScreen(s.stdout, s.stdin);
    const cleanup = vi.fn();
    screen.addCleanup(cleanup);
    screen.restore();
    screen.restore();
    expect(s.writes).toEqual([]);
    expect(s.rawModes).toEqual([]);
    expect(cleanup).toHaveBeenCalledTimes(1);
    screen.enter(); // too late: stays inactive
    expect(s.writes).toEqual([]);
  });

  it('a cleanup added after restore runs immediately', () => {
    const s = fakeStreams();
    const screen = createScreen(s.stdout, s.stdin);
    screen.restore();
    const cleanup = vi.fn();
    screen.addCleanup(cleanup);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('survives setRawMode throwing during restore', () => {
    const writes: string[] = [];
    const screen = createScreen(
      { write: (d: string) => writes.push(d) },
      {
        setRawMode: (mode: boolean) => {
          if (!mode) throw new Error('closed');
        },
      },
    );
    screen.enter();
    const cleanup = vi.fn();
    screen.addCleanup(cleanup);
    expect(() => screen.restore()).not.toThrow();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});

describe('drawCentered', () => {
  it('clears and positions each line', () => {
    const s = fakeStreams();
    drawCentered(s.stdout, ['ab', 'cdef'], 10, 6);
    expect(s.writes).toEqual([CLEAR + cursorPosition(3, 5) + 'ab' + cursorPosition(4, 4) + 'cdef']);
  });

  it('clamps to row 1 and column 1 on tiny screens', () => {
    const s = fakeStreams();
    drawCentered(s.stdout, ['long line'], 3, 0);
    expect(s.writes).toEqual([CLEAR + cursorPosition(1, 1) + 'long line']);
  });
});

describe('installExitTraps', () => {
  function setup(platform: string) {
    const emitter = new EventEmitter();
    const exit = vi.fn();
    const stderr: string[] = [];
    const host = Object.assign(emitter, {
      platform,
      exit,
      stderr: { write: (d: string) => stderr.push(d) },
    }) as unknown as TrapHost;
    const s = fakeStreams();
    const screen = createScreen(s.stdout, s.stdin);
    screen.enter();
    const uninstall = installExitTraps(screen, host);
    return { emitter, exit, stderr, s, screen, uninstall };
  }

  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
    ['SIGHUP', 129],
  ])('%s restores and exits with %i', (signal, code) => {
    const t = setup('linux');
    t.emitter.emit(signal);
    expect(t.s.writes.at(-1)).toBe(RESTORE_SEQUENCE);
    expect(t.exit).toHaveBeenCalledWith(code);
  });

  it('listens for SIGBREAK only on win32', () => {
    expect(setup('linux').emitter.listenerCount('SIGBREAK')).toBe(0);
    const win = setup('win32');
    expect(win.emitter.listenerCount('SIGBREAK')).toBe(1);
    win.emitter.emit('SIGBREAK');
    expect(win.exit).toHaveBeenCalledWith(149);
    expect(win.s.writes.at(-1)).toBe(RESTORE_SEQUENCE);
  });

  it.each(['uncaughtException', 'unhandledRejection'])('%s restores, reports and exits 1', (event) => {
    const t = setup('linux');
    t.emitter.emit(event, new Error('kaput'));
    expect(t.s.writes.at(-1)).toBe(RESTORE_SEQUENCE);
    expect(t.stderr.join('')).toContain('kaput');
    expect(t.exit).toHaveBeenCalledWith(1);
  });

  it('reports non-Error rejection reasons', () => {
    const t = setup('linux');
    t.emitter.emit('unhandledRejection', 'plain reason');
    expect(t.stderr.join('')).toContain('plain reason');
  });

  it("restores on 'exit' and restoring twice writes once", () => {
    const t = setup('linux');
    t.emitter.emit('exit', 0);
    t.emitter.emit('SIGTERM');
    expect(t.s.writes.filter((w) => w === RESTORE_SEQUENCE)).toHaveLength(1);
  });

  it('uninstall removes every handler', () => {
    const t = setup('win32');
    t.uninstall();
    for (const event of t.emitter.eventNames()) {
      expect(t.emitter.listenerCount(event)).toBe(0);
    }
  });
});
