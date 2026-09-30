import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { z } from 'zod';
import type { JsonRpcResponse, McpServer } from './mcp-server.js';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { modernServer } from './mcp-modern-server.js';

const MessageSchema = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: z.union([z.string(), z.number()]).optional(),
    method: z.string().min(1).max(200),
    params: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export interface StdioOptions {
  input?: Readable;
  output?: Writable;
  /** Where progress and problems go; never standard output, which carries the protocol. */
  log?: (message: string) => void;
}

const error = (id: string | number | null, code: number, message: string) => ({
  jsonrpc: '2.0' as const, id, error: { code, message },
});

/**
 * Newline-delimited JSON-RPC on standard input and output, the transport desktop AI tools start
 * as a child program. Everything a person should read goes to standard error, so the protocol
 * stream stays clean. Returns when the other side closes standard input.
 */
export async function serveMcpStdio(mcp: McpServer, options: StdioOptions = {}): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const log = options.log ?? ((message: string) => void process.stderr.write(`${message}\n`));
  if (mcp.sharing().statelessPreview) return serveModernStdio(mcp, input, output, log);
  log('Branch is ready for another AI tool on standard input. Close it or press Ctrl+C to stop.');
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const response = await answer(mcp, line, log);
    if (response) output.write(`${JSON.stringify(response)}\n`);
  }
  log('The other AI tool disconnected. Branch is stopping.');
}

async function serveModernStdio(mcp: McpServer, input: Readable, output: Writable,
  log: (message: string) => void): Promise<void> {
  mcp.requireModern();
  const stamp = mcp.modernAccessStamp();
  const transport = new StdioServerTransport(input, output, { maxBufferSize: 65536 });
  const handle = serveStdio(() => modernServer(mcp, mcp.modernPrincipal('stdio'), true), {
    transport, legacy: 'reject', maxSubscriptions: 32, onerror: () => log('Invalid modern MCP stdio request'),
  });
  let disconnected!: () => void;
  const ended = new Promise<void>((resolve) => { disconnected = resolve; });
  const closed = transport.onclose;
  transport.onclose = () => { closed?.(); disconnected(); };
  input.once('end', disconnected);
  input.once('close', disconnected);
  const timer = setInterval(() => {
    try { mcp.requireModern(); if (stamp !== mcp.modernAccessStamp()) void handle.close(); }
    catch { void handle.close(); }
  }, 250);
  timer.unref();
  log('Branch is ready for stateless MCP on standard input.');
  try { if (!input.readableEnded && !input.destroyed) await ended; }
  finally { clearInterval(timer); input.off('end', disconnected); input.off('close', disconnected); await handle.close(); }
}

/** One line in, one line out; `null` for a notification, which gets no reply. */
async function answer(
  mcp: McpServer,
  line: string,
  log: (message: string) => void,
): Promise<JsonRpcResponse | ReturnType<typeof error> | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    log('Ignored a line that was not valid JSON.');
    return error(null, -32700, 'Parse error');
  }
  const message = MessageSchema.safeParse(parsed);
  if (!message.success) {
    const id = parsed && typeof parsed === 'object' ? (parsed as { id?: unknown }).id : undefined;
    return error(typeof id === 'string' || typeof id === 'number' ? id : null, -32600, 'Invalid request');
  }
  const { id, method, params } = message.data;
  if (id === undefined) return null;
  return mcp.handle({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }, 'stdio');
}
