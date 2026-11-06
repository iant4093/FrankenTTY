// Task 4.8: `resolveInput` picks the media inputs of every segment. Real ffmpeg lavfi sources feed the
// player (pure red before the "cache" is ready, pure blue after); stdout, stdin, screen and audio are fakes.

import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { FakeAudio, STARTUP_MS, setup, sleep, waitFor } from '../helpers/player-fakes.ts';

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

const RIGHT = '\x1b[C';
// Pure red and blue come out of the YUV -> RGB conversion as about 252,0,0 and 0,0,253.
const RED_BG = /48;2;25\d;0;0m/;
const BLUE_BG = /48;2;0;0;25\d/;

function solid(hexColor: string, marker: string, seconds?: number): string[] {
  const duration = seconds === undefined ? '' : `:duration=${String(seconds)}`;
  return ['-f', 'lavfi', '-i', `color=c=0x${hexColor}:size=160x90:rate=30${duration}`, '-metadata', `title=${marker}`];
}

describe.skipIf(!hasFfmpeg)('resolveInput (task 4.8)', () => {
  it('is called once per segment, video and audio of a segment share the call, and the switch happens at the next seek', async () => {
    const audio = new FakeAudio();
    let cacheReady = false;
    let calls = 0;
    const resolveInput = () => {
      calls++;
      return cacheReady
        ? { videoArgs: solid('0000ff', 'res-blue'), audioArgs: ['-i', `cached-${String(calls)}`] }
        : { videoArgs: solid('ff0000', 'res-red'), audioArgs: ['-i', `lavfi-${String(calls)}`] };
    };
    const { stdout, stdin, player } = setup({
      marker: 'res-seq',
      extra: { audio, resolveInput, seekNotice: () => (cacheReady ? null : 'preparing seek cache...') },
    });
    const result = player.start();

    // Start: one call; the audio source gets the audio half of that very call; the picture is red.
    expect(calls).toBe(1);
    expect(audio.starts).toEqual([0]);
    expect(audio.startArgs).toEqual([['-i', 'lavfi-1']]);
    expect(await waitFor(() => RED_BG.test(stdout.text()), STARTUP_MS)).toBe(true);
    expect(BLUE_BG.test(stdout.text())).toBe(false);

    // The cache becomes ready mid-segment: nothing changes until the next segment starts.
    cacheReady = true;
    await sleep(300);
    expect(calls).toBe(1);
    expect(BLUE_BG.test(stdout.text())).toBe(false);

    // Seek: exactly one more call, used for both the audio source and the video decoder.
    stdin.key(RIGHT);
    expect(await waitFor(() => audio.seeks.length === 1, 2000)).toBe(true);
    expect(calls).toBe(2);
    expect(audio.seekArgs).toEqual([['-i', 'cached-2']]);
    expect(await waitFor(() => BLUE_BG.test(stdout.text()), STARTUP_MS)).toBe(true);
    // The cache was ready at this seek, so no "preparing" notice.
    expect(player.state().message).toMatch(/^\u00bb \+5s 0:\d\d$/);

    stdin.key('q');
    expect(await result).toBe(0);
  });

  it('a seek while the cache is not ready says so in the HUD message', async () => {
    const audio = new FakeAudio();
    const { stdout, stdin, player } = setup({
      marker: 'res-notice',
      extra: {
        audio,
        resolveInput: () => ({ videoArgs: solid('ff0000', 'res-notice-v'), audioArgs: ['-i', 'x'] }),
        seekNotice: () => 'preparing seek cache...',
      },
    });
    const result = player.start();
    expect(await waitFor(() => stdout.frames() > 2, STARTUP_MS)).toBe(true);
    stdin.key(RIGHT);
    expect(await waitFor(() => player.state().message !== null, 2000)).toBe(true);
    expect(player.state().message).toMatch(/^\u00bb \+5s 0:\d\d {2}preparing seek cache\.\.\.$/);
    stdin.key('q');
    expect(await result).toBe(0);
  });

  it('loop and a terminal resize call it again: loop uses it for audio and video, resize for the video only', async () => {
    const audio = new FakeAudio();
    let calls = 0;
    const looped = setup({
      marker: 'res-loop',
      seconds: 0.5,
      extra: {
        audio,
        loop: true,
        resolveInput: () => {
          calls++;
          return { videoArgs: solid('ff0000', 'res-loop-v', 0.5), audioArgs: ['-i', `a${String(calls)}`] };
        },
      },
    });
    const result = looped.player.start();
    expect(await waitFor(() => audio.seeks.length >= 1, STARTUP_MS)).toBe(true);
    // Every audio call came with the audio half of one resolution, in order.
    const all = [...audio.startArgs, ...audio.seekArgs];
    expect(all.every((a) => a !== undefined && /^a\d+$/.test(a[1] ?? ''))).toBe(true);
    expect(calls).toBeGreaterThanOrEqual(audio.startArgs.length + audio.seekArgs.length);
    expect(audio.startArgs).toEqual([['-i', 'a1']]);
    looped.stdin.key('q');
    expect(await result).toBe(0);

    // Resize: one more call, no audio restart.
    const audio2 = new FakeAudio();
    let calls2 = 0;
    const resized = setup({
      marker: 'res-resize',
      extra: {
        audio: audio2,
        resolveInput: () => {
          calls2++;
          return { videoArgs: solid('ff0000', 'res-resize-v'), audioArgs: ['-i', 'a'] };
        },
      },
    });
    const result2 = resized.player.start();
    expect(await waitFor(() => resized.stdout.frames() > 2, STARTUP_MS)).toBe(true);
    expect(calls2).toBe(1);
    resized.stdout.columns = 60;
    resized.stdout.emit('resize');
    expect(await waitFor(() => calls2 === 2, 2000)).toBe(true);
    expect(audio2.starts).toHaveLength(1);
    expect(audio2.seeks).toHaveLength(0);
    resized.stdin.key('q');
    expect(await result2).toBe(0);
  });

  it('without resolveInput the player behaves as before: `inputArgs` for video, no audio arguments', async () => {
    const audio = new FakeAudio();
    const { stdout, stdin, player } = setup({ marker: 'res-none', extra: { audio } });
    const result = player.start();
    expect(await waitFor(() => stdout.frames() > 2, STARTUP_MS)).toBe(true);
    stdin.key(RIGHT);
    expect(await waitFor(() => audio.seeks.length === 1, 2000)).toBe(true);
    expect(audio.startArgs).toEqual([undefined]);
    expect(audio.seekArgs).toEqual([undefined]);
    stdin.key('q');
    expect(await result).toBe(0);
  });

  it('showMessage shows text on the HUD for the given time, and does nothing before start or after the end', async () => {
    const { stdout, stdin, player } = setup({ marker: 'res-msg' });
    player.showMessage('too early', 100); // before start(): ignored
    expect(player.state().message).toBeNull();
    const result = player.start();
    expect(await waitFor(() => stdout.frames() > 2, STARTUP_MS)).toBe(true);
    player.showMessage('seek cache ready', 200);
    expect(player.state().message).toBe('seek cache ready');
    expect(await waitFor(() => stdout.text().includes('seek cache ready'), 2000)).toBe(true);
    expect(await waitFor(() => player.state().message === null, 2000)).toBe(true);
    stdin.key('q');
    expect(await result).toBe(0);
    player.showMessage('too late', 100);
    expect(player.state().message).toBeNull();
  });
});
