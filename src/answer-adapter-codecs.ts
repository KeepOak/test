import type { AdapterFields } from './answer-adapters.js';
export type AdapterKind = 'chat' | 'json' | 'xml';
export class AdapterFormatError extends Error {}
const xmlEscapes: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
const xmlEntities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function encodeAnswer(kind: AdapterKind, values: Record<string, unknown>): string {
  if (kind === 'json') return JSON.stringify(values);
  return Object.entries(values).map(([name, value]) => {
    const text = JSON.stringify(value);
    if (text === undefined) throw new Error('Adapter fields must contain a serializable value.');
    return kind === 'chat' ? `[[ ## ${name} ## ]]\n${text}`
      : `<${name}>${text.replace(/[&<>"']/g, character => xmlEscapes[character]!)}</${name}>`;
  }).join('\n\n') + (kind === 'chat' ? '\n\n[[ ## completed ## ]]' : '');
}
function typed(text: string, field: AdapterFields[string]): unknown {
  const value = text.trim();
  if (field.type === 'string' && !value.startsWith('"')) return value;
  try { return JSON.parse(value); }
  catch { throw new AdapterFormatError('A field did not contain a valid value of its declared type.'); }
}
function chat(raw: string, fields: AdapterFields): Record<string, unknown> {
  const markers = [...raw.matchAll(/(?:^|\n)\[\[ ## ([a-z][a-z0-9_]*) ## \]\]\s*\n?/g)];
  if (!markers.length || raw.slice(0, markers[0]!.index).trim()) throw new AdapterFormatError('Expected labeled chat output fields only.');
  if (markers.at(-1)?.[1] !== 'completed') throw new AdapterFormatError('The output must end with its completed marker.');
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [index, marker] of markers.entries()) {
    const name = marker[1]!, text = raw.slice(marker.index! + marker[0].length, markers[index + 1]?.index ?? raw.length);
    if (name === 'completed') {
      if (index !== markers.length - 1 || text.trim()) throw new AdapterFormatError('The completed marker must be empty and last.');
      continue;
    }
    if (!Object.hasOwn(fields, name) || Object.hasOwn(result, name)) throw new AdapterFormatError('Unknown or repeated output field.');
    result[name] = typed(text, fields[name]!);
  }
  return result;
}
function xml(raw: string, fields: AdapterFields): Record<string, unknown> {
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  let remaining = raw.trim();
  while (remaining) {
    const match = /^<([a-z][a-z0-9_]{0,39})>([\s\S]*?)<\/\1>\s*/.exec(remaining);
    if (!match) throw new AdapterFormatError('Expected plain output field tags, without XML declarations, entities, attributes or prose.');
    const name = match[1]!, text = match[2]!;
    if (!Object.hasOwn(fields, name) || Object.hasOwn(result, name)) throw new AdapterFormatError('Unknown or repeated output field.');
    if (text.includes('<') || text.includes(']]>') || /&(?!(?:amp|lt|gt|quot|apos);)/.test(text))
      throw new AdapterFormatError('XML text must use only escaped text and the five predefined entities.');
    result[name] = typed(text.replace(/&(amp|lt|gt|quot|apos);/g, (_all, entity: string) => xmlEntities[entity]!), fields[name]!);
    remaining = remaining.slice(match[0].length);
  }
  return result;
}
function json(raw: string): unknown {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new AdapterFormatError('Expected one valid JSON object without prose or fences.'); }
  // JSON.parse overwrites duplicate keys; scan validated JSON tokens before accepting an object.
  const names = new Set<string>();
  let depth = 0;
  for (let index = 0; index < raw.length; index++) {
    const character = raw[index];
    if (character === '"') {
      const token = /^"(?:[^"\\]|\\.)*"/s.exec(raw.slice(index))?.[0];
      if (!token) throw new AdapterFormatError('Invalid JSON string token.');
      const end = index + token.length;
      if (depth === 1 && /^\s*:/.test(raw.slice(end))) {
        const name = JSON.parse(token) as string;
        if (names.has(name)) throw new AdapterFormatError('Repeated JSON output field.');
        names.add(name);
      }
      index = end - 1;
    } else if (character === '{' || character === '[') depth++;
    else if (character === '}' || character === ']') depth--;
  }
  return parsed;
}
/** These are constrained field fragments, never a general XML document/resource loader. */
export function decodeAnswer(raw: string, kind: AdapterKind, fields: AdapterFields): unknown {
  if (Buffer.byteLength(raw) > 65536) throw new AdapterFormatError('Adapter response exceeds 64 KiB.');
  if (kind === 'chat') return chat(raw, fields);
  if (kind === 'xml') return xml(raw, fields);
  return json(raw);
}
