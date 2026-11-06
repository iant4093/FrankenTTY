import { describe, expect, it } from 'vitest';
import { createKeyRouter, MAX_PENDING_BYTES, type KeyEvent } from '../../src/tui/input.ts';

interface FakeTimers {
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  fire: () => void;
  pending: () => number;
  lastDelay: () => number | undefined;
}

function fakeTimers(): FakeTimers {
  let next = 1;
  const active = new Map<number, { fn: () => void; ms: number }>();
  let lastMs: number | undefined;
  return {
    setTimer(fn, ms) {
      const id = next++;
      active.set(id, { fn, ms });
      lastMs = ms;
      return id;
    },
    clearTimer(handle) {
      active.delete(handle as number);
    },
    fire() {
      const entries = [...active.entries()];
      active.clear();
      for (const [, timer] of entries) timer.fn();
    },
    pending: () => active.size,
    lastDelay: () => lastMs,
  };
}

function setup(escTimeoutMs?: number) {
  const events: KeyEvent[] = [];
  const timers = fakeTimers();
  const router = createKeyRouter({
    onKey: (key) => events.push(key),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    ...(escTimeoutMs === undefined ? {} : { escTimeoutMs }),
  });
  return { events, timers, router };
}

function bytes(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'utf8'));
}

function keysOf(text: string): KeyEvent[] {
  const { events, router } = setup();
  router.feed(bytes(text));
  router.flush();
  return events;
}

describe('[REQ-UI-01][REQ-TERM-03] key router: single-byte keys', () => {
  it.each([
    [' ', { type: 'toggle-pause' }],
    ['q', { type: 'quit' }],
    ['Q', { type: 'quit' }],
    ['\x03', { type: 'interrupt' }],
    ['m', { type: 'cycle-mode' }],
    ['M', { type: 'cycle-mode' }],
    ['c', { type: 'cycle-palette' }],
    ['C', { type: 'cycle-palette' }],
    ['i', { type: 'toggle-hud' }],
    ['I', { type: 'toggle-hud' }],
  ] as const)('%j maps to %j', (input, expected) => {
    expect(keysOf(input)).toEqual([expected]);
  });

  it('ignores other printable and control bytes', () => {
    expect(keysOf('abdefghjklnoprstuvwxyz0123456789\t\r\n\x00\x7f')).toEqual([]);
  });
});

describe('[REQ-SYNC-05][REQ-UI-02] key router: arrows', () => {
  const left5 = { type: 'seek', deltaSec: -5 };
  const right5 = { type: 'seek', deltaSec: 5 };
  const left30 = { type: 'seek', deltaSec: -30 };
  const right30 = { type: 'seek', deltaSec: 30 };

  it.each([
    ['CSI D', '\x1b[D', left5],
    ['SS3 D', '\x1bOD', left5],
    ['CSI 1;1 D', '\x1b[1;1D', left5],
    ['CSI C', '\x1b[C', right5],
    ['SS3 C', '\x1bOC', right5],
    ['CSI 1;1 C', '\x1b[1;1C', right5],
    ['Shift+Left CSI 1;2 D', '\x1b[1;2D', left30],
    ['Shift+Left CSI 2 D', '\x1b[2D', left30],
    ['Shift+Right CSI 1;2 C', '\x1b[1;2C', right30],
    ['Shift+Right CSI 2 C', '\x1b[2C', right30],
  ])('%s', (_name, input, expected) => {
    expect(keysOf(input)).toEqual([expected]);
  });

  it('decodes the Apple Terminal 488 bytes from EVIDENCE.md', () => {
    // Left CSI D, Right CSI C, Shift+Left CSI 1;2D, Shift+Right CSI 1;2C, Space, q
    expect(keysOf('\x1b[D\x1b[C\x1b[1;2D\x1b[1;2C q')).toEqual([
      left5,
      right5,
      left30,
      right30,
      { type: 'toggle-pause' },
      { type: 'quit' },
    ]);
  });

  it('delivers q after arrows in one stream', () => {
    expect(keysOf('\x1b[D\x1b[C\x1b[1;2Dq')).toEqual([left5, right5, left30, { type: 'quit' }]);
  });

  it('ignores arrows with modifiers it does not map', () => {
    expect(keysOf('\x1b[1;3C\x1b[1;5D\x1b[5C\x1bO2C')).toEqual([]);
  });
});

describe('[REQ-UI-02] key router: unknown sequences and noise', () => {
  it('consumes unknown CSI sequences without emitting', () => {
    expect(keysOf('\x1b[A\x1b[B\x1b[3~\x1b[1;5P\x1b[?25h\x1b[200~')).toEqual([]);
  });

  it('does not mistake a final byte of an unknown CSI for a key', () => {
    // CSI 5 q, CSI m, CSI c would be q, m, c if the escape were dropped
    expect(keysOf('\x1b[5 q\x1b[m\x1b[?1;2c')).toEqual([]);
  });

  it('consumes unknown SS3 sequences', () => {
    expect(keysOf('\x1bOP\x1bOQ\x1bOR\x1bOS')).toEqual([]);
  });

  it('ignores UTF-8 text, including bytes that look like keys when split', () => {
    expect(keysOf('héllo wörld € 日本語 🎬'.replace(/ /g, ''))).toEqual([]);
    expect(keysOf('é€🎬q')).toEqual([{ type: 'quit' }]);
  });

  it('recovers from a truncated UTF-8 sequence', () => {
    const { events, router } = setup();
    router.feed(new Uint8Array([0xe2, 0x82, 0x71])); // incomplete euro sign, then q
    expect(events).toEqual([{ type: 'quit' }]);
  });

  it('ignores stray continuation bytes', () => {
    const { events, router } = setup();
    router.feed(new Uint8Array([0x80, 0xbf, 0xff, 0xc0]));
    expect(events).toEqual([]);
    expect(router.pendingLength()).toBe(0);
  });

  it('keeps Ctrl+C working inside and right after a broken sequence', () => {
    expect(keysOf('\x1b[1;\x03')).toEqual([{ type: 'interrupt' }]);
    expect(keysOf('\x1b\x03')).toEqual([{ type: 'interrupt' }]);
    expect(keysOf('\x1bO\x03')).toEqual([{ type: 'interrupt' }]);
  });

  it('treats ESC followed by a printable ASCII byte as an ignored Alt chord', () => {
    expect(keysOf('\x1bq')).toEqual([]);
    expect(keysOf('\x1bq ')).toEqual([{ type: 'toggle-pause' }]);
  });

  it('starts a new sequence when ESC interrupts one', () => {
    expect(keysOf('\x1b[1;\x1b[C')).toEqual([{ type: 'seek', deltaSec: 5 }]);
  });
});

describe('[REQ-UI-02] key router: bounded buffer', () => {
  it('drops an unterminated sequence after 64 bytes and swallows its tail', () => {
    const { events, router } = setup();
    router.feed(bytes('\x1b[' + '1;'.repeat(60)));
    expect(router.pendingLength()).toBeLessThanOrEqual(MAX_PENDING_BYTES);
    router.feed(bytes('q')); // final byte of the overlong sequence, not a quit key
    expect(events).toEqual([]);
    router.feed(bytes('q')); // resynced
    expect(events).toEqual([{ type: 'quit' }]);
    expect(router.pendingLength()).toBe(0);
  });

  it('never holds more than 64 bytes byte by byte', () => {
    const { router } = setup();
    router.feed(bytes('\x1b['));
    for (let i = 0; i < 200; i++) {
      router.feed(bytes('9'));
      expect(router.pendingLength()).toBeLessThanOrEqual(MAX_PENDING_BYTES);
    }
  });

  it('accepts a sequence of exactly the limit', () => {
    const { events, router } = setup();
    // ESC [ + 61 params + final C: 63 pending bytes before the final
    router.feed(bytes('\x1b[' + '5'.repeat(61) + 'C'));
    expect(events).toEqual([]); // long params are ignored, not an arrow
    expect(router.pendingLength()).toBe(0);
  });
});

describe('[REQ-UI-02] key router: lone ESC', () => {
  it('emits escape on flush()', () => {
    const { events, router, timers } = setup();
    router.feed(bytes('\x1b'));
    expect(events).toEqual([]);
    router.flush();
    expect(events).toEqual([{ type: 'escape' }]);
    expect(timers.pending()).toBe(0);
  });

  it('emits escape when the timer fires, with the default 50 ms delay', () => {
    const { events, router, timers } = setup();
    router.feed(bytes('\x1b'));
    expect(timers.pending()).toBe(1);
    expect(timers.lastDelay()).toBe(50);
    expect(events).toEqual([]);
    timers.fire();
    expect(events).toEqual([{ type: 'escape' }]);
  });

  it('honors escTimeoutMs', () => {
    const { router, timers } = setup(120);
    router.feed(bytes('\x1b'));
    expect(timers.lastDelay()).toBe(120);
  });

  it('cancels the timer when a follow-up byte arrives', () => {
    const { events, router, timers } = setup();
    router.feed(bytes('\x1b'));
    router.feed(bytes('[D'));
    expect(timers.pending()).toBe(0);
    timers.fire();
    expect(events).toEqual([{ type: 'seek', deltaSec: -5 }]);
  });

  it('does not emit escape when the timer fires after the state moved on', () => {
    const { events, router, timers } = setup();
    router.feed(bytes('\x1b['));
    timers.fire();
    expect(events).toEqual([]);
  });

  it('emits escape for ESC ESC, then the second ESC is pending', () => {
    const { events, router, timers } = setup();
    router.feed(bytes('\x1b\x1b'));
    expect(events).toEqual([{ type: 'escape' }]);
    expect(timers.pending()).toBe(1);
    timers.fire();
    expect(events).toEqual([{ type: 'escape' }, { type: 'escape' }]);
  });

  it('flush() leaves a partial CSI pending', () => {
    const { events, router } = setup();
    router.feed(bytes('\x1b[1;'));
    router.flush();
    expect(events).toEqual([]);
    router.feed(bytes('2D'));
    expect(events).toEqual([{ type: 'seek', deltaSec: -30 }]);
  });

  it('flush() with nothing pending is a no-op', () => {
    const { events, router } = setup();
    router.flush();
    expect(events).toEqual([]);
  });
});

describe('key router: dispose', () => {
  it('cancels the timer and ignores later input', () => {
    const { events, router, timers } = setup();
    router.feed(bytes('\x1b'));
    router.dispose();
    expect(timers.pending()).toBe(0);
    router.feed(bytes('q'));
    router.flush();
    expect(events).toEqual([]);
  });
});

describe('[REQ-UI-02] key router: split delivery', () => {
  it('decodes a sequence fed one byte at a time', () => {
    const { events, router } = setup();
    for (const b of bytes('\x1b[1;2C')) router.feed(new Uint8Array([b]));
    expect(events).toEqual([{ type: 'seek', deltaSec: 30 }]);
  });

  it('decodes a UTF-8 character split across feeds', () => {
    const { events, router } = setup();
    const euro = bytes('€');
    router.feed(euro.subarray(0, 1));
    router.feed(euro.subarray(1, 2));
    router.feed(euro.subarray(2));
    router.feed(bytes('q'));
    expect(events).toEqual([{ type: 'quit' }]);
  });
});
