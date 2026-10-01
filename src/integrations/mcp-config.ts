import { z } from 'zod';
import { mcpHttp, mcpStdio } from './mcp-sdk.js';
import { boundedFetch } from './bounded-fetch.js';
import { runAsNode } from '../child-env.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';

/**
 * How a server is reached: every address through the network policy, and for a server the owner signed in to, the
 * saved sign-in, which the SDK's HTTP transport sends and renews itself (src/integrations/mcp-oauth.ts).
 */
export interface McpReach { guard(base: typeof fetch): typeof fetch; auth?: OAuthClientProvider | undefined }
/** The reach for one server: the network policy's guard (or none), with that server's sign-in when it has one. */
export function reachFor(policy: { guard(base: typeof fetch): typeof fetch } | undefined, auth?: OAuthClientProvider): McpReach | undefined {
  if (!policy && !auth) return undefined;
  return { guard: (base) => policy ? policy.guard(base) : base, ...(auth ? { auth } : {}) };
}

/** Seconds without progress before a tool call stops waiting. */
export const McpCallTimeoutSchema = z.number().int().min(1).max(3600);
const common = {
  id: z.string().regex(/^[a-z][a-z0-9-]{0,29}$/),
  tools: z.array(z.string().min(1).max(200)).min(1).max(64),
  expectedVersion: z.string().min(1).max(100),
  callTimeoutSeconds: McpCallTimeoutSchema.optional(),
};
const stdioShape = {
  transport: z.literal('stdio'), command: z.string().min(1),
  args: z.array(z.string()).max(40).default([]), cwd: z.string().optional(),
  envKeys: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).max(20).default([]),
};
const httpShape = {
  transport: z.literal('http'), url: z.string().url(),
  /** Explicit preview; SDK 1.x remains the default legacy transport. */
  protocol: z.enum(['legacy', 'stateless-preview', 'auto']).optional(),
  // A saved sign-in (OAUTH_*) is kept as JSON, not as a bare key, so it is never sent as one.
  bearerEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
    .refine((name) => !/^OAUTH_/i.test(name), 'A saved sign-in (OAUTH_…) cannot be used as a key').optional(),
};
/** Just how to reach a server, without the allowlist a permanently configured one also needs. */
export const McpTransportSchema = z.discriminatedUnion('transport', [
  z.object(stdioShape).strict(), z.object(httpShape).strict(),
]);
export type McpTransportConfig = z.infer<typeof McpTransportSchema>;
export const McpConfigSchema = z.discriminatedUnion('transport', [
  z.object({ ...common, ...stdioShape }).strict(),
  z.object({ ...common, ...httpShape }).strict(),
]);
export type McpConfig = z.infer<typeof McpConfigSchema>;

function credential(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Set ${name} as an environment variable, or save a secret called ${name} in the default project.`);
  return value;
}

/** Looks up one secret by name in the locker; undefined when there is none. */
export type SecretLookup = (name: string) => Promise<string | undefined>;
/** The names of the credentials a server is launched with. */
export const credentialNames = (config: McpTransportConfig): string[] =>
  config.transport === 'stdio' ? [...config.envKeys] : config.bearerEnv ? [config.bearerEnv] : [];
/** A lookup in the default project's locker for the owner of the moment. */
export const lockerSecret = (
  store: { secrets: { resolve(owner: string, project: string, names: string[], options: { purpose: string }): Promise<Record<string, string>> } },
  owner: () => string,
): SecretLookup => async (name) =>
  (await store.secrets.resolve(owner(), 'default', [name], { purpose: 'MCP server' }).catch(() => ({} as Record<string, string>)))[name];
/** Locker secret names are upper-case, environment style (src/locker.ts). */
const lockerName = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * The environment a server is launched with: each credential it needs comes from the environment first, then from a
 * secret of the same name in the default project's locker, the way chat channels find theirs (bootstrap.ts
 * `credential`). A desktop owner cannot set environment variables, so the locker is where the window saves them. The
 * copy is only handed to the transport, which reports every value it used so it is kept out of what comes back.
 */
export async function withLockerSecrets(
  config: McpTransportConfig, env: NodeJS.ProcessEnv, lookup?: SecretLookup,
): Promise<NodeJS.ProcessEnv> {
  const found: Record<string, string> = {};
  for (const name of credentialNames(config)) {
    if (env[name] || !lookup || !lockerName.test(name)) continue;
    const value = await lookup(name).catch(() => undefined);
    if (value) found[name] = value;
  }
  return Object.keys(found).length ? { ...env, ...found } : env;
}

export async function makeTransport(config: McpTransportConfig, env: NodeJS.ProcessEnv, policy?: McpReach) {
  if (config.transport === 'stdio') {
    const selected = Object.fromEntries(config.envKeys.map(key => [key, credential(env, key)]));
    const { getDefaultEnvironment, StdioClientTransport } = await mcpStdio();
    const transport = new StdioClientTransport({ command: config.command, args: config.args,
      // A server started with this app's own program (the example notes server) must run as Node.
      env: { ...getDefaultEnvironment(), ...selected, ...runAsNode(config.command) }, stderr: 'pipe', maxBufferSize: 1048576,
      ...(config.cwd ? { cwd: config.cwd } : {}) });
    transport.stderr?.on('data', () => undefined);
    return { transport, secrets: Object.values(selected) };
  }
  const url = new URL(config.url);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))
    throw new Error('MCP endpoint requires HTTPS or loopback HTTP');
  if (url.username || url.password || url.search || url.hash)
    throw new Error('MCP URL must not contain credentials, query, or fragment');
  const secret = config.bearerEnv ? credential(env, config.bearerEnv) : undefined;
  const StreamableHTTPClientTransport = await mcpHttp();
  const transport = new StreamableHTTPClientTransport(url, {
    fetch: policy ? policy.guard(boundedFetch) : boundedFetch,
    requestInit: { redirect: 'error', ...(secret ? { headers: { authorization: `Bearer ${secret}` } } : {}) },
    // A key given by hand wins; otherwise a saved sign-in is sent, and renewed by the SDK when the server says 401.
    ...(!secret && policy?.auth ? { authProvider: policy.auth } : {}),
  });
  return { transport, secrets: secret ? [secret] : [] };
}
