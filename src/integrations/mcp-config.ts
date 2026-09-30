import { z } from 'zod';
import { mcpHttp, mcpStdio } from './mcp-sdk.js';
import { boundedFetch } from './bounded-fetch.js';
import { runAsNode } from '../child-env.js';

const common = {
  id: z.string().regex(/^[a-z][a-z0-9-]{0,29}$/),
  tools: z.array(z.string().min(1).max(200)).min(1).max(64),
  expectedVersion: z.string().min(1).max(100),
};
const stdioShape = {
  transport: z.literal('stdio'), command: z.string().min(1),
  args: z.array(z.string()).max(40).default([]), cwd: z.string().optional(),
  envKeys: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).max(20).default([]),
};
const httpShape = {
  transport: z.literal('http'), url: z.string().url(),
  bearerEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional(),
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
  if (!value) throw new Error(`Missing configured MCP environment variable: ${name}`);
  return value;
}

export async function makeTransport(config: McpTransportConfig, env: NodeJS.ProcessEnv, policy?: { guard(base: typeof fetch): typeof fetch }) {
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
  });
  return { transport, secrets: secret ? [secret] : [] };
}
