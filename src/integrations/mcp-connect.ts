/**
 * Adapted from Gemini CLI mcp-client.ts, commit 40d4dccfa9aec692b27798ca819b918609e2bc60,
 * Copyright 2025 Google LLC, Apache-2.0: close a failed HTTP connection, check authentication
 * first, and only then try the older SSE transport. Branch shares one startup deadline.
 */
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { makeTransport, type McpReach, type McpTransportConfig } from './mcp-config.js';
import { mcpAuth } from './mcp-sdk.js';

export class McpSignInRequired extends Error {
  constructor() { super('This MCP server requires sign-in. Open Customize → Tools, select the server, and choose Sign in.'); }
}

async function authenticationRequired(error: unknown): Promise<boolean> {
  if (error instanceof Error && 'code' in error && error.code === 401) return true;
  return error instanceof (await mcpAuth()).UnauthorizedError;
}

/** Connection failures only: a later version, schema or allowlist refusal must never try another transport. */
export async function connectMcpTransport(
  client: Client, config: McpTransportConfig, env: NodeJS.ProcessEnv, reach?: McpReach, timeout = 10000,
): Promise<string[]> {
  const deadline = Date.now() + timeout;
  for (const legacy of [false, true]) {
    // Rebuild through the current guard on each attempt; keep the saved OAuth provider on both.
    const abort = new AbortController();
    const opened = await makeTransport(config, env, reach, legacy, abort.signal);
    const { transport, secrets } = opened;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('MCP startup deadline reached');
      // SDK transport declarations disagree on optional sessionId under exact optional types.
      // A legacy server can open a stream without ever announcing its endpoint; bound start(), too.
      const expired = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { abort.abort(); reject(new Error('MCP startup deadline reached')); }, remaining);
      });
      await Promise.race([client.connect(transport as Transport, { timeout: remaining }), expired]);
      return secrets;
    } catch (error) {
      abort.abort();
      await transport.close().catch(() => undefined);
      if (config.transport === 'http' && (opened.authenticationChallenged?.() || await authenticationRequired(error)))
        throw new McpSignInRequired();
      if (config.transport !== 'http' || legacy || Date.now() >= deadline)
        throw new Error('MCP connection failed: check server availability and connection settings');
    } finally { if (timer) clearTimeout(timer); }
  }
  throw new Error('MCP connection failed');
}
