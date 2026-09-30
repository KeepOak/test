import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AnswerShape } from './answer-shape.js';
import type { Message } from './contracts.js';
import { decodeAnswer, encodeAnswer, AdapterFormatError, type AdapterKind } from './answer-adapter-codecs.js';

const ValueType = z.enum(['string', 'number', 'integer', 'boolean', 'string[]', 'number[]', 'integer[]', 'boolean[]']);
const Field = z.object({ type: ValueType, description: z.string().max(400).default(''),
  choices: z.array(z.union([z.string().max(1000), z.number().finite(), z.boolean()])).min(1).max(32).optional() }).strict();
const Fields = z.record(z.string().regex(/^[a-z][a-z0-9_]{0,39}$/).refine(name =>
  !['constructor', 'prototype', 'completed'].includes(name)), Field)
  .refine(fields => Object.keys(fields).length >= 1 && Object.keys(fields).length <= 24, 'Declare one to 24 fields.');
export const AdaptAnswerInput = z.object({
  adapter: z.enum(['chat', 'json', 'xml']).default('json'),
  signature: z.object({ name: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
    instructions: z.string().min(1).max(8000), inputs: Fields, outputs: Fields }).strict(),
  inputs: z.record(z.string(), z.unknown()),
  demonstrations: z.array(z.object({ inputs: z.record(z.string(), z.unknown()),
    outputs: z.record(z.string(), z.unknown()) }).strict()).max(8).default([]),
}).strict();
export type AdaptAnswerRequest = z.infer<typeof AdaptAnswerInput>;
export type AdapterFields = AdaptAnswerRequest['signature']['outputs'];
export type AdaptAnswerResult = { status: 'resolved'; value: Record<string, unknown>; adapter: AdapterKind; reasked: boolean }
  | { status: 'refused'; reason: string; adapter: AdapterKind; reasked: boolean };
export type AdapterAsk = (messages: Message[], shape: AnswerShape | undefined) => Promise<string>;

/** Strict typed declarations are shared by prompts, demonstrations, native schemas and output validation. */
export function fieldValidator(fields: AdapterFields): z.ZodType<Record<string, unknown>> {
  const shape: Record<string, z.ZodType> = {};
  for (const [name, field] of Object.entries(fields)) {
    const base = field.type.replace('[]', '');
    const primitive = base === 'string' ? z.string().max(16000) : base === 'boolean' ? z.boolean()
      : base === 'integer' ? z.number().int() : z.number().finite();
    for (const choice of field.choices ?? []) if (!primitive.safeParse(choice).success)
      throw new Error(`Choices for ${name} must match its declared type.`);
    const item = field.choices ? z.literal(field.choices) : primitive;
    shape[name] = (field.type.endsWith('[]') ? z.array(item).max(128) : item).describe(field.description);
  }
  return z.object(shape).strict();
}
function nativeShape(input: AdaptAnswerRequest): AnswerShape {
  const { $schema: _version, ...schema } = z.toJSONSchema(fieldValidator(input.signature.outputs));
  const hash = createHash('sha256').update(JSON.stringify(schema)).digest('hex').slice(0, 8);
  return { name: `as_${input.signature.name}_${hash}`, schema };
}
function instructions(input: AdaptAnswerRequest, kind: AdapterKind): string {
  const format = kind === 'json' ? 'one JSON object, with no prose or code fence'
    : kind === 'xml' ? 'one <field_name>value</field_name> fragment for each output field, no root, attributes or prose. Escape XML text; use JSON for arrays'
      : 'one [[ ## field_name ## ]] section for each output, then an empty [[ ## completed ## ]] section. Use JSON for arrays';
  return `${input.signature.instructions}\n\nTyped input fields: ${JSON.stringify(input.signature.inputs)}\n`
    + `Typed output fields: ${JSON.stringify(input.signature.outputs)}\nReturn ${format}. All output fields are required, with no unknown or duplicate fields.`;
}
function messages(input: AdaptAnswerRequest, kind: AdapterKind, correction = ''): Message[] {
  const result: Message[] = [{ role: 'system', content: instructions(input, kind) }];
  for (const demo of input.demonstrations) {
    result.push({ role: 'user', content: encodeAnswer(kind, demo.inputs) },
      { role: 'assistant', content: encodeAnswer(kind, demo.outputs) });
  }
  result.push({ role: 'user', content: encodeAnswer(kind, input.inputs) + (correction ? `\n\nCorrect the previous formatting error: ${correction}` : '') });
  if (Buffer.byteLength(JSON.stringify(result)) > 65536) throw new Error('Adapter prompt exceeds 64 KiB.');
  return result;
}
function parse(raw: string, kind: AdapterKind, fields: AdapterFields): Record<string, unknown> {
  const decoded = decodeAnswer(raw, kind, fields), checked = fieldValidator(fields).safeParse(decoded);
  if (!checked.success) throw new AdapterFormatError(checked.error.issues.map(issue =>
    `${issue.path.join('.') || 'answer'}: ${issue.message}`).join('; ').slice(0, 1200));
  return checked.data;
}
/** One format repair only. Provider failures escape; formatting repair never repeats tool effects. */
export async function adaptAnswer(input: unknown, ask: AdapterAsk): Promise<AdaptAnswerResult> {
  const request = AdaptAnswerInput.parse(input), inputs = fieldValidator(request.signature.inputs), outputs = fieldValidator(request.signature.outputs);
  inputs.parse(request.inputs);
  for (const demo of request.demonstrations) { inputs.parse(demo.inputs); outputs.parse(demo.outputs); }
  let kind: AdapterKind = request.adapter, correction = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await ask(messages(request, kind, correction), kind === 'json' ? nativeShape(request) : undefined);
    try { return { status: 'resolved', value: parse(raw, kind, request.signature.outputs), adapter: kind, reasked: attempt > 0 }; }
    catch (error) {
      if (!(error instanceof AdapterFormatError)) throw error;
      if (attempt === 1) return { status: 'refused', reason: error.message, adapter: kind, reasked: true };
      correction = error.message;
      if (kind === 'chat') kind = 'json';
    }
  }
  throw new Error('Adapter attempt limit reached.');
}
