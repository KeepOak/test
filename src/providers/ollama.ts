import { randomUUID } from "node:crypto";
import { freemem, totalmem } from "node:os";
import { z } from "zod";
import { onOwnNetwork } from "../network-policy.js";
import type { Completion, CompletionRequest, Message, Provider, ToolCall } from "../contracts.js";
import { ProviderStreamError, estimateTokens } from "../contracts.js";
import { thinkingTokens } from "../empty-answer.js";
import { rejectedHttpResponse } from "../provider-retry.js";
import { restoreToolNames, wireName } from "../providers.js";

/**
 * Ollama's own route, rather than its OpenAI-compatible one. It runs on this computer, so nothing
 * leaves it and nothing is charged. Its replies stream as one JSON object per line rather than as
 * the text events every cloud service uses.
 */
export interface OllamaOptions {
  /** The OpenAI-compatible address, for example http://127.0.0.1:11434/v1. */
  endpoint: string;
  model: string;
  fetchImpl?: typeof globalThis.fetch;
}

const ollamaReply = z.object({
  message: z.object({
    content: z.string().default(""),
    // mac7/empty-completion: Ollama's own name for a reasoning model's thinking. It is not the
    // answer, but a model that is thinking is a model that is working, so it is heard rather than
    // dropped — see src/provider-stream.ts for the same gap in the OpenAI-shaped adapter.
    thinking: z.string().nullable().optional(),
    tool_calls: z.array(z.object({
      function: z.object({ name: z.string(), arguments: z.union([z.string(), z.record(z.string(), z.unknown())]) }),
    }).loose()).optional(),
  }).loose().default({ content: "" }),
  prompt_eval_count: z.number().nonnegative().optional(),
  eval_count: z.number().nonnegative().optional(),
  done: z.boolean().optional(),
}).loose();

/** Ollama's root, worked out from the OpenAI-compatible address by dropping the trailing `/v1`. */
export function ollamaRoot(endpoint: string): string {
  return endpoint.replace(/\/$/, "").replace(/\/v1$/, "");
}

/** Ollama runs on this computer: tools travel under the names the model reads (see `WireRule` in src/providers.ts). */
function ollamaMessage(message: Message): Record<string, unknown> {
  if (message.role === "tool") return { role: "tool", content: message.content };
  return {
    role: message.role,
    content: message.content,
    ...(message.images?.length ? { images: message.images.map((image) => image.data) } : {}),
    ...(message.toolCalls?.length
      ? {
          tool_calls: message.toolCalls.map((call: ToolCall) => ({
            function: { name: wireName(call.name, "local"), arguments: JSON.parse(call.arguments) as unknown },
          })),
        }
      : {}),
  };
}

/** What a model's /api/show says about the room it can hold. */
const showReply = z.object({
  model_info: z.record(z.string(), z.unknown()).optional(),
  parameters: z.string().optional(),
}).loose();
export interface ModelRoomFacts {
  /** The context the model was trained for (`<arch>.context_length`). */
  contextLength: number | null;
  /** The room a copy was made with (`num_ctx` in its parameters), for Branch's own sized copies. */
  bakedNumCtx: number | null;
  /** The memory one token of context takes, worked out from the model's shape when it says. */
  bytesPerToken: number | null;
}
export function roomFacts(body: unknown): ModelRoomFacts {
  const parsed = showReply.safeParse(body);
  const info = parsed.success ? parsed.data.model_info ?? {} : {};
  const number = (suffix: string): number | null => {
    const key = Object.keys(info).find((one) => one.endsWith(suffix));
    const value = key ? info[key] : undefined;
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
  };
  const layers = number(".block_count"), heads = number(".attention.head_count"), kvHeads = number(".attention.head_count_kv") ?? heads,
    width = number(".embedding_length");
  // Keys and values, for every layer, at two bytes a number.
  const bytesPerToken = layers && heads && kvHeads && width ? 2 * layers * kvHeads * (width / heads) * 2 : null;
  const baked = parsed.success ? /(?:^|\n)\s*num_ctx\s+(\d+)/.exec(parsed.data.parameters ?? "")?.[1] : undefined;
  return { contextLength: number(".context_length"), bakedNumCtx: baked ? Number(baked) : null, bytesPerToken };
}
/**
 * The room (num_ctx) a model on this computer runs with. A copy made with its own room (setup's sized copy, fitted to
 * this computer's memory and graphics card) runs with exactly that room, never more. Any other model runs with what it
 * was made for, as far as a quarter of this computer's memory (or half of what is free, whichever is less) holds: left
 * alone, Ollama gives it a few thousand tokens, and a long task is cut off without a word.
 */
export function contextRoom(facts: ModelRoomFacts, memory = { free: freemem(), total: totalmem() }): number {
  if (facts.bakedNumCtx) return facts.bakedNumCtx;
  const made = Math.min(facts.contextLength ?? 8192, 65536);
  const budget = Math.min(memory.free / 2, memory.total / 4);
  const holds = Math.floor(budget / (facts.bytesPerToken ?? 131072) / 1024) * 1024;
  return Math.min(made, Math.max(holds, 2048));
}

export function ollamaBody(request: CompletionRequest, model: string, numCtx?: number | null): Record<string, unknown> {
  return {
    model,
    messages: request.messages.map(ollamaMessage),
    options: { num_predict: request.maxTokens, ...(numCtx ? { num_ctx: numCtx } : {}) },
    ...(request.tools.length
      ? {
          tools: request.tools.map((tool) => ({
            type: "function",
            function: { name: wireName(tool.name, "local"), description: tool.description, parameters: tool.parameters },
          })),
        }
      : {}),
  };
}

export class OllamaProvider implements Provider {
  readonly name = "ollama";
  readonly acceptsImages = true;
  private readonly fetchImpl: typeof globalThis.fetch;
  /** The model this connection asks for (src/contracts.ts Provider.model). */
  get model(): string { return this.options.model; }
  constructor(private readonly options: OllamaOptions) {
    if (!options.model) throw new Error("Ollama needs the name of a model that is installed here");
    // #463's rule, as for an OpenAI-shaped server: plain http only on this computer or an address on the owner's own network.
    const url = new URL(options.endpoint);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || onOwnNetwork(url.hostname))))
      throw new Error("Ollama endpoint requires HTTPS (plain HTTP is allowed only on this computer or your own network)");
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }
  /** The OpenAI-compatible side of the same service serves speech and embeddings. */
  audio(): { endpoint: string; apiKey: string } | null {
    return { endpoint: this.options.endpoint, apiKey: "local" };
  }
  embeddings(): { endpoint: string; apiKey: string; fetchImpl: typeof fetch } | null {
    return { endpoint: this.options.endpoint, apiKey: "local", fetchImpl: this.fetchImpl };
  }
  images(): null { return null; }
  supportsImages(): boolean { return true; }
  modelsList(): { url: string; headers: Record<string, string> } | null {
    return { url: ollamaRoot(this.options.endpoint) + "/api/tags", headers: {} };
  }
  /** The room this model runs with, read once from Ollama's /api/show; null when Ollama does not say. */
  private room: Promise<number | null> | undefined;
  contextTokens(): Promise<number | null> {
    this.room ??= this.readRoom();
    return this.room;
  }
  private async readRoom(): Promise<number | null> {
    try {
      const response = await this.fetchImpl(ollamaRoot(this.options.endpoint) + "/api/show", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: this.options.model }),
        redirect: "error", signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return null;
      const facts = roomFacts(await response.json());
      return facts.contextLength || facts.bakedNumCtx ? contextRoom(facts) : null;
    } catch {
      return null; // Ollama did not say: the model runs with Ollama's own room, as before
    }
  }
  async complete(request: CompletionRequest): Promise<Completion> {
    const body = ollamaBody(request, this.options.model, await this.contextTokens());
    if (request.onTextDelta) return this.stream(request, body);
    const response = await this.post({ ...body, stream: false }, request.signal);
    return restoreToolNames(readCompletion(ollamaReply.parse(await response.json())), request, "local");
  }
  private async stream(request: CompletionRequest, body: Record<string, unknown>): Promise<Completion> {
    const emit = request.onTextDelta!;
    let text = "", thinking = 0, usage: { input: number; output: number } | undefined, calls: ToolCall[] = [];
    try {
      const response = await this.post({ ...body, stream: true }, request.signal);
      for await (const line of lines(response)) {
        const part = ollamaReply.parse(JSON.parse(line) as unknown);
        const chunk = part.message.content;
        if (chunk) { text += chunk; emit(chunk); }
        const thought = part.message.thinking;
        if (thought) { thinking += thought.length; request.onReasoningDelta?.(thought); }
        const finished = readCompletion(part);
        if (finished.toolCalls.length) calls = [...calls, ...finished.toolCalls];
        if (part.done && finished.usage) usage = finished.usage;
      }
    } catch (error) {
      // integrate/empty-completion: thinking that arrived before the failure was produced and is charged.
      throw new ProviderStreamError(error, estimateTokens(text) + thinkingTokens(thinking), usage);
    }
    return restoreToolNames({ content: text, toolCalls: calls, ...(usage ? { usage } : {}), ...(thinking ? { reasoningChars: thinking } : {}) }, request, "local");
  }
  private async post(body: unknown, signal: AbortSignal): Promise<Response> {
    const response = await this.fetchImpl(ollamaRoot(this.options.endpoint) + "/api/chat", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body), signal, redirect: "error",
    });
    if (!response.ok) throw await rejectedHttpResponse(response, signal);
    if (!response.body) throw new Error("Provider returned empty body");
    return response;
  }
}

/** One JSON object per line, held together across reads, with a cap so nothing runs away. */
async function* lines(response: Response): AsyncGenerator<string> {
  const reader = response.body!.getReader(), decoder = new TextDecoder();
  let buffer = "", size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 4 * 1048576) throw new Error("Provider response exceeds 4 MiB");
      buffer += decoder.decode(part.value, { stream: true });
      let at = buffer.indexOf("\n");
      while (at >= 0) {
        const line = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        if (line) yield line;
        at = buffer.indexOf("\n");
      }
    }
    if (buffer.trim()) yield buffer.trim();
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function readCompletion(parsed: z.infer<typeof ollamaReply>): Completion {
  // Ollama gives a call no id of its own, and a streamed reply brings each call in a chunk of its own, so every call
  // is given one that no other call in the task can share: a result goes back to the call that asked for it.
  const calls = (parsed.message.tool_calls ?? []).map((call) => ({
    id: `ollama-${randomUUID()}`,
    name: call.function.name,
    arguments: typeof call.function.arguments === "string" ? call.function.arguments : JSON.stringify(call.function.arguments),
  }));
  const input = parsed.prompt_eval_count, output = parsed.eval_count;
  return {
    content: parsed.message.content,
    toolCalls: calls,
    ...(parsed.message.thinking ? { reasoningChars: parsed.message.thinking.length } : {}),
    ...(input !== undefined || output !== undefined
      ? { usage: { input: Math.trunc(input ?? 0), output: Math.trunc(output ?? 0) } } : {}),
  };
}
