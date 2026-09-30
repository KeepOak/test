import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

export function mcpUi(tool: Pick<Tool, '_meta'>): { uri?: string; app: boolean; model: boolean } {
  const meta = tool._meta as { ui?: { resourceUri?: unknown; visibility?: unknown }; 'ui/resourceUri'?: unknown } | undefined;
  const uri = meta?.ui?.resourceUri ?? meta?.['ui/resourceUri'];
  const visibility = Array.isArray(meta?.ui?.visibility) ? meta.ui.visibility : ['app', 'model'];
  return { ...(typeof uri === 'string' && uri.startsWith('ui://') && uri.length <= 500 ? { uri } : {}),
    app: visibility.includes('app'), model: visibility.includes('model') };
}

/** Read only the tool's declared UI resource on its already-authorized connection. */
export async function appendMcpUi(client: Client, tool: Tool | undefined, result: unknown, signal: AbortSignal): Promise<unknown> {
  const uri = tool ? mcpUi(tool).uri : undefined;
  if (!uri) return result;
  try {
    const resource = await client.readResource({ uri }, { signal, timeout: 10000 });
    const page = resource.contents.find(item => item.uri === uri && 'text' in item && /^text\/html\b/i.test(item.mimeType ?? ''));
    if (!page || !('text' in page) || Buffer.byteLength(page.text) > 40000) return result;
    const original = result as { content?: unknown[] };
    if (!Array.isArray(original.content) || (result as { isError?: boolean }).isError) return result;
    const appended = { ...original, content: [{ type: 'resource', resource: page }, ...original.content] };
    return Buffer.byteLength(JSON.stringify(appended)) <= 60000 ? appended : result;
  } catch { signal.throwIfAborted(); return result; }
}
