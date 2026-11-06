// Requirement traceability: which test (or CI job) verifies each EARS requirement.
//
//   node scripts/trace.ts > docs/TRACEABILITY.md
//
// Reads the requirement IDs and texts from .kiro/specs/frankentty/requirements.md, finds the
// `[REQ-…]` tags at the start of describe/it/test titles under tests/, adds the few requirements
// that no automated test can verify (see MANUAL below), and prints a Markdown table on stdout.
// Exit code 1 when a requirement has no verification or a test names a requirement that does not
// exist. Problems go to stderr. Only `node:` built-ins are used.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export interface Requirement {
  id: string;
  /** Requirement text with Markdown markup removed. */
  text: string;
}

export interface TaggedTitle {
  /** Path relative to the repository root, with `/` separators. */
  file: string;
  line: number;
  /** Title without its leading `[…]` tags. */
  title: string;
  /** `REQ-…` IDs in the tags. */
  reqs: string[];
  /** Property IDs (`P2c`, `P8b`, …) in the tags. */
  props: string[];
}

export interface Verification {
  requirement: string;
  where: string;
}

/**
 * Requirements that no automated test can verify directly. Each is verified by existing files or
 * CI jobs, and the script checks that they exist: a missing file or job leaves the requirement
 * with zero verifications.
 */
interface ManualEntry {
  id: string;
  reason: string;
  files?: string[];
  /** Job keys in .github/workflows/ci.yml. */
  jobs?: string[];
}

const MANUAL: readonly ManualEntry[] = [
  {
    id: 'REQ-COMP-04',
    reason: 'documentation deliverable, reviewed by architect-opus; the script checks the files exist',
    files: ['README.md', 'DEVPOST_WRITEUP.md'],
  },
  {
    id: 'REQ-CI-01',
    reason: 'the workflow is the verification: it runs the checks on three operating systems and gates the release',
    jobs: ['quality', 'test', 'release'],
  },
  {
    id: 'REQ-DIST-01',
    reason: 'verified by the release build, the archive smoke test and the installer jobs (tests/integration/release.test.ts and install.test.ts add local checks)',
    jobs: ['build', 'smoke', 'install-test', 'release'],
  },
];

const REQUIREMENTS_FILE = path.join('.kiro', 'specs', 'frankentty', 'requirements.md');
const WORKFLOW_FILE = path.join('.github', 'workflows', 'ci.yml');

const SUMMARY_CHARS = 80;
const SHOWN_PER_REQUIREMENT = 3;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** `- **REQ-TERM-01 (changed):** WHEN …` -> `{ id: 'REQ-TERM-01', text: 'WHEN …' }`. */
export function parseRequirements(markdown: string): Requirement[] {
  const out: Requirement[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const m = /^- \*\*(REQ-[A-Z]+-\d+)(?: \([^)]*\))?:\*\*\s*(.*)$/.exec(line);
    if (m === null) continue;
    const text = (m[2] ?? '').replace(/\*\*/g, '').replace(/`/g, '').replace(/\s+/g, ' ').trim();
    out.push({ id: m[1] ?? '', text });
  }
  return out;
}

const TAG_GROUP = /^\s*\[([^\]]+)\]/;

/** Splits the leading `[…]` tags from a title. */
export function splitTags(title: string): { reqs: string[]; props: string[]; title: string } {
  const reqs: string[] = [];
  const props: string[] = [];
  let rest = title;
  for (;;) {
    const m = TAG_GROUP.exec(rest);
    if (m === null) break;
    const tag = m[1] ?? '';
    if (/^REQ-[A-Z]+-\d+$/.test(tag)) reqs.push(tag);
    else if (/^P\d+[a-z]?(?:-[a-z]+)?$/.test(tag)) props.push(tag);
    else break; // not a tag: a title such as "[x] done" is left alone
    rest = rest.slice(m[0].length);
  }
  return { reqs, props, title: rest.trim() };
}

/** A describe/it/test call with an optional `.skipIf(...)`-style modifier, then a string title. */
const TITLE_CALL = /^\s*(?:describe|it|test)(?:\.\w+)*(?:\([^()]*\))?\(\s*(['"`])((?:\\.|(?!\1).)*)\1/;

/** Finds the tagged titles of one test file. */
export function scanTestSource(file: string, source: string): TaggedTitle[] {
  const out: TaggedTitle[] = [];
  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = TITLE_CALL.exec(lines[i] ?? '');
    if (m === null) continue;
    const { reqs, props, title } = splitTags(m[2] ?? '');
    if (reqs.length === 0) continue;
    out.push({ file, line: i + 1, title: title === '' ? '(untitled)' : title, reqs, props });
  }
  return out;
}

/** Test files under `<root>/tests`, sorted, as `tests/…` paths with `/` separators. */
export function listTestFiles(root: string): string[] {
  const dir = path.join(root, 'tests');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.test.ts'))
    .map((f) => ['tests', ...f.split(path.sep)].join('/'))
    .sort();
}

/** `jobs:` keys of a workflow with their `name:`. A small line scan, enough for this repository's ci.yml. */
export function parseWorkflowJobs(yaml: string): Map<string, string> {
  const jobs = new Map<string, string>();
  let inJobs = false;
  let current: string | null = null;
  for (const line of yaml.split(/\r?\n/)) {
    if (/^jobs:\s*$/.test(line)) {
      inJobs = true;
      continue;
    }
    if (!inJobs) continue;
    if (/^\S/.test(line) && line.trim() !== '') break; // next top-level key
    const key = /^ {2}([A-Za-z_][\w-]*):\s*$/.exec(line);
    if (key !== null) {
      current = key[1] ?? null;
      if (current !== null) jobs.set(current, current);
      continue;
    }
    const name = /^ {4}name:\s*(.+?)\s*$/.exec(line);
    if (name !== null && current !== null && jobs.get(current) === current) jobs.set(current, (name[1] ?? '').replace(/^["']|["']$/g, ''));
  }
  return jobs;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export interface Report {
  markdown: string;
  /** Requirements with no verification. */
  missing: string[];
  /** Tags that name a requirement not in requirements.md. */
  unknown: { id: string; where: string }[];
}

/** Makes text safe inside a Markdown table cell: pipes, HTML-looking brackets and emphasis marks. */
export function escapeCell(text: string): string {
  return text
    .replace(/\r?\n/g, ' ')
    .replace(/\|/g, '\\|')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\*/g, '\\*');
}

function summarize(text: string): string {
  return text.length <= SUMMARY_CHARS ? text : `${text.slice(0, SUMMARY_CHARS).trimEnd()}…`;
}

export function buildReport(root: string): Report {
  const requirements = parseRequirements(readFileSync(path.join(root, REQUIREMENTS_FILE), 'utf8'));
  const known = new Set(requirements.map((r) => r.id));

  const byRequirement = new Map<string, Verification[]>();
  for (const r of requirements) byRequirement.set(r.id, []);
  const unknown: { id: string; where: string }[] = [];

  for (const file of listTestFiles(root)) {
    const source = readFileSync(path.join(root, ...file.split('/')), 'utf8');
    for (const t of scanTestSource(file, source)) {
      for (const id of t.reqs) {
        const where = `\`${file}\` › ${t.title}`;
        if (!known.has(id)) {
          unknown.push({ id, where: `${file}:${String(t.line)}` });
          continue;
        }
        byRequirement.get(id)?.push({ requirement: id, where });
      }
    }
  }

  const workflowPath = path.join(root, WORKFLOW_FILE);
  const jobs = existsSync(workflowPath) ? parseWorkflowJobs(readFileSync(workflowPath, 'utf8')) : new Map<string, string>();
  for (const entry of MANUAL) {
    const list = byRequirement.get(entry.id);
    if (list === undefined) continue; // the requirement was removed from the spec; nothing to attach to
    for (const f of entry.files ?? []) {
      if (existsSync(path.join(root, f))) list.push({ requirement: entry.id, where: `\`${f}\` (${entry.reason})` });
    }
    for (const job of entry.jobs ?? []) {
      const name = jobs.get(job);
      if (name !== undefined) list.push({ requirement: entry.id, where: `CI job \`${job}\` (${name})` });
    }
  }

  const rows: string[] = [];
  const missing: string[] = [];
  for (const r of requirements) {
    const list = byRequirement.get(r.id) ?? [];
    if (list.length === 0) missing.push(r.id);
    const unique = [...new Set(list.map((v) => v.where))];
    const shown = unique.slice(0, SHOWN_PER_REQUIREMENT).map(escapeCell);
    if (unique.length > shown.length) shown.push(`+${String(unique.length - shown.length)} more`);
    rows.push(`| ${r.id} | ${escapeCell(summarize(r.text))} | ${shown.length === 0 ? '**none**' : shown.join('<br>')} | ${String(list.length)} |`);
  }

  const markdown = [
    '# Requirement traceability',
    '',
    'Generated by `node scripts/trace.ts`. A test is listed when its title starts with the requirement ID in brackets.',
    '',
    '| Requirement | Summary | Verified by | Count |',
    '|---|---|---|---|',
    ...rows,
    '',
    `${String(requirements.length - missing.length)} of ${String(requirements.length)} requirements have at least one verification.`,
    '',
  ].join('\n');

  return { markdown, missing, unknown };
}

function main(): number {
  const root = path.resolve(import.meta.dirname, '..');
  const report = buildReport(root);
  process.stdout.write(report.markdown);
  for (const id of report.missing) console.error(`trace: ${id} has no verification`);
  for (const u of report.unknown) console.error(`trace: ${u.where} names unknown requirement ${u.id}`);
  return report.missing.length > 0 || report.unknown.length > 0 ? 1 : 0;
}

if (import.meta.main) process.exitCode = main();
