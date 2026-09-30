import { createHash } from "node:crypto";
import type { CompletionRequest, Message, ToolDescription } from "../contracts.js";

export const nativeToolPrefix = "mcp__branch__";
/**
 * provider-audit: room for a 1M-token conversation (about 4 MB of plain text, more with pictures and JSON escaping),
 * kept under the 32 MB the Messages API accepts in one request.
 */
export const maximumNativeRequestBytes = 30 * 1024 * 1024;
export interface NativeFrame { type: "user" | "assistant"; message: { role: "user" | "assistant"; content: Record<string, unknown>[] }; shouldQuery?: false }
export interface NativeInventory { manifest: Record<string, unknown>[]; tools: Record<string, unknown>[]; names: Map<string, string> }
export const nativeToolName = (name: string): string => "b_" + createHash("sha256").update(name).digest("hex").slice(0, 32);

/** A stable, collision-checked wire alias keeps Branch's dotted names out of native MCP identifiers. */
export function nativeInventory(tools: ToolDescription[]): NativeInventory {
  if (tools.length > 512) throw new Error("Claude subscription supports at most 512 tools per request");
  const names = new Map<string, string>(), manifest = [], native = [];
  for (const tool of tools) {
    if (!tool.name || tool.name.length > 512 || !tool.parameters || typeof tool.parameters !== "object")
      throw new Error("Claude subscription received an invalid tool description");
    const name = nativeToolName(tool.name);
    if (names.has(name)) throw new Error("Claude subscription tool names are not unique");
    names.set(name, tool.name);
    const description = `Branch tool ${tool.name}. ${tool.description}`;
    manifest.push({ name, description, inputSchema: tool.parameters });
    native.push({ name: nativeToolPrefix + name, description, input_schema: tool.parameters });
  }
  boundedNativeJson({ manifest, native });
  return { names, manifest, tools: native };
}
export function boundedNativeJson(value: unknown): string {
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) > maximumNativeRequestBytes)
    throw new Error("Claude subscription request exceeds 30 MiB; shorten the conversation or tool inventory");
  return json;
}
function messageBlocks(message: Message): Record<string, unknown>[] {
  if (message.role === "tool") {
    if (!message.toolCallId) throw new Error("Claude subscription tool result has no call id");
    return [{ type: "tool_result", tool_use_id: message.toolCallId, content: message.content }];
  }
  const blocks: Record<string, unknown>[] = message.content ? [{ type: "text", text: message.content }] : [];
  for (const image of message.images ?? []) blocks.push({ type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } });
  for (const call of message.toolCalls ?? []) {
    let input: unknown;
    try { input = JSON.parse(call.arguments); } catch { throw new Error("Claude subscription history has invalid tool arguments"); }
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Claude subscription tool arguments must be an object");
    blocks.push({ type: "tool_use", id: call.id, name: nativeToolPrefix + nativeToolName(call.name), input });
  }
  return blocks;
}
/** Replay canonical messages without flattening text, dropping tool outcomes or adding a continue prompt. */
export function nativeHistory(request: CompletionRequest): { system: string; frames: NativeFrame[] } {
  if (request.messages.length > 2048) throw new Error("Claude subscription history exceeds 2048 messages");
  boundedNativeJson(request.messages);
  const systems: string[] = [], frames: NativeFrame[] = [];
  for (const message of request.messages) {
    if (message.role === "system") {
      if (frames.length) throw new Error("Claude subscription requires system instructions before conversation history");
      systems.push(message.content); continue;
    }
    const role = message.role === "tool" ? "user" : message.role, content = messageBlocks(message);
    if (role === "user" && frames.at(-1)?.type === "user") frames.at(-1)!.message.content.push(...content);
    else frames.push({ type: role, message: { role, content } });
  }
  if (frames.at(-1)?.type !== "user" || !frames.at(-1)!.message.content.length)
    throw new Error("Claude subscription history must end with a user message or tool results");
  for (const frame of frames.slice(0, -1)) if (frame.type === "user") frame.shouldQuery = false;
  boundedNativeJson(frames);
  return { system: systems.join("\n\n"), frames };
}
export function nativeGeneration(request: CompletionRequest, inventory: NativeInventory): Record<string, unknown> {
  if (!Number.isInteger(request.maxTokens) || request.maxTokens < 1 || request.maxTokens > 65536)
    throw new Error("Claude subscription reply allowance must be between 1 and 65536 tokens");
  return { tools: inventory.tools, max_tokens: request.maxTokens,
    ...(request.reasoning ? { output_config: { effort: request.reasoning } } : {}),
    ...(request.responseFormat ? { output_config: { ...(request.reasoning ? { effort: request.reasoning } : {}),
      format: { type: "json_schema", schema: request.responseFormat.schema } } } : {}) };
}
