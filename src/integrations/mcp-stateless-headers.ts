import { headerValue, StatelessError } from '../mcp-stateless.js';

interface Annotation { name: string; path: string[]; type: string }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Inspect all annotations, rejecting ones hidden behind refs/composition/arrays. */
export function headerAnnotations(schema: unknown): Annotation[] {
  const found: Annotation[] = [], names = new Set<string>(); let nodes = 0;
  const visit = (value: unknown, path: string[], reachable: boolean, depth: number): void => {
    if (++nodes > 512 || depth > 12) throw new Error('MCP header schema exceeds limits');
    if (Array.isArray(value)) { for (const item of value) visit(item, path, false, depth + 1); return; }
    if (!object(value)) return;
    if ('x-mcp-header' in value) {
      const name = value['x-mcp-header'], type = value.type;
      if (!reachable || !path.length || typeof name !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)
        || name.length > 80 || typeof type !== 'string' || !['string', 'integer', 'boolean'].includes(type) || names.has(name.toLowerCase()))
        throw new Error('Invalid MCP header annotation');
      names.add(name.toLowerCase()); found.push({ name, path, type });
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === 'properties' && object(child))
        for (const [property, shape] of Object.entries(child)) visit(shape, [...path, property], reachable, depth + 1);
      else if (typeof child === 'object') visit(child, path, false, depth + 1);
    }
  };
  visit(schema, [], true, 0); return found;
}

export function parameterHeaders(schema: unknown, args: Record<string, unknown>): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const annotation of headerAnnotations(schema)) {
    let value: unknown = args;
    for (const part of annotation.path) value = object(value) && Object.hasOwn(value, part) ? value[part] : undefined;
    if (value === undefined || value === null) continue;
    const valid = annotation.type === 'integer' ? Number.isSafeInteger(value) : typeof value === annotation.type;
    if (!valid) throw new StatelessError(-32602, 'Invalid mirrored MCP parameter');
    const encoded = headerValue(String(value));
    if (encoded.length > 4096) throw new Error('MCP parameter header exceeds limit');
    headers[`mcp-param-${annotation.name}`] = encoded;
  }
  return headers;
}
