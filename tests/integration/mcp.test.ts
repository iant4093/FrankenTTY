import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VERSION } from '../../src/build-info.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SERVER = path.join('tools', 'frankentty-mcp', 'server.ts');

const hasTool = (tool: string): boolean => spawnSync(tool, ['-version'], { stdio: 'ignore' }).status === 0;
const canRun = hasTool('ffmpeg') && hasTool('ffprobe');

interface Message {
  jsonrpc?: string;
  id?: number | string | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

interface ToolReply {
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** Speaks newline-delimited JSON-RPC to a spawned server and records every stdout line. */
class Client {
  readonly child: ChildProcessWithoutNullStreams;
  readonly rawLines: string[] = [];
  stderr = '';
  readonly exited: Promise<number | null>;
  private buffer = '';
  private nextId = 1;
  private readonly messages: Message[] = [];
  private waiters: { match: (m: Message) => boolean; resolve: (m: Message) => void }[] = [];

  constructor() {
    this.child = spawn(process.execPath, [SERVER], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      let nl = this.buffer.indexOf('\n');
      while (nl >= 0) {
        const line = this.buffer.slice(0, nl);
        this.buffer = this.buffer.slice(nl + 1);
        this.rawLines.push(line);
        this.deliver(JSON.parse(line) as Message);
        nl = this.buffer.indexOf('\n');
      }
    });
    this.child.stderr.on('data', (chunk: string) => {
      this.stderr += chunk;
    });
    this.exited = new Promise((resolve) => this.child.once('close', (code) => resolve(code)));
  }

  private deliver(message: Message): void {
    const waiter = this.waiters.find((w) => w.match(message));
    if (waiter === undefined) {
      this.messages.push(message);
      return;
    }
    this.waiters = this.waiters.filter((w) => w !== waiter);
    waiter.resolve(message);
  }

  private wait(match: (m: Message) => boolean): Promise<Message> {
    const queued = this.messages.findIndex(match);
    if (queued >= 0) return Promise.resolve(this.messages.splice(queued, 1)[0] as Message);
    return new Promise((resolve) => this.waiters.push({ match, resolve }));
  }

  sendRaw(text: string): void {
    this.child.stdin.write(`${text}\n`);
  }

  notify(method: string, params?: unknown): void {
    this.sendRaw(JSON.stringify({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) }));
  }

  request(method: string, params?: unknown): Promise<Message> {
    const id = this.nextId++;
    this.sendRaw(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }));
    return this.wait((m) => m.id === id);
  }

  waitForId(id: number | string): Promise<Message> {
    return this.wait((m) => m.id === id);
  }

  /** Waits for a message that answers no request (id null), such as a parse error. */
  nextNullId(): Promise<Message> {
    return this.wait((m) => m.id === null);
  }

  async call(name: string, args?: unknown): Promise<ToolReply> {
    const reply = await this.request('tools/call', { name, ...(args === undefined ? {} : { arguments: args }) });
    expect(reply.error).toBeUndefined();
    return reply.result as unknown as ToolReply;
  }

  async close(): Promise<void> {
    this.child.stdin.end();
    await this.exited;
  }
}

describe('frankentty MCP server: protocol', () => {
  let client: Client;
  beforeAll(() => {
    client = new Client();
  });
  afterAll(async () => {
    await client.close();
  });

  it('initialize returns capabilities, server info and the client version when supported', async () => {
    const reply = await client.request('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    expect(reply.jsonrpc).toBe('2.0');
    expect(reply.error).toBeUndefined();
    expect(reply.result).toEqual({
      protocolVersion: '2025-03-26',
      capabilities: { tools: {} },
      serverInfo: { name: 'frankentty', version: VERSION },
    });
  });

  it('initialize answers 2025-06-18 for a version it does not know', async () => {
    const reply = await client.request('initialize', { protocolVersion: '1999-01-01' });
    expect(reply.result?.['protocolVersion']).toBe('2025-06-18');
  });

  it('notifications get no response and ping still answers', async () => {
    client.notify('notifications/initialized');
    client.notify('notifications/something-unknown');
    const reply = await client.request('ping');
    expect(reply.result).toEqual({});
    expect(reply.id).toBeGreaterThan(0);
  });

  it('tools/list returns the four tools with object schemas', async () => {
    const reply = await client.request('tools/list');
    const tools = reply.result?.['tools'] as { name: string; description: string; inputSchema: Record<string, unknown> }[];
    expect(tools.map((t) => t.name).sort()).toEqual([
      'frankentty_bench',
      'frankentty_probe_media',
      'frankentty_render_snapshot',
      'frankentty_terminal_caps',
    ]);
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.inputSchema['type']).toBe('object');
      expect(tool.inputSchema['additionalProperties']).toBe(false);
      expect(typeof tool.inputSchema['properties']).toBe('object');
    }
    const probeTool = tools.find((t) => t.name === 'frankentty_probe_media');
    expect(probeTool?.inputSchema['required']).toEqual(['input']);
  });

  it('terminal_caps with an Apple Terminal 488 environment reports 24-bit color', async () => {
    const reply = await client.call('frankentty_terminal_caps', {
      env: { TERM_PROGRAM: 'Apple_Terminal', TERM: 'xterm-256color', LANG: 'en_US.UTF-8' },
      platform: 'darwin',
      osRelease: '25.1.0',
    });
    expect(reply.isError).toBeUndefined();
    expect(reply.structuredContent).toMatchObject({ colorDepth: 24, unicode: true, braille: true, platform: 'darwin' });
    expect(JSON.parse(reply.content[0]?.text ?? '')).toEqual(reply.structuredContent);
  });

  it('terminal_caps follows the detection rules for other environments', async () => {
    const oldMac = await client.call('frankentty_terminal_caps', {
      env: { TERM_PROGRAM: 'Apple_Terminal', TERM: 'xterm-256color' },
      platform: 'darwin',
      osRelease: '24.6.0',
    });
    // The last detection step is Node's getColorDepth(), which on a Windows host reads the real
    // console (24-bit on Windows 10+) instead of the emulated env, so only the Unicode rules are
    // host-independent there.
    expect(oldMac.structuredContent).toMatchObject(
      process.platform === 'win32' ? { unicode: false, braille: false } : { colorDepth: 8, unicode: false, braille: false },
    );

    const linuxConsole = await client.call('frankentty_terminal_caps', {
      env: { COLORTERM: 'truecolor', TERM: 'linux', LC_ALL: 'C.UTF-8' },
      platform: 'linux',
    });
    expect(linuxConsole.structuredContent).toMatchObject({ colorDepth: 24, unicode: true, braille: false });

    const own = await client.call('frankentty_terminal_caps');
    expect(own.structuredContent?.['platform']).toBe(process.platform);
  });

  it('answers -32601 for an unknown method', async () => {
    const reply = await client.request('resources/list');
    expect(reply.error?.code).toBe(-32601);
    expect(reply.result).toBeUndefined();
  });

  it('answers -32700 with a null id for a malformed line, and keeps serving', async () => {
    client.sendRaw('{"jsonrpc":"2.0","id":1,"method":');
    const reply = await client.nextNullId();
    expect(reply.error?.code).toBe(-32700);
    expect((await client.request('ping')).result).toEqual({});
  });

  it('answers -32600 for messages that are not requests', async () => {
    client.sendRaw('[1,2]');
    expect((await client.nextNullId()).error?.code).toBe(-32600);
    client.sendRaw('{"jsonrpc":"2.0","id":"seven"}');
    const missingMethod = await client.waitForId('seven');
    expect(missingMethod.error?.code).toBe(-32600);
    client.sendRaw('{"jsonrpc":"2.0","id":{"a":1},"method":"ping"}');
    expect((await client.nextNullId()).error?.code).toBe(-32600);
  });

  it('answers -32602 for bad params', async () => {
    const cases: [string, unknown][] = [
      ['tools/call', undefined],
      ['tools/call', { arguments: {} }],
      ['tools/call', { name: 5 }],
      ['tools/call', { name: 'frankentty_terminal_caps', arguments: [] }],
      ['tools/call', { name: 'no_such_tool', arguments: {} }],
      ['tools/call', { name: 'frankentty_terminal_caps', arguments: { platform: 5 } }],
      ['tools/call', { name: 'frankentty_terminal_caps', arguments: { env: { A: 1 } } }],
      ['tools/call', { name: 'frankentty_terminal_caps', arguments: { surprise: true } }],
      ['tools/call', { name: 'frankentty_probe_media', arguments: {} }],
      ['tools/call', { name: 'frankentty_bench', arguments: { demo: 'testsrc2', frames: 0 } }],
      ['tools/call', { name: 'frankentty_bench', arguments: { demo: 'testsrc2', frames: 1.5 } }],
      ['tools/call', { name: 'frankentty_bench', arguments: { demo: 'testsrc2', frames: 1001 } }],
      ['tools/call', { name: 'frankentty_bench', arguments: { demo: 'nope' } }],
      ['tools/call', { name: 'frankentty_bench', arguments: { demo: 'testsrc2', size: '80by24' } }],
      ['tools/call', { name: 'frankentty_bench', arguments: { demo: 'testsrc2', size: '80x1' } }],
      ['tools/call', { name: 'frankentty_bench', arguments: { demo: 'testsrc2', color: 'auto' } }],
      ['tools/call', { name: 'frankentty_bench', arguments: { demo: 'testsrc2', threshold: 101 } }],
      ['tools/call', { name: 'frankentty_bench', arguments: {} }],
      ['tools/call', { name: 'frankentty_bench', arguments: { demo: 'testsrc2', input: 'x.mp4' } }],
      ['tools/call', { name: 'frankentty_render_snapshot', arguments: { demo: 'testsrc2', atSec: -1 } }],
      ['tools/call', { name: 'frankentty_render_snapshot', arguments: { demo: 'testsrc2', size: '301x24' } }],
      ['initialize', undefined],
      ['initialize', { protocolVersion: 3 }],
    ];
    for (const [method, params] of cases) {
      const reply = await client.request(method, params);
      expect(reply.error?.code, `${method} ${JSON.stringify(params)}`).toBe(-32602);
      expect(reply.error?.message.length).toBeGreaterThan(0);
    }
  });

  it('reports a missing input as a tool failure, not a protocol error', async () => {
    const reply = await client.call('frankentty_probe_media', { input: path.join(os.tmpdir(), 'frankentty-no-such-file.mp4') });
    expect(reply.isError).toBe(true);
    expect(reply.content[0]?.text).toContain('no such file');
    const live = await client.call('frankentty_probe_media', { input: 'rtmp://example.invalid/live' });
    expect(live.isError).toBe(true);
  });

  it('writes only JSON-RPC lines to stdout', () => {
    expect(client.rawLines.length).toBeGreaterThan(10);
    for (const line of client.rawLines) {
      const parsed = JSON.parse(line) as Message;
      expect(parsed.jsonrpc).toBe('2.0');
    }
  });
});

describe('frankentty MCP server: shutdown', () => {
  it('finishes an accepted call after stdin closes, then exits 0', async () => {
    const client = new Client();
    client.sendRaw(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'frankentty_terminal_caps' } }));
    client.child.stdin.end();
    expect(await client.exited).toBe(0);
    expect(client.rawLines).toHaveLength(1);
    expect((JSON.parse(client.rawLines[0] ?? '') as Message).id).toBe(1);
  });
});

describe.skipIf(!canRun)('frankentty MCP server: ffmpeg tools', () => {
  let client: Client;
  let tmp: string;
  let clip: string;

  beforeAll(() => {
    client = new Client();
    tmp = mkdtempSync(path.join(os.tmpdir(), 'frankentty-mcp-'));
    clip = path.join(tmp, 'clip.mp4');
    const made = spawnSync(
      'ffmpeg',
      [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=15:duration=2',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
        '-c:v', 'mpeg4', '-c:a', 'aac', '-shortest', clip,
      ],
      { encoding: 'utf8' },
    );
    if (made.status !== 0) throw new Error(`cannot generate test clip: ${made.stderr}`);
  });
  afterAll(async () => {
    await client.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('bench on testsrc2 returns the report as text and structured content', async () => {
    const reply = await client.call('frankentty_bench', { demo: 'testsrc2', frames: 10, size: '80x24' });
    expect(reply.isError).toBeUndefined();
    const report = reply.structuredContent as Record<string, number | string>;
    expect(report['source']).toBe('testsrc2');
    expect(report['frames']).toBe(10);
    expect(report['cols']).toBe(80);
    expect(report['rows']).toBe(24);
    expect(report['depth']).toBe('truecolor');
    const savings = report['sgrSavingsPct'] as number;
    expect(savings).toBeGreaterThanOrEqual(0);
    expect(savings).toBeLessThanOrEqual(100);
    expect(JSON.parse(reply.content[0]?.text ?? '')).toEqual(report);
  });

  it('bench honors mode, palette, color and threshold', async () => {
    const reply = await client.call('frankentty_bench', {
      demo: 'testsrc2', frames: 5, size: '60x20', mode: 'ascii', palette: 'green', color: '256', threshold: 20,
    });
    expect(reply.structuredContent).toMatchObject({ mode: 'ascii', palette: 'green', depth: '256', threshold: 20, frames: 5 });
  });

  it('probe_media reads a generated mp4', async () => {
    const reply = await client.call('frankentty_probe_media', { input: clip });
    expect(reply.isError).toBeUndefined();
    const info = reply.structuredContent as Record<string, unknown>;
    expect(info).toMatchObject({ width: 160, height: 90, hasAudio: true, source: 'file' });
    expect(info['fps']).toBeCloseTo(15, 1);
    expect(info['durationSec']).toBeGreaterThan(1.5);
    expect(info['durationSec']).toBeLessThan(2.5);
  });

  it('render_snapshot on testsrc2 returns a 23-row grid of spaces and half blocks', async () => {
    const reply = await client.call('frankentty_render_snapshot', { demo: 'testsrc2' });
    expect(reply.isError).toBeUndefined();
    const s = reply.structuredContent as {
      grid: string;
      cols: number;
      rows: number;
      stats: Record<string, number>;
      topBackgrounds: { color: string; count: number }[];
      ansi?: string;
    };
    const rows = s.grid.split('\n');
    expect(rows).toHaveLength(23);
    for (const row of rows) expect([...row]).toHaveLength(80);
    const glyphs = new Set(s.grid.replaceAll('\n', ''));
    expect([...glyphs].every((g) => g === ' ' || g === '▀')).toBe(true);
    expect(glyphs.has('▀')).toBe(true);

    expect(Object.keys(s.stats).sort()).toEqual(['bytes', 'naiveBytes', 'naiveSgr', 'sgrEmitted']);
    expect(s.stats['bytes']).toBeGreaterThan(0);
    expect(s.stats['naiveBytes']).toBeGreaterThanOrEqual(s.stats['bytes'] as number);
    expect(s.stats['sgrEmitted']).toBeLessThanOrEqual(s.stats['naiveSgr'] as number);

    expect(s.topBackgrounds.length).toBeGreaterThan(0);
    expect(s.topBackgrounds.length).toBeLessThanOrEqual(8);
    for (const bg of s.topBackgrounds) expect(bg.color).toMatch(/^#[0-9a-f]{6}$/);
    const counts = s.topBackgrounds.map((b) => b.count);
    expect([...counts].sort((a, b) => b - a)).toEqual(counts);
    expect(s.ansi).toBeUndefined();
    expect(reply.content[0]?.text.startsWith(rows[0] ?? '?')).toBe(true);
  });

  it('render_snapshot honors size and returns the escape stream on request', async () => {
    const reply = await client.call('frankentty_render_snapshot', {
      demo: 'testsrc2', atSec: 0.5, size: '40x12', includeAnsi: true,
    });
    const s = reply.structuredContent as { grid: string; ansi: string; ansiTruncated: boolean; rows: number };
    expect(s.grid.split('\n')).toHaveLength(11);
    expect(s.ansi.startsWith('\\x1b[?2026h')).toBe(true);
    expect(s.ansi.endsWith('\\x1b[0m\\x1b[?2026l')).toBe(true);
    expect(s.ansi).not.toContain('\x1b');
    expect(s.ansiTruncated).toBe(false);
  });

  it('render_snapshot caps the escape stream at 64 KB', async () => {
    const reply = await client.call('frankentty_render_snapshot', {
      demo: 'testsrc2', size: '300x100', threshold: 0, includeAnsi: true,
    });
    const s = reply.structuredContent as { ansi: string; ansiTruncated: boolean };
    expect(s.ansiTruncated).toBe(true);
    expect(s.ansi.length).toBe(64 * 1024);
  });

  it('render_snapshot works for a file, in other modes, depths and palettes', async () => {
    const file = await client.call('frankentty_render_snapshot', { input: clip, atSec: 0.5, size: '60x20' });
    expect(file.isError).toBeUndefined();
    expect((file.structuredContent?.['grid'] as string).split('\n')).toHaveLength(19);

    const ascii = await client.call('frankentty_render_snapshot', { demo: 'testsrc2', mode: 'ascii', size: '60x20' });
    expect(ascii.structuredContent).toMatchObject({ mode: 'ascii' });
    const asciiGlyphs = new Set((ascii.structuredContent?.['grid'] as string).replaceAll('\n', ''));
    expect([...asciiGlyphs].every((g) => ' .:-=+*#%@'.includes(g))).toBe(true);

    const sixteen = await client.call('frankentty_render_snapshot', { demo: 'testsrc2', color: '16', palette: 'amber', size: '60x20' });
    const backgrounds = sixteen.structuredContent?.['topBackgrounds'] as { color: string }[];
    expect(backgrounds.length).toBeGreaterThan(0);
    const ansi16 = new Set(['#000000', '#cd0000', '#00cd00', '#cdcd00', '#0000ee', '#cd00cd', '#00cdcd', '#e5e5e5',
      '#7f7f7f', '#ff0000', '#00ff00', '#ffff00', '#5c5cff', '#ff00ff', '#00ffff', '#ffffff']);
    expect(backgrounds.every((b) => ansi16.has(b.color))).toBe(true);
  });

  it('render_snapshot past the end of the media is a tool failure', async () => {
    const reply = await client.call('frankentty_render_snapshot', { input: clip, atSec: 600 });
    expect(reply.isError).toBe(true);
    expect(reply.content[0]?.text.length).toBeGreaterThan(0);
  });

  it('stdout stayed clean through the ffmpeg tools', () => {
    for (const line of client.rawLines) expect((JSON.parse(line) as Message).jsonrpc).toBe('2.0');
  });
});
