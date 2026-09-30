import { z } from 'zod';
import type { Client } from '@modelcontextprotocol/client';
import { mcpValidator } from './mcp-sdk.js';
import type { JsonSchemaType } from '@modelcontextprotocol/sdk/validation';

function safeSchema(value: Record<string, unknown>): boolean {
  if (value.type !== 'object' || Buffer.byteLength(JSON.stringify(value)) > 32768) return false;
  const visit = (item: unknown, depth: number): boolean => {
    if (depth > 16) return false;
    if (!item || typeof item !== 'object') return true;
    return Object.entries(item).every(([key, child]) => {
      if (['pattern', 'patternProperties', '__proto__', 'constructor', 'prototype'].includes(key)) return false;
      if (['$ref', '$dynamicRef', '$recursiveRef'].includes(key) && (typeof child !== 'string' || !child.startsWith('#'))) return false;
      return visit(child, depth + 1);
    });
  };
  return visit(value, 0);
}
// No external references or server-supplied regex execution in the public callback's validator.
const schema = z.record(z.string(), z.unknown()).refine(safeSchema, 'Unsupported or excessive MCP event schema');
export const EventDefinition = z.object({
  name: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/), description: z.string().max(2000).optional(),
  delivery: z.array(z.enum(['webhook', 'poll', 'push'])).min(1).max(3),
  inputSchema: schema, payloadSchema: schema,
}).strip();
export type McpEventDefinition = z.infer<typeof EventDefinition>;
const pageSchema = z.object({ events: z.array(EventDefinition).max(100), nextCursor: z.string().max(2000).optional() });
const discoverSchema = z.object({ supportedVersions: z.array(z.string()),
  capabilities: z.object({ events: z.record(z.string(), z.unknown()).optional() }).passthrough() });
export const SubscriptionResult = z.object({ id: z.string().min(1).max(200),
  refreshBefore: z.string().datetime({ offset: true }).nullable(), cursor: z.string().max(2000).nullable(),
  truncated: z.boolean() });

/** Explicit schemas keep draft extension methods on the real SDK's modern request codec. */
export async function listMcpEvents(client: Client, signal: AbortSignal): Promise<McpEventDefinition[]> {
  // Core SDK 2.2 strips unknown capabilities; an explicit discover schema retains this draft capability.
  const discovered = await client.request({ method: 'server/discover', params: {} }, discoverSchema, { signal, timeout: 10000 });
  if (!discovered.supportedVersions.includes('2026-07-28') || discovered.capabilities.events === undefined)
    throw new Error('This modern server does not advertise MCP Events.');
  const result: McpEventDefinition[] = [], cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const response = await client.request({ method: 'events/list', params: cursor ? { cursor } : {} }, pageSchema, { signal, timeout: 10000 });
    result.push(...response.events);
    if (result.length > 256 || new Set(result.map(event => event.name)).size !== result.length)
      throw new Error('MCP Events catalog exceeds limits or contains duplicate names.');
    if (!response.nextCursor) return result.filter(event => event.delivery.includes('webhook'));
    if (cursors.has(response.nextCursor)) throw new Error('Repeated MCP Events cursor.');
    cursors.add(response.nextCursor); cursor = response.nextCursor;
  }
  throw new Error('MCP Events pagination exceeds limits.');
}

export async function validateEventSchema(shape: Record<string, unknown>, value: unknown): Promise<void> {
  const Validator = await mcpValidator();
  const validate = new Validator().getValidator(shape as JsonSchemaType);
  if (!validate(value).valid) throw new Error('MCP Events data does not match its reviewed schema.');
}
