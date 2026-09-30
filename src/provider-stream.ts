import { z } from "zod";
import type { Completion, ToolCall, Usage } from "./contracts.js";
import { estimateTokens, ProviderStreamError } from "./contracts.js";
import { thinkingTokens } from "./empty-answer.js";
import { anthropicUsage, AnthropicUsageSchema, type AnthropicUsage } from "./anthropic-usage.js";

const count = z.number().int().nonnegative();
const index = count.max(15);
const openaiChunk = z.object({
  choices: z.array(z.object({
    index: z.literal(0),
    delta: z.object({
      content: z.string().nullable().optional(),
      // mac7/empty-completion: a reasoning model streams its thinking in a field beside the answer.
      // OpenAI-shaped local servers (Ollama, llama.cpp, vLLM) use one of these two names. Dropping
      // them made a thinking model look silent: no text ever arrived, so the stall watchdog fired,
      // and a reply that was all thinking arrived as an empty answer with nothing to explain it.
      // integrate/empty-completion: read loosely. A server that puts something other than text
      // here (an object, a list of summaries) must behave exactly as it did before these fields
      // were read — ignored — rather than fail every chunk.
      reasoning_content: z.unknown().optional(),
      reasoning: z.unknown().optional(),
      tool_calls: z.array(z.object({
        index,
        id: z.string().optional(),
        function: z.object({
          name: z.string().optional(), arguments: z.string().optional(),
        }).optional(),
      })).optional(),
    }),
    finish_reason: z.string().nullable().optional(),
  })).max(1),
  usage: z.object({ prompt_tokens: count, completion_tokens: count }).nullable().optional(),
});

/** Parse bounded SSE frames, including UTF-8 and CRLF split across reads. */
export async function readEventStream(
  response: Response,
  consume: (data: string) => void,
): Promise<void> {
  const type = response.headers.get("content-type");
  if (type && !type.includes("text/event-stream"))
    throw new Error("Provider did not return an event stream");
  const reader = response.body!.getReader(), decoder = new TextDecoder();
  const framing = new EventFraming(consume);
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 1048576) throw new Error("Provider response exceeds 1 MiB");
      framing.push(decoder.decode(part.value, { stream: true }));
    }
    framing.push(decoder.decode(), true);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

class EventFraming {
  private buffer = "";
  private data: string[] = [];
  constructor(private readonly consume: (data: string) => void) {}
  push(text: string, eof = false): void {
    this.buffer += text;
    while (true) {
      const match = /\r\n|\r|\n/.exec(this.buffer);
      if (!match || (!eof && match[0] === "\r" && match.index === this.buffer.length - 1)) return;
      const line = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      if (!line) {
        if (this.data.length) this.consume(this.data.join("\n"));
        this.data = [];
      } else if (line === "data" || line.startsWith("data:")) {
        this.data.push(line.slice(5).replace(/^ /, ""));
      }
    }
  }
}

export class OpenAIStream {
  private content = "";
  private thinking = 0;
  private calls = new Map<number, ToolCall>();
  private usage: Usage | undefined;
  private finish = "";
  private done = false;
  constructor(
    private readonly emit: (text: string) => void,
    /** mac7/empty-completion: thinking as it arrives. It is not the answer, so it is counted, not kept. */
    private readonly think: (text: string) => void = () => undefined,
  ) {}
  consume(data: string): void {
    if (this.done) throw new Error("Provider sent data after stream completion");
    if (data === "[DONE]") { this.done = true; return; }
    const chunk = openaiChunk.parse(JSON.parse(data));
    if (chunk.usage) this.usage = {
      input: chunk.usage.prompt_tokens, output: chunk.usage.completion_tokens,
    };
    for (const choice of chunk.choices) {
      if (this.finish) {
        // Some compatible providers repeat the terminal choice before [DONE].
        if (choice.finish_reason === this.finish &&
            !choice.delta.content && !choice.delta.tool_calls?.length &&
            !thinkingText(choice.delta.reasoning_content, choice.delta.reasoning)) continue;
        throw new Error("Provider sent choices after finish");
      }
      const text = choice.delta.content;
      if (text) { this.content += text; this.emit(text); }
      const thought = thinkingText(choice.delta.reasoning_content, choice.delta.reasoning);
      if (thought) { this.thinking += thought.length; this.think(thought); }
      for (const fragment of choice.delta.tool_calls ?? []) {
        const call = this.calls.get(fragment.index) ?? { id: "", name: "", arguments: "" };
        call.id += fragment.id ?? "";
        call.name += fragment.function?.name ?? "";
        call.arguments += fragment.function?.arguments ?? "";
        this.calls.set(fragment.index, call);
      }
      if (choice.finish_reason) this.finish = choice.finish_reason;
    }
  }
  result(): Completion {
    // integrate/empty-completion: out of room before a word of the answer is the model's limit, not
    // a broken provider, and the person is told so.
    if (this.done && this.finish === "length" && !this.content && !this.calls.size && this.thinking)
      throw new Error(outOfRoomThinking(this.thinking));
    if (!this.done || !["stop", "tool_calls"].includes(this.finish))
      throw new Error("Provider stream ended without a complete response");
    if (this.calls.size && this.finish !== "tool_calls")
      throw new Error("Provider did not finish its tool calls");
    return {
      content: this.content,
      toolCalls: [...this.calls].sort(([a], [b]) => a - b).map(([, call]) => call),
      ...(this.usage ? { usage: this.usage } : {}),
      ...(this.thinking ? { reasoningChars: this.thinking } : {}),
    };
  }
  failure(cause: unknown): ProviderStreamError {
    return streamFailure(cause, this.content, [...this.calls.values()], this.usage, this.thinking);
  }
}

const anthropicEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("message_start"), message: z.object({
    usage: AnthropicUsageSchema.nullish(),
  }) }),
  z.object({ type: z.literal("content_block_start"), index, content_block: z.discriminatedUnion("type", [
    z.object({ type: z.literal("text"), text: z.string() }),
    z.object({ type: z.literal("tool_use"), id: z.string(), name: z.string(), input: z.record(z.string(), z.unknown()) }),
    // integrate/empty-completion: extended thinking, sent when the owner turns reasoning on.
    z.object({ type: z.literal("thinking"), thinking: z.string().optional() }),
    z.object({ type: z.literal("redacted_thinking") }),
  ]) }),
  z.object({ type: z.literal("content_block_delta"), index, delta: z.discriminatedUnion("type", [
    z.object({ type: z.literal("text_delta"), text: z.string() }),
    z.object({ type: z.literal("input_json_delta"), partial_json: z.string() }),
    z.object({ type: z.literal("thinking_delta"), thinking: z.string() }),
    z.object({ type: z.literal("signature_delta") }),
  ]) }),
  z.object({ type: z.literal("content_block_stop"), index }),
  z.object({ type: z.literal("message_delta"), delta: z.object({ stop_reason: z.string().nullable().optional() }),
    usage: AnthropicUsageSchema.nullish() }),
  z.object({ type: z.literal("message_stop") }),
  z.object({ type: z.literal("ping") }),
  z.object({ type: z.literal("error") }),
]);
type AnthropicEvent = z.infer<typeof anthropicEvent>;
/** A thinking block keeps only how much was thought; the thinking itself is never kept. */
type Block = { text: string } | { call: ToolCall; json: string } | { thought: number };

export class AnthropicStream {
  private blocks = new Map<number, Block>();
  private open = new Set<number>();
  private usage: Usage | undefined;
  /** What Anthropic said so far, merged across message_start and message_delta. */
  private said: AnthropicUsage = {};
  private finalUsage = false;
  private started = false;
  private done = false;
  private finish = "";
  constructor(
    private readonly emit: (text: string) => void,
    /** integrate/empty-completion: thinking as it arrives, for the watchdog. Counted, not kept. */
    private readonly think: (text: string) => void = () => undefined,
  ) {}
  consume(data: string): void {
    const event = anthropicEvent.parse(JSON.parse(data));
    if (event.type === "ping") return;
    if (this.done) throw new Error("Provider sent data after stream completion");
    if (event.type === "error") throw new Error("Provider stream failed");
    if (event.type === "message_start") {
      if (this.started) throw new Error("Duplicate provider message start");
      this.started = true;
      // The cache reads and writes are part of what the call used; Anthropic counts them apart from input_tokens.
      if (event.message.usage) { this.said = { ...event.message.usage }; this.usage = anthropicUsage(this.said); }
    } else {
      if (!this.started) throw new Error("Provider stream missing message start");
      this.advance(event);
    }
  }
  private advance(event: Exclude<AnthropicEvent, { type: "ping" | "error" | "message_start" }>): void {
    if (event.type === "content_block_start") this.startBlock(event);
    if (event.type === "content_block_delta") this.delta(event);
    if (event.type === "content_block_stop" && !this.open.delete(event.index))
      throw new Error("Provider stopped an unknown content block");
    if (event.type === "message_delta") {
      this.finish = event.delta.stop_reason ?? this.finish;
      if (this.usage && event.usage) {
        // The closing counts are cumulative; a field it leaves out keeps what message_start said.
        for (const [key, value] of Object.entries(event.usage)) if (value != null) (this.said as Record<string, unknown>)[key] = value;
        this.usage = anthropicUsage(this.said, event.usage.output_tokens ?? this.usage.output);
        this.finalUsage = true;
      }
    }
    if (event.type === "message_stop") this.done = true;
  }
  private startBlock(event: Extract<AnthropicEvent, { type: "content_block_start" }>): void {
    if (this.finish || this.blocks.has(event.index)) throw new Error("Invalid provider content block start");
    const block = event.content_block;
    this.open.add(event.index);
    if (block.type === "thinking" || block.type === "redacted_thinking") {
      const opening = block.type === "thinking" ? block.thinking ?? "" : "";
      this.blocks.set(event.index, { thought: opening.length });
      if (opening) this.think(opening);
    } else if (block.type === "text") {
      if ([...this.blocks.values()].some((value) => "text" in value)) this.emit("\n");
      this.blocks.set(event.index, { text: block.text });
      if (block.text) this.emit(block.text);
    } else this.blocks.set(event.index, {
      call: { id: block.id, name: block.name, arguments: JSON.stringify(block.input) }, json: "",
    });
  }
  private delta(event: Extract<AnthropicEvent, { type: "content_block_delta" }>): void {
    const block = this.blocks.get(event.index);
    if (!block || !this.open.has(event.index) || this.finish)
      throw new Error("Provider delta has no active content block");
    if (event.delta.type === "text_delta" && "text" in block) {
      block.text += event.delta.text;
      this.emit(event.delta.text);
    } else if (event.delta.type === "input_json_delta" && "call" in block) {
      block.json += event.delta.partial_json;
    } else if (event.delta.type === "thinking_delta" && "thought" in block) {
      block.thought += event.delta.thinking.length;
      this.think(event.delta.thinking);
    } else if (event.delta.type === "signature_delta" && "thought" in block) {
      // The signature only matters to a caller that sends the thinking back, and Branch never does.
    } else throw new Error("Provider content delta type mismatch");
  }
  private thinking(): number {
    return [...this.blocks.values()].reduce((sum, block) => sum + ("thought" in block ? block.thought : 0), 0);
  }
  result(): Completion {
    const thought = this.thinking();
    const said = [...this.blocks.values()].some((block) => !("thought" in block));
    if (this.done && this.finish === "max_tokens" && !said && thought) throw new Error(outOfRoomThinking(thought));
    // selfdev: an answer or a tool call cut off at the reply ceiling is out of room too, so the task asks again with more.
    if (this.done && this.finish === "max_tokens") throw new Error(outOfRoomAnswer);
    if (!this.done || this.open.size || !["end_turn", "tool_use", "stop_sequence"].includes(this.finish))
      throw new Error("Provider stream ended without a complete response");
    const blocks = [...this.blocks].sort(([a], [b]) => a - b).map(([, block]) => block);
    if (blocks.some((block) => "call" in block) && this.finish !== "tool_use")
      throw new Error("Provider did not finish its tool calls");
    return {
      content: blocks.filter((b) => "text" in b).map((b) => b.text).join("\n"),
      toolCalls: blocks.filter((b) => "call" in b).map((b) => ({ ...b.call, arguments: b.json || b.call.arguments })),
      ...(this.usage && this.finalUsage ? { usage: this.usage } : {}),
      ...(thought ? { reasoningChars: thought } : {}),
    };
  }
  failure(cause: unknown): ProviderStreamError {
    const blocks = [...this.blocks.values()];
    return streamFailure(cause,
      blocks.filter((block) => "text" in block).map((block) => block.text).join("\n"),
      blocks.filter((block) => "call" in block).map((block) => ({ ...block.call, arguments: block.json || block.call.arguments })),
      this.usage, this.thinking());
  }
}

function streamFailure(cause: unknown, content: string, toolCalls: ToolCall[], usage?: Usage, thinking = 0): ProviderStreamError {
  const estimatedOutput = (content || toolCalls.length ? estimateTokens({ content, toolCalls }) : 0) + thinkingTokens(thinking);
  return new ProviderStreamError(cause, estimatedOutput, usage);
}
/** integrate/empty-completion: a reply that ran out of room before a word of its answer. */
function outOfRoomThinking(chars: number): string {
  return `The model used its whole reply allowance thinking (${chars.toLocaleString()} characters) `
    + "and was cut off before it answered. Try a larger model, or ask for one step at a time.";
}
/** selfdev: a reply (text or a tool call such as a long edit) cut off at the reply ceiling before it was finished. */
export const outOfRoomAnswer = "The model used its whole reply allowance before finishing its answer, so the answer was cut off.";
/** Whether a failure is a reply cut off at the reply ceiling (while thinking or while answering), not the provider's fault. */
export function isOutOfRoomThinking(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("The model used its whole reply allowance");
}
/** integrate/empty-completion: the first of the thinking fields that is text; anything else is ignored. */
export function thinkingText(...fields: unknown[]): string {
  for (const field of fields) if (typeof field === "string" && field) return field;
  return "";
}
