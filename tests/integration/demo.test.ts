import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEMO_NAMES,
  demoAudioInputArgs,
  demoVideoInputArgs,
  getDemo,
} from '../../src/ingest/demo.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const hasTool = (tool: string): boolean =>
  spawnSync(tool, ['-version'], { stdio: 'ignore' }).status === 0;
const canRun = hasTool('ffmpeg') && hasTool('ffprobe');

const W = 64;
const H = 36;
const MAX_BUFFER = 64 * 1024 * 1024;

describe.skipIf(!canRun)('demo sources through FFmpeg', () => {
  describe.each([...DEMO_NAMES])('%s', (name) => {
    const src = getDemo(name);

    it('renders 1 s of video as 30 distinct-looking rgb24 frames', () => {
      const run = spawnSync(
        'ffmpeg',
        [
          '-v', 'error',
          ...demoVideoInputArgs(src),
          '-t', '1',
          '-vf', `scale=${W}:${H}`,
          '-f', 'rawvideo',
          '-pix_fmt', 'rgb24',
          'pipe:1',
        ],
        { maxBuffer: MAX_BUFFER },
      );
      expect(run.status, run.stderr.toString()).toBe(0);
      const frameBytes = W * H * 3;
      expect(run.stdout.length).toBe(30 * frameBytes);

      // Not a single color overall, and every frame has more than one color.
      const colors = new Set<number>();
      let blankFrames = 0;
      for (let f = 0; f < 30; f++) {
        const base = f * frameBytes;
        const first = run.stdout.readUIntBE(base, 3);
        let varied = false;
        for (let i = 3; i < frameBytes; i += 3) {
          const c = run.stdout.readUIntBE(base + i, 3);
          colors.add(c);
          if (c !== first) varied = true;
        }
        if (!varied) blankFrames++;
      }
      expect(colors.size).toBeGreaterThan(1);
      expect(blankFrames).toBe(0);
    });

    it('renders 1 s of quiet stereo audio at 48 kHz', () => {
      const run = spawnSync(
        'ffmpeg',
        [
          '-v', 'error',
          ...demoAudioInputArgs(src),
          '-t', '1',
          '-f', 's16le',
          '-ac', '2',
          '-ar', '48000',
          'pipe:1',
        ],
        { maxBuffer: MAX_BUFFER },
      );
      expect(run.status, run.stderr.toString()).toBe(0);
      expect(run.stdout.length).toBe(48000 * 2 * 2);
      let peak = 0;
      let nonZero = 0;
      for (let i = 0; i < run.stdout.length; i += 2) {
        const v = Math.abs(run.stdout.readInt16LE(i));
        if (v > peak) peak = v;
        if (v !== 0) nonZero++;
      }
      expect(peak).toBeGreaterThan(0);
      expect(nonZero).toBeGreaterThan(100);
      expect(peak).toBeLessThanOrEqual(8192);
    });
  });

  it('scripts/generate-demo-media.sh writes a 2 s h264 + aac mp4', () => {
    if (process.platform === 'win32') return;
    const script = path.join(root, 'scripts', 'generate-demo-media.sh');
    const run = spawnSync('bash', [script, 'mandelbrot', '2'], { cwd: root, encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain('PASS: assets/demo-mandelbrot.mp4');
    expect(run.stdout).toContain('RESULT: PASS');

    const out = path.join(root, 'assets', 'demo-mandelbrot.mp4');
    expect(existsSync(out)).toBe(true);
    const probe = spawnSync(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'stream=codec_name,codec_type:format=duration', '-of', 'json', out],
      { encoding: 'utf8' },
    );
    expect(probe.status).toBe(0);
    const info = JSON.parse(probe.stdout) as {
      streams: { codec_name: string; codec_type: string }[];
      format: { duration: string };
    };
    expect(info.streams.filter((s) => s.codec_type === 'video').map((s) => s.codec_name)).toEqual(['h264']);
    expect(info.streams.filter((s) => s.codec_type === 'audio').map((s) => s.codec_name)).toEqual(['aac']);
    expect(Math.abs(Number(info.format.duration) - 2)).toBeLessThanOrEqual(0.2);
  });

  it('scripts/generate-demo-media.sh rejects an unknown demo name', () => {
    if (process.platform === 'win32') return;
    const script = path.join(root, 'scripts', 'generate-demo-media.sh');
    const run = spawnSync('bash', [script, 'nope', '2'], { cwd: root, encoding: 'utf8' });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('Unknown demo');
  });
});
