import type { AdapterFields } from './answer-adapter-fields.js';
import { decodeXml, encodeXml } from './answer-adapter-xml.js';
import { AdapterFormatError, readAdapterValue, readAdapterJson } from './answer-adapter-values.js';
export { AdapterFormatError } from './answer-adapter-values.js';
export type AdapterKind = 'chat' | 'json' | 'xml';
export function encodeAnswer(kind: AdapterKind, values: Record<string, unknown>, fields: AdapterFields): string {
  if (kind === 'json') return JSON.stringify(values);
  if (kind === 'xml') return encodeXml(values, fields);
  return Object.entries(values).filter(([, value]) => value !== undefined).map(([name, value]) => {
    const text = JSON.stringify(value);
    if (text === undefined) throw new Error('Adapter fields must contain a serializable value.');
    return `[[ ## ${name} ## ]]\n${text}`;
  }).join('\n\n') + '\n\n[[ ## completed ## ]]';
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
    result[name] = readAdapterValue(text, fields[name]!);
  }
  return result;
}
/** These are constrained field fragments, never a general XML document/resource loader. */
export function decodeAnswer(raw: string, kind: AdapterKind, fields: AdapterFields): unknown {
  if (Buffer.byteLength(raw) > 65536) throw new AdapterFormatError('Adapter response exceeds 64 KiB.');
  if (kind === 'chat') return chat(raw, fields);
  if (kind === 'xml') return decodeXml(raw, fields);
  return readAdapterJson(raw);
}
