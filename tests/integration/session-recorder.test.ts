import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MAX_JSON_BYTES,
  SceneError,
  recordSession,
  validateCommand,
  validateScene,
  writeSession,
} from '../../tools/session-recorder/record.ts';
import type { SceneSpec, Session } from '../../tools/session-recorder/record.ts';
import { KEY_RIGHT, KEY_SHIFT_LEFT, SCENES, getScene } from '../../tools/session-recorder/scenes.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const hasTool = (tool: string, flag: string): boolean => spawnSync(tool, [flag], { stdio: 'ignore' }).status === 0;
// The recorder drives a POSIX pseudo-terminal (Python pty/fcntl), which Windows does not have.
const canRecord = process.platform !== 'win32' && hasTool('ffmpeg', '-version') && hasTool('python3', '--version');

const RESTORE = '\x1b[?2026l\x1b[0m\x1b[?7h\x1b[?25h\x1b[?1049l';

const SMALL: SceneSpec = {
  name: 'test-small',
  title: 'Test scene',
  command: ['--demo', 'testsrc2'],
  cols: 40,
  rows: 12,
  durationSec: 2,
  events: [],
};

function expectSessionShape(session: Session): void {
  expect(session.version).toBe(1);
  expect(session.fps).toBe(30);
  expect(session.cols).toBe(40);
  expect(session.rows).toBe(12);
  expect(session.title).toBe('Test scene');
  expect(session.command).toEqual(['frankentty', '--demo', 'testsrc2']);
  expect(session.env).toMatchObject({ TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: 'en_US.UTF-8', SDL_AUDIODRIVER: 'dummy' });
  expect(Object.keys(session.env)).not.toContain('FRANKENTTY_CACHE_DIR');
  expect(session.events).toEqual([{ t: 2, keys: 'q', label: 'quit' }]);
  expect(session.durationSec).toBeGreaterThanOrEqual(2);
  expect(session.durationSec).toBeLessThan(8);
  expect(session.chunks.length).toBeGreaterThan(0);

  let previous = -Infinity;
  let bytes = 0;
  for (const chunk of session.chunks) {
    expect(typeof chunk.t).toBe('number');
    expect(chunk.t).toBeGreaterThanOrEqual(previous);
    previous = chunk.t;
    bytes += Buffer.from(chunk.b64, 'base64').length;
  }
  expect(bytes).toBeGreaterThan(0);

  const first = Buffer.from(session.chunks[0]?.b64 ?? '', 'base64').toString('latin1');
  expect(first).toContain('\x1b[?1049h');
  const last = Buffer.from(session.chunks[session.chunks.length - 1]?.b64 ?? '', 'base64').toString('latin1');
  expect(last).toContain(RESTORE);
}

describe('scenes', () => {
  it('define the five scenes of video/script.md and all validate', () => {
    expect(SCENES.map((s) => s.name)).toEqual(['act1-mandelbrot', 'act3-modes', 'act3-seek-pause', 'act3-resize', 'act2-cell']);
    for (const scene of SCENES) {
      const checked = validateScene(scene);
      expect(checked.events[checked.events.length - 1]?.keys).toBe('q');
    }
    expect(getScene('act3-modes').events.map((e) => [e.t, e.keys])).toEqual([
      [2, 'm'], [5, 'm'], [8, 'm'], [10, 'c'], [12, 'c'], [14, 'c'], [16, 'c'], [18.5, 'q'],
    ]);
    expect(getScene('act3-seek-pause').events.map((e) => e.keys)).toEqual([KEY_RIGHT, KEY_RIGHT, ' ', ' ', KEY_SHIFT_LEFT, 'i', 'i', 'q']);
    expect(KEY_RIGHT).toBe('\x1b[C');
    expect(KEY_SHIFT_LEFT).toBe('\x1b[1;2D');
    const resize = getScene('act3-resize');
    expect([resize.cols, resize.rows]).toEqual([100, 30]);
    expect(resize.events[0]).toMatchObject({ t: 4, resize: [160, 45] });
    expect(() => getScene('nope')).toThrow(RangeError);
  });

  it('validateScene appends a final q only when none is present', () => {
    expect(validateScene({ ...SMALL }).events).toEqual([{ t: 2, keys: 'q', label: 'quit' }]);
    const withQ = validateScene({ ...SMALL, events: [{ t: 1, keys: 'q', label: 'bye' }] });
    expect(withQ.events).toEqual([{ t: 1, keys: 'q', label: 'bye' }]);
  });
});

describe('validateCommand', () => {
  it('accepts a demo with playback flags', () => {
    expect(validateCommand(['--demo'])).toEqual(['--demo']);
    expect(validateCommand(['--demo', 'life', '--mode', 'halfblock', '--palette', 'amber', '--no-audio'])).toEqual([
      '--demo', 'life', '--mode', 'halfblock', '--palette', 'amber', '--no-audio',
    ]);
    expect(validateCommand(['--fps', '24', '--threshold', '12.5', '--demo', 'gradients'])).toHaveLength(6);
  });

  it('accepts an existing local file', () => {
    expect(validateCommand([path.join(root, 'package.json')])).toHaveLength(1);
  });

  it.each([
    [[]],
    [['--bench']],
    [['--demo', 'testsrc2', '--bench']],
    [['--demo', 'nope']],
    [['--demo', 'life', 'extra']],
    [['--demo', 'life', '--demo', 'life']],
    [['--demo', 'life', '--mode', 'cube']],
    [['--demo', 'life', '--fps', '61']],
    [['--demo', 'life', '--fps', '1.5']],
    [['--demo', 'life', '--threshold']],
    [['--demo', 'life', '--loop']],
    [['--mode', 'ascii']],
    [['rm', '-rf', '/']],
    [['https://example.invalid/live.mp4']],
    [['/definitely/not/a/file.mp4']],
    [['--help']],
    [['--version']],
    [['--', 'x']],
    [['--demo', '']],
    [['--demo', 'life\0']],
  ])('rejects %j', (args) => {
    expect(() => validateCommand(args as string[])).toThrow(SceneError);
  });
});

describe('validateScene limits', () => {
  it.each([
    ['name with a slash', { name: '../x' }],
    ['uppercase name', { name: 'Bad' }],
    ['too few cols', { cols: 10 }],
    ['too many rows', { rows: 101 }],
    ['fractional cols', { cols: 40.5 }],
    ['zero duration', { durationSec: 0 }],
    ['long duration', { durationSec: 121 }],
    ['event after the end', { events: [{ t: 3, keys: 'm', label: '' }] }],
    ['negative event time', { events: [{ t: -1, keys: 'm', label: '' }] }],
    ['empty event', { events: [{ t: 1, keys: '', label: '' }] }],
    ['long keys', { events: [{ t: 1, keys: 'x'.repeat(17), label: '' }] }],
    ['resize with keys', { events: [{ t: 1, keys: 'm', label: '', resize: [80, 24] as [number, number] }] }],
    ['resize out of range', { events: [{ t: 1, keys: '', label: '', resize: [80, 2] as [number, number] }] }],
    ['bad command', { command: ['--bench'] }],
  ])('rejects %s', (_label, patch) => {
    expect(() => validateScene({ ...SMALL, ...patch })).toThrow(SceneError);
  });
});

describe('writeSession', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'frankentty-session-write-'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const tiny: Session = {
    version: 1, cols: 40, rows: 12, fps: 30, durationSec: 1, title: 't', command: ['frankentty', '--demo'], env: {},
    events: [], chunks: [{ t: 0.1, b64: Buffer.from('hello').toString('base64') }],
  };

  it('writes plain JSON under the size limit', () => {
    const out = path.join(dir, 'small.json');
    const written = writeSession(tiny, out);
    expect(written).toMatchObject({ path: out, gzipped: false, chunks: 1, bytes: 5 });
    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual(tiny);
  });

  it('gzips above the limit and removes a stale plain copy', () => {
    const out = path.join(dir, 'big.json');
    writeSession(tiny, out);
    const big: Session = { ...tiny, chunks: [{ t: 0.1, b64: 'A'.repeat(MAX_JSON_BYTES + 1) }] };
    const written = writeSession(big, out);
    expect(written.gzipped).toBe(true);
    expect(written.path).toBe(`${out}.gz`);
    expect(existsSync(out)).toBe(false);
    const back = JSON.parse(gunzipSync(readFileSync(`${out}.gz`)).toString('utf8')) as Session;
    expect(back.chunks[0]?.b64.length).toBe(MAX_JSON_BYTES + 1);
  });
});

describe.skipIf(!canRecord)('recordSession (real player in a PTY)', () => {
  let cacheDir: string;
  beforeAll(() => {
    cacheDir = mkdtempSync(path.join(os.tmpdir(), 'frankentty-session-test-'));
  });
  afterAll(() => {
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it('records a 2 s custom scene with the expected shape', async () => {
    const session = await recordSession(SMALL, { cacheDir });
    expectSessionShape(session);
  }, 90_000);

  it('records keys at their times: an m at 1 s changes the mode', async () => {
    const session = await recordSession(
      { ...SMALL, name: 'test-keys', events: [{ t: 1, keys: 'm', label: 'ASCII' }] },
      { cacheDir },
    );
    expect(session.events.map((e) => e.keys)).toEqual(['m', 'q']);
    const bytes = Buffer.concat(session.chunks.filter((c) => c.t > 1.3).map((c) => Buffer.from(c.b64, 'base64'))).toString('latin1');
    // After the switch to ASCII mode no half blocks are drawn (they are U+2580, UTF-8 e2 96 80).
    expect(bytes.includes('\xe2\x96\x80')).toBe(false);
  }, 90_000);

  it('rejects a command that is not FrankenTTY playback before running anything', async () => {
    await expect(recordSession({ ...SMALL, command: ['--bench'] }, { cacheDir })).rejects.toBeInstanceOf(SceneError);
  });
});

// ---------------------------------------------------------------------------
// MCP tool
// ---------------------------------------------------------------------------

interface Reply {
  id?: number | null;
  result?: { content: { text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };
  error?: { code: number; message: string };
}

/** A minimal newline-delimited JSON-RPC client for the MCP server. */
class McpClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private buffer = '';
  private nextId = 1;
  private readonly waiting = new Map<number, (r: Reply) => void>();

  constructor() {
    this.child = spawn(process.execPath, [path.join('tools', 'frankentty-mcp', 'server.ts')], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      let nl = this.buffer.indexOf('\n');
      while (nl >= 0) {
        const reply = JSON.parse(this.buffer.slice(0, nl)) as Reply;
        this.buffer = this.buffer.slice(nl + 1);
        if (typeof reply.id === 'number') this.waiting.get(reply.id)?.(reply);
        nl = this.buffer.indexOf('\n');
      }
    });
  }

  call(name: string, args: unknown): Promise<Reply> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })}\n`);
    });
  }

  async close(): Promise<void> {
    const closed = new Promise<void>((resolve) => this.child.once('close', () => resolve()));
    this.child.stdin.end();
    await closed;
  }
}

describe('frankentty_record_session (MCP)', () => {
  const outDir = path.join(root, 'video', 'build', 'session-recorder-test');
  let client: McpClient;
  beforeAll(() => {
    client = new McpClient();
  });
  afterAll(async () => {
    await client.close();
    rmSync(outDir, { recursive: true, force: true });
  });

  it.skipIf(!canRecord)('records a custom scene and returns path, duration, chunk and byte counts', async () => {
    const out = path.join('video', 'build', 'session-recorder-test', 'mcp-small.json');
    const reply = await client.call('frankentty_record_session', {
      custom: {
        name: 'mcp-small',
        title: 'Test scene',
        command: ['--demo', 'testsrc2'],
        cols: 40,
        rows: 12,
        durationSec: 2,
        events: [],
      },
      path: out,
    });
    expect(reply.error).toBeUndefined();
    expect(reply.result?.isError).toBeUndefined();
    const s = reply.result?.structuredContent as Record<string, unknown>;
    expect(Object.keys(s).sort()).toEqual(['bytes', 'chunks', 'durationSec', 'fileBytes', 'gzipped', 'path']);
    expect(s['path']).toBe(out);
    expect(s['gzipped']).toBe(false);
    expect(s['chunks']).toBeGreaterThan(0);
    expect(s['bytes']).toBeGreaterThan(0);
    expect(JSON.parse(reply.result?.content[0]?.text ?? '')).toEqual(s);

    const session = JSON.parse(readFileSync(path.join(root, out), 'utf8')) as Session;
    expectSessionShape(session);
    expect(session.chunks).toHaveLength(s['chunks'] as number);
    expect(session.durationSec).toBe(s['durationSec']);
  }, 90_000);

  it.each([
    ['a command that is not FrankenTTY', { custom: { name: 'x', command: ['rm', '-rf', '/'], cols: 40, rows: 12, durationSec: 2, events: [] } }],
    ['--bench', { custom: { name: 'x', command: ['--demo', '--bench'], cols: 40, rows: 12, durationSec: 2, events: [] } }],
    ['a URL', { custom: { name: 'x', command: ['https://example.invalid/a.mp4'], cols: 40, rows: 12, durationSec: 2, events: [] } }],
    ['an empty command', { custom: { name: 'x', command: [], cols: 40, rows: 12, durationSec: 2, events: [] } }],
    ['a command that is not an array', { custom: { name: 'x', command: 'frankentty --demo', cols: 40, rows: 12, durationSec: 2, events: [] } }],
    ['an unknown scene', { scene: 'act9' }],
    ['both scene and custom', { scene: 'act2-cell', custom: { name: 'x', command: ['--demo'], cols: 40, rows: 12, durationSec: 2, events: [] } }],
    ['neither scene nor custom', {}],
    ['an output path outside video/', { scene: 'act2-cell', path: 'package.json' }],
    ['an output path that climbs out', { scene: 'act2-cell', path: 'video/../src/x.json' }],
    ['a non-json output path', { scene: 'act2-cell', path: 'video/sessions/x.txt' }],
    ['an event after the end', { custom: { name: 'x', command: ['--demo'], cols: 40, rows: 12, durationSec: 2, events: [{ t: 5, keys: 'm' }] } }],
    ['too many columns', { custom: { name: 'x', command: ['--demo'], cols: 301, rows: 12, durationSec: 2, events: [] } }],
    ['an extra field', { custom: { name: 'x', command: ['--demo'], cols: 40, rows: 12, durationSec: 2, events: [], env: {} } }],
  ])('rejects %s with JSON-RPC -32602', async (_label, args) => {
    const reply = await client.call('frankentty_record_session', args);
    expect(reply.result).toBeUndefined();
    expect(reply.error?.code).toBe(-32602);
    expect(existsSync(path.join(root, 'video', 'sessions', 'x.json'))).toBe(false);
  });
});
