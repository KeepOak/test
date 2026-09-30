import type { AdapterField, AdapterFields } from './answer-adapter-fields.js';
import { AdapterFormatError, readAdapterValue as typed } from './answer-adapter-values.js';
type Element = { name: string; text: string; children: Element[] };
const escapes: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function encodeField(name: string, value: unknown, field: AdapterField): string {
  let content: string;
  if (value !== null && field.type.endsWith('[]')) content = (value as unknown[])
    .map(item => encodeField('item', item, { ...field, type: field.type.slice(0, -2) as AdapterField['type'], nullable: false })).join('');
  else if (value !== null && field.type === 'object') content = encodeXml(value as Record<string, unknown>, field.fields!);
  else {
    const text = JSON.stringify(value);
    if (text === undefined) throw new Error('XML fields must contain a serializable value.');
    content = text.replace(/[&<>"']/g, character => escapes[character]!);
  }
  return `<${name}>${content}</${name}>`;
}
export function encodeXml(values: Record<string, unknown>, fields: AdapterFields): string {
  return Object.entries(values).filter(([, value]) => value !== undefined)
    .map(([name, value]) => encodeField(name, value, fields[name]!)).join('\n');
}
function unescape(text: string): string {
  if (text.includes(']]>') || /&(?!(?:amp|lt|gt|quot|apos);)/.test(text))
    throw new AdapterFormatError('XML accepts only the five predefined text entities.');
  return text.replace(/&(amp|lt|gt|quot|apos);/g, (_all, entity: string) => entities[entity]!);
}
/** Restricted token reader: no attributes, DTD, processing instructions, CDATA or external resources. */
function elements(raw: string): Element[] {
  let position = 0, count = 0;
  const read = (depth: number): Element => {
    if (depth > 9 || ++count > 4096) throw new AdapterFormatError('XML structure exceeds its depth or element limit.');
    const opening = /^<([a-z][a-z0-9_]{0,39})(\/?)>/.exec(raw.slice(position));
    if (!opening) throw new AdapterFormatError('Expected a plain XML field tag.');
    position += opening[0].length;
    const node: Element = { name: opening[1]!, text: '', children: [] };
    if (opening[2]) return node;
    const closing = `</${node.name}>`;
    while (!raw.startsWith(closing, position)) {
      if (position >= raw.length) throw new AdapterFormatError('An XML field was not closed.');
      if (raw[position] === '<') node.children.push(read(depth + 1));
      else {
        const end = raw.indexOf('<', position);
        if (end < 0) throw new AdapterFormatError('An XML field was not closed.');
        node.text += unescape(raw.slice(position, end)); position = end;
      }
    }
    position += closing.length;
    if (node.children.length && node.text.trim()) throw new AdapterFormatError('XML fields cannot mix text and child tags.');
    return node;
  };
  const result: Element[] = [];
  while (position < raw.length) {
    if (/\s/.test(raw[position]!)) { position++; continue; }
    result.push(read(1));
  }
  return result;
}
function value(node: Element, field: AdapterField): unknown {
  if (!node.children.length && field.nullable && (node.text.trim() === 'null' || !node.text.trim())) return null;
  if (field.type.endsWith('[]')) {
    if (!node.children.length && node.text.trim()) return typed(node.text, field);
    if (node.children.length > 128 || node.children.some(child => child.name !== 'item'))
      throw new AdapterFormatError('XML arrays require at most 128 item children.');
    const item: AdapterField = { ...field, type: field.type.slice(0, -2) as AdapterField['type'], nullable: false };
    return node.children.map(child => value(child, item));
  }
  if (field.type === 'object') {
    if (!node.children.length && node.text.trim()) return typed(node.text, field);
    return object(node.children, field.fields!);
  }
  if (node.children.length) throw new AdapterFormatError('Primitive XML fields cannot contain tags.');
  return typed(node.text, field);
}
function object(nodes: Element[], fields: AdapterFields): Record<string, unknown> {
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const node of nodes) {
    if (!Object.hasOwn(fields, node.name) || Object.hasOwn(result, node.name))
      throw new AdapterFormatError('Unknown or repeated XML field.');
    result[node.name] = value(node, fields[node.name]!);
  }
  return result;
}
export function decodeXml(raw: string, fields: AdapterFields): Record<string, unknown> {
  return object(elements(raw), fields);
}
