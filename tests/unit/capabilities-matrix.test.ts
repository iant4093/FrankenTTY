import { describe, expect, it } from 'vitest';
import { effectiveMode } from '../../src/player/pipeline.ts';
import type { Env } from '../../src/term/capabilities.ts';
import { detectColorDepth, detectUnicode } from '../../src/term/capabilities.ts';
import type { ColorDepth } from '../../src/term/capabilities.ts';

// Capability detection per terminal (docs/PLAN.md section 2: Tier 1 and Tier 2, plus the Tier 3 fallbacks).
//
// Each row is the environment a terminal gives its shell, run through the real detection functions.
// Variables per terminal come from each project's documentation and from the behavior of its
// shell integration, as recalled when this file was written; none of it was re-fetched in this
// run, and the real terminals are checked by hand in the Wave 5 pass:
//   - iTerm2: sets TERM_PROGRAM=iTerm.app, TERM_PROGRAM_VERSION, LC_TERMINAL=iTerm2, COLORTERM=truecolor.
//   - Ghostty: TERM=xterm-ghostty, TERM_PROGRAM=ghostty, COLORTERM=truecolor.
//   - WezTerm: TERM_PROGRAM=WezTerm, TERM=xterm-256color by default, COLORTERM=truecolor.
//   - kitty: TERM=xterm-kitty, KITTY_WINDOW_ID, COLORTERM=truecolor.
//   - Alacritty: TERM=alacritty (xterm-256color without its terminfo), COLORTERM=truecolor.
//   - VS Code integrated terminal: TERM_PROGRAM=vscode, COLORTERM=truecolor.
//   - GNOME Terminal and other VTE terminals: VTE_VERSION (7600 = VTE 0.76), COLORTERM=truecolor.
//   - Konsole: KONSOLE_VERSION (240802 = 24.08.2), COLORTERM=truecolor.
//   - tmux: TERM=tmux-256color, TMUX=<socket>,<pid>,<session>. tmux does not set COLORTERM; the
//     value passes through only when the server was started inside a terminal that had it.
//   - Windows Terminal: WT_SESSION=<guid>, WT_PROFILE_ID; no TERM, no COLORTERM.
//   - conhost: none of the above.
//   - Linux console: TERM=linux.
//   - Apple Terminal 488 on macOS 27: docs/EVIDENCE.md, Wave 0 (TERM_PROGRAM=Apple_Terminal, COLORTERM=truecolor).
//
// `nodeDepth` is what Node's `tty.WriteStream#getColorDepth(env)` returned for that environment on
// Node 26 (measured with a throwaway script on macOS). Node answers 8 for Apple Terminal even with
// COLORTERM=truecolor, 24 on Windows 10 build 14931 and later, and 24 whenever TMUX is set.

interface Row {
  name: string;
  env: Env;
  platform: string;
  osRelease: string;
  nodeDepth: number;
  /** The right answer for this terminal. */
  depth: ColorDepth;
  unicode: boolean;
  braille: boolean;
  /**
   * Set when the current detection differs from `depth`. The test then pins what detection returns
   * today, so the gap stays visible and a fix makes the test fail until the row is updated.
   */
  gap?: { actual: ColorDepth; why: string };
}

const UTF8 = 'en_US.UTF-8';
const MAC = { platform: 'darwin', osRelease: '25.1.0' } as const; // macOS 26
const LINUX = { platform: 'linux', osRelease: '6.8.0' } as const;
const WIN = { platform: 'win32', osRelease: '10.0.26100' } as const;

const ROWS: readonly Row[] = [
  // Tier 1
  {
    name: 'Apple Terminal 488 on macOS 27 (EVIDENCE.md, Node says 8)',
    env: { TERM: 'xterm-256color', TERM_PROGRAM: 'Apple_Terminal', COLORTERM: 'truecolor', LANG: UTF8 },
    platform: 'darwin', osRelease: '27.0.0', nodeDepth: 8, depth: 24, unicode: true, braille: true,
  },
  {
    name: 'Apple Terminal on macOS 26 (Darwin 25) without COLORTERM',
    env: { TERM: 'xterm-256color', TERM_PROGRAM: 'Apple_Terminal', LANG: UTF8 },
    ...MAC, nodeDepth: 8, depth: 24, unicode: true, braille: true,
  },
  {
    name: 'Windows Terminal',
    env: { WT_SESSION: '0f8b3c52-6a0e-4b0c-9a58-3f3f4a0c9b11', WT_PROFILE_ID: '{61c54bbd-c2c6-5271-96e7-009a87ff44bf}' },
    ...WIN, nodeDepth: 24, depth: 24, unicode: true, braille: true,
  },
  {
    name: 'Windows Terminal when Node reports only 8',
    env: { WT_SESSION: '0f8b3c52-6a0e-4b0c-9a58-3f3f4a0c9b11' },
    ...WIN, nodeDepth: 8, depth: 24, unicode: true, braille: true,
  },

  // Tier 2
  {
    name: 'iTerm2',
    env: { TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.5.11', LC_TERMINAL: 'iTerm2', TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: UTF8 },
    ...MAC, nodeDepth: 24, depth: 24, unicode: true, braille: true,
  },
  {
    name: 'Ghostty',
    env: { TERM: 'xterm-ghostty', TERM_PROGRAM: 'ghostty', TERM_PROGRAM_VERSION: '1.2.0', COLORTERM: 'truecolor', LANG: UTF8 },
    ...MAC, nodeDepth: 24, depth: 24, unicode: true, braille: true,
  },
  {
    name: 'Ghostty without COLORTERM (for example after sudo)',
    env: { TERM: 'xterm-ghostty', TERM_PROGRAM: 'ghostty', LANG: UTF8 },
    ...MAC, nodeDepth: 4, depth: 24, unicode: true, braille: true,
    gap: { actual: 4, why: 'TERM=xterm-ghostty and TERM_PROGRAM=ghostty are not recognized; Node reports 16 colors for xterm-*' },
  },
  {
    name: 'WezTerm',
    env: { TERM_PROGRAM: 'WezTerm', TERM: 'xterm-256color', COLORTERM: 'truecolor', WEZTERM_PANE: '0', LANG: UTF8 },
    ...MAC, nodeDepth: 24, depth: 24, unicode: true, braille: true,
  },
  {
    name: 'WezTerm without COLORTERM',
    env: { TERM_PROGRAM: 'WezTerm', TERM: 'xterm-256color', LANG: UTF8 },
    ...MAC, nodeDepth: 8, depth: 24, unicode: true, braille: true,
    gap: { actual: 8, why: 'TERM_PROGRAM=WezTerm is not recognized; Node reports 256 colors for xterm-256color' },
  },
  {
    name: 'kitty',
    env: { TERM: 'xterm-kitty', KITTY_WINDOW_ID: '1', COLORTERM: 'truecolor', LANG: UTF8 },
    ...LINUX, nodeDepth: 24, depth: 24, unicode: true, braille: true,
  },
  {
    name: 'kitty without COLORTERM (Node knows xterm-kitty)',
    env: { TERM: 'xterm-kitty', LANG: UTF8 },
    ...LINUX, nodeDepth: 24, depth: 24, unicode: true, braille: true,
  },
  {
    name: 'Alacritty',
    env: { TERM: 'alacritty', COLORTERM: 'truecolor', LANG: UTF8 },
    ...LINUX, nodeDepth: 24, depth: 24, unicode: true, braille: true,
  },
  {
    name: 'Alacritty without COLORTERM',
    env: { TERM: 'alacritty', LANG: UTF8 },
    ...LINUX, nodeDepth: 1, depth: 24, unicode: true, braille: true,
    gap: { actual: 4, why: 'TERM=alacritty is not recognized; Node reports 2 colors, which maps to 4-bit' },
  },
  {
    name: 'VS Code integrated terminal',
    env: { TERM_PROGRAM: 'vscode', TERM_PROGRAM_VERSION: '1.105.0', TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: UTF8 },
    ...MAC, nodeDepth: 24, depth: 24, unicode: true, braille: true,
  },
  {
    name: 'GNOME Terminal (VTE)',
    env: { VTE_VERSION: '7600', TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: UTF8 },
    ...LINUX, nodeDepth: 24, depth: 24, unicode: true, braille: true,
  },
  {
    name: 'GNOME Terminal (VTE) without COLORTERM',
    env: { VTE_VERSION: '7600', TERM: 'xterm-256color', LANG: UTF8 },
    ...LINUX, nodeDepth: 8, depth: 24, unicode: true, braille: true,
    gap: { actual: 8, why: 'VTE_VERSION >= 3600 (truecolor support) is not read; Node reports 256 colors for xterm-256color' },
  },
  {
    name: 'Konsole',
    env: { KONSOLE_VERSION: '240802', TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: UTF8 },
    ...LINUX, nodeDepth: 24, depth: 24, unicode: true, braille: true,
  },
  {
    name: 'Konsole without COLORTERM',
    env: { KONSOLE_VERSION: '240802', TERM: 'xterm-256color', LANG: UTF8 },
    ...LINUX, nodeDepth: 8, depth: 24, unicode: true, braille: true,
    gap: { actual: 8, why: 'KONSOLE_VERSION is not read; Node reports 256 colors for xterm-256color' },
  },
  {
    name: 'tmux with COLORTERM passed through',
    env: { TERM: 'tmux-256color', TMUX: '/tmp/tmux-1000/default,4242,0', COLORTERM: 'truecolor', LANG: UTF8 },
    ...LINUX, nodeDepth: 24, depth: 24, unicode: true, braille: true,
  },
  {
    // Node treats TMUX as truecolor-capable. tmux itself converts to the outer terminal's depth.
    name: 'tmux without COLORTERM',
    env: { TERM: 'tmux-256color', TMUX: '/tmp/tmux-1000/default,4242,0', LANG: UTF8 },
    ...LINUX, nodeDepth: 24, depth: 24, unicode: true, braille: true,
  },

  // Tier 3 fallbacks
  {
    name: 'Apple Terminal on macOS 15 (Darwin 24) without COLORTERM',
    env: { TERM: 'xterm-256color', TERM_PROGRAM: 'Apple_Terminal', LANG: UTF8 },
    platform: 'darwin', osRelease: '24.6.0', nodeDepth: 8, depth: 8, unicode: true, braille: true,
  },
  {
    name: 'Windows conhost on a current Windows 10 or 11 build (Node says 24)',
    env: {},
    ...WIN, nodeDepth: 24, depth: 24, unicode: true, braille: true,
  },
  {
    name: 'Windows conhost on Windows 10 build 10586 (Node says 8)',
    env: {},
    platform: 'win32', osRelease: '10.0.10586', nodeDepth: 8, depth: 8, unicode: true, braille: true,
  },
  {
    name: 'Linux console with a UTF-8 locale: no Braille',
    env: { TERM: 'linux', LANG: UTF8 },
    ...LINUX, nodeDepth: 4, depth: 4, unicode: true, braille: false,
  },
  {
    name: 'Linux console with the C locale: ASCII only',
    env: { TERM: 'linux', LANG: 'C' },
    ...LINUX, nodeDepth: 4, depth: 4, unicode: false, braille: false,
  },
  {
    name: 'screen',
    env: { TERM: 'screen-256color', STY: '4242.pts-0.host', LANG: UTF8 },
    ...LINUX, nodeDepth: 8, depth: 8, unicode: true, braille: true,
  },

  // Locale gates on a capable terminal
  {
    name: 'Truecolor terminal over ssh with the C locale: ASCII only',
    env: { TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: 'C' },
    ...LINUX, nodeDepth: 24, depth: 24, unicode: false, braille: false,
  },
  {
    name: 'GNOME Terminal with LC_ALL=C overriding a UTF-8 LANG',
    env: { VTE_VERSION: '7600', TERM: 'xterm-256color', COLORTERM: 'truecolor', LC_ALL: 'C', LANG: UTF8 },
    ...LINUX, nodeDepth: 24, depth: 24, unicode: false, braille: false,
  },
];

describe('[REQ-CAP-01][REQ-CAP-03][REQ-PLAT-01] capability matrix', () => {
  it('has a row for every terminal in docs/PLAN.md tiers 1 and 2', () => {
    const names = ROWS.map((r) => r.name).join('\n');
    for (const terminal of [
      'Apple Terminal 488', 'Windows Terminal', 'iTerm2', 'Ghostty', 'WezTerm', 'kitty', 'Alacritty',
      'VS Code', 'GNOME Terminal', 'Konsole', 'tmux', 'conhost', 'Linux console',
    ]) {
      expect(names, terminal).toContain(terminal);
    }
  });

  it.each(ROWS.map((r) => [r.name, r] as const))('color depth: %s', (_name, row) => {
    const detected = detectColorDepth(row.env, row.platform, row.osRelease, row.nodeDepth, 'auto');
    if (row.gap === undefined) {
      expect(detected).toBe(row.depth);
    } else {
      // Pins today's behavior. Fixing the gap makes this fail: then drop `gap` from the row.
      expect(row.gap.actual).not.toBe(row.depth);
      expect(detected).toBe(row.gap.actual);
    }
  });

  it.each(ROWS.map((r) => [r.name, r] as const))('unicode and Braille: %s', (_name, row) => {
    expect(detectUnicode(row.env, row.platform)).toEqual({ unicode: row.unicode, braille: row.braille });
  });

  it.each(ROWS.map((r) => [r.name, r] as const))('modes offered: %s', (_name, row) => {
    const { unicode, braille } = detectUnicode(row.env, row.platform);
    const expected = braille ? 'braille' : unicode ? 'halfblock' : 'ascii';
    expect(effectiveMode('braille', unicode, braille)).toBe(expected);
    expect(effectiveMode('halfblock', unicode, braille)).toBe(unicode ? 'halfblock' : 'ascii');
    expect(effectiveMode('ascii', unicode, braille)).toBe('ascii');
  });

  it('--color overrides detection on every row', () => {
    for (const row of ROWS) {
      expect(detectColorDepth(row.env, row.platform, row.osRelease, row.nodeDepth, 'truecolor'), row.name).toBe(24);
      expect(detectColorDepth(row.env, row.platform, row.osRelease, row.nodeDepth, '256'), row.name).toBe(8);
      expect(detectColorDepth(row.env, row.platform, row.osRelease, row.nodeDepth, '16'), row.name).toBe(4);
    }
  });

  it('COLORTERM wins over the Apple Terminal rule on every row that sets it', () => {
    for (const row of ROWS.filter((r) => /^(truecolor|24bit)$/i.test(r.env['COLORTERM'] ?? ''))) {
      for (const nodeDepth of [1, 4, 8, 24]) {
        expect(detectColorDepth(row.env, row.platform, row.osRelease, nodeDepth, 'auto'), `${row.name} at node ${String(nodeDepth)}`).toBe(24);
      }
    }
  });

  it('the Windows rows are unicode regardless of LANG, as on Windows Terminal and conhost', () => {
    for (const lang of [undefined, 'C', 'POSIX', UTF8]) {
      const env: Env = lang === undefined ? {} : { LANG: lang };
      expect(detectUnicode(env, 'win32')).toEqual({ unicode: true, braille: true });
    }
  });
});

// Detection gaps found by this matrix are listed in the task report; src/ is unchanged.
