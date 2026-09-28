import { AnthropicStream } from "../provider-stream.js";
import type { Completion, CompletionRequest } from "../contracts.js";
import { nativeToolPrefix, type NativeInventory } from "./claude-subscription-history.js";

const maximumOutputBytes = 4 * 1024 * 1024;
const count = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Claude subscription returned invalid usage");
  return value;
};
/** The completed upstream SSE is authoritative; native recovery cannot replace a captured tool batch. */
export class NativeCapture {
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private readonly stream: AnthropicStream;
  private pending = "";
  private bytes = 0;
  private usage: { input: number; read: number; write: number } | null = null;
  private complete = false;
  constructor(private readonly inventory: NativeInventory, request: CompletionRequest) {
    this.stream = new AnthropicStream((text) => request.onTextDelta?.(text), (text) => request.onReasoningDelta?.(text));
  }
  feed(chunk: Uint8Array): void {
    this.bytes += chunk.byteLength;
    if (this.bytes > maximumOutputBytes) throw new Error("Claude subscription response exceeds 4 MiB");
    this.pending += this.decoder.decode(chunk, { stream: true });
    this.frames();
  }
  private frames(): void {
    let boundary: RegExpExecArray | null;
    while ((boundary = /\r?\n\r?\n/.exec(this.pending))) {
      const frame = this.pending.slice(0, boundary.index);
      this.pending = this.pending.slice(boundary.index + boundary[0].length);
      const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n");
      if (data) this.event(data);
    }
  }
  private event(data: string): void {
    let event: { type?: string; message?: { usage?: Record<string, unknown> } };
    try { event = JSON.parse(data); } catch { throw new Error("Claude subscription returned invalid stream JSON"); }
    if (event.type === "message_start") {
      const usage = event.message?.usage;
      if (!usage) throw new Error("Claude subscription response has no usage");
      this.usage = { input: count(usage.input_tokens), read: count(usage.cache_read_input_tokens ?? 0), write: count(usage.cache_creation_input_tokens ?? 0) };
    }
    this.stream.consume(data);
    if (event.type === "message_stop") this.complete = true;
  }
  result(): Completion {
    this.pending += this.decoder.decode(); this.frames();
    if (this.pending.trim() || !this.complete || !this.usage) throw new Error("Claude subscription upstream response is incomplete");
    const result = this.stream.result();
    if (!result.usage) throw new Error("Claude subscription response has no final usage");
    const ids = new Set<string>();
    for (const call of result.toolCalls) {
      const name = call.name.startsWith(nativeToolPrefix) ? this.inventory.names.get(call.name.slice(nativeToolPrefix.length)) : undefined;
      if (!name || !call.id || ids.has(call.id)) throw new Error("Claude subscription returned an unknown or repeated tool call");
      ids.add(call.id); call.name = name;
      let input: unknown;
      try { input = JSON.parse(call.arguments); } catch { throw new Error("Claude subscription returned incomplete tool arguments"); }
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Claude subscription tool arguments must be an object");
    }
    result.usage = { input: this.usage.input + this.usage.read + this.usage.write, output: result.usage.output, cachedInput: this.usage.read };
    return result;
  }
}
