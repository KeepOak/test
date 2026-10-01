import { z } from 'zod';
import type { IncomingHttpHeaders } from 'node:http';
import type { JsonRpcRequest, JsonRpcResponse } from './mcp-server.js';

export const statelessVersion = '2026-07-28';
export const protocolKey = 'io.modelcontextprotocol/protocolVersion';
export const capabilitiesKey = 'io.modelcontextprotocol/clientCapabilities';
export const clientInfoKey = 'io.modelcontextprotocol/clientInfo';
export const serverInfoKey = 'io.modelcontextprotocol/serverInfo';
const record = z.record(z.string(), z.unknown());
const message = z.object({ jsonrpc: z.literal('2.0'), id: z.union([z.string().max(200), z.number().int().safe()]),
  method: z.string().min(1).max(200).regex(/^[A-Za-z0-9_/-]+$/), params: record }).strict();

export class StatelessError extends Error {
  constructor(readonly code: number, reason: string, readonly data?: unknown) { super(reason); }
}
export function headerValue(value: string): string {
  return /^[\x21-\x7e](?:[\x20-\x7e\t]*[\x21-\x7e])?$/.test(value) && !/^=\?base64\?.*\?=$/.test(value)
    ? value : `=?base64?${Buffer.from(value).toString('base64')}?=`;
}
export function decodeHeader(value: string | string[] | undefined): string | undefined {
  if (typeof value !== 'string' || !/^[\x20-\x7e\t]*$/.test(value)) return undefined;
  if (!value.startsWith('=?base64?') || !value.endsWith('?=')) return value;
  const encoded = value.slice(9, -2), bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) return undefined;
  try { return new TextDecoder('utf8', { fatal: true }).decode(bytes); } catch { return undefined; }
}
export function statelessHeaders(request: JsonRpcRequest): Record<string, string> {
  const headers: Record<string, string> = { 'mcp-protocol-version': statelessVersion, 'mcp-method': request.method };
  const field = request.method === 'resources/read' ? 'uri' : ['tools/call', 'prompts/get'].includes(request.method) ? 'name' : null;
  if (field && typeof request.params?.[field] === 'string') headers['mcp-name'] = headerValue(request.params[field]);
  return headers;
}
/** Every request supplies its own context; HTTP headers are checked against the JSON body. */
export function validateStateless(input: unknown, headers: IncomingHttpHeaders): JsonRpcRequest {
  const parsed = message.safeParse(input);
  if (!parsed.success) throw new StatelessError(-32600, 'Invalid JSON-RPC request');
  const request = parsed.data, meta = record.safeParse(request.params._meta);
  if (!/application\/json/i.test(String(headers['content-type'] ?? '')) || !/application\/json/i.test(String(headers.accept ?? ''))
    || !/text\/event-stream/i.test(String(headers.accept ?? ''))) throw new StatelessError(-32602, 'Use JSON with the required JSON and SSE Accept types');
  if (!meta.success || typeof meta.data[protocolKey] !== 'string' || !record.safeParse(meta.data[capabilitiesKey]).success)
    throw new StatelessError(-32602, 'Required per-request metadata is missing');
  if (headers['mcp-protocol-version'] !== meta.data[protocolKey] || headers['mcp-method'] !== request.method)
    throw new StatelessError(-32020, 'Protocol or method header does not match the body');
  const field = request.method === 'resources/read' ? 'uri' : ['tools/call', 'prompts/get'].includes(request.method) ? 'name' : null;
  if (field && (typeof request.params[field] !== 'string' || decodeHeader(headers['mcp-name']) !== request.params[field]))
    throw new StatelessError(-32020, 'Name header does not match the body');
  if (headers['mcp-session-id'] !== undefined) throw new StatelessError(-32602, 'Stateless requests do not use protocol sessions');
  return request;
}
export function statelessFailure(input: unknown, error: StatelessError): Omit<JsonRpcResponse, 'id'> & { id?: string | number } {
  const id = input && typeof input === 'object' ? (input as { id?: unknown }).id : undefined;
  return { jsonrpc: '2.0', ...(typeof id === 'string' || typeof id === 'number' && Number.isSafeInteger(id) ? { id } : {}),
    error: { code: error.code, message: error.message, ...(error.data === undefined ? {} : { data: error.data }) } };
}
export function completed(value: unknown): Record<string, unknown> {
  return { ...(value && typeof value === 'object' ? value as Record<string, unknown> : {}), resultType: 'complete',
    _meta: { [serverInfoKey]: { name: 'branch', version: '1.0.0' } } };
}
