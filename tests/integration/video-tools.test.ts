import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const hasTool = (tool: string, arg: string): boolean =>
  spawnSync(tool, [arg], { stdio: 'ignore' }).status === 0;
const hasFfmpeg = hasTool('ffmpeg', '-version') && hasTool('ffprobe', '-version');
const hasPython = hasTool('python3', '--version');

interface Line {
  id: string;
  text: string;
}

const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim();

const lines = JSON.parse(readFileSync(path.join(root, 'video', 'narration', 'lines.json'), 'utf8')) as {
  acts: Record<string, Line[]>;
};

/** Narration blockquotes from video/script.md, keyed act1..act4. */
const scriptNarration = (): Record<string, string> => {
  const script = readFileSync(path.join(root, 'video', 'script.md'), 'utf8').split('\n');
  const romans = ['I', 'II', 'III', 'IV'];
  const out: Record<string, string> = {};
  let act = '';
  let inNarration = false;
  let quote: string[] = [];
  const flush = (): void => {
    if (act && quote.length > 0) out[act] = normalize(quote.join(' '));
    quote = [];
    inNarration = false;
  };
  for (const line of script) {
    const heading = /^## Act (I{1,3}|IV) /.exec(line);
    if (heading) {
      flush();
      act = `act${romans.indexOf(heading[1] ?? '') + 1}`;
    } else if (/^## /.test(line)) {
      flush();
      act = '';
    } else if (line.startsWith('**Narration')) {
      inNarration = true;
    } else if (inNarration && line.startsWith('>')) {
      quote.push(line.slice(1));
    } else if (inNarration && quote.length > 0) {
      flush();
    }
  }
  flush();
  return out;
};

describe('narration lines (REQ-VID-06 in the video spec)', () => {
  it('has unique ids that start with their act name', () => {
    const ids: string[] = [];
    for (const [act, entries] of Object.entries(lines.acts)) {
      for (const entry of entries) {
        expect(entry.id).toMatch(new RegExp(`^${act}-\\d{2}$`));
        ids.push(entry.id);
      }
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('matches the narration blocks of video/script.md word for word', () => {
    const expected = scriptNarration();
    expect(Object.keys(expected).sort()).toEqual(['act1', 'act2', 'act3', 'act4']);
    for (const [act, entries] of Object.entries(lines.acts)) {
      expect(normalize(entries.map((entry) => entry.text).join(' ')), act).toBe(expected[act]);
    }
  });
});

describe.skipIf(!hasFfmpeg)('video/music/music.sh', () => {
  it('writes a stereo 48 kHz wav of the requested length, quieter than -20 dBFS', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'frankentty-music-'));
    try {
      const out = path.join(dir, 'bed.wav');
      const run = spawnSync('bash', ['video/music/music.sh', '--duration', '3', '--output', out], {
        cwd: root,
        encoding: 'utf8',
      });
      expect(run.status, run.stderr).toBe(0);
      const probe = spawnSync(
        'ffprobe',
        ['-v', 'error', '-show_entries', 'stream=sample_rate,channels:format=duration', '-of', 'json', out],
        { encoding: 'utf8' },
      );
      const info = JSON.parse(probe.stdout) as {
        streams: { sample_rate: string; channels: number }[];
        format: { duration: string };
      };
      expect(Number(info.format.duration)).toBeCloseTo(3, 1);
      expect(info.streams[0]?.sample_rate).toBe('48000');
      expect(info.streams[0]?.channels).toBe(2);
      const peak = /peak (-?[\d.]+) dBFS/.exec(run.stdout);
      expect(Number(peak?.[1])).toBeLessThanOrEqual(-20);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects an invalid duration', () => {
    const run = spawnSync('bash', ['video/music/music.sh', '--duration', 'abc'], { cwd: root, encoding: 'utf8' });
    expect(run.status).toBe(2);
  });
});

describe('video/build.sh', () => {
  it('prints usage for --help and rejects unknown flags', () => {
    const help = spawnSync('bash', ['video/build.sh', '--help'], { cwd: root, encoding: 'utf8' });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('Usage: video/build.sh');
    const bad = spawnSync('bash', ['video/build.sh', '--nope'], { cwd: root, encoding: 'utf8' });
    expect(bad.status).toBe(2);
  });
});

describe.skipIf(!hasPython)('video/narration/narrate.py', () => {
  it('parses as Python', () => {
    const run = spawnSync('python3', ['-m', 'py_compile', 'video/narration/narrate.py'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, PYTHONPYCACHEPREFIX: path.join(tmpdir(), 'frankentty-pycache') },
    });
    expect(run.status, run.stderr).toBe(0);
  });
});
