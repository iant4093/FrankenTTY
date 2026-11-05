// Presentation clock (REQ-SYNC-01..03). Pure apart from the injected `now()`.
//
// The clock tracks "media seconds". Internally it keeps `raw`, the position without the A/V
// offset, and adds the offset when reporting. Keeping the offset out of `raw` means that
// pause and resume do not add it a second time.
//
// Running:  raw = base + max(0, now - anchorMs) / 1000
// Paused:   raw = frozen
// position() = max(0, raw + offsetMs / 1000)
//
// A new clock is paused at 0 until start() or resume() is called.

export interface ClockOptions {
  /** Monotonic time source in milliseconds. Default `performance.now`. */
  now?: () => number;
  /** A/V offset in milliseconds (`--av-offset`), added to the reported position. Default 0. */
  offsetMs?: number;
}

export interface Clock {
  /** Starts running from `atSec` (clamped to >= 0), anchored at the current time. Also unpauses. */
  start(atSec: number): void;
  /** Freezes the position. No effect when already paused. */
  pause(): void;
  /** Continues from the frozen position, anchored at the current time. No effect when running. */
  resume(): void;
  /** Jumps to `sec` (clamped to >= 0). Keeps the paused or running state. */
  seek(sec: number): void;
  /**
   * Re-anchors a running clock: the position set by the latest start(), seek() or resume()
   * is reached at `atMs` (default: now). Use it with the time at which audio actually began
   * playing. Before `atMs` the position holds at that base value. No effect while paused.
   */
  anchor(atMs?: number): void;
  /** Current media position in seconds. Never negative. */
  position(): number;
  isPaused(): boolean;
}

function assertFinite(name: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${name} must be a finite number, got ${String(value)}`);
  }
}

export function createClock(opts: ClockOptions = {}): Clock {
  const now = opts.now ?? ((): number => performance.now());
  const offsetSec = (opts.offsetMs ?? 0) / 1000;
  assertFinite('offsetMs', offsetSec);

  let paused = true;
  /** Position without offset at `anchorMs` while running. */
  let base = 0;
  let anchorMs = 0;
  /** Position without offset while paused. */
  let frozen = 0;

  const raw = (): number => (paused ? frozen : base + Math.max(0, now() - anchorMs) / 1000);

  return {
    start(atSec) {
      assertFinite('atSec', atSec);
      base = Math.max(0, atSec);
      anchorMs = now();
      paused = false;
    },
    pause() {
      if (paused) return;
      frozen = raw();
      paused = true;
    },
    resume() {
      if (!paused) return;
      base = frozen;
      anchorMs = now();
      paused = false;
    },
    seek(sec) {
      assertFinite('sec', sec);
      const target = Math.max(0, sec);
      if (paused) {
        frozen = target;
      } else {
        base = target;
        anchorMs = now();
      }
    },
    anchor(atMs) {
      if (atMs !== undefined) assertFinite('atMs', atMs);
      if (paused) return;
      anchorMs = atMs ?? now();
    },
    position: () => Math.max(0, raw() + offsetSec),
    isPaused: () => paused,
  };
}
