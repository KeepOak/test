import { randomUUID } from "node:crypto";
import { z } from "zod";
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

export function ollamaBody(request: CompletionRequest, model: string): Record<string, unknown> {
  return {
    model,
    messages: request.messages.map(ollamaMessage),
    options: { num_predict: request.maxTokens },
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
  constructor(private readonly options: OllamaOptions) {
    if (!options.model) throw new Error("Ollama needs the name of a model that is installed here");
    const url = new URL(options.endpoint);
    if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
      throw new Error("Ollama endpoint requires HTTPS (HTTP is allowed only on loopback)");
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }
  /** The OpenAI-compatible side of the same service serves speech and embeddings. */
  audio(): { endpoint: string; apiKey: string } | null {
    return { endpoint: this.options.endpoint, apiKey: "local" };
  }
  embeddings(): { endpoint: string; apiKey: string } | null {
    return { endpoint: this.options.endpoint, apiKey: "local" };
  }
  images(): null { return null; }
  supportsImages(): boolean { return true; }
  modelsList(): { url: string; headers: Record<string, string> } | null {
    return { url: ollamaRoot(this.options.endpoint) + "/api/tags", headers: {} };
  }
  async complete(request: CompletionRequest): Promise<Completion> {
    const body = ollamaBody(request, this.options.model);
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
