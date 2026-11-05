// Player controls (task 4.4): pause/resume, seek, mode and palette cycling, HUD, audio wiring and the
// quality governor. Real ffmpeg lavfi sources feed the player; stdout, stdin, screen and audio are fakes.

import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { CLEAR, ERASE_LINE, SGR_HUD, SGR_RESET, SYNC_BEGIN, SYNC_END, cursorPosition } from '../../src/renderer/sequences.ts';
import { formatClock } from '../../src/player/controller.ts';
import { FakeAudio, MEDIA, STARTUP_MS, setup, sleep, waitFor } from '../helpers/player-fakes.ts';

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

const RIGHT = '\x1b[C';
const SHIFT_RIGHT = '\x1b[1;2C';
const SHIFT_LEFT = '\x1b[1;2D';

describe('formatClock', () => {
  it('formats m:ss and h:mm:ss', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(17.9)).toBe('0:17');
    expect(formatClock(75)).toBe('1:15');
    expect(formatClock(3600)).toBe('1:00:00');
    expect(formatClock(3725)).toBe('1:02:05');
    expect(formatClock(-3)).toBe('0:00');
    expect(formatClock(Number.NaN)).toBe('0:00');
  });
});

describe.skipIf(!hasFfmpeg)('pause and resume (REQ-SYNC-03)', () => {
  it('pause freezes the position and the frames; resume continues from the paused position', async () => {
    const { stdout, stdin, player } = setup({ marker: 'ctl-pause' });
    const result = player.start();
    expect(await waitFor(() => stdout.frames() > 3, STARTUP_MS)).toBe(true);

    stdin.key(' ');
    await sleep(100);
    const pausedAt = player.state().positionSec;
    const framesBefore = stdout.frames();
    const writesBefore = stdout.writes.length;
    expect(player.state().paused).toBe(true);
    expect(stdout.text()).toContain('\u23f8');

    await sleep(600);
    expect(stdout.frames()).toBe(framesBefore);
    expect(stdout.writes.length).toBe(writesBefore);
    expect(player.state().positionSec).toBe(pausedAt);

    stdin.key(' ');
    expect(player.state().paused).toBe(false);
    expect(await waitFor(() => stdout.frames() > framesBefore + 3, STARTUP_MS)).toBe(true);
    const resumed = player.state().positionSec;
    expect(resumed).toBeGreaterThan(pausedAt);
    expect(resumed - pausedAt).toBeLessThan(2);
    expect(stdout.text()).toContain('\u25b6');

    stdin.key('q');
    expect(await result).toBe(0);
  });

  it('stops the audio on pause and restarts it at the paused position on resume', async () => {
    const audio = new FakeAudio(() => performance.now());
    const { stdout, stdin, player } = setup({ marker: 'ctl-pause-audio', extra: { audio } });
    const result = player.start();
    expect(audio.plays).toEqual([0]);
    await waitFor(() => stdout.frames() > 3, STARTUP_MS);

    stdin.key(' ');
    expect(audio.stops).toBe(1);
    const pausedAt = player.state().positionSec;
    await sleep(100);
    stdin.key(' ');
    expect(audio.plays).toHaveLength(2);
    expect(audio.plays[1]).toBeCloseTo(pausedAt, 3);

    stdin.key('q');
    expect(await result).toBe(0);
    expect(audio.killed).toBeGreaterThanOrEqual(1);
  });

  it('a key typed during the probe (initialInput) is handled as soon as playback starts', async () => {
    const quit = setup({ marker: 'ctl-init-q', extra: { initialInput: Buffer.from('q') } });
    expect(await quit.player.start()).toBe(0);

    const pause = setup({ marker: 'ctl-init-space', extra: { initialInput: Buffer.from(' ') } });
    const result = pause.player.start();
    expect(pause.player.state().paused).toBe(true);
    // Paused before the first frame: that frame is still shown.
    expect(await waitFor(() => pause.stdout.frames() === 1, STARTUP_MS)).toBe(true);
    await sleep(300);
    expect(pause.stdout.frames()).toBe(1);
    pause.stdin.key('q');
    expect(await result).toBe(0);
  });
});

describe.skipIf(!hasFfmpeg)('seek (REQ-SYNC-05)', () => {
  it('coalesces three quick +5 presses into one +15 s seek', async () => {
    const { stdout, stdin, player } = setup({ marker: 'ctl-seek3' });
    const result = player.start();
    expect(await waitFor(() => stdout.frames() > 3, STARTUP_MS)).toBe(true);
    const startsBefore = player.counters().decoderStarts;
    const before = player.state().positionSec;

    stdin.key(RIGHT);
    await sleep(20);
    stdin.key(RIGHT);
    await sleep(20);
    stdin.key(RIGHT);
    expect(await waitFor(() => player.state().message !== null, 2000)).toBe(true);

    expect(player.state().message).toMatch(/^\u00bb \+15s 0:\d\d$/);
    expect(player.counters().decoderStarts).toBe(startsBefore + 1);
    const after = player.state().positionSec;
    expect(after).toBeGreaterThanOrEqual(before + 15);
    expect(after).toBeLessThan(before + 17);

    // Frames keep coming from the new decoder, and the HUD shows the message.
    const frames = stdout.frames();
    expect(await waitFor(() => stdout.frames() > frames + 3, STARTUP_MS)).toBe(true);
    expect(stdout.text()).toContain('\u00bb +15s');

    stdin.key('q');
    expect(await result).toBe(0);
  });

  it('clamps to 0 at the start and to duration - 0.5 s near the end', async () => {
    const { stdout, stdin, player } = setup({
      marker: 'ctl-clamp',
      extra: { mediaInfo: { ...MEDIA, durationSec: 2 } },
    });
    const result = player.start();
    expect(await waitFor(() => stdout.frames() > 3, STARTUP_MS)).toBe(true);

    stdin.key(SHIFT_RIGHT);
    expect(await waitFor(() => player.state().message?.startsWith('\u00bb +30s') === true, 2000)).toBe(true);
    expect(player.state().message).toBe('\u00bb +30s 0:01');
    expect(player.state().positionSec).toBeGreaterThanOrEqual(1.5);
    expect(player.state().positionSec).toBeLessThan(2.1);

    stdin.key(SHIFT_LEFT);
    expect(await waitFor(() => player.state().message?.startsWith('\u00bb -30s') === true, 2000)).toBe(true);
    expect(player.state().message).toBe('\u00bb -30s 0:00');
    expect(player.state().positionSec).toBeLessThan(0.6);

    stdin.key('q');
    expect(await result).toBe(0);
  });

  it('while paused, a seek shows the new frame and stays paused; audio stays stopped', async () => {
    const audio = new FakeAudio(() => performance.now());
    const { stdout, stdin, player } = setup({ marker: 'ctl-seek-paused', extra: { audio } });
    const result = player.start();
    await waitFor(() => stdout.frames() > 3, STARTUP_MS);

    stdin.key(' ');
    await sleep(100);
    const pausedAt = player.state().positionSec;
    const frames = stdout.frames();
    const starts = player.counters().decoderStarts;
    const plays = audio.plays.length;

    stdin.key(RIGHT);
    expect(await waitFor(() => stdout.frames() === frames + 1, STARTUP_MS)).toBe(true);
    expect(player.counters().decoderStarts).toBe(starts + 1);
    expect(player.state().paused).toBe(true);
    expect(player.state().positionSec).toBeCloseTo(pausedAt + 5, 3);
    expect(audio.plays).toHaveLength(plays);

    await sleep(400);
    expect(stdout.frames()).toBe(frames + 1);

    // Resuming restarts the audio at the seek target.
    stdin.key(' ');
    expect(audio.plays).toHaveLength(plays + 1);
    expect(audio.plays[plays]).toBeCloseTo(pausedAt + 5, 3);

    stdin.key('q');
    expect(await result).toBe(0);
  });

  it('while playing, a seek restarts the audio at the target and re-anchors the clock', async () => {
    const audio = new FakeAudio(() => performance.now());
    const { stdout, stdin, player } = setup({ marker: 'ctl-seek-audio', extra: { audio } });
    const result = player.start();
    await waitFor(() => stdout.frames() > 3, STARTUP_MS);
    const before = player.state().positionSec;

    stdin.key(SHIFT_RIGHT);
    expect(await waitFor(() => audio.plays.length === 2, 2000)).toBe(true);
    expect(audio.plays[1]).toBeGreaterThanOrEqual(before + 30);
    expect(audio.plays[1]).toBeLessThan(before + 31);

    stdin.key('q');
    expect(await result).toBe(0);
  });
});

describe.skipIf(!hasFfmpeg)('mode, palette and HUD keys (REQ-UI-01)', () => {
  it('m cycles halfblock -> ascii -> braille -> halfblock and names the mode on the HUD', async () => {
    const { stdout, stdin, player } = setup({ marker: 'ctl-mode' });
    const result = player.start();
    expect(player.state().mode).toBe('halfblock');
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      stdin.key('m');
      seen.push(player.state().mode);
    }
    expect(seen).toEqual(['ascii', 'braille', 'halfblock', 'ascii']);
    expect(player.state().message).toBe('mode ascii');
    expect(await waitFor(() => stdout.text().includes('mode ascii'), STARTUP_MS)).toBe(true);
    stdin.key('q');
    expect(await result).toBe(0);
  });

  it('m skips Braille when it is unavailable, and stays on ascii without a UTF-8 locale', async () => {
    const noBraille = setup({ marker: 'ctl-mode-nb', extra: { braille: false } });
    const r1 = noBraille.player.start();
    const seen: string[] = [];
    for (let i = 0; i < 3; i++) {
      noBraille.stdin.key('m');
      seen.push(noBraille.player.state().mode);
    }
    expect(seen).toEqual(['ascii', 'halfblock', 'ascii']);
    noBraille.stdin.key('q');
    await r1;

    const ascii = setup({ marker: 'ctl-mode-ascii', extra: { mode: 'ascii', unicode: false, braille: false } });
    const r2 = ascii.player.start();
    ascii.stdin.key('m');
    ascii.stdin.key('m');
    expect(ascii.player.state().mode).toBe('ascii');
    ascii.stdin.key('q');
    await r2;
  });

  it('c cycles truecolor -> amber -> green -> dmg -> truecolor', async () => {
    const { stdin, player } = setup({ marker: 'ctl-palette' });
    const result = player.start();
    expect(player.state().palette).toBe('truecolor');
    const seen: string[] = [];
    for (let i = 0; i < 5; i++) {
      stdin.key('c');
      seen.push(player.state().palette);
    }
    expect(seen).toEqual(['amber', 'green', 'dmg', 'truecolor', 'amber']);
    expect(player.state().message).toBe('palette amber');
    stdin.key('q');
    expect(await result).toBe(0);
  });

  it('a mode change redraws the whole render area in the new mode', async () => {
    const { stdout, stdin, player } = setup({ marker: 'ctl-mode-redraw' });
    const result = player.start();
    await waitFor(() => stdout.frames() > 3, STARTUP_MS);
    const from = stdout.writes.length;
    stdin.key('m');
    expect(await waitFor(() => stdout.frames() > 0 && /[.:\-=+*#%@]/.test(stdout.text(from)), STARTUP_MS)).toBe(true);
    await sleep(200);
    expect(stdout.text(from + 1)).not.toContain('\u2580');
    stdin.key('q');
    await result;
  });

  it('i hides and shows the HUD; the bottom row stays reserved either way', async () => {
    const { stdout, stdin, player } = setup({ marker: 'ctl-hud' });
    const result = player.start();
    expect(await waitFor(() => stdout.frames() > 5, STARTUP_MS)).toBe(true);
    expect(player.state().hudVisible).toBe(true);

    stdin.key('i');
    expect(player.state().hudVisible).toBe(false);
    const eraseAt = stdout.writes.length - 1;
    expect(stdout.asText(eraseAt)).toBe(cursorPosition(12, 1) + SGR_RESET + ERASE_LINE);
    const frames = stdout.frames();
    expect(await waitFor(() => stdout.frames() > frames + 5, STARTUP_MS)).toBe(true);
    expect(stdout.text(eraseAt + 1)).not.toContain(SGR_HUD);

    stdin.key('i');
    expect(player.state().hudVisible).toBe(true);
    expect(stdout.text(eraseAt + 1)).toContain(SGR_HUD);
    expect(stdout.text(eraseAt + 1)).toContain('\u25b6');

    // Video never touches row 12, hidden or not. Only HUD writes (white on black) are positioned there.
    const moves = [...stdout.text().matchAll(/\x1b\[(\d+);\d+H(\x1b\[0;37;40m)?/g)];
    for (const m of moves) {
      if (m[2] === undefined && Number(m[1]) === 12) {
        // The only non-HUD move on row 12 is the one that erases the row.
        expect(stdout.text()).toContain(cursorPosition(12, 1) + SGR_RESET + ERASE_LINE);
      } else if (m[2] === undefined) {
        expect(Number(m[1])).toBeLessThanOrEqual(11);
      }
    }

    stdin.key('q');
    expect(await result).toBe(0);
  });

  it('writes the HUD inside the frame write (or alone for an unchanged frame), at most about 4 times per second', async () => {
    const { stdout, stdin, player } = setup({ marker: 'ctl-hud-cadence', cols: 100 });
    const result = player.start();
    expect(await waitFor(() => stdout.frames() > 3, STARTUP_MS)).toBe(true);
    const from = stdout.writes.length;
    const t0 = performance.now();
    await sleep(1500);
    const seconds = (performance.now() - t0) / 1000;
    stdin.key('q');
    await result;

    let hudFrames = 0;
    for (let i = from; i < stdout.writes.length; i++) {
      const text = stdout.asText(i);
      // One write per tick: a frame (with the HUD inside it when due), or the HUD row alone when the frame was empty.
      const isFrame = text.startsWith(SYNC_BEGIN);
      const isHudOnly = text.startsWith(cursorPosition(12, 1) + SGR_HUD);
      expect(isFrame || isHudOnly).toBe(true);
      if (text.includes(SGR_HUD)) {
        hudFrames++;
        if (isFrame) {
          expect(text.endsWith(SYNC_END)).toBe(true);
          expect(text.indexOf(SGR_HUD)).toBeGreaterThan(0);
          expect(text.lastIndexOf(SYNC_BEGIN)).toBe(0);
        }
      }
    }
    expect(hudFrames).toBeGreaterThanOrEqual(2);
    expect(hudFrames).toBeLessThanOrEqual(Math.ceil(seconds * 4) + 1);
  });

  it('with the HUD hidden from the start, nothing is ever written to the HUD row', async () => {
    const { stdout, stdin, player } = setup({ marker: 'ctl-hud-off', extra: { hudVisible: false } });
    const result = player.start();
    expect(await waitFor(() => stdout.frames() > 10, STARTUP_MS)).toBe(true);
    stdin.key('q');
    await result;
    expect(stdout.text()).not.toContain(SGR_HUD);
    expect(stdout.text()).not.toContain(ERASE_LINE);
    const rows = [...stdout.text().matchAll(/\x1b\[(\d+);\d+H/g)].map((m) => Number(m[1]));
    expect(Math.max(...rows)).toBeLessThanOrEqual(11);
  });

  it('the HUD shows fps, KB/s, SGR saving, quality step, color depth, mode and palette', async () => {
    const { stdout, stdin, player } = setup({ marker: 'ctl-hud-fields', cols: 100 });
    const result = player.start();
    expect(await waitFor(() => stdout.frames() > 40, STARTUP_MS)).toBe(true);
    await sleep(600);
    stdin.key('q');
    await result;
    const hud = [...stdout.text().matchAll(/(\d+\.\d) fps {2}(\d+) KB\/s {2}-(\d+)% SGR {2}Q(\d+) (24-bit|256|16) {2}(\w+) (\w+)/g)];
    const last = hud[hud.length - 1];
    expect(last).toBeDefined();
    expect(Number(last?.[1])).toBeGreaterThan(10);
    expect(Number(last?.[2])).toBeGreaterThan(0);
    expect(Number(last?.[3])).toBeGreaterThan(0);
    expect(last?.[4]).toBe('0');
    expect(last?.[5]).toBe('24-bit');
    expect(last?.[6]).toBe('halfblock');
    expect(last?.[7]).toBe('truecolor');
  });
});

describe.skipIf(!hasFfmpeg)('audio and the clock (REQ-SYNC-01, REQ-SYNC-02)', () => {
  it('anchors the clock at the audio spawn time', async () => {
    const audio = new FakeAudio(() => performance.now() - 300); // audio "started" 300 ms ago
    const { stdin, player } = setup({ marker: 'ctl-anchor', extra: { audio } });
    const result = player.start();
    expect(player.state().positionSec).toBeGreaterThanOrEqual(0.3);
    expect(player.state().positionSec).toBeLessThan(0.6);
    stdin.key('q');
    await result;
  });

  it('shows an audio error on the HUD and keeps playing', async () => {
    const audio = new FakeAudio(() => performance.now());
    const { stdout, stdin, player } = setup({ marker: 'ctl-audio-err', extra: { audio } });
    const result = player.start();
    await waitFor(() => stdout.frames() > 3, STARTUP_MS);
    audio.errorCallbacks[0]?.('ffplay: boom');
    expect(player.state().message).toBe('audio: ffplay: boom');
    const frames = stdout.frames();
    expect(await waitFor(() => stdout.frames() > frames + 3, STARTUP_MS)).toBe(true);
    stdin.key('q');
    expect(await result).toBe(0);
  });

  it('loop restarts video and audio together at 0', async () => {
    const audio = new FakeAudio(() => performance.now());
    const { stdin, player } = setup({ marker: 'ctl-loop-audio', seconds: 0.5, extra: { audio, loop: true } });
    const result = player.start();
    expect(await waitFor(() => audio.plays.length >= 3, STARTUP_MS)).toBe(true);
    expect(audio.plays.every((p) => p === 0)).toBe(true);
    expect(player.counters().decoderStarts).toBeGreaterThanOrEqual(3);
    stdin.key('q');
    expect(await result).toBe(0);
  });

  it('plays the stream to its end by the clock when there is no audio', async () => {
    const { player } = setup({ marker: 'ctl-wall', seconds: 1 });
    const t0 = Date.now();
    expect(await player.start()).toBe(0);
    expect(Date.now() - t0).toBeGreaterThan(800);
  });
});

/** A simulated clock: a terminal whose write() takes `writeMs` of simulated time. */
function simulated(writeMs: number) {
  let skew = 0;
  return {
    now: (): number => performance.now() + skew,
    advance: (): void => {
      skew += writeMs;
    },
  };
}

interface Snapshot {
  depth: number;
  threshold: number;
  maxCells: number | null;
  level: number;
  starts: number;
}

describe.skipIf(!hasFfmpeg)('quality governor wiring (REQ-PERF-01)', () => {
  it('80 ms writes at 30 fps step down to 256 colors without restarting the decoder', async () => {
    const sim = simulated(80);
    const { stdout, stdin, player } = setup({
      marker: 'ctl-gov-slow',
      cols: 100,
      extra: { quality: 'auto', now: sim.now },
    });
    const log: Snapshot[] = [];
    stdout.onWrite = () => {
      sim.advance();
      const s = player.state();
      log.push({ depth: s.depth, threshold: s.threshold, maxCells: s.maxCells, level: s.qualityLevel, starts: player.counters().decoderStarts });
    };
    const result = player.start();
    expect(await waitFor(() => player.state().depth === 8, STARTUP_MS)).toBe(true);
    const reached = log.length;
    await waitFor(() => stdout.writes.length > reached + 5, STARTUP_MS);

    const s = player.state();
    expect(s.depth).toBe(8);
    expect(s.qualityLevel).toBe(3); // 40x12 is small: no cell-cap steps exist
    expect(s.threshold).toBe(24); // 8 + 2 * 8
    expect(s.maxCells).toBeNull();
    // Threshold and depth steps never restarted the decoder.
    expect(log.every((e) => e.starts === 1)).toBe(true);
    // Threshold levels came first, then depth.
    const firstThreshold = log.findIndex((e) => e.threshold > 8);
    const firstDepth = log.findIndex((e) => e.depth === 8);
    expect(firstThreshold).toBeGreaterThanOrEqual(0);
    expect(firstDepth).toBeGreaterThan(firstThreshold);
    // The pipeline really switched: later frames use 256-color sequences only.
    const lastFrames = stdout.text(stdout.writes.length - 3);
    expect(lastFrames).toMatch(/\x1b\[[\d;]*[34]8;5;\d+/);
    expect(lastFrames).not.toMatch(/\x1b\[[\d;]*[34]8;2;/);
    expect(stdout.text()).toContain('Q3');

    stdin.key('q');
    expect(await result).toBe(0);
  });

  it('2 ms writes keep level 0', async () => {
    const sim = simulated(2);
    const { stdout, stdin, player } = setup({
      marker: 'ctl-gov-fast',
      extra: { quality: 'auto', now: sim.now },
    });
    stdout.onWrite = () => {
      sim.advance();
    };
    const result = player.start();
    expect(await waitFor(() => stdout.frames() > 60, STARTUP_MS)).toBe(true);
    const s = player.state();
    expect(s.qualityLevel).toBe(0);
    expect(s.depth).toBe(24);
    expect(s.threshold).toBe(8);
    expect(s.maxCells).toBeNull();
    expect(player.counters().decoderStarts).toBe(1);
    stdin.key('q');
    await result;
  });

  it('--quality max never steps, however slow the writes', async () => {
    const sim = simulated(80);
    const { stdout, stdin, player } = setup({
      marker: 'ctl-gov-max',
      extra: { quality: 'max', now: sim.now },
    });
    stdout.onWrite = () => {
      sim.advance();
    };
    const result = player.start();
    expect(await waitFor(() => stdout.frames() > 60, STARTUP_MS)).toBe(true);
    expect(player.state().qualityLevel).toBe(0);
    expect(player.state().depth).toBe(24);
    stdin.key('q');
    await result;
  });

  it('a cell-cap step clears the screen and restarts the decoder with the quality already reached', async () => {
    const sim = simulated(80);
    const { stdout, stdin, player } = setup({
      marker: 'ctl-gov-cells',
      cols: 120,
      rows: 40,
      extra: { quality: 'auto', now: sim.now },
    });
    const log: Snapshot[] = [];
    stdout.onWrite = () => {
      sim.advance();
      const s = player.state();
      log.push({ depth: s.depth, threshold: s.threshold, maxCells: s.maxCells, level: s.qualityLevel, starts: player.counters().decoderStarts });
    };
    const result = player.start();
    expect(await waitFor(() => player.state().maxCells !== null, STARTUP_MS)).toBe(true);
    expect(player.state().maxCells).toBeLessThanOrEqual(3264); // 120x34 = 4080 cells, first cap 0.8x
    expect(player.state().maxCells).toBeGreaterThanOrEqual(960);
    expect(player.state().depth).toBe(8);

    // Restarts happened only once a cell cap was chosen.
    expect(log.filter((e) => e.maxCells === null).every((e) => e.starts === 1)).toBe(true);
    expect(player.counters().decoderStarts).toBeGreaterThanOrEqual(2);

    // The screen was cleared, and frames after it keep arriving in 256 colors.
    const clearAt = stdout.writes.lastIndexOf(CLEAR);
    expect(clearAt).toBeGreaterThanOrEqual(0);
    const frames = stdout.frames();
    expect(await waitFor(() => stdout.frames() > frames + 2, STARTUP_MS)).toBe(true);
    const after = stdout.text(clearAt + 1);
    expect(after).toMatch(/\x1b\[[\d;]*[34]8;5;\d+/);
    expect(after).not.toMatch(/\x1b\[[\d;]*[34]8;2;/);

    stdin.key('q');
    expect(await result).toBe(0);
  });
});
