import { randomUUID } from 'node:crypto';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { McpConfig } from './mcp-config.js';
import type { ToolContext } from '../contracts.js';
import { boundedFetch } from './bounded-fetch.js';
import { headerAnnotations, parameterHeaders } from './mcp-stateless-headers.js';
import { protocolKey, capabilitiesKey, clientInfoKey, serverInfoKey, statelessVersion, statelessHeaders, StatelessError } from '../mcp-stateless.js';

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export class LegacyMcpFallback extends Error {}

/** HTTP only; request-local metadata replaces initialization and session IDs. */
class StatelessHttpClient {
  private closed = false;
  private readonly active = new Set<AbortController>();
  constructor(private readonly url: URL, private readonly fetch: typeof globalThis.fetch, private readonly bearer?: string) {}
  alive = (): boolean => !this.closed;
  close = async (): Promise<void> => { this.closed = true; for (const controller of this.active) controller.abort(); };
  async request(method: string, params: Record<string, unknown>, timeout: number, signal?: AbortSignal,
    extraHeaders: Record<string, string> = {}): Promise<Record<string, unknown>> {
    if (this.closed || this.active.size >= 8) throw new Error('MCP client is closed or busy');
    const controller = new AbortController(); this.active.add(controller);
    const signals = [controller.signal, AbortSignal.timeout(timeout)]; if (signal) signals.push(signal);
    const request = { jsonrpc: '2.0' as const, id: randomUUID(), method, params: { ...params, _meta: {
      [protocolKey]: statelessVersion, [capabilitiesKey]: {}, [clientInfoKey]: { name: 'branch', version: '0.1.0' },
    } } };
    try {
      const body = JSON.stringify(request);
      if (Buffer.byteLength(body) > 65536 || Object.entries(extraHeaders).reduce((bytes, [key, value]) => bytes + key.length + value.length, 0) > 16384)
        throw new Error('MCP request body or routing headers exceed limits');
      const response = await this.fetch(this.url, { method: 'POST', redirect: 'error', signal: AbortSignal.any(signals),
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
          ...(this.bearer ? { authorization: `Bearer ${this.bearer}` } : {}), ...statelessHeaders(request), ...extraHeaders },
        body });
      const message = await reply(response, request.id);
      if (!object(message) || message.jsonrpc !== '2.0' || message.id !== request.id) throw new Error('Invalid MCP response identity');
      if (object(message.error)) {
        const code = message.error.code;
        if (Number.isInteger(code) && [-32020, -32021, -32022].includes(Number(code)))
          throw new StatelessError(Number(code), 'Stateless MCP request refused', message.error.data);
        if (method === 'server/discover' && (code === -32601 || code === -32002 || response.status >= 400 && response.status < 500))
          throw new LegacyMcpFallback('Server requires legacy MCP initialization');
        throw new Error('MCP request failed');
      }
      if (!response.ok || !object(message.result)) throw new Error('Invalid MCP result');
      if (message.result.resultType === 'input_required') throw new Error('MCP requires client input; stateless MRTR is not implemented');
      if (message.result.resultType !== 'complete') throw new Error('Unsupported MCP result type');
      return message.result;
    } finally { this.active.delete(controller); }
  }
}

async function reply(response: Response, id: string): Promise<unknown> {
  const type = response.headers.get('content-type') ?? '';
  if (/application\/json/i.test(type)) {
    try { return await response.json(); } catch {
      if (response.status >= 400 && response.status < 500) throw new LegacyMcpFallback('Server returned a legacy HTTP error');
      throw new Error('Invalid MCP JSON response');
    }
  }
  if (!/text\/event-stream/i.test(type) || !response.body) {
    if (response.status >= 400 && response.status < 500) throw new LegacyMcpFallback('Server did not return MCP JSON or SSE');
    throw new Error('Server did not return MCP JSON or SSE');
  }
  const reader = response.body.getReader(), decoder = new TextDecoder(); let pending = '', count = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) throw new Error('MCP stream ended without a result');
      pending = (pending + decoder.decode(part.value, { stream: true })).replace(/\r\n|\r(?!$)/g, '\n');
      let boundary: number;
      while ((boundary = pending.indexOf('\n\n')) >= 0) {
        if (++count > 200) throw new Error('MCP response stream exceeds event limit');
        const event = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
        const data = event.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).replace(/^ /, '')).join('\n');
        if (!data) continue;
        const message: unknown = JSON.parse(data);
        if (!object(message) || message.jsonrpc !== '2.0') throw new Error('Invalid MCP stream message');
        if (message.id === id && ('result' in message || 'error' in message)) return message;
        if ('id' in message || typeof message.method !== 'string') throw new Error('Unexpected MCP stream request');
      }
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

export async function openStatelessMcp(config: Extract<McpConfig, { transport: 'http' }>, env: NodeJS.ProcessEnv,
  policy: { guard(base: typeof fetch): typeof fetch } | undefined, timeout: number) {
  const url = new URL(config.url), local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password || url.search || url.hash)
    throw new Error('MCP endpoint requires credential-free HTTPS or loopback HTTP');
  const secret = config.bearerEnv ? env[config.bearerEnv] : undefined;
  if (config.bearerEnv && !secret) throw new Error('Configured MCP bearer credential is unavailable');
  const client = new StatelessHttpClient(url, policy ? policy.guard(boundedFetch) : boundedFetch, secret);
  let discovered = false;
  try {
    const discovery = await client.request('server/discover', {}, timeout);
    const info = object(discovery._meta) ? discovery._meta[serverInfoKey] : undefined;
    if (!object(info) || info.version !== config.expectedVersion || !Array.isArray(discovery.supportedVersions)
      || !discovery.supportedVersions.includes(statelessVersion)) throw new Error('MCP stateless discovery or server version changed');
    discovered = true;
    const found = await listTools(client, config.tools, timeout);
    const call = (name: string, args: Record<string, unknown>, context: ToolContext): Promise<unknown> => {
      const tool = found.find((item) => item.name === name);
      if (!tool) throw new Error('MCP tool is not in the reviewed allowlist');
      return client.request('tools/call', { name, arguments: args }, 30000, context.signal, parameterHeaders(tool.inputSchema, args));
    };
    return { config, found, secrets: secret ? [secret] : [], call, close: client.close, alive: client.alive };
  } catch (error) {
    await client.close();
    if (discovered && (error instanceof LegacyMcpFallback || error instanceof StatelessError))
      throw new Error('Modern MCP discovery succeeded but its tool list failed; legacy execution was not attempted');
    throw error;
  }
}

async function listTools(client: StatelessHttpClient, wanted: string[], timeout: number): Promise<Tool[]> {
  const found = new Map<string, Tool>(), cursors = new Set<string>(); let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const result = await client.request('tools/list', cursor ? { cursor } : {}, timeout);
    if (!Array.isArray(result.tools) || result.tools.length > 1000) throw new Error('Invalid MCP tool list');
    for (const tool of result.tools) {
      if (!object(tool) || typeof tool.name !== 'string' || !object(tool.inputSchema) || tool.inputSchema.type !== 'object'
        || JSON.stringify(tool).length > 65536) throw new Error('Invalid MCP tool schema');
      try { headerAnnotations(tool.inputSchema); } catch { continue; }
      if (wanted.includes(tool.name)) found.set(tool.name, tool as unknown as Tool);
    }
    if (result.nextCursor === undefined) break;
    if (typeof result.nextCursor !== 'string' || cursors.has(result.nextCursor) || page === 9) throw new Error('MCP tool pagination limit');
    cursor = result.nextCursor; cursors.add(cursor);
  }
  if (wanted.some((name) => !found.has(name))) throw new Error('Configured stateless MCP tool is unavailable');
  return [...found.values()];
}
