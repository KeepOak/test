import type { JsonRpcResponse } from './mcp-server.js';

export const statelessVersion = '2026-07-28';
export const protocolKey = 'io.modelcontextprotocol/protocolVersion';
export const serverInfoKey = 'io.modelcontextprotocol/serverInfo';

export class StatelessError extends Error {
  constructor(readonly code: number, reason: string, readonly data?: unknown) { super(reason); }
}
export function headerValue(value: string): string {
  return /^[\x21-\x7e](?:[\x20-\x7e\t]*[\x21-\x7e])?$/.test(value) && !/^=\?base64\?.*\?=$/.test(value)
    ? value : `=?base64?${Buffer.from(value).toString('base64')}?=`;
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
