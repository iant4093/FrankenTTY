import { describe, expect, it } from 'vitest';
import { DEMOS } from '../../src/cli/args.ts';
import {
  DEMO_NAMES,
  demoAudioInputArgs,
  demoMetadata,
  demoVideoInputArgs,
  getDemo,
} from '../../src/ingest/demo.ts';

describe('demo sources', () => {
  it('uses the same names, in the same order, as the CLI', () => {
    expect([...DEMO_NAMES]).toEqual([...DEMOS]);
    expect([...DEMO_NAMES]).toEqual(['mandelbrot', 'life', 'cellauto', 'gradients', 'testsrc2']);
  });

  it.each([...DEMO_NAMES])('%s resolves with fixed fps, duration and size', (name) => {
    const src = getDemo(name);
    expect(src.name).toBe(name);
    expect(src.description.length).toBeGreaterThan(0);
    expect(src.fps).toBe(30);
    expect(src.durationSec).toBe(60);
    expect(src.width).toBe(640);
    expect(src.height).toBe(360);
  });

  it.each([...DEMO_NAMES])('%s video filter has size, rate=30 and duration=60', (name) => {
    const f = getDemo(name).videoFilter;
    expect(f).toMatch(/size=\d+x\d+/);
    expect(f).toContain('rate=30');
    expect(f).toContain('duration=60');
    expect(f).not.toContain('\n');
  });

  it.each([...DEMO_NAMES])('%s audio filter is 48 kHz stereo with duration=60', (name) => {
    const f = getDemo(name).audioFilter;
    expect(f.startsWith('aevalsrc=')).toBe(true);
    expect(f).toContain('duration=60');
    expect(f).toContain('sample_rate=48000');
    expect(f).toContain('channel_layout=stereo');
    // Exactly two channel expressions separated by `|` inside the quotes.
    const quoted = /exprs='([^']*)'/.exec(f)?.[1];
    expect(quoted).toBeDefined();
    expect(quoted?.split('|')).toHaveLength(2);
  });

  it('audio filters are distinct per demo', () => {
    const filters = DEMO_NAMES.map((n) => getDemo(n).audioFilter);
    expect(new Set(filters).size).toBe(DEMO_NAMES.length);
  });

  it('video filters are distinct per demo', () => {
    const filters = DEMO_NAMES.map((n) => getDemo(n).videoFilter);
    expect(new Set(filters).size).toBe(DEMO_NAMES.length);
  });

  it('builds lavfi input args', () => {
    for (const name of DEMO_NAMES) {
      const src = getDemo(name);
      expect(demoVideoInputArgs(src)).toEqual(['-f', 'lavfi', '-i', src.videoFilter]);
      expect(demoAudioInputArgs(src)).toEqual(['-f', 'lavfi', '-i', src.audioFilter]);
    }
  });

  it('describes each demo as MediaInfo', () => {
    for (const name of DEMO_NAMES) {
      const src = getDemo(name);
      expect(demoMetadata(src)).toEqual({
        width: 640,
        height: 360,
        fps: 30,
        durationSec: 60,
        hasAudio: true,
        source: 'demo',
      });
    }
  });

  it('throws RangeError for an unknown name', () => {
    expect(() => getDemo('nope')).toThrow(RangeError);
    expect(() => getDemo('')).toThrow(RangeError);
    expect(() => getDemo('Mandelbrot')).toThrow(/Allowed: mandelbrot, life/);
  });
});
