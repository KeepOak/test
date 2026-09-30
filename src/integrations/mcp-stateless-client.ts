import { Client, StreamableHTTPClientTransport, withInputRequired, isInputRequiredResult,
  SdkError, SdkErrorCode, ProtocolError } from '@modelcontextprotocol/client';
import { CallToolResultSchema } from '@modelcontextprotocol/core';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { McpConfig } from './mcp-config.js';
import type { ToolContext } from '../contracts.js';
import { boundedFetch } from './bounded-fetch.js';
import { runAsNode } from '../child-env.js';
import { argumentFingerprint } from '../runtime.js';
import { headerAnnotations, parameterHeaders } from './mcp-stateless-headers.js';
import { appendMcpUi } from './mcp-app-resource.js';
import { mcpToolName } from './mcp.js';
import type { McpOwnerRequests } from '../mcp-owner-requests.js';
export class LegacyMcpFallback extends Error {}

function selectedEnv(config: Extract<McpConfig, { transport: 'stdio' }>, env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(config.envKeys.map((key) => {
    const value = env[key];
    if (!value) throw new Error(`Missing configured MCP environment variable: ${key}`);
    return [key, value];
  }));
}

function httpTransport(config: Extract<McpConfig, { transport: 'http' }>, env: NodeJS.ProcessEnv,
  policy?: { guard(base: typeof fetch): typeof fetch }) {
  const url = new URL(config.url), local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password || url.search || url.hash)
    throw new Error('MCP endpoint requires credential-free HTTPS or loopback HTTP');
  const secret = config.bearerEnv ? env[config.bearerEnv] : undefined;
  if (config.bearerEnv && !secret) throw new Error('Missing configured MCP credential');
  return { transport: new StreamableHTTPClientTransport(url, {
    fetch: boundedRequests(policy ? policy.guard(boundedFetch) : boundedFetch),
    requestInit: { redirect: 'error', ...(secret ? { headers: { authorization: `Bearer ${secret}` } } : {}) },
  }), secrets: secret ? [secret] : [] };
}

function boundedRequests(base: typeof fetch): typeof fetch {
  return async (input, init) => {
    if (typeof init?.body === 'string' && Buffer.byteLength(init.body) > 65536)
      throw new Error('MCP request body exceeds limit');
    const headers = new Headers(init?.headers);
    let size = 0;
    headers.forEach((value, name) => { size += name.length + value.length; });
    if (size > 16384) throw new Error('MCP routing headers exceed limit');
    return base(input, init);
  };
}

export async function openStatelessMcp(config: McpConfig, env: NodeJS.ProcessEnv,
  policy: { guard(base: typeof fetch): typeof fetch } | undefined, timeout: number, ownerRequests?: McpOwnerRequests) {
  const interactive = ownerRequests?.capabilities(config.id, true) ?? {};
  const client = new Client({ name: 'branch', version: '0.1.0' }, {
    capabilities: { ...(interactive.sampling ? { sampling: {} } : {}),
      ...(interactive.elicitation ? { elicitation: { form: {} } } : {}), ...(interactive.roots ? { roots: {} } : {}),
      ...(config.apps ? { extensions: {
      'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } } : {}) },
    inputRequired: { autoFulfill: false }, listMaxPages: 10,
    versionNegotiation: { mode: { pin: '2026-07-28' } },
  });
  const selected = config.transport === 'stdio' ? selectedEnv(config, env) : {};
  const connection = config.transport === 'http' ? httpTransport(config, env, policy) : {
    transport: new StdioClientTransport({ command: config.command, args: config.args,
      env: { ...getDefaultEnvironment(), ...selected, ...runAsNode(config.command) }, stderr: 'pipe', maxBufferSize: 1048576,
      ...(config.cwd ? { cwd: config.cwd } : {}) }), secrets: Object.values(selected),
  };
  if ('stderr' in connection.transport) connection.transport.stderr?.on('data', () => undefined);
  let alive = true;
  client.onclose = () => { alive = false; };
  const continuations = new Map<string, { state: string; expires: number }>();
  try {
    await negotiateModern(client, connection.transport, config, timeout);
    if (client.getProtocolEra() !== 'modern') throw new LegacyMcpFallback('Server negotiated legacy MCP');
    if (client.getServerVersion()?.version !== config.expectedVersion) throw new Error('MCP server version changed');
    const found = await listTools(client, config.tools, timeout);
    const call = modernCall(client, found, continuations, config, new Set(Object.keys(interactive)), ownerRequests);
    // Shared Apps bridge can consume this structural interface after capability negotiation is wired.
    const resourceReader = { readResource: client.readResource.bind(client) };
    return { config, found, secrets: connection.secrets, call, resourceReader, alive: () => alive,
      close: async () => { alive = false; continuations.clear(); await client.close(); } };
  } catch (error) { await client.close(); throw error; }
}

async function negotiateModern(client: Client, transport: Parameters<Client['connect']>[0], config: McpConfig, timeout: number) {
  try { await client.connect(transport, { timeout }); }
  catch (error) {
    // Only the side-effect-free discovery negotiation may fall back; never tool execution.
    if (config.protocol === 'auto' && (error instanceof SdkError && error.code === SdkErrorCode.EraNegotiationFailed
      || error instanceof ProtocolError && [-32601, -32022].includes(error.code)))
      throw new LegacyMcpFallback('Modern discovery was unavailable');
    throw error;
  }
}

function modernCall(client: Client, found: Tool[], continuations: Map<string, { state: string; expires: number }>,
  config: McpConfig, declared: ReadonlySet<string>, ownerRequests?: McpOwnerRequests) {
  return async (name: string, args: Record<string, unknown>, context: ToolContext): Promise<unknown> => {
    const tool = found.find((item) => item.name === name);
    if (!tool) throw new Error('MCP tool is not in the reviewed allowlist');
    const key = `${context.runId}:${argumentFingerprint(name, JSON.stringify(args))}`, deadline = Date.now() + 120000;
    const bound = { ...context, signal: AbortSignal.any([context.signal, AbortSignal.timeout(120000)]) };
    let inputResponses: Record<string, unknown> | undefined;
    for (const [id, held] of continuations) if (held.expires < Date.now()) continuations.delete(id);
    for (let round = 0; round < 10 && Date.now() < deadline; round++) {
      bound.signal.throwIfAborted();
      const held = continuations.get(key);
      const result = await client.request({ method: 'tools/call', params: { name, arguments: args,
        ...(held ? { requestState: held.state } : {}), ...(inputResponses ? { inputResponses } : {}) } }, withInputRequired(CallToolResultSchema),
        { signal: bound.signal, timeout: Math.min(30000, Math.max(1, deadline - Date.now())), allowInputRequired: true,
          headers: parameterHeaders(tool.inputSchema, args) });
      if (!isInputRequiredResult(result)) {
        continuations.delete(key);
        return config.apps ? appendMcpUi(client, tool, result, bound.signal) : result;
      }
      inputResponses = await embeddedResponses(result.inputRequests, config.id, name, args, bound, declared, ownerRequests);
      if (result.requestState !== undefined && (typeof result.requestState !== 'string' || result.requestState.length > 16384 || continuations.size >= 100 && !held))
        throw new Error('MCP continuation exceeds limits');
      if (result.requestState === undefined) continuations.delete(key);
      else continuations.set(key, { state: result.requestState, expires: Date.now() + 600000 });
      if (!inputResponses) await pause(bound.signal);
    }
    throw new Error('MCP is waiting for its native owner approval. The same task may retry after the owner answers.');
  };
}

async function embeddedResponses(requests: Record<string, unknown> | undefined, server: string, tool: string, args: Record<string, unknown>,
  context: ToolContext, declared: ReadonlySet<string>, ownerRequests?: McpOwnerRequests): Promise<Record<string, unknown> | undefined> {
  if (!requests || !Object.keys(requests).length) return undefined;
  if (!ownerRequests || Object.keys(requests).length > 8 || Buffer.byteLength(JSON.stringify(requests)) > 32768)
    throw new Error('MCP embedded requests are unavailable or exceed limits');
  const responses: Record<string, unknown> = {};
  for (const [id, request] of Object.entries(requests)) {
    if (!id || id.length > 200 || ['__proto__', 'constructor', 'prototype'].includes(id)) throw new Error('Invalid embedded request ID');
    const method = request && typeof request === 'object' ? (request as { method?: unknown }).method : undefined;
    const capability = method === 'sampling/createMessage' ? 'sampling' : method === 'elicitation/create' ? 'elicitation' : method === 'roots/list' ? 'roots' : '';
    if (!declared.has(capability)) throw new Error('MCP requested a capability absent from this connection');
    responses[id] = await ownerRequests.fulfill(server, request, context, mcpToolName(server, tool), args);
  }
  return responses;
}

function pause(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cancelled = () => { clearTimeout(timer); reject(new Error('MCP call cancelled')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancelled); resolve(); }, 500);
    signal.addEventListener('abort', cancelled, { once: true });
    if (signal.aborted) cancelled();
  });
}

async function listTools(client: Client, wanted: string[], timeout: number): Promise<Tool[]> {
  const found = new Map<string, Tool>(), seen = new Set<string>(); let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const result = await client.listTools(cursor ? { cursor } : {}, { timeout });
    if (result.tools.length > 1000) throw new Error('MCP tool list exceeds limit');
    for (const tool of result.tools) {
      if (JSON.stringify(tool).length > 65536) throw new Error('MCP tool schema exceeds limit');
      try { headerAnnotations(tool.inputSchema); } catch { continue; }
      if (wanted.includes(tool.name)) found.set(tool.name, tool as unknown as Tool);
    }
    if (!result.nextCursor) break;
    if (seen.has(result.nextCursor) || page === 9) throw new Error('MCP tool pagination limit');
    cursor = result.nextCursor; seen.add(cursor);
  }
  if (wanted.some((name) => !found.has(name))) throw new Error('Configured stateless MCP tool is unavailable');
  return [...found.values()];
}
