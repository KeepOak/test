import { createHash } from 'node:crypto';
import { describesScreen } from '../screen-guard.js'; // dogfood follow-up
import { z } from 'zod';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { mcpClient, mcpValidator } from './mcp-sdk.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { JsonSchemaType } from '@modelcontextprotocol/sdk/validation';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { ToolRegistry } from '../registry.js';
import type { ToolDefinition, ToolContext } from '../contracts.js';
import { McpConfigSchema, makeTransport, type McpConfig } from './mcp-config.js';
import type { McpOwnerRequests } from '../mcp-owner-requests.js';
import { openStatelessMcp, LegacyMcpFallback } from './mcp-stateless-client.js';
import { StatelessError } from '../mcp-stateless.js';

export const mcpToolName = (id: string, tool: string): string =>
  `mcp.${id}.${createHash('sha256').update(tool).digest('hex').slice(0, 16)}`;

async function discover(client: Client, wanted: string[], timeout = 10000): Promise<Tool[]> {
  const found = new Map<string, Tool>(), seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const result = await client.listTools(cursor ? { cursor } : {}, { timeout });
    for (const tool of result.tools) {
      if (JSON.stringify(tool).length > 65536) throw new Error('MCP tool schema is too large');
      if (wanted.includes(tool.name)) found.set(tool.name, tool);
    }
    if (!result.nextCursor) break;
    if (seen.has(result.nextCursor) || page === 9) throw new Error('MCP tool pagination limit');
    seen.add(result.nextCursor); cursor = result.nextCursor;
  }
  if (wanted.some(name => !found.has(name))) throw new Error('Configured MCP tool is unavailable');
  return [...found.values()];
}

function clean(value: unknown, secrets: string[], depth = 0): unknown {
  if (depth > 20) throw new Error('MCP result nesting exceeds limit');
  if (typeof value === 'string')
    return secrets.reduce((text, secret) => text.split(secret).join('[credential redacted]'), value);
  if (Array.isArray(value)) return value.map(item => clean(item, secrets, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (secrets.some(secret => key.includes(secret))) throw new Error('MCP metadata contains a credential');
    return [key, clean(item, secrets, depth + 1)];
  }));
  return value;
}

function redact(result: unknown, secrets: string[]): unknown {
  if (Buffer.byteLength(JSON.stringify(result)) > 60000) throw new Error('MCP output exceeds 60 KiB');
  return clean(result, secrets);
}

/**
 * How one of a server's tools is actually called. With the server already connected this is the
 * client it was connected with; on demand it is a function that opens the connection first, so a
 * tool can sit in the list long before anything has been started.
 */
type CallThrough = (tool: string, args: Record<string, unknown>, context: ToolContext) => Promise<unknown>;

const through = (client: Client): CallThrough =>
  (tool, args, context) => client.callTool({ name: tool, arguments: args }, undefined,
    { signal: context.signal, timeout: 30000 });

function definition(call: CallThrough, config: McpConfig, tool: Tool, secrets: string[]): ToolDefinition {
  if (JSON.stringify(redact(tool, secrets)) !== JSON.stringify(tool))
    throw new Error('MCP discovery contains a configured credential');
  // The schema checker is made on the first call, so listing a server's tools loads no part of the SDK.
  let validate: ((args: unknown) => { valid: boolean }) | undefined;
  const name = mcpToolName(config.id, tool.name);
  // Dogfood follow-up: a server's computer-use or screen tool, by its annotations' title, name, description or inputs.
  const screen = describesScreen({ name: tool.name, title: tool.annotations?.title ?? tool.title, description: tool.description, inputSchema: tool.inputSchema });
  return { name, description: tool.description?.slice(0, 2000) ?? tool.name, external: true, ...(screen ? { screen: true } : {}),
    permission: name, parameters: z.record(z.string(), z.unknown()), inputSchema: tool.inputSchema,
    execute: async (args: unknown, context: ToolContext) => {
      validate ??= new (await mcpValidator())().getValidator(tool.inputSchema as JsonSchemaType);
      if (!validate(args).valid) throw new Error('MCP arguments do not match the configured tool schema');
      try {
        const result = await call(tool.name, args as Record<string, unknown>, context) as { isError?: boolean };
        if (result.isError) throw new Error('Remote tool reported failure');
        return redact(result, secrets);
      } catch {
        context.signal.throwIfAborted();
        throw new Error('MCP tool failed; inspect the configured server locally');
      }
    } };
}

/** What a connected server said its tools are, kept so they can be listed without connecting. */
export interface CachedMcpTool { name: string; description: string; inputSchema: unknown }
/**
 * A server that is actually open: a way to call it, the credentials it was opened with so they can
 * be kept out of what comes back, and what it says its tools are right now.
 */
export interface LiveMcp {
  call: CallThrough;
  secrets?: readonly string[];
  tools?: readonly { name: string; inputSchema?: unknown }[];
  /** False once the connection has closed under it: the program ended or crashed, or the address went away. */
  alive?: () => boolean;
}
/**
 * How long to wait before starting a server again after it stopped answering: a moment the first time, doubling each
 * time it goes down again within a minute, never more than five seconds. A server that crashes on every call is not
 * started again in a tight loop, and one that crashed once an hour ago is started again straight away.
 */
export const restartBackoffMs = (crashes: number): number => crashes <= 0 ? 0 : Math.min(200 * 2 ** (crashes - 1), 5000);
/** The crash count after one more: back to one when the last was over a minute ago. */
export const nextCrashCount = (crashes: number, lastCrashAt: number, now = Date.now()): number =>
  now - lastCrashAt > 60_000 ? 1 : crashes + 1;
const pause = (ms: number): Promise<void> => new Promise((resolve) => { if (ms <= 0) { resolve(); return; } setTimeout(resolve, ms).unref?.(); });
export interface McpToolCache {
  read(id: string): CachedMcpTool[];
  write(id: string, tools: CachedMcpTool[]): void;
}
const cacheable = (tools: Tool[]): CachedMcpTool[] =>
  tools.map(tool => ({ name: tool.name, description: tool.description?.slice(0, 2000) ?? tool.name,
    inputSchema: tool.inputSchema }));

/**
 * Puts a server's tools in the list without starting it. They come from what that server said the
 * last time it was connected, so the assistant can find them and the owner can see them; the
 * connection is opened the first time one of them is actually called, and the list is written down
 * again as soon as it is. A server nobody has ever connected has nothing to list, so this gives
 * back an empty list and the caller connects it the ordinary way instead.
 */
export function registerCachedMcp(
  registry: ToolRegistry, input: unknown, cached: readonly CachedMcpTool[],
  open: () => Promise<LiveMcp>,
): string[] {
  const config = McpConfigSchema.parse(input);
  const wanted = config.tools
    .map(name => cached.find(tool => tool.name === name))
    .filter((tool): tool is CachedMcpTool => tool !== undefined);
  if (wanted.length !== config.tools.length) return [];
  const remembered = new Map(wanted.map(tool => [tool.name, JSON.stringify(tool.inputSchema)]));
  let opened: Promise<LiveMcp> | undefined;
  // A connection that failed to open, or that has since closed under it (its program crashed), is not kept: the next
  // call opens it again through `open`, where the connection manager waits and retries (src/mcp-lifecycle.ts).
  const reach = async (again = true): Promise<LiveMcp> => {
    const current = (opened ??= open());
    let live: LiveMcp;
    try { live = await current; } catch (error) { if (opened === current) opened = undefined; throw error; }
    if (live.alive?.() !== false) return live;
    if (opened === current) opened = undefined;
    if (!again) throw new Error('MCP server stopped answering');
    return reach(false);
  };
  const call: CallThrough = async (name, args, context) => {
    const live = await reach();
    // The shape above came from an earlier connection. If the server has changed what this tool
    // needs since then, the remembered shape is not to be trusted for a moment longer: the call is
    // checked against what the server says now, and refused if it no longer fits.
    const fresh = live.tools?.find(tool => tool.name === name);
    if (fresh && JSON.stringify(fresh.inputSchema) !== remembered.get(name)) {
      remembered.set(name, JSON.stringify(fresh.inputSchema));
      const check = new (await mcpValidator())().getValidator(fresh.inputSchema as JsonSchemaType);
      if (!check(args).valid) throw new Error('MCP server changed this tool since Branch last spoke to it');
    }
    const result = await live.call(name, args, context);
    // Redacted here as well as in `definition`, because the credentials are only known once the
    // connection has actually been made; without this an on-demand server could echo one back.
    return live.secrets?.length ? redact(result, [...live.secrets]) : result;
  };
  const names: string[] = [];
  for (const tool of wanted) {
    const made = definition(call, config, tool as unknown as Tool, []);
    registry.register(made);
    names.push(made.name);
  }
  return names;
}

/**
 * Opens a server and asks it what its tools are, without putting anything in the tool list. This
 * is what the on-demand path uses: the tools are already listed from what the server said last
 * time, so all that is wanted here is a way to call them, and a fresh list to write down.
 */
export async function openMcp(
  input: unknown, env = process.env,
  policy?: { guard(base: typeof fetch): typeof fetch }, cache?: McpToolCache,
  /** R17-S20: how long the server may take to start and list its tools (Settings › Connections). */
  startupTimeoutMs = 10000,
  ownerRequests?: McpOwnerRequests,
) {
  const config = McpConfigSchema.parse(input);
  if (new Set(config.tools).size !== config.tools.length) throw new Error('Duplicate MCP tool allowlist entry');
  const modern = await tryStateless(config, env, policy, cache, startupTimeoutMs);
  if (modern) return modern;
  const { transport, secrets } = await makeTransport(config, env, policy);
  const capabilities = ownerRequests?.capabilities(config.id, false, true) ?? {};
  const client = new (await mcpClient())({ name: 'branch', version: '0.1.0' }, { capabilities });
  let revokeOwnerRequests: (() => void) | undefined;
  try {
    revokeOwnerRequests = await ownerRequests?.install(client, config.id, capabilities);
    // SDK 1.x transport declarations disagree on optional sessionId under exact optional types.
    await client.connect(transport as Transport, { timeout: startupTimeoutMs });
    if (client.getServerVersion()?.version !== config.expectedVersion)
      throw new Error('MCP server version changed; review compatibility before enabling');
    const found = await discover(client, config.tools, startupTimeoutMs);
    // What it has just said its tools are, so a later launch can list them without starting it.
    cache?.write(config.id, cacheable(found));
    // Told when the connection closes for any reason, so a crashed program is started again on next use, not called dead.
    let alive = true;
    client.onclose = () => { alive = false; revokeOwnerRequests?.(); };
    return { config, found, secrets, call: through(client), close: () => { revokeOwnerRequests?.(); return client.close(); }, alive: () => alive };
  } catch {
    revokeOwnerRequests?.();
    await client.close().catch(() => undefined);
    throw new Error('MCP connection failed: check server availability, version, tool allowlist and metadata');
  }
}

async function tryStateless(config: McpConfig, env: NodeJS.ProcessEnv, policy: { guard(base: typeof fetch): typeof fetch } | undefined,
  cache: McpToolCache | undefined, timeout: number): Promise<Awaited<ReturnType<typeof openStatelessMcp>> | undefined> {
  if (config.transport !== 'http' || (config.protocol ?? 'legacy') === 'legacy') return undefined;
  let opened: Awaited<ReturnType<typeof openStatelessMcp>> | undefined;
  try {
    opened = await openStatelessMcp(config, env, policy, timeout);
    if (JSON.stringify(redact(opened.found, opened.secrets)) !== JSON.stringify(opened.found))
      throw new Error('MCP discovery contains a configured credential');
    cache?.write(config.id, cacheable(opened.found));
    return opened;
  } catch (error) {
    await opened?.close();
    const supported = error instanceof StatelessError && error.code === -32022 && error.data && typeof error.data === 'object'
      ? (error.data as { supported?: unknown }).supported : undefined;
    const compatible = Array.isArray(supported) && supported.some((version) => ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'].includes(String(version)));
    if (config.protocol !== 'auto' || !(error instanceof LegacyMcpFallback || compatible)) throw error;
    // Only a read-only discovery probe can negotiate down. Tool calls are never automatically retried.
    return undefined;
  }
}

/**
 * A connected server's calls, started again when its program has crashed. The next call after a crash waits the
 * backoff above, opens the same launch again through `reopen` (which checks it the way a first start is checked) and
 * carries on; calls arriving meanwhile share that one restart. Closing it for good (switched off, removed, Branch
 * closing) is final: nothing is started again after that.
 */
function restarting(first: Awaited<ReturnType<typeof openMcp>>, reopen: () => Promise<Awaited<ReturnType<typeof openMcp>>>) {
  let current = first, closed = false, crashes = 0, lastCrashAt = 0;
  let restart: Promise<Awaited<ReturnType<typeof openMcp>>> | undefined;
  const again = async () => {
    crashes = nextCrashCount(crashes, lastCrashAt);
    lastCrashAt = Date.now();
    await current.close().catch(() => undefined);
    await pause(restartBackoffMs(crashes));
    if (closed) throw new Error('MCP server was switched off');
    const opened = await reopen();
    if (closed) { await opened.close().catch(() => undefined); throw new Error('MCP server was switched off'); }
    return opened;
  };
  const call: CallThrough = async (tool, args, context) => {
    if (closed) throw new Error('MCP server was switched off');
    if (!current.alive()) {
      const pending = (restart ??= again().finally(() => { restart = undefined; }));
      current = await pending;
    }
    return current.call(tool, args, context);
  };
  return { call, close: async () => { closed = true; await current.close(); } };
}

export async function connectMcp(
  registry: ToolRegistry, input: unknown, env = process.env,
  policy?: { guard(base: typeof fetch): typeof fetch }, cache?: McpToolCache, startupTimeoutMs?: number,
  /** How to open the same server again after a crash; the plain open when not given. */
  reopen?: () => Promise<Awaited<ReturnType<typeof openMcp>>>,
  ownerRequests?: McpOwnerRequests,
) {
  const first = await openMcp(input, env, policy, cache, startupTimeoutMs, ownerRequests);
  const live = restarting(first, reopen ?? (() => openMcp(input, env, policy, cache, startupTimeoutMs, ownerRequests)));
  const opened = { ...first, call: live.call, close: live.close };
  try {
    const definitions = opened.found.map(tool => definition(opened.call, opened.config, tool, opened.secrets));
    const existing = new Set(registry.descriptions(new Set(registry.permissions())).map(tool => tool.name));
    if (definitions.some(tool => existing.has(tool.name))) throw new Error('MCP tool name collision');
    for (const tool of definitions) registry.register(tool);
    return { id: opened.config.id, version: opened.config.expectedVersion,
      tools: definitions.map(tool => tool.name), call: opened.call, close: opened.close };
  } catch {
    await opened.close().catch(() => undefined);
    throw new Error('MCP connection failed: check server availability, version, tool allowlist and metadata');
  }
}
