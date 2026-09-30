import { z } from 'zod';
import { mcpValidator } from './integrations/mcp-sdk.js';
import { unsafePattern } from './add-ons/filters.js';
const name = z.string().min(1).max(200);
const key = z.string().min(1).max(80).refine(value => !['__proto__', 'constructor', 'prototype'].includes(value));
export const SettingsCapability = z.object({ readTool: name, updateTool: name }).strict()
  .refine(value => value.readTool !== value.updateTool);
const property = z.object({ type: z.enum(['boolean', 'string', 'number', 'integer']), title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(), enum: z.array(z.string().max(16000)).min(1).max(64).optional(),
  minLength: z.number().int().nonnegative().optional(), maxLength: z.number().int().nonnegative().optional(),
  pattern: z.string().max(500).refine(pattern => !unsafePattern(pattern), 'This setting pattern is unsupported by the native host.').optional(), minimum: z.number().finite().optional(), maximum: z.number().finite().optional(),
  multipleOf: z.number().finite().positive().optional(),
}).strict().refine(field => field.enum === undefined || field.type === 'string');
const item = z.discriminatedUnion('kind', [z.object({ kind: z.literal('property'), property: key }).strict(),
  z.object({ kind: z.literal('tool'), tool: name, title: z.string().min(1).max(200), description: z.string().max(2000).optional() }).strict()]);
export const SettingsRead = z.object({ schema: z.object({ type: z.literal('object'),
  properties: z.record(key, property).refine(fields => Object.keys(fields).length <= 64),
  required: z.array(key).max(64).optional(), additionalProperties: z.literal(false).optional(), $schema: z.string().optional(),
}).strict(), values: z.record(key, z.unknown()),
  layout: z.array(z.object({ kind: z.literal('group'), title: z.string().min(1).max(200), items: z.array(item).max(64) }).strict()).max(16).optional(),
}).strict();
export type NativeSettings = z.infer<typeof SettingsRead>;
export function structured(result: unknown): unknown {
  if (Buffer.byteLength(JSON.stringify(result)) > 60000) throw new Error('Native MCP response exceeds 60 KiB.');
  const envelope = z.object({ isError: z.boolean().optional(), structuredContent: z.unknown() }).passthrough().parse(result);
  if (envelope.isError || envelope.structuredContent === undefined) throw new Error('The server did not return successful structured content.');
  return envelope.structuredContent;
}
export async function validateValues(settings: NativeSettings, values: Record<string, unknown>, partial = false): Promise<void> {
  const fields = settings.schema.properties, keys = Object.keys(values);
  if (keys.some(key => !Object.hasOwn(fields, key)) || (!partial && Object.keys(fields).some(key => !Object.hasOwn(values, key))))
    throw new Error('Settings values must match the declared property keys.');
  const checker = new (await mcpValidator())().getValidator({ ...settings.schema, additionalProperties: false,
    required: partial ? [] : Object.keys(fields) });
  if (!checker(values).valid) throw new Error('Settings values violate their declared schema.');
}
export function validateLayout(settings: NativeSettings): void {
  const seen = new Set<string>();
  for (const group of settings.layout ?? []) for (const item of group.items) if (item.kind === 'property') {
    if (!Object.hasOwn(settings.schema.properties, item.property) || seen.has(item.property))
      throw new Error('Settings layout contains an unknown or repeated property.');
    seen.add(item.property);
  }
}
export const MentionItems = z.object({ items: z.array(z.union([
  z.object({ type: z.literal('resource_link'), uri: z.string().min(1).max(2000), name: z.string().min(1).max(200),
    title: z.string().max(200).optional(), description: z.string().max(2000).optional() }).passthrough(),
  z.object({ type: z.literal('resource'), resourceUri: z.string().min(1).max(2000), title: z.string().min(1).max(200),
    subtitle: z.string().max(2000).optional() }).passthrough(),
])).max(32) }).strict();
