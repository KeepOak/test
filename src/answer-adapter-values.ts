import type { AdapterField } from './answer-adapter-fields.js';
export class AdapterFormatError extends Error {}

export function readAdapterValue(text: string, field: AdapterField): unknown {
  const value = text.trim();
  if (field.nullable && value === 'null') return null;
  if (field.type === 'string' && !value.startsWith('"')) return value;
  try { return readAdapterJson(value); }
  catch { throw new AdapterFormatError('A field did not contain a valid value of its declared type.'); }
}
export function readAdapterJson(raw: string): unknown {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new AdapterFormatError('Expected valid JSON without prose or fences.'); }
  // JSON.parse overwrites duplicates; keep independent key sets for every validated object token.
  const stack: (Set<string> | null)[] = [];
  for (let index = 0; index < raw.length; index++) {
    const character = raw[index];
    if (character === '"') {
      const token = /^"(?:[^"\\]|\\.)*"/s.exec(raw.slice(index))?.[0];
      if (!token) throw new AdapterFormatError('Invalid JSON string token.');
      const end = index + token.length, names = stack.at(-1);
      if (names && /^\s*:/.test(raw.slice(end))) {
        const name = JSON.parse(token) as string;
        if (names.has(name)) throw new AdapterFormatError('Repeated JSON output field.');
        names.add(name);
      }
      index = end - 1;
    } else if (character === '{' || character === '[') {
      if (stack.length >= 9) throw new AdapterFormatError('JSON structure exceeds its depth limit.');
      stack.push(character === '{' ? new Set<string>() : null);
    } else if (character === '}' || character === ']') stack.pop();
  }
  return parsed;
}
