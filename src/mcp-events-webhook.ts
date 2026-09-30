import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Branch } from './index.js';
import { readBodyWithRaw } from './triggers.js';

const peers = new Map<string, { until: number; count: number }>();
let reading = 0;
function admitPeer(address: string): boolean {
  const now = Date.now();
  for (const [key, value] of peers) if (value.until <= now) peers.delete(key);
  const old = peers.get(address);
  if (!old && peers.size >= 1024) return false;
  const current = old ?? { until: now + 60000, count: 0 };
  current.count++; peers.set(address, current);
  return current.count <= 120 && reading < 8;
}

/** A signed webhook door only; management stays behind the existing local owner API authentication. */
export async function mcpEventWebhook(app: Branch, request: IncomingMessage, response: ServerResponse, path: string): Promise<boolean> {
  const match = /^\/webhooks\/mcp-events\/([a-f0-9]{16}-[a-f0-9-]{36})$/.exec(path);
  if (!match) return false;
  const send = (status: number, value: unknown) => {
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify(value));
  };
  if (!admitPeer(request.socket.remoteAddress ?? 'unknown')) { send(429, { error: 'Webhook admission is busy.' }); return true; }
  if (request.method !== 'POST') { send(405, { error: 'Use POST.' }); return true; }
  if (request.headers.origin || !/^application\/json(?:;|$)/i.test(String(request.headers['content-type'] ?? ''))
    || request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity') {
    send(400, { error: 'Unsupported webhook request.' }); return true;
  }
  if (Number(request.headers['content-length'] ?? 0) > 262144) {
    send(413, { error: 'Webhook body exceeds limit.' }); return true;
  }
  request.setTimeout(10000, () => request.destroy());
  reading++;
  try {
    const { raw, parsed } = await readBodyWithRaw(request, 262144);
    send(200, await app.mcpEvents.receive(match[1]!, request.headers, raw, parsed));
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const status = message.includes('exceeds') ? 413 : message.includes('busy') || message.includes('full') ? 429
      : message.includes('signature') || message.includes('headers') ? 401
      : message.includes('stopped') || message.includes('expired') || message.includes('Unknown') ? 410 : 400;
    send(status, { error: 'MCP event was not admitted.' });
  } finally { reading--; request.setTimeout(0); }
  return true;
}
