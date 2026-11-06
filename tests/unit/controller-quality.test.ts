// Quality governor wired into the player (task 4.12, B1). A fake stdout that is slower in Braille
// than in half-block reproduces the report "cycling with m shrinks the video": Braille pushes the
// governor into the cell-cap levels (geometry shrinks), and a mode change used to keep the cap.
// Real ffmpeg lavfi sources feed the player; stdout, stdin and screen are fakes. The time a write
// "takes" is real: the fake spins for a mode-dependent number of milliseconds inside write().

import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import type { Player } from '../../src/player/controller.ts';
import { STARTUP_MS, setup, waitFor } from '../helpers/player-fakes.ts';
import type { FakeStdout } from '../helpers/player-fakes.ts';

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

/** Budget at 30 fps is 33.3 ms: half-block sits between 0.5 and 0.9 of it, Braille is over it. */
const HALFBLOCK_WRITE_MS = 20;
const BRAILLE_WRITE_MS = 45;
const TEST_TIMEOUT_MS = 90_000;

function spin(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    // Busy wait: the governor measures the real time of the write.
  }
}

/** Makes every write cost `costMs(mode)` of real time. */
function slowWrites(stdout: FakeStdout, player: () => Player | null, costMs: (mode: string) => number): void {
  stdout.onWrite = (): void => {
    const p = player();
    if (p !== null) spin(costMs(p.state().mode));
  };
}

describe.skipIf(!hasFfmpeg)('[REQ-PERF-01] quality governor and mode changes', () => {
  it(
    'a mode change drops the cell cap at once and the picture returns to full size, with HUD messages for both size changes',
    async () => {
      let player: Player | null = null;
      const s = setup({
        marker: 'quality-mode',
        cols: 120,
        rows: 40,
        extra: { quality: 'auto', mode: 'braille' },
      });
      player = s.player;
      slowWrites(s.stdout, () => player, (mode) => (mode === 'braille' ? BRAILLE_WRITE_MS : HALFBLOCK_WRITE_MS));

      const result = player.start();

      // Braille is over budget: the governor walks down into a cell-cap level, which takes about 6 s
      // (three color levels at 1 s each, then 3 s over budget).
      expect(await waitFor(() => player.state().maxCells !== null, STARTUP_MS)).toBe(true);
      expect(player.state().qualityLevel).toBeGreaterThanOrEqual(4);
      expect(await waitFor(() => s.stdout.text().includes('quality: smaller picture'), STARTUP_MS)).toBe(true);
      const startsBefore = player.counters().decoderStarts;

      // Braille -> half-block: the cap goes away in the same call, before any new measurement.
      s.stdin.key('m'); // braille -> halfblock (cycle order halfblock, ascii, braille)
      const after = player.state();
      expect(after.mode).toBe('halfblock');
      expect(after.maxCells).toBeNull();
      expect(after.qualityLevel).toBeLessThanOrEqual(3);
      expect(player.counters().decoderStarts).toBeGreaterThan(startsBefore);
      expect(await waitFor(() => s.stdout.text().includes('quality: full size'), STARTUP_MS)).toBe(true);

      // Half-block at 20 ms per frame is between 0.5 and 0.9 of the budget: it stays at full size.
      const startsAfter = player.counters().decoderStarts;
      await new Promise((r) => setTimeout(r, 2500));
      expect(player.state().maxCells).toBeNull();
      expect(player.counters().decoderStarts).toBe(startsAfter);

      s.stdin.key('q');
      expect(await result).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'a palette change also drops the cell cap',
    async () => {
      let player: Player | null = null;
      const s = setup({
        marker: 'quality-palette',
        cols: 120,
        rows: 40,
        extra: { quality: 'auto', mode: 'braille' },
      });
      player = s.player;
      slowWrites(s.stdout, () => player, (mode) => (mode === 'braille' ? BRAILLE_WRITE_MS : HALFBLOCK_WRITE_MS));
      const result = player.start();
      expect(await waitFor(() => player.state().maxCells !== null, STARTUP_MS)).toBe(true);

      s.stdin.key('c');
      expect(player.state().maxCells).toBeNull();
      expect(player.state().qualityLevel).toBeLessThanOrEqual(3);

      s.stdin.key('q');
      expect(await result).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'with --quality max a mode change starts no decoder and shows no quality message',
    async () => {
      const s = setup({ marker: 'quality-max', extra: { quality: 'max' } });
      const result = s.player.start();
      expect(await waitFor(() => s.stdout.frames() > 3, STARTUP_MS)).toBe(true);
      const starts = s.player.counters().decoderStarts;
      s.stdin.key('m');
      s.stdin.key('m');
      expect(s.player.counters().decoderStarts).toBe(starts);
      expect(s.stdout.text()).not.toContain('quality:');
      s.stdin.key('q');
      expect(await result).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );
});
