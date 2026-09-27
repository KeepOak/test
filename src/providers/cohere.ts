import { z } from "zod";
import type { Completion, CompletionRequest, Message, Provider, ToolCall } from "../contracts.js";
import { ProviderStreamError, estimateTokens } from "../contracts.js";
import { rejectedHttpResponse } from "../provider-retry.js";
import { readEventStream } from "../provider-stream.js";
import { readJsonBody, restoreToolNames, wireName } from "../providers.js";

/**
 * Cohere's second-generation chat route. It looks like OpenAI's at a glance, but the reply's words
 * arrive as a list of blocks rather than one string, and the token tally sits one level deeper, so
 * it gets an adapter of its own rather than being bent into the OpenAI shape.
 */
export interface CohereOptions {
  endpoint: string;
  model: string;
  apiKey: string;
  fetchImpl?: typeof globalThis.fetch;
}

const toolCall = z.object({
  id: z.string(),
  function: z.object({ name: z.string(), arguments: z.string() }),
}).loose();
const cohereResponse = z.object({
  message: z.object({
    content: z.array(z.object({ type: z.string(), text: z.string().optional() }).loose()).default([]),
    tool_calls: z.array(toolCall).optional(),
  }).loose(),
  usage: z.object({
    tokens: z.object({
      input_tokens: z.number().nonnegative().optional(),
      output_tokens: z.number().nonnegative().optional(),
    }).loose().optional(),
  }).loose().optional(),
}).loose();

/** One turn in Cohere's shape. Tool results are their own role, as with OpenAI. */
function cohereMessage(message: Message): Record<string, unknown> {
  if (message.role === "tool")
    return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
  if (message.toolCalls?.length)
    return {
      role: "assistant",
      ...(message.content ? { content: message.content } : {}),
      tool_calls: message.toolCalls.map((call: ToolCall) => ({
        id: call.id, type: "function", function: { name: wireName(call.name), arguments: call.arguments },
      })),
    };
  return { role: message.role, content: message.content };
}

export function cohereBody(request: CompletionRequest, model: string): Record<string, unknown> {
  return {
    model,
    max_tokens: request.maxTokens,
    ...(request.tools.length
      ? {
          tools: request.tools.map((tool) => ({
            type: "function",
            function: { name: wireName(tool.name), description: tool.description, parameters: tool.parameters },
          })),
        }
      : {}),
    messages: request.messages.map(cohereMessage),
  };
}

export class CohereProvider implements Provider {
  readonly name = "cohere";
  /** Cohere's command models take text only, so a picture is refused in words rather than dropped. */
  readonly acceptsImages = false;
  private readonly fetchImpl: typeof globalThis.fetch;
  /** The model this connection asks for (src/contracts.ts Provider.model). */
  get model(): string { return this.options.model; }
  constructor(private readonly options: CohereOptions) {
    if (!options.model || !options.apiKey) throw new Error("Cohere model and API key are required");
    const url = new URL(options.endpoint);
    if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
      throw new Error("Cohere endpoint requires HTTPS (HTTP is allowed only on loopback)");
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }
  audio(): null { return null; }
  images(): null { return null; }
  supportsImages(): boolean { return false; }
  /** The same address and key also serve `/embed`, which is how passages are compared. */
  embeddings(): { endpoint: string; apiKey: string } | null {
    return { endpoint: this.options.endpoint, apiKey: this.options.apiKey };
  }
  async complete(request: CompletionRequest): Promise<Completion> {
    const body = cohereBody(request, this.options.model);
    if (request.onTextDelta) return this.stream(request, body);
    const response = await this.post({ ...body, stream: false }, request.signal);
    return restoreToolNames(readCompletion(cohereResponse.parse(await readJsonBody(response))), request);
  }
  private async stream(request: CompletionRequest, body: Record<string, unknown>): Promise<Completion> {
    const state = new CohereStreamState(request.onTextDelta!);
    try {
      const response = await this.post({ ...body, stream: true }, request.signal);
      await readEventStream(response, (data) => state.consume(data));
    } catch (error) {
      throw new ProviderStreamError(error, estimateTokens(state.text), state.usage);
    }
    return restoreToolNames(state.result(), request);
  }
  private async post(body: unknown, signal: AbortSignal): Promise<Response> {
    const response = await this.fetchImpl(this.options.endpoint.replace(/\/$/, "") + "/chat", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${this.options.apiKey}` },
      body: JSON.stringify(body), signal, redirect: "error",
    });
    if (!response.ok) throw await rejectedHttpResponse(response, signal);
    if (!response.body) throw new Error("Provider returned empty body");
    return response;
  }
}

function readCompletion(parsed: z.infer<typeof cohereResponse>): Completion {
  const tokens = parsed.usage?.tokens;
  return {
    content: parsed.message.content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n"),
    toolCalls: (parsed.message.tool_calls ?? []).map((call) => ({
      id: call.id, name: call.function.name, arguments: call.function.arguments,
    })),
    ...(tokens ? { usage: { input: Math.trunc(tokens.input_tokens ?? 0), output: Math.trunc(tokens.output_tokens ?? 0) } } : {}),
  };
}

/** Cohere streams text events and finishes with one that carries the token tally. */
class CohereStreamState {
  text = "";
  usage: { input: number; output: number } | undefined;
  private readonly calls: ToolCall[] = [];
  private partial = new Map<number, { id: string; name: string; input: string }>();
  constructor(private readonly emit: (text: string) => void) {}
  consume(data: string): void {
    if (data === "[DONE]") return;
    const event = JSON.parse(data) as Record<string, any>;
    const delta = event.delta ?? {};
    if (event.type === "content-delta") {
      const text = delta.message?.content?.text;
      if (typeof text === "string" && text) { this.text += text; this.emit(text); }
    }
    if (event.type === "tool-call-start" && delta.message?.tool_calls)
      this.partial.set(Number(event.index ?? 0), {
        id: String(delta.message.tool_calls.id ?? ""), name: String(delta.message.tool_calls.function?.name ?? ""), input: "",
      });
    if (event.type === "tool-call-delta") {
      const block = this.partial.get(Number(event.index ?? 0));
      const chunk = delta.message?.tool_calls?.function?.arguments;
      if (block && typeof chunk === "string") block.input += chunk;
    }
    if (event.type === "tool-call-end") {
      const block = this.partial.get(Number(event.index ?? 0));
      if (block) { this.calls.push({ id: block.id, name: block.name, arguments: block.input || "{}" }); this.partial.delete(Number(event.index ?? 0)); }
    }
    if (event.type === "message-end" && delta.usage?.tokens)
      this.usage = { input: Math.trunc(delta.usage.tokens.input_tokens ?? 0), output: Math.trunc(delta.usage.tokens.output_tokens ?? 0) };
  }
  result(): Completion {
    return { content: this.text, toolCalls: this.calls, ...(this.usage ? { usage: this.usage } : {}) };
  }
}
