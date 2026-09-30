import type { McpConfig } from "../integrations/mcp-config.js";
export const clickupWriteSource = "mcp:official-clickup-confirmed";
/** Exact official endpoint only; never trust server readOnlyHint or promotional tool names. */
export function officialClickup(config: McpConfig): boolean {
  return config.transport === "http" && new URL(config.url).href === "https://mcp.clickup.com/mcp";
}
export function clickupCallPreview(tool: string, args: unknown): string {
  const serialized = JSON.stringify(args);
  if (!serialized || Buffer.byteLength(serialized) > 16000) throw new Error("ClickUp arguments exceed the 16 KiB approval preview limit.");
  return `Official ClickUp MCP tool ${tool}; exact arguments ${serialized}. The remote tool may change workspace data.`;
}
