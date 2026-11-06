// Fakes shared by the player control tests: a stdout that records writes (and can take time to
// write), a stdin that emits chunks, a screen that records cleanups, and a fake audio player.

import { EventEmitter } from 'node:events';
import type { AudioPlayer } from '../../src/audio/player.ts';
import type { MediaInfo } from '../../src/ingest/media-info.ts';
import { createPlayer } from '../../src/player/controller.ts';
import type { Player, PlayerDeps, PlayerStdin, PlayerStdout } from '../../src/player/controller.ts';
import { SYNC_BEGIN } from '../../src/renderer/sequences.ts';
import type { Screen } from '../../src/term/screen.ts';

export class FakeStdout extends EventEmitter implements PlayerStdout {
  columns: number;
  rows: number;
  writableNeedDrain = false;
  writableLength = 0;
  writes: (Uint8Array | string)[] = [];
  /** Called after each write was recorded. May advance a simulated clock to model a slow terminal. */
  onWrite: ((index: number) => void) | null = null;
  constructor(columns: number, rows: number) {
    super();
    this.columns = columns;
    this.rows = rows;
  }
  write(data: Uint8Array | string): boolean {
    // The serializer reuses its buffer, so keep a copy.
    this.writes.push(typeof data === 'string' ? data : Uint8Array.from(data));
    this.onWrite?.(this.writes.length - 1);
    return true;
  }
  asText(i: number): string {
    const w = this.writes[i];
    if (w === undefined) return '';
    return typeof w === 'string' ? w : Buffer.from(w).toString('utf8');
  }
  /** Writes that carry a video frame (start with the synchronized-update begin). */
  frames(): number {
    return this.writes.filter((_, i) => this.asText(i).startsWith(SYNC_BEGIN)).length;
  }
  text(from = 0): string {
    let out = '';
    for (let i = from; i < this.writes.length; i++) out += this.asText(i);
    return out;
  }
}

export class FakeStdin extends EventEmitter implements PlayerStdin {
  resumed = false;
  resume(): this {
    this.resumed = true;
    return this;
  }
  key(text: string): void {
    this.emit('data', Buffer.from(text, 'latin1'));
  }
}

export function fakeScreen(): { screen: Screen; cleanups: (() => void)[] } {
  const cleanups: (() => void)[] = [];
  const screen: Screen = {
    isActive: true,
    enter: () => undefined,
    restore: () => undefined,
    addCleanup: (fn) => {
      cleanups.push(fn);
    },
  };
  return { screen, cleanups };
}

/**
 * Records every call and models the audio clock like the real player: the position holds at the
 * segment start until release(), runs in wall time, and freezes while paused. `ready()` is true
 * `readyAfterMs` after start() or seek(), so tests can model a slow audio source.
 */
export class FakeAudio implements AudioPlayer {
  /** Positions passed to start() and seek(), in order. */
  plays: number[] = [];
  starts: number[] = [];
  seeks: number[] = [];
  pauses = 0;
  resumes = 0;
  releases = 0;
  stops = 0;
  killed = 0;
  errorCallbacks: ((message: string) => void)[] = [];
  endCallbacks: (() => void)[] = [];
  readyAfterMs = 0;
  private now: () => number;
  private segStart = 0;
  private segAt = 0;
  private runAt: number | null = null;
  private frozen = 0;
  private isPaused = false;
  private isFailed = false;
  constructor(now: () => number = () => performance.now()) {
    this.now = now;
  }
  private begin(sec: number): void {
    this.plays.push(sec);
    this.segStart = sec;
    this.segAt = this.now();
    this.runAt = null;
    this.frozen = 0;
  }
  start(atSec: number): void {
    this.starts.push(atSec);
    this.begin(atSec);
  }
  seek(sec: number): void {
    this.seeks.push(sec);
    this.begin(sec);
  }
  release(): void {
    if (this.runAt !== null) return;
    this.releases++;
    this.runAt = this.now();
  }
  pause(): void {
    if (this.isPaused) return;
    this.isPaused = true;
    this.pauses++;
    this.frozen = this.elapsed();
  }
  resume(): void {
    if (!this.isPaused) return;
    this.isPaused = false;
    this.resumes++;
    if (this.runAt !== null) this.runAt = this.now() - this.frozen * 1000;
  }
  private elapsed(): number {
    if (this.runAt === null) return 0;
    return Math.max(0, this.now() - this.runAt) / 1000;
  }
  ready(): boolean {
    return this.isFailed || this.now() - this.segAt >= this.readyAfterMs;
  }
  positionSec(): number {
    return this.segStart + (this.isPaused ? this.frozen : this.elapsed());
  }
  failed(): boolean {
    return this.isFailed;
  }
  stop(): Promise<void> {
    this.stops++;
    return Promise.resolve();
  }
  killNow(): void {
    this.killed++;
  }
  pids(): number[] {
    return [];
  }
  onEnd(cb: () => void): void {
    this.endCallbacks.push(cb);
  }
  onError(cb: (message: string) => void): void {
    this.errorCallbacks.push(cb);
  }
  stats(): null {
    return null;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await sleep(5);
  }
  return cond();
}

/** Process start-up is slow on some machines (Windows CI), so waits for the first frames are generous. */
export const STARTUP_MS = 20_000;

export const MEDIA: MediaInfo = { width: 160, height: 90, fps: 30, durationSec: 60, hasAudio: false, source: 'demo' };

/** An endless 160x90 test pattern; the title tag gives the ffmpeg command line a unique marker. */
export function lavfi(marker: string, seconds: number | null = null): string[] {
  const duration = seconds === null ? '' : `:duration=${String(seconds)}`;
  return ['-f', 'lavfi', '-i', `testsrc2=size=160x90:rate=30${duration}`, '-metadata', `title=${marker}`];
}

export interface SetupOptions {
  cols?: number;
  rows?: number;
  marker?: string;
  /** Source length in seconds; null (default) is endless. */
  seconds?: number | null;
  extra?: Partial<PlayerDeps>;
}

export interface Setup {
  stdout: FakeStdout;
  stdin: FakeStdin;
  cleanups: (() => void)[];
  player: Player;
}

/** A player on fakes, fed by a real ffmpeg lavfi source. `extra` overrides any dependency. */
export function setup(opts: SetupOptions = {}): Setup {
  const stdout = new FakeStdout(opts.cols ?? 40, opts.rows ?? 12);
  const stdin = new FakeStdin();
  const { screen, cleanups } = fakeScreen();
  const player = createPlayer({
    stdout,
    stdin,
    screen,
    mediaInfo: MEDIA,
    inputArgs: lavfi(opts.marker ?? 'ctl', opts.seconds ?? null),
    isFile: false,
    fps: 30,
    cellAspect: 2,
    loop: false,
    // Governor off unless a test asks for it, so loaded machines cannot change quality mid-test.
    quality: 'max',
    ...opts.extra,
  });
  return { stdout, stdin, cleanups, player };
}
