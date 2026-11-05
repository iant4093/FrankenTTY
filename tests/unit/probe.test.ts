import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ProbeError, classifyInput, parseProbeJson, probe } from '../../src/ingest/probe.ts';
import type { MediaInfo } from '../../src/ingest/media-info.ts';

const FIXTURES = path.join(import.meta.dirname, '..', 'fixtures', 'ffprobe');

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8'));
}

describe('parseProbeJson fixtures', () => {
  const cases: [string, MediaInfo][] = [
    [
      'h264-aac-1080p',
      { width: 1920, height: 1080, fps: 30, durationSec: 12.523, hasAudio: true, source: 'file' },
    ],
    [
      'anamorphic-sar-4-3',
      { width: 1920, height: 1080, fps: 25, durationSec: 60.08, hasAudio: true, source: 'file' },
    ],
    [
      'rotated-phone-90',
      { width: 1080, height: 1920, fps: 29.97, durationSec: 8.366667, hasAudio: true, source: 'file' },
    ],
    [
      'cover-art-and-video',
      { width: 1280, height: 720, fps: 24, durationSec: 200.5, hasAudio: true, source: 'file' },
    ],
    [
      'vfr-unknown-avg',
      { width: 854, height: 480, fps: 30000 / 1001, durationSec: null, hasAudio: false, source: 'file' },
    ],
  ];

  for (const [name, expected] of cases) {
    it(`${name}`, () => {
      expect(parseProbeJson(fixture(name), 'file')).toEqual(expected);
    });
  }

  it('passes the source through', () => {
    expect(parseProbeJson(fixture('h264-aac-1080p'), 'url').source).toBe('url');
    expect(parseProbeJson(fixture('h264-aac-1080p'), 'demo').source).toBe('demo');
  });

  it('rejects audio-only input', () => {
    expect(() => parseProbeJson(fixture('audio-only'), 'file')).toThrow(ProbeError);
    expect(() => parseProbeJson(fixture('audio-only'), 'file')).toThrow('no video stream found');
  });
});

describe('parseProbeJson details', () => {
  function video(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      codec_type: 'video',
      width: 640,
      height: 360,
      avg_frame_rate: '30/1',
      r_frame_rate: '30/1',
      ...extra,
    };
  }

  it('swaps dimensions for the legacy rotate tag, including 270 and -270', () => {
    for (const rotate of ['90', '270', '-90', '-270']) {
      const info = parseProbeJson({ streams: [video({ tags: { rotate } })], format: {} }, 'file');
      expect([info.width, info.height]).toEqual([360, 640]);
    }
  });

  it('keeps dimensions for 0 and 180 degree rotation', () => {
    for (const rotate of ['0', '180', '-180']) {
      const info = parseProbeJson({ streams: [video({ tags: { rotate } })], format: {} }, 'file');
      expect([info.width, info.height]).toEqual([640, 360]);
    }
  });

  it('applies SAR before the rotation swap', () => {
    const info = parseProbeJson(
      { streams: [video({ width: 720, height: 480, sample_aspect_ratio: '32:27', side_data_list: [{ rotation: 90 }] })], format: {} },
      'file',
    );
    expect([info.width, info.height]).toEqual([480, 853]);
  });

  it('ignores SAR 0:1, malformed SAR and a missing SAR', () => {
    for (const sar of ['0:1', 'abc', '1:0', undefined]) {
      const extra = sar === undefined ? {} : { sample_aspect_ratio: sar };
      const info = parseProbeJson({ streams: [video(extra)], format: {} }, 'file');
      expect(info.width).toBe(640);
    }
  });

  it('falls back to r_frame_rate when avg_frame_rate is 0/0 or missing', () => {
    const a = parseProbeJson({ streams: [video({ avg_frame_rate: '0/0', r_frame_rate: '25/1' })], format: {} }, 'file');
    expect(a.fps).toBe(25);
    const b = parseProbeJson({ streams: [{ ...video(), avg_frame_rate: undefined, r_frame_rate: '24/1' }], format: {} }, 'file');
    expect(b.fps).toBe(24);
  });

  it('rejects a stream with no usable frame rate', () => {
    const json = { streams: [video({ avg_frame_rate: '0/0', r_frame_rate: '0/0' })], format: {} };
    expect(() => parseProbeJson(json, 'file')).toThrow(ProbeError);
  });

  it('takes duration from format, then stream, then null', () => {
    expect(parseProbeJson({ streams: [video({ duration: '3.5' })], format: { duration: '4.25' } }, 'file').durationSec).toBe(4.25);
    expect(parseProbeJson({ streams: [video({ duration: '3.5' })], format: { duration: 'N/A' } }, 'file').durationSec).toBe(3.5);
    expect(parseProbeJson({ streams: [video()], format: {} }, 'file').durationSec).toBeNull();
    expect(parseProbeJson({ streams: [video({ duration: 'N/A' })] }, 'file').durationSec).toBeNull();
  });

  it('rejects missing, zero and fractional dimensions', () => {
    for (const bad of [{ width: 0 }, { height: 0 }, { width: undefined }, { height: -4 }, { width: 10.5 }, { width: 'wide' }]) {
      expect(() => parseProbeJson({ streams: [video(bad)], format: {} }, 'file')).toThrow('invalid dimensions');
    }
  });

  it('rejects non-object and stream-less input', () => {
    for (const bad of [null, 'x', 5, [], {}, { streams: [] }, { streams: 'no' }]) {
      expect(() => parseProbeJson(bad, 'file')).toThrow(ProbeError);
    }
  });

  it('throws single-line errors', () => {
    try {
      parseProbeJson({ streams: [] }, 'file');
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).not.toContain('\n');
    }
  });
});

describe('classifyInput', () => {
  it('treats paths as files and http(s) as urls', () => {
    expect(classifyInput('movie.mp4')).toBe('file');
    expect(classifyInput('/tmp/a b/movie.mp4')).toBe('file');
    expect(classifyInput('C:\\videos\\movie.mp4')).toBe('file');
    expect(classifyInput('-weird.mp4')).toBe('file');
    expect(classifyInput('http://example.com/a.mp4')).toBe('url');
    expect(classifyInput('HTTPS://example.com/a.mp4')).toBe('url');
  });

  it('rejects other URL schemes', () => {
    for (const url of ['rtmp://host/app', 'udp://127.0.0.1:1234', 'rtsp://cam/stream', 'ftp://host/a.mp4', 'tcp://h:1']) {
      expect(() => classifyInput(url)).toThrow('live and non-http streams are not supported');
    }
  });
});

describe('probe()', () => {
  it('rejects non-http schemes before spawning anything', async () => {
    await expect(probe('rtmp://host/app', { ffprobePath: '/nonexistent/ffprobe' })).rejects.toThrow(
      'live and non-http streams are not supported',
    );
  });

  it('reports a missing executable', async () => {
    await expect(probe('movie.mp4', { ffprobePath: '/nonexistent/ffprobe' })).rejects.toThrow(ProbeError);
  });

  describe.skipIf(process.platform === 'win32')('with a fake ffprobe script', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'frankentty-probe-'));
    afterAll(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    function script(name: string, body: string): string {
      const file = path.join(dir, name);
      writeFileSync(file, `#!${process.execPath}\n${body}\n`);
      chmodSync(file, 0o755);
      return file;
    }

    it('times out, kills the child and rejects with a one-line error', async () => {
      const sleeper = script('sleep.mjs', 'setTimeout(() => {}, 60000);');
      const started = Date.now();
      const err = await probe('movie.mp4', { ffprobePath: sleeper, timeoutMs: 300 }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProbeError);
      expect((err as Error).message).toBe('ffprobe timed out after 0.3 s');
      expect(Date.now() - started).toBeLessThan(5000);
    });

    it('formats a whole-second timeout without decimals', async () => {
      const sleeper = script('sleep2.mjs', 'setTimeout(() => {}, 60000);');
      const err = await probe('movie.mp4', { ffprobePath: sleeper, timeoutMs: 1000 }).catch((e: unknown) => e);
      expect((err as Error).message).toBe('ffprobe timed out after 1 s');
    });

    it('parses JSON printed by the child and passes an argv array', async () => {
      const json = readFileSync(path.join(FIXTURES, 'h264-aac-1080p.json'), 'utf8');
      const fake = script(
        'ok.mjs',
        `const argv = process.argv.slice(2);
if (argv[argv.length - 1] !== 'a file; rm -rf x.mp4' || argv[argv.length - 2] !== '-i') process.exit(3);
process.stdout.write(${JSON.stringify(json)});`,
      );
      const info = await probe('a file; rm -rf x.mp4', { ffprobePath: fake });
      expect(info).toEqual({ width: 1920, height: 1080, fps: 30, durationSec: 12.523, hasAudio: true, source: 'file' });
    });

    it('marks http inputs as url', async () => {
      const json = readFileSync(path.join(FIXTURES, 'h264-aac-1080p.json'), 'utf8');
      const fake = script('ok-url.mjs', `process.stdout.write(${JSON.stringify(json)});`);
      const info = await probe('https://example.com/a.mp4', { ffprobePath: fake });
      expect(info.source).toBe('url');
    });

    it('turns a failing exit into the last stderr line', async () => {
      const fake = script('fail.mjs', `process.stderr.write('first\\nmovie.mp4: No such file or directory\\n'); process.exit(1);`);
      await expect(probe('movie.mp4', { ffprobePath: fake })).rejects.toThrow('movie.mp4: No such file or directory');
    });

    it('rejects unreadable output', async () => {
      const fake = script('junk.mjs', `process.stdout.write('not json');`);
      await expect(probe('movie.mp4', { ffprobePath: fake })).rejects.toThrow('unreadable output');
    });

    it('rejects output over 4 MB', async () => {
      const fake = script(
        'big.mjs',
        `const b = Buffer.alloc(1024 * 1024, 32); for (let i = 0; i < 6; i++) process.stdout.write(b); setTimeout(() => {}, 60000);`,
      );
      await expect(probe('movie.mp4', { ffprobePath: fake })).rejects.toThrow('too large');
    });
  });
});
