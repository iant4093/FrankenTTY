// Raw key byte stream -> key events (REQ-UI-01, REQ-UI-02, REQ-SYNC-05).
//
// A byte-at-a-time state machine, so the result is identical for any split of
// the stream. Nothing here allocates per key: events are shared frozen objects
// and sequence parameters live in one preallocated buffer.
//
// State handling notes:
// - ESC followed by `[` or `O` starts a CSI / SS3 sequence. ESC followed by any
//   other printable ASCII byte is an Alt+key chord: both bytes are consumed
//   and ignored. ESC followed by a control or non-ASCII byte drops the ESC and
//   processes that byte normally.
//   ESC ESC emits `escape` for the first and keeps the second pending.
// - A lone ESC becomes `escape` after `escTimeoutMs`, or on flush().
// - An unterminated sequence is dropped after 64 pending bytes. The router
//   then discards the rest of that sequence up to its final byte, so a late
//   final byte such as `q` is not mistaken for a key press.
// - A control byte or non-ASCII byte inside a sequence aborts it and is
//   processed again as a fresh byte.
// - The key callback runs after the router state is updated. If it throws, the
//   exception propagates and the rest of that chunk is not processed.

import { CSI_BYTE, ESC_BYTE, SS3_BYTE } from '../renderer/sequences.ts';

export type SeekDelta = -30 | -5 | 5 | 30;

export type KeyEvent =
  | { readonly type: 'toggle-pause' }
  | { readonly type: 'quit' }
  | { readonly type: 'interrupt' }
  | { readonly type: 'cycle-mode' }
  | { readonly type: 'cycle-palette' }
  | { readonly type: 'toggle-hud' }
  | { readonly type: 'seek'; readonly deltaSec: SeekDelta }
  | { readonly type: 'escape' };

export interface KeyRouterOptions {
  onKey: (key: KeyEvent) => void;
  /** Milliseconds a lone ESC waits for a follow-up byte. Default 50. */
  escTimeoutMs?: number;
  /** Timer injection for tests. Defaults to an unref'd `setTimeout`. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface KeyRouter {
  feed(bytes: Uint8Array): void;
  /** Emits a pending lone ESC as `escape` now. Other partial input stays pending. */
  flush(): void;
  /** Cancels the ESC timer and ignores all later input. */
  dispose(): void;
  /** Bytes held for the current unfinished sequence. Never exceeds MAX_PENDING_BYTES. */
  pendingLength(): number;
}

/** Longest unterminated sequence held before it is dropped. */
export const MAX_PENDING_BYTES = 64;
export const DEFAULT_ESC_TIMEOUT_MS = 50;

const EV_TOGGLE_PAUSE: KeyEvent = Object.freeze({ type: 'toggle-pause' });
const EV_QUIT: KeyEvent = Object.freeze({ type: 'quit' });
const EV_INTERRUPT: KeyEvent = Object.freeze({ type: 'interrupt' });
const EV_CYCLE_MODE: KeyEvent = Object.freeze({ type: 'cycle-mode' });
const EV_CYCLE_PALETTE: KeyEvent = Object.freeze({ type: 'cycle-palette' });
const EV_TOGGLE_HUD: KeyEvent = Object.freeze({ type: 'toggle-hud' });
const EV_ESCAPE: KeyEvent = Object.freeze({ type: 'escape' });
const EV_SEEK_BACK_5: KeyEvent = Object.freeze({ type: 'seek', deltaSec: -5 });
const EV_SEEK_FWD_5: KeyEvent = Object.freeze({ type: 'seek', deltaSec: 5 });
const EV_SEEK_BACK_30: KeyEvent = Object.freeze({ type: 'seek', deltaSec: -30 });
const EV_SEEK_FWD_30: KeyEvent = Object.freeze({ type: 'seek', deltaSec: 30 });

// Router states (plain constants: enums are not erasable).
const GROUND = 0;
const ESC = 1;
const SEQ = 2; // CSI or SS3, parameters being collected
const DISCARD = 3; // overlong sequence, swallow up to its final byte
const UTF8 = 4;

const BYTE_SPACE = 0x20;
const BYTE_CTRL_C = 0x03;
const BYTE_SEMI = 0x3b;
const BYTE_1 = 0x31;
const BYTE_2 = 0x32;
const BYTE_C = 0x43;
const BYTE_D = 0x44;

function defaultSetTimer(fn: () => void, ms: number): unknown {
  const handle = setTimeout(fn, ms);
  handle.unref();
  return handle;
}

function defaultClearTimer(handle: unknown): void {
  clearTimeout(handle as ReturnType<typeof setTimeout>);
}

export function createKeyRouter(options: KeyRouterOptions): KeyRouter {
  const onKey = options.onKey;
  const escTimeoutMs = options.escTimeoutMs ?? DEFAULT_ESC_TIMEOUT_MS;
  const setTimer = options.setTimer ?? defaultSetTimer;
  const clearTimer = options.clearTimer ?? defaultClearTimer;

  let state = GROUND;
  let disposed = false;

  // CSI / SS3 parameter and intermediate bytes (0x20-0x3F).
  const seq = new Uint8Array(MAX_PENDING_BYTES);
  let seqLen = 0;
  let seqIsSs3 = false;

  // UTF-8 continuation tracking.
  let utf8Remaining = 0;
  let utf8Seen = 0;

  let timerHandle: unknown = undefined;
  let timerArmed = false;

  function armTimer(): void {
    if (timerArmed) return;
    timerHandle = setTimer(onTimeout, escTimeoutMs);
    timerArmed = true;
  }

  function disarmTimer(): void {
    if (!timerArmed) return;
    timerArmed = false;
    const handle = timerHandle;
    timerHandle = undefined;
    clearTimer(handle);
  }

  function onTimeout(): void {
    timerArmed = false;
    timerHandle = undefined;
    if (disposed || state !== ESC) return;
    state = GROUND;
    onKey(EV_ESCAPE);
  }

  /** Decodes a finished CSI / SS3 sequence. Returns null when the sequence is ignored. */
  function decodeSequence(final: number): KeyEvent | null {
    if (final !== BYTE_C && final !== BYTE_D) return null;
    const forward = final === BYTE_C;
    if (seqLen === 0) return forward ? EV_SEEK_FWD_5 : EV_SEEK_BACK_5;
    if (seqIsSs3) return null;
    if (seqLen === 1 && seq[0] === BYTE_2) return forward ? EV_SEEK_FWD_30 : EV_SEEK_BACK_30;
    if (seqLen === 3 && seq[0] === BYTE_1 && seq[1] === BYTE_SEMI) {
      if (seq[2] === BYTE_1) return forward ? EV_SEEK_FWD_5 : EV_SEEK_BACK_5;
      if (seq[2] === BYTE_2) return forward ? EV_SEEK_FWD_30 : EV_SEEK_BACK_30;
    }
    return null;
  }

  function ground(b: number): void {
    switch (b) {
      case BYTE_SPACE:
        onKey(EV_TOGGLE_PAUSE);
        return;
      case 0x71: // q
      case 0x51: // Q
        onKey(EV_QUIT);
        return;
      case BYTE_CTRL_C:
        onKey(EV_INTERRUPT);
        return;
      case 0x6d: // m
      case 0x4d: // M
        onKey(EV_CYCLE_MODE);
        return;
      case 0x63: // c
      case 0x43: // C
        onKey(EV_CYCLE_PALETTE);
        return;
      case 0x69: // i
      case 0x49: // I
        onKey(EV_TOGGLE_HUD);
        return;
      case ESC_BYTE:
        state = ESC;
        return;
      default:
        break;
    }
    if (b >= 0xc2 && b <= 0xf4) {
      utf8Remaining = b >= 0xf0 ? 3 : b >= 0xe0 ? 2 : 1;
      utf8Seen = 1;
      state = UTF8;
    }
    // Everything else (other controls, stray continuation bytes) is ignored.
  }

  function step(b: number): void {
    switch (state) {
      case GROUND:
        ground(b);
        return;

      case ESC:
        disarmTimer();
        if (b === CSI_BYTE || b === SS3_BYTE) {
          state = SEQ;
          seqLen = 0;
          seqIsSs3 = b === SS3_BYTE;
          return;
        }
        if (b === ESC_BYTE) {
          // State stays ESC: the second ESC is itself pending.
          onKey(EV_ESCAPE);
          return;
        }
        state = GROUND;
        // ESC + printable ASCII is an Alt chord: both bytes are ignored. Controls
        // (so Ctrl+C still works) and non-ASCII bytes are processed on their own.
        if (b < BYTE_SPACE || b > 0x7e) ground(b);
        return;

      case SEQ:
        if (b >= 0x40 && b <= 0x7e) {
          const event = decodeSequence(b);
          state = GROUND;
          seqLen = 0;
          if (event !== null) onKey(event);
          return;
        }
        if (b >= BYTE_SPACE && b <= 0x3f) {
          if (2 + seqLen + 1 > MAX_PENDING_BYTES) {
            state = DISCARD;
            seqLen = 0;
            return;
          }
          seq[seqLen++] = b;
          return;
        }
        state = GROUND;
        seqLen = 0;
        step(b);
        return;

      case DISCARD:
        if (b >= 0x40 && b <= 0x7e) {
          state = GROUND;
          return;
        }
        if (b >= BYTE_SPACE && b <= 0x3f) return;
        state = GROUND;
        step(b);
        return;

      case UTF8:
        if ((b & 0xc0) === 0x80) {
          utf8Seen++;
          utf8Remaining--;
          if (utf8Remaining === 0) state = GROUND;
          return;
        }
        state = GROUND;
        step(b);
        return;

      default:
        state = GROUND;
        return;
    }
  }

  return {
    feed(bytes: Uint8Array): void {
      if (disposed) return;
      const n = bytes.length;
      for (let i = 0; i < n; i++) {
        step(bytes[i] ?? 0);
        if (disposed) return;
      }
      if (state === ESC) armTimer();
    },

    flush(): void {
      if (disposed) return;
      disarmTimer();
      if (state === ESC) {
        state = GROUND;
        onKey(EV_ESCAPE);
      }
    },

    dispose(): void {
      disposed = true;
      disarmTimer();
      state = GROUND;
      seqLen = 0;
    },

    pendingLength(): number {
      switch (state) {
        case ESC:
          return 1;
        case SEQ:
          return 2 + seqLen;
        case UTF8:
          return utf8Seen;
        default:
          return 0;
      }
    },
  };
}
