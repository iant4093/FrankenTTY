import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildReport,
  escapeCell,
  listTestFiles,
  parseRequirements,
  parseWorkflowJobs,
  scanTestSource,
  splitTags,
} from '../../scripts/trace.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Sample test sources are arrays of quoted lines, so that none of them starts with `describe(` or
// `it(` in this file: scripts/trace.ts scans this file too.
const lines = (...l: string[]): string => l.join('\n');

describe('trace: parseRequirements', () => {
  it('reads IDs, drops the (changed) note and strips Markdown from the text', () => {
    const md = lines(
      '# Requirements',
      '## 1. Section',
      '- **REQ-AAA-01:** THE SYSTEM SHALL do `x` and **y**.',
      '- **REQ-BBB-12 (changed):** WHEN   a  b, THEN c.',
      'not a requirement line',
      '- **NOTREQ-01:** ignored',
    );
    expect(parseRequirements(md)).toEqual([
      { id: 'REQ-AAA-01', text: 'THE SYSTEM SHALL do x and y.' },
      { id: 'REQ-BBB-12', text: 'WHEN a b, THEN c.' },
    ]);
  });

  it('finds every requirement of this repository, once each', () => {
    const reqs = parseRequirements(readFileSync(path.join(root, '.kiro', 'specs', 'frankentty', 'requirements.md'), 'utf8'));
    const ids = reqs.map((r) => r.id);
    expect(ids.length).toBeGreaterThanOrEqual(40);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('REQ-TERM-03');
    expect(ids).toContain('REQ-CI-01');
  });
});

describe('trace: splitTags', () => {
  it('separates requirement tags, property tags and the title', () => {
    expect(splitTags('[P2c][REQ-RENDER-02][REQ-RENDER-05] encoder in a terminal')).toEqual({
      reqs: ['REQ-RENDER-02', 'REQ-RENDER-05'],
      props: ['P2c'],
      title: 'encoder in a terminal',
    });
  });

  it('accepts spaces between tags and several property forms', () => {
    expect(splitTags('[P8b] [REQ-SYNC-01]  x')).toEqual({ reqs: ['REQ-SYNC-01'], props: ['P8b'], title: 'x' });
    expect(splitTags('[P2c-naive][REQ-RENDER-01] y').props).toEqual(['P2c-naive']);
  });

  it('leaves titles without tags, and brackets that are not tags, alone', () => {
    expect(splitTags('plain title')).toEqual({ reqs: [], props: [], title: 'plain title' });
    expect(splitTags('[x] done')).toEqual({ reqs: [], props: [], title: '[x] done' });
    expect(splitTags('[REQ-A-01 x')).toEqual({ reqs: [], props: [], title: '[REQ-A-01 x' });
    expect(splitTags('title with [REQ-AAA-01] inside').reqs).toEqual([]);
  });

  it('does not take lookalike IDs for requirements', () => {
    expect(splitTags('[REQ-aaa-01] x').reqs).toEqual([]);
    expect(splitTags('[REQ-AAA-1x] x').reqs).toEqual([]);
    expect(splitTags('[PERF-01] x').reqs).toEqual([]);
  });
});

describe('trace: scanTestSource', () => {
  it('finds tagged describe, it and test titles with modifiers and every quote style', () => {
    const src = lines(
      "describe('[REQ-AAA-01] top', () => {",
      "  it('[REQ-AAA-02] single quotes', () => {});",
      '  it("[REQ-AAA-03] it\'s double quoted", () => {});',
      '  test(`[REQ-AAA-04] template ${String(1)}`, () => {});',
      "  it.skipIf(!ok)('[REQ-AAA-05] skipIf', () => {});",
      "describe.skipIf(!a || process.env['X'] !== '1')('[REQ-AAA-06] long guard', () => {});",
      "  describe.each([...NAMES])('[P1][REQ-AAA-07] %s', () => {});",
      "  it.fails('[REQ-AAA-08] fails', () => {});",
      '});',
    );
    const found = scanTestSource('tests/unit/x.test.ts', src);
    expect(found.map((f) => f.reqs[0])).toEqual([
      'REQ-AAA-01', 'REQ-AAA-02', 'REQ-AAA-03', 'REQ-AAA-04', 'REQ-AAA-05', 'REQ-AAA-06', 'REQ-AAA-07', 'REQ-AAA-08',
    ]);
    expect(found.map((f) => f.line)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(found[2]?.title).toBe("it's double quoted");
    expect(found[6]).toMatchObject({ props: ['P1'], title: '%s', file: 'tests/unit/x.test.ts' });
  });

  it('collects several requirements from one title and ignores untagged titles, comments and other calls', () => {
    const src = lines(
      "describe('[REQ-AAA-01][REQ-AAA-02] two', () => {});",
      "describe('untagged', () => {});",
      "// it('[REQ-AAA-03] in a comment', () => {});",
      "const t = foo('[REQ-AAA-04] not a test call');",
      "expect(x).toBe('[REQ-AAA-05]');",
    );
    const found = scanTestSource('f.test.ts', src);
    expect(found).toHaveLength(1);
    expect(found[0]?.reqs).toEqual(['REQ-AAA-01', 'REQ-AAA-02']);
  });

  it('names a title that is only tags', () => {
    expect(scanTestSource('f.test.ts', "it('[REQ-AAA-01]', () => {});")[0]?.title).toBe('(untitled)');
  });
});

describe('trace: parseWorkflowJobs', () => {
  const yaml = lines(
    'name: CI',
    'on:',
    '  push:',
    '    branches: [main]',
    'jobs:',
    '  quality:',
    '    name: Workflow checks',
    '    runs-on: ubuntu-latest',
    '  test:',
    '    name: "Tests (${{ matrix.os }})"',
    '    steps:',
    '      - name: not a job name',
    '  nameless:',
    '    runs-on: x',
    'other:',
    '  after:',
    '    name: ignored',
  );

  it('reads job keys and names, and stops at the next top-level key', () => {
    expect([...parseWorkflowJobs(yaml)]).toEqual([
      ['quality', 'Workflow checks'],
      ['test', 'Tests (${{ matrix.os }})'],
      ['nameless', 'nameless'],
    ]);
  });

  it('finds every job that the manual entries rely on in the real workflow', () => {
    const jobs = parseWorkflowJobs(readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8'));
    for (const job of ['quality', 'test', 'build', 'smoke', 'install-test', 'release']) {
      expect(jobs.has(job), job).toBe(true);
    }
  });
});

describe('trace: escapeCell', () => {
  it('escapes pipes, angle brackets, asterisks and newlines', () => {
    expect(escapeCell('a|b <c> W*H\nz')).toBe('a\\|b &lt;c&gt; W\\*H z');
  });
});

describe('trace: buildReport on a temporary repository', () => {
  const temps: string[] = [];
  afterEach(() => {
    for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function makeRepo(opts: { requirements: string[]; tests: Record<string, string>; files?: string[]; ci?: string }): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'frankentty-trace-'));
    temps.push(dir);
    const put = (rel: string, text: string): void => {
      mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      writeFileSync(path.join(dir, rel), text);
    };
    put(path.join('.kiro', 'specs', 'frankentty', 'requirements.md'), opts.requirements.join('\n') + '\n');
    for (const [rel, text] of Object.entries(opts.tests)) put(rel, text);
    for (const f of opts.files ?? []) put(f, 'x\n');
    if (opts.ci !== undefined) put(path.join('.github', 'workflows', 'ci.yml'), opts.ci);
    return dir;
  }

  it('lists verifications, counts them, and reports missing and unknown requirements', () => {
    const dir = makeRepo({
      requirements: [
        '- **REQ-AAA-01:** First needs a | pipe and <angle> and W*H and a very long tail that goes past the eighty character limit of the summary column.',
        '- **REQ-AAA-02:** Second has no test.',
        '- **REQ-AAA-03 (changed):** Third has many tests.',
      ],
      tests: {
        'tests/unit/a.test.ts': lines("describe('[REQ-AAA-01] alpha', () => {});", "it('[REQ-AAA-03] one', () => {});", "it('[REQ-AAA-03] two', () => {});"),
        'tests/pbt/b.pbt.test.ts': lines("it('[P1][REQ-AAA-03] three', () => {});", "it('[REQ-AAA-03] four', () => {});", "it('[REQ-ZZZ-99] unknown', () => {});"),
        'tests/helpers/not-a-test.ts': "it('[REQ-AAA-02] helper files are not scanned', () => {});",
      },
    });
    const r = buildReport(dir);
    expect(r.missing).toEqual(['REQ-AAA-02']);
    expect(r.unknown).toEqual([{ id: 'REQ-ZZZ-99', where: 'tests/pbt/b.pbt.test.ts:3' }]);

    const rows = r.markdown.split('\n').filter((l) => l.startsWith('| REQ-'));
    expect(rows).toHaveLength(3);
    const [first, second, third] = rows;
    // Pipes, angle brackets and asterisks are escaped; the summary is cut near 80 characters.
    expect(first).toContain('a \\| pipe and &lt;angle&gt; and W\\*H');
    expect(first).toContain('…');
    expect(first).toContain('`tests/unit/a.test.ts` › alpha');
    expect(first?.endsWith('| 1 |')).toBe(true);
    expect(second).toContain('**none**');
    expect(second?.endsWith('| 0 |')).toBe(true);
    // Four tests: three listed, then "+1 more"; the count is the full four.
    expect(third).toContain('`tests/pbt/b.pbt.test.ts` › three');
    expect(third).toContain('+1 more');
    expect(third?.endsWith('| 4 |')).toBe(true);
    expect(r.markdown).toContain('| Requirement | Summary | Verified by | Count |');
    expect(r.markdown).toContain('2 of 3 requirements have at least one verification.');
  });

  it('counts documents and CI jobs for the manual entries only when they exist', () => {
    const ci = lines('jobs:', '  quality:', '    name: Checks', '  test:', '    name: Tests', '  release:', '    name: Publish');
    const req = [
      '- **REQ-COMP-04:** Docs.',
      '- **REQ-CI-01:** CI.',
      '- **REQ-DIST-01:** Releases.',
    ];
    const full = buildReport(makeRepo({ requirements: req, tests: {}, files: ['README.md', 'DEVPOST_WRITEUP.md'], ci }));
    // COMP-04: two files. CI-01: three jobs. DIST-01: only `release` of build, smoke, install-test, release exists.
    expect(full.missing).toEqual([]);
    expect(full.markdown).toContain('`README.md`');
    expect(full.markdown).toContain('CI job `quality` (Checks)');
    expect(full.markdown).toContain('CI job `release` (Publish)');

    const partial = buildReport(makeRepo({ requirements: req, tests: {}, files: ['README.md'], ci }));
    expect(partial.missing).toEqual([]);
    expect(partial.markdown).not.toContain('DEVPOST_WRITEUP.md');

    const none = buildReport(makeRepo({ requirements: req, tests: {}, files: [] }));
    expect(none.missing).toEqual(['REQ-COMP-04', 'REQ-CI-01', 'REQ-DIST-01']);
  });

  it('lists test files in a stable order with / separators', () => {
    const dir = makeRepo({
      requirements: ['- **REQ-AAA-01:** x'],
      tests: { 'tests/unit/b.test.ts': '', 'tests/integration/a.test.ts': '', 'tests/unit/a.test.ts': '', 'tests/unit/c.ts': '' },
    });
    expect(listTestFiles(dir)).toEqual(['tests/integration/a.test.ts', 'tests/unit/a.test.ts', 'tests/unit/b.test.ts']);
    expect(listTestFiles(path.join(dir, 'nowhere'))).toEqual([]);
  });
});

describe('trace: this repository', () => {
  it('node scripts/trace.ts exits 0: every requirement has a verification and every tag is known', () => {
    const r = spawnSync(process.execPath, [path.join('scripts', 'trace.ts')], { cwd: root, encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const ids = parseRequirements(readFileSync(path.join(root, '.kiro', 'specs', 'frankentty', 'requirements.md'), 'utf8')).map((q) => q.id);
    for (const id of ids) expect(r.stdout, id).toMatch(new RegExp(`^\\| ${id} \\|.*\\| [1-9]\\d* \\|$`, 'm'));
    expect(r.stdout).not.toContain('**none**');
  });
});
