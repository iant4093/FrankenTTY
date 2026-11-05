import { describe, expect, it } from 'vitest';
import { DEMOS, HELP_TEXT, VERSION, parseArgs } from '../../src/cli/args.ts';
import type { Options } from '../../src/cli/args.ts';

function ok(argv: string[]): Options {
  const result = parseArgs(argv);
  if (!result.ok) throw new Error(`expected ok, got: ${result.message}`);
  return result.options;
}

function fail(argv: string[]): string {
  const result = parseArgs(argv);
  if (result.ok) throw new Error('expected failure');
  expect(result.message).not.toContain('\n');
  return result.message;
}

describe('parseArgs defaults', () => {
  it('parses a file input with defaults', () => {
    expect(ok(['video.mp4'])).toEqual({
      input: 'video.mp4',
      demo: null,
      mode: 'halfblock',
      palette: 'truecolor',
      fps: 30,
      color: 'auto',
      threshold: null,
      cellAspect: null,
      avOffset: 0,
      quality: 'auto',
      noAudio: false,
      loop: false,
      bench: false,
      frames: null,
      version: false,
      help: false,
    });
  });

  it('accepts an http(s) URL as input', () => {
    expect(ok(['https://example.com/a.mp4']).input).toBe('https://example.com/a.mp4');
  });
});

describe('parseArgs demo', () => {
  it('defaults the demo name to mandelbrot', () => {
    const o = ok(['--demo']);
    expect(o.demo).toBe('mandelbrot');
    expect(o.input).toBeNull();
  });

  it.each(DEMOS)('accepts demo %s', (name) => {
    expect(ok(['--demo', name]).demo).toBe(name);
  });

  it('accepts the demo name before other flags and after them', () => {
    expect(ok(['--demo', 'life', '--mode', 'ascii']).demo).toBe('life');
    expect(ok(['--mode', 'ascii', '--demo', 'life']).demo).toBe('life');
  });

  it('rejects an unknown demo name and lists the allowed ones', () => {
    const message = fail(['--demo', 'nope']);
    expect(message).toContain('--demo');
    for (const name of DEMOS) expect(message).toContain(name);
  });

  it('rejects --demo together with an input file', () => {
    fail(['--demo', 'movie.mp4']);
    fail(['--demo', 'life', 'movie.mp4']);
  });

  it('rejects a missing input', () => {
    expect(fail([])).toContain('input');
  });

  it('rejects two inputs', () => {
    fail(['a.mp4', 'b.mp4']);
  });
});

describe('parseArgs enum flags', () => {
  it.each(['halfblock', 'ascii', 'braille'])('accepts --mode %s', (v) => {
    expect(ok(['x', '--mode', v]).mode).toBe(v);
  });
  it.each(['truecolor', 'amber', 'green', 'dmg'])('accepts --palette %s', (v) => {
    expect(ok(['x', '--palette', v]).palette).toBe(v);
  });
  it.each(['auto', 'truecolor', '256', '16'])('accepts --color %s', (v) => {
    expect(ok(['x', '--color', v]).color).toBe(v);
  });
  it.each(['auto', 'max'])('accepts --quality %s', (v) => {
    expect(ok(['x', '--quality', v]).quality).toBe(v);
  });

  it('rejects bad values and names the flag and the allowed values', () => {
    expect(fail(['x', '--mode', 'rgb'])).toMatch(/--mode.*halfblock\|ascii\|braille/);
    expect(fail(['x', '--palette', 'pink'])).toMatch(/--palette.*truecolor\|amber\|green\|dmg/);
    expect(fail(['x', '--color', '8'])).toMatch(/--color.*auto\|truecolor\|256\|16/);
    expect(fail(['x', '--quality', 'low'])).toMatch(/--quality.*auto\|max/);
  });

  it('rejects a flag without its value', () => {
    fail(['x', '--mode']);
  });
});

describe('parseArgs numeric ranges', () => {
  it('--fps accepts 1 and 60 and rejects 0, 61, fractions and text', () => {
    expect(ok(['x', '--fps', '1']).fps).toBe(1);
    expect(ok(['x', '--fps', '60']).fps).toBe(60);
    expect(fail(['x', '--fps', '0'])).toContain('--fps');
    fail(['x', '--fps', '61']);
    fail(['x', '--fps', '29.5']);
    fail(['x', '--fps', 'fast']);
    fail(['x', '--fps', '']);
  });

  it('--threshold accepts 0 and 100 (also fractional) and rejects outside', () => {
    expect(ok(['x', '--threshold', '0']).threshold).toBe(0);
    expect(ok(['x', '--threshold', '100']).threshold).toBe(100);
    expect(ok(['x', '--threshold', '12.5']).threshold).toBe(12.5);
    expect(fail(['x', '--threshold', '-1'])).toContain('--threshold');
    fail(['x', '--threshold', '100.1']);
    fail(['x', '--threshold', 'NaN']);
  });

  it('--cell-aspect accepts 1.0 and 3.0 and rejects outside', () => {
    expect(ok(['x', '--cell-aspect', '1.0']).cellAspect).toBe(1);
    expect(ok(['x', '--cell-aspect', '3.0']).cellAspect).toBe(3);
    expect(ok(['x', '--cell-aspect', '2.15']).cellAspect).toBe(2.15);
    expect(fail(['x', '--cell-aspect', '0.99'])).toContain('--cell-aspect');
    fail(['x', '--cell-aspect', '3.01']);
    fail(['x', '--cell-aspect', 'tall']);
  });

  it('--av-offset accepts -2000 and 2000, with a space before a negative value', () => {
    expect(ok(['x', '--av-offset', '-2000']).avOffset).toBe(-2000);
    expect(ok(['x', '--av-offset', '2000']).avOffset).toBe(2000);
    expect(ok(['x', '--av-offset=-150']).avOffset).toBe(-150);
    expect(ok(['x', '--av-offset', '0']).avOffset).toBe(0);
    expect(fail(['x', '--av-offset', '-2001'])).toContain('--av-offset');
    fail(['x', '--av-offset', '2001']);
    fail(['x', '--av-offset', '1.5']);
  });

  it('--frames needs a positive integer and --bench', () => {
    expect(ok(['x', '--bench', '--frames', '90']).frames).toBe(90);
    expect(fail(['x', '--bench', '--frames', '0'])).toContain('--frames');
    fail(['x', '--bench', '--frames', '-3']);
    fail(['x', '--bench', '--frames', '1.5']);
  });

  it('rejects --frames without --bench', () => {
    expect(fail(['x', '--frames', '10'])).toMatch(/--frames.*--bench/);
  });
});

describe('parseArgs boolean flags', () => {
  it('sets --no-audio, --loop, --bench', () => {
    const o = ok(['x', '--no-audio', '--loop', '--bench']);
    expect(o.noAudio).toBe(true);
    expect(o.loop).toBe(true);
    expect(o.bench).toBe(true);
  });

  it('accepts --bench with --demo', () => {
    const o = ok(['--demo', '--bench', '--frames', '5']);
    expect(o.bench).toBe(true);
    expect(o.demo).toBe('mandelbrot');
  });
});

describe('parseArgs help and version', () => {
  it('--help needs no input', () => {
    expect(ok(['--help']).help).toBe(true);
  });
  it('--version needs no input', () => {
    expect(ok(['--version']).version).toBe(true);
  });
  it('still rejects bad values next to --help', () => {
    fail(['--help', '--mode', 'rgb']);
  });
  it('exports help text mentioning every flag, and a semver-like version', () => {
    for (const flag of [
      '--mode',
      '--palette',
      '--fps',
      '--color',
      '--threshold',
      '--cell-aspect',
      '--av-offset',
      '--quality',
      '--no-audio',
      '--loop',
      '--bench',
      '--frames',
      '--version',
      '--help',
      '--demo',
    ]) {
      expect(HELP_TEXT).toContain(flag);
    }
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('parseArgs unknown arguments', () => {
  it('rejects an unknown flag by name', () => {
    const message = fail(['x', '--bogus']);
    expect(message).toContain('--bogus');
  });
  it('rejects an unknown short flag', () => {
    expect(fail(['x', '-z'])).toContain('-z');
  });
  it('rejects a value given to a boolean flag', () => {
    fail(['x', '--loop=yes']);
  });
});
