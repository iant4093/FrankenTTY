import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GUARD = path.join('scripts', 'hooks', 'compliance-guard.sh');

const has = (cmd: string): boolean => spawnSync(cmd, ['--version'], { stdio: 'ignore' }).status === 0;
const canRun = process.platform !== 'win32' && has('bash') && has('git');
const inGitRepo = has('git') && spawnSync('git', ['rev-parse', '--git-dir'], { cwd: root, stdio: 'ignore' }).status === 0;

function runGuard(cwd: string) {
  const r = spawnSync('bash', [path.join(cwd, GUARD), '--check'], { cwd, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const temps: string[] = [];

/** A minimal repo copy: the guard script and its helper, the four .kiro folders and the real LICENSE. */
function makeRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'frankentty-compliance-'));
  temps.push(dir);
  spawnSync('git', ['init', '--quiet'], { cwd: dir });
  mkdirSync(path.join(dir, 'scripts', 'hooks'), { recursive: true });
  for (const f of ['compliance-guard.sh', 'lib.sh']) {
    cpSync(path.join(root, 'scripts', 'hooks', f), path.join(dir, 'scripts', 'hooks', f));
  }
  for (const d of ['steering', 'specs', 'hooks', 'agents']) {
    mkdirSync(path.join(dir, '.kiro', d), { recursive: true });
    writeFileSync(path.join(dir, '.kiro', d, 'README.md'), `${d}\n`);
  }
  cpSync(path.join(root, 'LICENSE'), path.join(dir, 'LICENSE'));
  writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\nbuild/\n');
  return dir;
}

afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe.skipIf(!canRun)('[REQ-COMP-01][REQ-COMP-02] compliance-guard --check', () => {
  it('passes in this repository', () => {
    const r = runGuard(root);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('compliance-guard: PASS');
  });

  it('passes on a clean temporary copy (fixture sanity)', () => {
    const r = runGuard(makeRepo());
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  // KNOWN BUG, reported to architect-opus (scripts/hooks is not writable by builder-sonnet):
  // compliance-guard.sh runs `git check-ignore -q` with three paths. Git rejects that
  // ("--quiet is only valid with a single pathname", exit 128) and the script hides stderr, so the
  // "ignores .kiro" check never fires. These cases assert the required behavior and are marked
  // `fails` until the script checks one path at a time. When it is fixed, vitest reports them as
  // unexpectedly passing: change `it.fails` to `it`.
  for (const entry of ['.kiro', '.kiro/', '/.kiro/specs/', '.kiro/steering']) {
    it(`exits 2 when .gitignore lists ${entry}`, () => {
      const dir = makeRepo();
      writeFileSync(path.join(dir, '.gitignore'), `node_modules/\n${entry}\n`);
      const r = runGuard(dir);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('.gitignore ignores .kiro');
    });
  }

  it('git itself reports a .gitignore that lists .kiro as ignoring the paths the guard checks', () => {
    const dir = makeRepo();
    writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n.kiro\n');
    for (const p of ['.kiro', '.kiro/steering/product.md', '.kiro/hooks/review-and-pbt.json']) {
      expect(spawnSync('git', ['check-ignore', '-q', p], { cwd: dir }).status, p).toBe(0);
    }
  });

  it('exits 2 when LICENSE is missing', () => {
    const dir = makeRepo();
    rmSync(path.join(dir, 'LICENSE'));
    const r = runGuard(dir);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('LICENSE missing or not MIT');
  });

  it('exits 2 when LICENSE is not the MIT license', () => {
    const dir = makeRepo();
    writeFileSync(path.join(dir, 'LICENSE'), 'Proprietary. All rights reserved.\n');
    const r = runGuard(dir);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('LICENSE missing or not MIT');
  });

  it('exits 2 when a required .kiro folder is missing', () => {
    const dir = makeRepo();
    rmSync(path.join(dir, '.kiro', 'agents'), { recursive: true });
    const r = runGuard(dir);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('missing .kiro/agents');
  });
});

describe('[REQ-COMP-02] LICENSE', () => {
  it('is the MIT license with copyright "Ian Truong"', () => {
    const text = readFileSync(path.join(root, 'LICENSE'), 'utf8');
    expect(text.startsWith('MIT License')).toBe(true);
    expect(text).toMatch(/^Copyright \(c\) \d{4} Ian Truong$/m);
    expect(text).toContain('Permission is hereby granted, free of charge');
  });
});

describe.skipIf(!inGitRepo)('[REQ-COMP-01] .kiro is tracked and never ignored', () => {
  it('git tracks files under .kiro/specs, .kiro/hooks, .kiro/steering and .kiro/agents', () => {
    for (const dir of ['specs', 'hooks', 'steering', 'agents']) {
      const r = spawnSync('git', ['ls-files', '--', `.kiro/${dir}`], { cwd: root, encoding: 'utf8' });
      expect(r.stdout.trim().length, `.kiro/${dir} has no tracked file`).toBeGreaterThan(0);
    }
  });

  it('git does not ignore .kiro or the files the guard checks', () => {
    for (const p of ['.kiro', '.kiro/steering/product.md', '.kiro/hooks/review-and-pbt.json', '.kiro/specs/frankentty/requirements.md', '.kiro/agents/builder-sonnet.json']) {
      // Exit 1 means "not ignored"; 0 would mean ignored.
      expect(spawnSync('git', ['check-ignore', '-q', p], { cwd: root }).status, p).toBe(1);
    }
  });

  it('.gitignore has no line that ignores .kiro', () => {
    const lines = readFileSync(path.join(root, '.gitignore'), 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '' && !l.startsWith('#'));
    expect(lines.filter((l) => /^!?\/?\.kiro(\/|$)/.test(l) && !l.startsWith('!'))).toEqual([]);
    expect(existsSync(path.join(root, '.kiro'))).toBe(true);
  });
});
