import { z } from 'zod';
import { mcpHttp, mcpStdio } from './mcp-sdk.js';
import { boundedFetch } from './bounded-fetch.js';
import { runAsNode } from '../child-env.js';

const common = {
  id: z.string().regex(/^[a-z][a-z0-9-]{0,29}$/),
  tools: z.array(z.string().min(1).max(200)).min(1).max(64),
  expectedVersion: z.string().min(1).max(100),
};
const privateName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const environmentName = privateName.refine(name => !/^(PATH|PATHEXT|NODE_OPTIONS|NODE_PATH|PYTHONPATH|PYTHONHOME|LD_PRELOAD|DYLD_.*|BASH_ENV|ENV|COMSPEC)$/i.test(name), 'Use manual configuration for runtime control environment variables');
const privateBinding = z.union([privateName, z.object({ template: z.string().max(2000), refs: z.record(privateName, privateName) }).strict()]);
const stdioShape = {
  transport: z.literal('stdio'), command: z.string().min(1),
  args: z.array(z.string()).max(40).default([]), cwd: z.string().optional(),
  envKeys: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).max(20).default([]),
  envValues: z.record(environmentName, z.string().max(2000)).optional(),
  envRefs: z.record(environmentName, privateBinding).optional(),
  argEnv: z.record(z.string().regex(/^\d{1,2}$/), privateBinding).optional(),
};
const httpShape = {
  transport: z.literal('http'), url: z.string().url(),
  bearerEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional(),
  headerEnv: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9-]{0,99}$/).refine(name => !/^(host|cookie|content-length|connection|transfer-encoding|proxy-.*|mcp-.*)$/i.test(name)),
    z.object({ env: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), prefix: z.enum(['', 'Bearer ', 'Basic ']).default('') }).strict()).optional(),
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
function bindingValue(binding: z.infer<typeof privateBinding>, env: NodeJS.ProcessEnv): string {
  if (typeof binding === 'string') return credential(env, binding);
  return binding.template.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match: string, name: string) => {
    const ref = binding.refs[name];
    if (!ref) throw new Error('A private input template is unresolved');
    return credential(env, ref);
  });
}
function bindingSecrets(bindings: z.infer<typeof privateBinding>[], env: NodeJS.ProcessEnv): string[] {
  return bindings.flatMap(binding => typeof binding === 'string' ? [credential(env, binding)] : Object.values(binding.refs).map(name => credential(env, name)));
}
export function privateStdioArguments(config: Extract<McpTransportConfig, { transport: 'stdio' }>, env: NodeJS.ProcessEnv): string[] {
  if (Object.keys(config.argEnv ?? {}).some(key => Number(key) >= config.args.length)) throw new Error('MCP argument credential reference is outside the configured arguments');
  return config.args.map((arg, index) => config.argEnv?.[String(index)] ? bindingValue(config.argEnv[String(index)]!, env) : arg);
}

export async function makeTransport(config: McpTransportConfig, env: NodeJS.ProcessEnv, policy?: { guard(base: typeof fetch): typeof fetch }) {
  if (config.transport === 'stdio') {
    const refs = Object.fromEntries(Object.entries(config.envRefs ?? {}).map(([key, ref]) => [key, bindingValue(ref, env)]));
    const selected = { ...config.envValues, ...Object.fromEntries(config.envKeys.map(key => [key, credential(env, key)])), ...refs };
    const args = privateStdioArguments(config, env);
    const { getDefaultEnvironment, StdioClientTransport } = await mcpStdio();
    const transport = new StdioClientTransport({ command: config.command, args,
      // A server started with this app's own program (the example notes server) must run as Node.
      env: { ...getDefaultEnvironment(), ...selected, ...runAsNode(config.command) }, stderr: 'pipe', maxBufferSize: 1048576,
      ...(config.cwd ? { cwd: config.cwd } : {}) });
    transport.stderr?.on('data', () => undefined);
    return { transport, secrets: [...Object.values(selected), ...bindingSecrets([...Object.values(config.argEnv ?? {}), ...Object.values(config.envRefs ?? {})], env)] };
  }
  const url = new URL(config.url);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))
    throw new Error('MCP endpoint requires HTTPS or loopback HTTP');
  if (url.username || url.password || url.search || url.hash)
    throw new Error('MCP URL must not contain credentials, query, or fragment');
  const secret = config.bearerEnv ? credential(env, config.bearerEnv) : undefined;
  const names = Object.keys(config.headerEnv ?? {}).map(name => name.toLowerCase());
  if (new Set(names).size !== names.length || secret && names.includes('authorization')) throw new Error('MCP header references must have distinct names and one authorization source');
  const headers = Object.fromEntries(Object.entries(config.headerEnv ?? {}).map(([name, binding]) => {
    const value = credential(env, binding.env);
    if (/[\r\n]/.test(value)) throw new Error('MCP header credential contains invalid characters');
    return [name, binding.prefix + value];
  }));
  if (secret) headers.authorization = `Bearer ${secret}`;
  const StreamableHTTPClientTransport = await mcpHttp();
  const transport = new StreamableHTTPClientTransport(url, {
    fetch: policy ? policy.guard(boundedFetch) : boundedFetch,
    requestInit: { redirect: 'error', headers },
  });
  return { transport, secrets: [...(secret ? [secret] : []), ...Object.values(config.headerEnv ?? {}).map(binding => credential(env, binding.env))] };
}
