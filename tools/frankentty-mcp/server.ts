// FrankenTTY MCP server: Model Context Protocol over stdio, JSON-RPC 2.0, one JSON message per line.
// No SDK. stdout carries protocol messages only; logs go to stderr.
// Dev tooling for the vt100-video Power. Not shipped, never imported by src/.

import { createInterface } from 'node:readline';
import { VERSION } from '../../src/build-info.ts';
import { ArgError, TOOLS, callTool, killAllChildren } from './tools.ts';

const SUPPORTED_VERSIONS: readonly string[] = ['2025-06-18', '2025-03-26', '2024-11-05'];
const LATEST_VERSION = '2025-06-18';

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

type Id = string | number | null;

function send(message: object): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id: Id, result: object): void {
  send({ jsonrpc: '2.0', id, result });
}

function sendError(id: Id, code: number, message: string): void {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Tool calls run one at a time: the bench measures timing and each one owns ffmpeg processes. */
let toolQueue: Promise<void> = Promise.resolve();

async function handleToolCall(id: Id, params: unknown): Promise<void> {
  if (!isObject(params) || typeof params['name'] !== 'string') {
    sendError(id, INVALID_PARAMS, 'tools/call needs params.name (string)');
    return;
  }
  const args = params['arguments'];
  if (args !== undefined && !isObject(args)) {
    sendError(id, INVALID_PARAMS, 'params.arguments must be an object');
    return;
  }
  try {
    sendResult(id, await callTool(params['name'], args));
  } catch (err) {
    if (err instanceof ArgError) {
      sendError(id, INVALID_PARAMS, err.message);
      return;
    }
    console.error(`frankentty-mcp: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    sendError(id, INTERNAL_ERROR, 'internal error');
  }
}

function handleRequest(id: Id, method: string, params: unknown): void {
  switch (method) {
    case 'initialize': {
      if (!isObject(params)) {
        sendError(id, INVALID_PARAMS, 'initialize needs params');
        return;
      }
      const requested = params['protocolVersion'];
      if (typeof requested !== 'string') {
        sendError(id, INVALID_PARAMS, 'initialize needs params.protocolVersion (string)');
        return;
      }
      sendResult(id, {
        protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : LATEST_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'frankentty', version: VERSION },
      });
      return;
    }
    case 'ping':
      sendResult(id, {});
      return;
    case 'tools/list':
      sendResult(id, {
        tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      });
      return;
    case 'tools/call':
      toolQueue = toolQueue.then(() => handleToolCall(id, params));
      return;
    default:
      sendError(id, METHOD_NOT_FOUND, `method not found: ${method}`);
  }
}

function handleLine(line: string): void {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    sendError(null, PARSE_ERROR, 'parse error');
    return;
  }
  if (!isObject(message)) {
    sendError(null, INVALID_REQUEST, 'a message must be a JSON object (batches are not supported)');
    return;
  }
  const hasId = Object.hasOwn(message, 'id');
  const rawId = message['id'];
  if (hasId && typeof rawId !== 'string' && typeof rawId !== 'number') {
    sendError(null, INVALID_REQUEST, 'id must be a string or a number');
    return;
  }
  const id: Id = hasId ? (rawId as string | number) : null;
  const method = message['method'];
  if (typeof method !== 'string') {
    // A response to a request we never sent: ignore it.
    if (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error')) return;
    sendError(id, INVALID_REQUEST, 'method must be a string');
    return;
  }
  // Notifications (no id) never get a response, including notifications/initialized.
  if (!hasId) return;
  handleRequest(id, method, message['params']);
}

function shutdown(code: number): void {
  killAllChildren();
  process.exit(code);
}

process.stdout.on('error', () => {
  // The client went away; nothing left to tell it.
  shutdown(0);
});
process.once('SIGINT', () => {
  shutdown(130);
});
process.once('SIGTERM', () => {
  shutdown(143);
});

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', (line) => {
  if (line.trim() !== '') handleLine(line);
});
// stdin closed: finish the calls already accepted, then let the process end.
lines.on('close', () => {
  void toolQueue.then(() => {
    killAllChildren();
  });
});
