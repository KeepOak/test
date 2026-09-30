export interface NativeTool {
  name: string; inputSchema: unknown; outputSchema?: unknown;
  annotations?: { readOnlyHint?: boolean | undefined } | undefined;
  _meta?: Record<string, unknown> | undefined;
}
export interface McpNativeSource {
  capabilities: unknown; tools: readonly NativeTool[];
  alive(): boolean;
  read(uri: string, signal: AbortSignal): Promise<unknown>;
}
/** Resource reads stay on the originating transport and redact its known credentials. */
export function nativeSource(capabilities: unknown, tools: readonly NativeTool[], secrets: readonly string[],
  alive: () => boolean, read: (uri: string, signal: AbortSignal) => Promise<unknown>): McpNativeSource {
  return { capabilities, tools, alive, read: async (uri, signal) => {
    if (!alive()) throw new Error('The original MCP connection closed.');
    const result = await read(uri, signal);
    const text = JSON.stringify(result);
    if (Buffer.byteLength(text) > 60000) throw new Error('MCP mention resource exceeds 60 KiB.');
    signal.throwIfAborted();
    if (!alive()) throw new Error('The original MCP connection closed.');
    return JSON.parse(text, (key: string, value: unknown) => {
      if (secrets.some(secret => secret && key.includes(secret))) throw new Error('MCP resource key contains a configured credential.');
      return typeof value === 'string' ? secrets.reduce((clean, secret) => secret ? clean.split(secret).join('[credential redacted]') : clean, value) : value;
    }) as unknown;
  } };
}
