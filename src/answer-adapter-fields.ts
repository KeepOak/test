import { z } from 'zod';

export type AdapterField = {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'string[]' | 'number[]' | 'integer[]' | 'boolean[]' | 'object[]';
  description?: string; optional?: boolean; nullable?: boolean;
  choices?: (string | number | boolean)[]; fields?: AdapterFields;
};
export type AdapterFields = Record<string, AdapterField>;
const names = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/)
  .refine(name => !['constructor', 'prototype', 'completed'].includes(name));
const types = z.enum(['string', 'number', 'integer', 'boolean', 'object', 'string[]', 'number[]', 'integer[]', 'boolean[]', 'object[]']);

/** Finite schemas bound both declaration parsing and exported tool JSON schemas to four object levels. */
function declarations(depth: number): z.ZodType<AdapterFields> {
  const field = z.object({ type: types, description: z.string().max(400).optional(),
    optional: z.boolean().optional(), nullable: z.boolean().optional(),
    choices: z.array(z.union([z.string().max(1000), z.number().finite(), z.boolean()])).min(1).max(32).optional(),
    fields: depth < 4 ? declarations(depth + 1).optional() : z.never().optional(),
  }).strict().refine(value => value.type.startsWith('object')
    ? value.fields !== undefined && value.choices === undefined
    : value.fields === undefined, 'Object fields require nested fields and cannot declare choices.');
  return z.record(names, field).refine(fields => Object.keys(fields).length >= 1 && Object.keys(fields).length <= 24,
    'Declare one to 24 fields per object.');
}
export const Fields = declarations(1).refine(fields => fieldCount(fields) <= 96, 'Declare at most 96 fields in a signature side.');
function fieldCount(fields: AdapterFields): number {
  return Object.values(fields).reduce((count, field) => count + 1 + (field.fields ? fieldCount(field.fields) : 0), 0);
}
export function hasOptional(fields: AdapterFields): boolean {
  return Object.values(fields).some(field => field.optional || (field.fields && hasOptional(field.fields)));
}
function valueValidator(field: AdapterField, name: string): z.ZodType {
  const base = field.type.replace('[]', '');
  const primitive = base === 'object' ? fieldValidator(field.fields!) : base === 'string' ? z.string().max(16000)
    : base === 'boolean' ? z.boolean() : base === 'integer' ? z.number().int() : z.number().finite();
  for (const choice of field.choices ?? []) if (!primitive.safeParse(choice).success)
    throw new Error(`Choices for ${name} must match its declared type.`);
  let value: z.ZodType = field.choices ? z.literal(field.choices) : primitive;
  if (field.type.endsWith('[]')) value = z.array(value).max(128);
  if (field.nullable) value = value.nullable();
  if (field.optional) value = value.optional();
  return value.describe(field.description ?? '');
}
/** Unknown fields are rejected at every nested object, in inputs, demonstrations and replies. */
export function fieldValidator(fields: AdapterFields): z.ZodType<Record<string, unknown>> {
  const shape: Record<string, z.ZodType> = {};
  for (const [name, field] of Object.entries(fields)) shape[name] = valueValidator(field, name);
  return z.object(shape).strict();
}
