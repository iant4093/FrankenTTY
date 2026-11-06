import { describe, expect, it } from 'vitest';
import {
  ProbeParser,
  deriveCellAspect,
  describeCapabilities,
  detectColorDepth,
  detectUnicode,
  installCommand,
  PROBE_REQUEST_WITHOUT_DECRQM,
  resolveCellAspect,
  runProbe,
  skipsDecrqm,
} from '../../src/term/capabilities.ts';
import type { ProbeInput, ProbeOutput } from '../../src/term/capabilities.ts';
import { PROBE_DECRQM_2026, PROBE_REQUEST } from '../../src/renderer/sequences.ts';

// Apple Terminal 488 on macOS 27 (docs/EVIDENCE.md).
const APPLE_ENV_NO_COLORTERM = { TERM: 'xterm-256color', TERM_PROGRAM: 'Apple_Terminal' };
const APPLE_ENV = { ...APPLE_ENV_NO_COLORTERM, COLORTERM: 'truecolor' };

describe('[REQ-CAP-01] detectColorDepth', () => {
  it('--color flag wins over everything', () => {
    expect(detectColorDepth(APPLE_ENV, 'darwin', '27.0.0', 24, '256')).toBe(8);
    expect(detectColorDepth(APPLE_ENV, 'darwin', '27.0.0', 24, '16')).toBe(4);
    expect(detectColorDepth({}, 'linux', '6.1.0', 4, 'truecolor')).toBe(24);
  });

  it('COLORTERM truecolor or 24bit gives 24-bit, case-insensitively', () => {
    expect(detectColorDepth({ COLORTERM: 'truecolor' }, 'linux', '6.1.0', 4, 'auto')).toBe(24);
    expect(detectColorDepth({ COLORTERM: '24bit' }, 'linux', '6.1.0', 4, 'auto')).toBe(24);
    expect(detectColorDepth({ COLORTERM: 'TrueColor' }, 'linux', '6.1.0', 4, 'auto')).toBe(24);
  });

  it('Apple Terminal 488 env on Darwin 27 gives 24-bit even though Node says 8', () => {
    expect(detectColorDepth(APPLE_ENV, 'darwin', '27.0.0', 8, 'auto')).toBe(24);
  });

  it('Apple Terminal without COLORTERM on Darwin 27 and 25 gives 24-bit', () => {
    expect(detectColorDepth(APPLE_ENV_NO_COLORTERM, 'darwin', '27.0.0', 8, 'auto')).toBe(24);
    expect(detectColorDepth(APPLE_ENV_NO_COLORTERM, 'darwin', '25.0.0', 8, 'auto')).toBe(24);
  });

  it('Apple Terminal without COLORTERM on Darwin 24 uses the Node depth', () => {
    expect(detectColorDepth(APPLE_ENV_NO_COLORTERM, 'darwin', '24.6.0', 8, 'auto')).toBe(8);
    expect(detectColorDepth(APPLE_ENV_NO_COLORTERM, 'darwin', '24.6.0', 4, 'auto')).toBe(4);
  });

  it('Apple_Terminal on a non-Darwin platform does not match the Apple rule', () => {
    expect(detectColorDepth(APPLE_ENV_NO_COLORTERM, 'linux', '27.0.0', 8, 'auto')).toBe(8);
  });

  it('an unparsable Darwin release falls through', () => {
    expect(detectColorDepth(APPLE_ENV_NO_COLORTERM, 'darwin', 'weird', 8, 'auto')).toBe(8);
  });

  it('WT_SESSION gives 24-bit', () => {
    expect(detectColorDepth({ WT_SESSION: 'abc' }, 'win32', '10.0.26100', 4, 'auto')).toBe(24);
  });

  it('empty WT_SESSION is ignored', () => {
    expect(detectColorDepth({ WT_SESSION: '' }, 'win32', '10.0.26100', 4, 'auto')).toBe(4);
  });

  it('maps Node depths to 24, 8 and 4', () => {
    expect(detectColorDepth({}, 'linux', '6.1.0', 24, 'auto')).toBe(24);
    expect(detectColorDepth({}, 'linux', '6.1.0', 8, 'auto')).toBe(8);
    expect(detectColorDepth({}, 'linux', '6.1.0', 4, 'auto')).toBe(4);
    expect(detectColorDepth({}, 'linux', '6.1.0', 1, 'auto')).toBe(4);
  });
});

describe('[REQ-CAP-01] detectColorDepth rule table without COLORTERM', () => {
  const depth = (env: Record<string, string>, nodeDepth = 4, platform = 'linux', release = '6.1.0'): number =>
    detectColorDepth(env, platform, release, nodeDepth, 'auto');

  it.each(['iTerm.app', 'ghostty', 'WezTerm', 'vscode', 'Hyper', 'Tabby'])('TERM_PROGRAM=%s gives 24-bit', (program) => {
    expect(depth({ TERM_PROGRAM: program })).toBe(24);
  });

  it('TERM_PROGRAM matching is exact', () => {
    expect(depth({ TERM_PROGRAM: 'wezterm' })).toBe(4);
    expect(depth({ TERM_PROGRAM: 'Terminal' })).toBe(4);
    expect(depth({ TERM_PROGRAM: '' })).toBe(4);
  });

  it.each(['xterm-ghostty', 'xterm-kitty', 'alacritty', 'wezterm', 'foot', 'foot-extra', 'contour', 'xterm-direct'])(
    'TERM=%s gives 24-bit',
    (term) => {
      expect(depth({ TERM: term })).toBe(24);
    },
  );

  it('other TERM values use the Node depth', () => {
    expect(depth({ TERM: 'xterm' }, 4)).toBe(4);
    expect(depth({ TERM: 'xterm-256color' }, 8)).toBe(8);
    expect(depth({ TERM: 'alacritty-direct-extra' }, 8)).toBe(8);
  });

  it('VTE_VERSION 3599 uses the Node depth and 3600 gives 24-bit', () => {
    expect(depth({ VTE_VERSION: '3599' }, 8)).toBe(8);
    expect(depth({ VTE_VERSION: '3600' }, 8)).toBe(24);
    expect(depth({ VTE_VERSION: '7600' }, 8)).toBe(24);
  });

  it('a malformed or empty VTE_VERSION is ignored', () => {
    expect(depth({ VTE_VERSION: '' }, 8)).toBe(8);
    expect(depth({ VTE_VERSION: 'abc' }, 8)).toBe(8);
    expect(depth({ VTE_VERSION: '7600abc' }, 8)).toBe(8);
  });

  it('KONSOLE_VERSION set gives 24-bit, empty is ignored', () => {
    expect(depth({ KONSOLE_VERSION: '240802' }, 8)).toBe(24);
    expect(depth({ KONSOLE_VERSION: '' }, 8)).toBe(8);
  });

  it('COLORTERM wins and the --color flag wins over the table', () => {
    expect(detectColorDepth({ TERM_PROGRAM: 'ghostty' }, 'linux', '6.1.0', 4, '256')).toBe(8);
    expect(detectColorDepth({ TERM_PROGRAM: 'ghostty' }, 'linux', '6.1.0', 4, '16')).toBe(4);
  });

  describe('inside tmux or screen', () => {
    it('does not trust TERM_PROGRAM, VTE_VERSION or KONSOLE_VERSION of the outer terminal', () => {
      for (const outer of [{ TERM_PROGRAM: 'ghostty' }, { TERM_PROGRAM: 'iTerm.app' }, { VTE_VERSION: '7600' }, { KONSOLE_VERSION: '240802' }]) {
        expect(depth({ ...outer, TERM: 'screen-256color' }, 8), JSON.stringify(outer)).toBe(8);
        expect(depth({ ...outer, TERM: 'tmux-256color' }, 8), JSON.stringify(outer)).toBe(8);
        expect(depth({ ...outer, TERM: 'xterm-256color', TMUX: '/tmp/tmux-1000/default,1,0' }, 8), JSON.stringify(outer)).toBe(8);
      }
    });

    it('does not trust the Apple Terminal or WT_SESSION rules either', () => {
      expect(depth({ TERM_PROGRAM: 'Apple_Terminal', TERM: 'screen' }, 8, 'darwin', '25.1.0')).toBe(8);
      expect(depth({ WT_SESSION: 'abc', TMUX: '/tmp/x,1,0' }, 8, 'linux')).toBe(8);
    });

    it('still takes COLORTERM and the Node depth', () => {
      expect(depth({ TERM_PROGRAM: 'ghostty', TERM: 'tmux-256color', COLORTERM: 'truecolor' }, 4)).toBe(24);
      expect(depth({ TERM_PROGRAM: 'ghostty', TERM: 'tmux-256color', TMUX: '/tmp/x,1,0' }, 24)).toBe(24);
    });

    it('an empty TMUX does not count as a multiplexer', () => {
      expect(depth({ TERM_PROGRAM: 'ghostty', TERM: 'xterm-256color', TMUX: '' }, 4)).toBe(24);
    });
  });
});

describe('[REQ-CAP-03] detectUnicode', () => {
  it('assumes UTF-8 on Windows', () => {
    expect(detectUnicode({}, 'win32')).toEqual({ unicode: true, braille: true });
  });

  it('reads LANG', () => {
    expect(detectUnicode({ LANG: 'en_US.UTF-8' }, 'linux').unicode).toBe(true);
    expect(detectUnicode({ LANG: 'en_US.utf8' }, 'linux').unicode).toBe(true);
    expect(detectUnicode({ LANG: 'C' }, 'linux').unicode).toBe(false);
  });

  it('uses the first set variable of LC_ALL, LC_CTYPE, LANG', () => {
    expect(detectUnicode({ LC_ALL: 'C', LANG: 'en_US.UTF-8' }, 'linux').unicode).toBe(false);
    expect(detectUnicode({ LC_CTYPE: 'en_US.UTF-8', LANG: 'C' }, 'linux').unicode).toBe(true);
    expect(detectUnicode({ LC_ALL: '', LANG: 'en_US.UTF-8' }, 'linux').unicode).toBe(true);
  });

  it('is false when nothing is set', () => {
    expect(detectUnicode({}, 'darwin')).toEqual({ unicode: false, braille: false });
  });

  it('skips Braille on TERM=linux', () => {
    expect(detectUnicode({ LANG: 'en_US.UTF-8', TERM: 'linux' }, 'linux')).toEqual({
      unicode: true,
      braille: false,
    });
    expect(detectUnicode({ LANG: 'en_US.UTF-8', TERM: 'xterm-256color' }, 'linux').braille).toBe(true);
  });
});

describe('[REQ-PREREQ-01] installCommand', () => {
  it('picks the command per OS', () => {
    expect(installCommand('darwin', null)).toBe('brew install ffmpeg');
    expect(installCommand('win32', null)).toBe('winget install Gyan.FFmpeg');
    expect(installCommand('linux', 'ID=ubuntu\nID_LIKE=debian\n')).toBe('sudo apt install ffmpeg');
    expect(installCommand('linux', 'ID="fedora"\n')).toBe('sudo dnf install ffmpeg');
    expect(installCommand('linux', 'ID=endeavouros\nID_LIKE=arch\n')).toBe('sudo pacman -S ffmpeg');
    expect(installCommand('linux', null)).toBe('sudo apt install ffmpeg');
  });
});

describe('[REQ-CAP-02] ProbeParser', () => {
  const bytes = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, 'latin1'));

  it('parses the real Apple Terminal reply (window size and DA1 only)', () => {
    const parser = new ProbeParser();
    parser.feed(bytes('\x1b[4;717;1245t\x1b[?1;2c'));
    const r = parser.result();
    expect(r.windowPx).toEqual({ w: 1245, h: 717 });
    expect(r.cellPx).toBeNull();
    expect(r.sync2026).toBe('unknown');
    expect(r.done).toBe(true);
    expect(r.replied).toBe(true);
    expect(r.passthrough).toEqual(new Uint8Array(0));
  });

  it('parses a full reply from a modern terminal', () => {
    const parser = new ProbeParser();
    parser.feed(bytes('\x1b[?2026;2$y\x1b[6;18;9t\x1b[4;720;1080t\x1b[?62;22c'));
    const r = parser.result();
    expect(r.sync2026).toBe('supported');
    expect(r.cellPx).toEqual({ w: 9, h: 18 });
    expect(r.windowPx).toEqual({ w: 1080, h: 720 });
    expect(r.done).toBe(true);
  });

  it.each([
    [0, 'unsupported'],
    [1, 'supported'],
    [2, 'supported'],
    [3, 'supported'],
    [4, 'unsupported'],
  ] as const)('DECRQM Ps %i is %s', (ps, expected) => {
    const parser = new ProbeParser();
    parser.feed(bytes(`\x1b[?2026;${ps}$y`));
    expect(parser.result().sync2026).toBe(expected);
  });

  it('reports unknown with no reply at all', () => {
    const r = new ProbeParser().result();
    expect(r.sync2026).toBe('unknown');
    expect(r.done).toBe(false);
    expect(r.replied).toBe(false);
  });

  it('handles a reply split across chunks at every byte', () => {
    const parser = new ProbeParser();
    for (const b of bytes('\x1b[?2026;2$y\x1b[4;717;1245t\x1b[?1;2c')) parser.feed(Uint8Array.of(b));
    const r = parser.result();
    expect(r.sync2026).toBe('supported');
    expect(r.windowPx).toEqual({ w: 1245, h: 717 });
    expect(r.done).toBe(true);
  });

  it('passes typed keys through, including between and inside nothing', () => {
    const parser = new ProbeParser();
    parser.feed(bytes('a\x1b[4;10;20tb\x1b[?1;2cq'));
    expect(Buffer.from(parser.result().passthrough).toString('latin1')).toBe('abq');
  });

  it('passes a non-probe escape sequence (arrow key) through unchanged', () => {
    const parser = new ProbeParser();
    parser.feed(bytes('\x1b[A\x1b[1;2C'));
    const r = parser.result();
    expect(Buffer.from(r.passthrough).toString('latin1')).toBe('\x1b[A\x1b[1;2C');
    expect(r.replied).toBe(false);
  });

  it('keeps a lone trailing ESC in the passthrough', () => {
    const parser = new ProbeParser();
    parser.feed(bytes('\x1b'));
    expect(Array.from(parser.result().passthrough)).toEqual([0x1b]);
  });

  it('ignores zero-sized pixel replies', () => {
    const parser = new ProbeParser();
    parser.feed(bytes('\x1b[6;0;0t'));
    expect(parser.result().cellPx).toBeNull();
  });

  it('does not throw on garbage and recovers afterwards', () => {
    const parser = new ProbeParser();
    parser.feed(bytes('\x1b\x1b\x1b[[[;;;\x1b[' + '9'.repeat(200) + '\x00\xff\x1b[?1;2c'));
    expect(parser.result().done).toBe(true);
  });
});

describe('[REQ-GEO-01] deriveCellAspect and resolveCellAspect', () => {
  it('uses the cell size when present', () => {
    expect(deriveCellAspect({ cellPx: { w: 9, h: 18 }, windowPx: null }, 80, 24)).toBe(2);
  });
  it('derives from the window size and grid', () => {
    // 1245x717 px over 100x30 cells: 12.45 wide, 23.9 high.
    const aspect = deriveCellAspect({ cellPx: null, windowPx: { w: 1245, h: 717 } }, 100, 30);
    expect(aspect).toBeCloseTo(23.9 / 12.45, 5);
  });
  it('returns null without data or a grid', () => {
    expect(deriveCellAspect({ cellPx: null, windowPx: null }, 80, 24)).toBeNull();
    expect(deriveCellAspect({ cellPx: null, windowPx: { w: 10, h: 10 } }, undefined, 24)).toBeNull();
    expect(deriveCellAspect({ cellPx: null, windowPx: { w: 10, h: 10 } }, 0, 24)).toBeNull();
  });
  it('resolves flag, then probe, then 2.0', () => {
    expect(resolveCellAspect(1.5, 2.2)).toEqual({ value: 1.5, source: 'flag' });
    expect(resolveCellAspect(null, 2.2)).toEqual({ value: 2.2, source: 'probe' });
    expect(resolveCellAspect(null, null)).toEqual({ value: 2, source: 'default' });
  });
});

describe('describeCapabilities', () => {
  it('prints one line per capability', () => {
    const lines = describeCapabilities({
      colorDepth: 24,
      sync2026: 'unknown',
      cellAspect: { value: 2, source: 'default' },
      unicode: true,
      braille: false,
      cols: 120,
      rows: 40,
    });
    expect(lines).toEqual([
      'color: 24-bit',
      'sync2026: unknown',
      'cell aspect: 2.00 (default)',
      'unicode: yes, braille: no',
      'size: 120x40',
    ]);
  });
});

describe('[REQ-CAP-02] runProbe', () => {
  function fakeStdin() {
    const listeners = new Set<(chunk: Uint8Array | string) => void>();
    let resumed = false;
    const stdin: ProbeInput = {
      on(_event, listener) {
        listeners.add(listener);
        return stdin;
      },
      removeListener(_event, listener) {
        listeners.delete(listener);
        return stdin;
      },
      resume() {
        resumed = true;
      },
    };
    return {
      stdin,
      emit: (chunk: Uint8Array | string) => {
        for (const l of [...listeners]) l(chunk);
      },
      listenerCount: () => listeners.size,
      wasResumed: () => resumed,
    };
  }

  function fakeStdout(columns = 100, rows = 30) {
    const writes: string[] = [];
    const stdout: ProbeOutput = {
      write(data) {
        writes.push(data);
      },
      columns,
      rows,
    };
    return { stdout, writes };
  }

  it('writes the probe once and stops at the DA1 reply', async () => {
    const s = fakeStdin();
    const o = fakeStdout();
    const promise = runProbe(s.stdin, o.stdout, 1000);
    expect(o.writes).toEqual([PROBE_REQUEST]);
    expect(s.wasResumed()).toBe(true);
    s.emit(Buffer.from('\x1b[4;717;1245t'));
    expect(s.listenerCount()).toBe(1);
    s.emit(Buffer.from('\x1b[?1;2c'));
    const r = await promise;
    expect(r.done).toBe(true);
    expect(r.windowPx).toEqual({ w: 1245, h: 717 });
    expect(r.cellAspect).toBeCloseTo(717 / 30 / (1245 / 100), 5);
    expect(s.listenerCount()).toBe(0);
  });

  it('times out without replies and removes its listener', async () => {
    const s = fakeStdin();
    const o = fakeStdout();
    const r = await runProbe(s.stdin, o.stdout, 20);
    expect(r.done).toBe(false);
    expect(r.replied).toBe(false);
    expect(r.sync2026).toBe('unknown');
    expect(r.cellAspect).toBeNull();
    expect(s.listenerCount()).toBe(0);
  });

  it('returns keys typed during the probe as passthrough', async () => {
    const s = fakeStdin();
    const o = fakeStdout();
    const promise = runProbe(s.stdin, o.stdout, 1000);
    s.emit(Buffer.from('q\x1b[?1;2c'));
    const r = await promise;
    expect(Buffer.from(r.passthrough).toString('latin1')).toBe('q');
  });

  it('[REQ-CAP-02] sends the full probe when TERM_PROGRAM is not Apple_Terminal', async () => {
    for (const env of [{}, { TERM_PROGRAM: 'iTerm.app' }, { TERM_PROGRAM: 'vscode', TERM: 'xterm-256color' }]) {
      const s = fakeStdin();
      const o = fakeStdout();
      const promise = runProbe(s.stdin, o.stdout, 1000, env);
      expect(o.writes).toEqual([PROBE_REQUEST]);
      expect(o.writes[0]).toContain('$p');
      s.emit(Buffer.from('\x1b[?2026;2$y\x1b[?1;2c'));
      const r = await promise;
      expect(r.sync2026).toBe('supported');
    }
  });

  it('[REQ-CAP-02] Apple Terminal: no DECRQM query is sent, sync2026 is unsupported, the other replies are read', async () => {
    const s = fakeStdin();
    const o = fakeStdout();
    const promise = runProbe(s.stdin, o.stdout, 1000, { TERM_PROGRAM: 'Apple_Terminal' });
    expect(o.writes).toEqual([PROBE_REQUEST_WITHOUT_DECRQM]);
    expect(o.writes[0]).not.toContain(PROBE_DECRQM_2026);
    expect(o.writes[0]).not.toContain('$p');
    expect(o.writes[0]).toContain('\x1b[16t');
    expect(o.writes[0]).toContain('\x1b[14t');
    expect(o.writes[0]?.endsWith('\x1b[c')).toBe(true);
    s.emit(Buffer.from('\x1b[4;717;1245t\x1b[?1;2c'));
    const r = await promise;
    expect(r.sync2026).toBe('unsupported');
    expect(r.done).toBe(true);
    expect(r.replied).toBe(true);
    expect(r.windowPx).toEqual({ w: 1245, h: 717 });
    expect(s.listenerCount()).toBe(0);
  });

  it('[REQ-CAP-02] Apple Terminal: a timeout still reports unsupported, with no reply', async () => {
    const s = fakeStdin();
    const o = fakeStdout();
    const r = await runProbe(s.stdin, o.stdout, 20, { TERM_PROGRAM: 'Apple_Terminal' });
    expect(r.sync2026).toBe('unsupported');
    expect(r.done).toBe(false);
    expect(r.replied).toBe(false);
  });

  it('[REQ-CAP-02] skipsDecrqm is true for Apple Terminal only', () => {
    expect(skipsDecrqm({ TERM_PROGRAM: 'Apple_Terminal' })).toBe(true);
    expect(skipsDecrqm({ TERM_PROGRAM: 'iTerm.app' })).toBe(false);
    expect(skipsDecrqm({ TERM_PROGRAM: 'apple_terminal' })).toBe(false);
    expect(skipsDecrqm({})).toBe(false);
  });
});
