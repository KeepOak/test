import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AnswerShape } from './answer-shape.js';
import type { Message } from './contracts.js';
import { decodeAnswer, encodeAnswer, AdapterFormatError, type AdapterKind } from './answer-adapter-codecs.js';
import { Fields, fieldValidator, hasOptional } from './answer-adapter-fields.js';
export type { AdapterFields } from './answer-adapter-fields.js';
import type { AdapterFields } from './answer-adapter-fields.js';
export const AdaptAnswerInput = z.object({
  adapter: z.enum(['chat', 'json', 'xml']).default('json'),
  signature: z.object({ name: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
    instructions: z.string().min(1).max(8000), inputs: Fields, outputs: Fields }).strict(),
  inputs: z.record(z.string(), z.unknown()),
  demonstrations: z.array(z.object({ inputs: z.record(z.string(), z.unknown()),
    outputs: z.record(z.string(), z.unknown()) }).strict()).max(8).default([]),
}).strict();
export type AdaptAnswerRequest = z.infer<typeof AdaptAnswerInput>;
export type AdaptAnswerResult = { status: 'resolved'; value: Record<string, unknown>; adapter: AdapterKind; reasked: boolean }
  | { status: 'refused'; reason: string; adapter: AdapterKind; reasked: boolean };
export type AdapterAsk = (messages: Message[], shape: AnswerShape | undefined) => Promise<string>;

function nativeShape(input: AdaptAnswerRequest): AnswerShape | undefined {
  // Strict native schemas often require every property. Keep actual omission semantics in prompt mode.
  if (hasOptional(input.signature.outputs)) return undefined;
  const { $schema: _version, ...schema } = z.toJSONSchema(fieldValidator(input.signature.outputs));
  const hash = createHash('sha256').update(JSON.stringify(schema)).digest('hex').slice(0, 8);
  return { name: `as_${input.signature.name}_${hash}`, schema };
}
function instructions(input: AdaptAnswerRequest, kind: AdapterKind): string {
  const format = kind === 'json' ? 'one JSON object, with no prose or code fence'
    : kind === 'xml' ? 'one <field_name>value</field_name> fragment per present field, no root, attributes or prose. Objects contain named child tags; arrays contain <item> children. Escape primitive JSON values as XML text; use JSON null as text for nullable fields'
      : 'one [[ ## field_name ## ]] section per present field, then an empty [[ ## completed ## ]] section. Use JSON for objects and arrays';
  return `${input.signature.instructions}\n\nTyped input fields: ${JSON.stringify(input.signature.inputs)}\n`
    + `Typed output fields: ${JSON.stringify(input.signature.outputs)}\nReturn ${format}. Only fields marked optional may be omitted; null requires nullable. No unknown or duplicate fields at any depth.`;
}
function messages(input: AdaptAnswerRequest, kind: AdapterKind, correction = ''): Message[] {
  const result: Message[] = [{ role: 'system', content: instructions(input, kind) }];
  for (const demo of input.demonstrations) {
    result.push({ role: 'user', content: encodeAnswer(kind, demo.inputs, input.signature.inputs) },
      { role: 'assistant', content: encodeAnswer(kind, demo.outputs, input.signature.outputs) });
  }
  result.push({ role: 'user', content: encodeAnswer(kind, input.inputs, input.signature.inputs) + (correction ? `\n\nCorrect the previous formatting error: ${correction}` : '') });
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
  const request = AdaptAnswerInput.parse(input);
  if (Buffer.byteLength(JSON.stringify(request)) > 65536) throw new Error('Adapter declaration and values exceed 64 KiB.');
  const inputs = fieldValidator(request.signature.inputs), outputs = fieldValidator(request.signature.outputs);
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
