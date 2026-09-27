import { z } from "zod";
import type { Completion, CompletionRequest, Message, Provider, ToolCall } from "../contracts.js";
import { ProviderStreamError, estimateTokens } from "../contracts.js";
import { rejectedHttpResponse } from "../provider-retry.js";
import { readEventStream } from "../provider-stream.js";
import { readJsonBody, restoreToolNames, serviceTierPart, wireName } from "../providers.js";

/**
 * OpenAI's newer Responses route. The conversation goes in as a list of items rather than as chat
 * messages, tool requests come back as items of their own, and the token tally is named
 * differently. The same key and the same address serve it.
 */
export interface ResponsesOptions {
  endpoint: string;
  model: string;
  apiKey: string;
  fetchImpl?: typeof globalThis.fetch;
  /** Where the route lives under the address; OpenAI's is `/responses`. */
  path?: string;
  /** A last change to the body, for a service that speaks this shape with its own small differences. */
  shapeBody?: (body: Record<string, unknown>) => Record<string, unknown>;
}

const outputItem = z.object({
  type: z.string(),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() }).loose()).optional(),
  call_id: z.string().optional(),
  id: z.string().optional(),
  name: z.string().optional(),
  arguments: z.string().optional(),
}).loose();
const responsesReply = z.object({
  output: z.array(outputItem).default([]),
  usage: z.object({
    input_tokens: z.number().nonnegative().optional(),
    output_tokens: z.number().nonnegative().optional(),
    input_tokens_details: z.object({ cached_tokens: z.number().nonnegative().optional() }).loose().optional(),
  }).loose().optional(),
}).loose();

function responsesItem(message: Message): Record<string, unknown>[] {
  if (message.role === "tool")
    return [{ type: "function_call_output", call_id: message.toolCallId, output: message.content }];
  const items: Record<string, unknown>[] = [];
  const kind = message.role === "assistant" ? "output_text" : "input_text";
  const parts: Record<string, unknown>[] = [];
  if (message.content) parts.push({ type: kind, text: message.content });
  for (const image of message.images ?? [])
    parts.push({ type: "input_image", image_url: `data:${image.mediaType};base64,${image.data}` });
  if (parts.length) items.push({ type: "message", role: message.role === "system" ? "system" : message.role, content: parts });
  for (const call of message.toolCalls ?? [])
    items.push({ type: "function_call", call_id: call.id, name: wireName(call.name), arguments: call.arguments });
  return items;
}

export function responsesBody(request: CompletionRequest, model: string): Record<string, unknown> {
  return {
    model,
    max_output_tokens: request.maxTokens,
    ...(request.reasoning ? { reasoning: { effort: request.reasoning } } : {}),
    ...(request.tools.length
      ? {
          tools: request.tools.map((tool) => ({
            type: "function", name: wireName(tool.name), description: tool.description, parameters: tool.parameters,
          })),
        }
      : {}),
    input: request.messages.flatMap(responsesItem),
  };
}

export class OpenAIResponsesProvider implements Provider {
  readonly name: string = "openai-responses";
  readonly acceptsImages = true;
  private readonly fetchImpl: typeof globalThis.fetch;
  /** The model this connection asks for (src/contracts.ts Provider.model). */
  get model(): string { return this.options.model; }
  constructor(private readonly options: ResponsesOptions) {
    if (!options.model || !options.apiKey) throw new Error("Provider model and API key are required");
    const url = new URL(options.endpoint);
    if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
      throw new Error("Provider endpoint requires HTTPS (HTTP is allowed only on loopback)");
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }
  audio(): { endpoint: string; apiKey: string } | null {
    return { endpoint: this.options.endpoint, apiKey: this.options.apiKey };
  }
  embeddings(): { endpoint: string; apiKey: string } | null {
    return { endpoint: this.options.endpoint, apiKey: this.options.apiKey };
  }
  images(): { kind: "openai"; endpoint: string; apiKey: string; defaultModel: string } | null {
    return { kind: "openai", endpoint: this.options.endpoint, apiKey: this.options.apiKey, defaultModel: "gpt-image-1" };
  }
  supportsImages(): boolean { return true; }
  async complete(request: CompletionRequest): Promise<Completion> {
    // R17-S12 (integration review): the faster or cheaper tier, only for OpenAI's own address or Azure.
    const plain = { ...responsesBody(request, this.options.model), ...serviceTierPart(this.options.endpoint, request.serviceTier) };
    const body = this.options.shapeBody ? this.options.shapeBody(plain) : plain;
    if (request.onTextDelta) return this.stream(request, body);
    const response = await this.post({ ...body, stream: false }, request.signal);
    return restoreToolNames(readCompletion(responsesReply.parse(await readJsonBody(response))), request);
  }
  private async stream(request: CompletionRequest, body: Record<string, unknown>): Promise<Completion> {
    const state = new ResponsesStreamState(request.onTextDelta!);
    try {
      const response = await this.post({ ...body, stream: true }, request.signal);
      await readEventStream(response, (data) => state.consume(data));
    } catch (error) {
      throw new ProviderStreamError(error, estimateTokens(state.text), state.usage);
    }
    return restoreToolNames(state.result(), request);
  }
  private async post(body: unknown, signal: AbortSignal): Promise<Response> {
    const response = await this.fetchImpl(this.options.endpoint.replace(/\/$/, "") + (this.options.path ?? "/responses"), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.options.apiKey}` },
      body: JSON.stringify(body), signal, redirect: "error",
    });
    if (!response.ok) throw await rejectedHttpResponse(response, signal);
    if (!response.body) throw new Error("Provider returned empty body");
    return response;
  }
}

function readCompletion(parsed: z.infer<typeof responsesReply>): Completion {
  const toolCalls: ToolCall[] = [];
  let content = "";
  for (const item of parsed.output) {
    if (item.type === "message")
      for (const part of item.content ?? [])
        if (part.type === "output_text" && part.text) content += (content ? "\n" : "") + part.text;
    if (item.type === "function_call")
      toolCalls.push({ id: item.call_id ?? item.id ?? "", name: item.name ?? "", arguments: item.arguments ?? "{}" });
  }
  const usage = parsed.usage;
  return {
    content, toolCalls,
    ...(usage
      ? {
          usage: {
            input: Math.trunc(usage.input_tokens ?? 0), output: Math.trunc(usage.output_tokens ?? 0),
            ...(usage.input_tokens_details?.cached_tokens !== undefined
              ? { cachedInput: Math.trunc(usage.input_tokens_details.cached_tokens) } : {}),
          },
        }
      : {}),
  };
}

class ResponsesStreamState {
  text = "";
  usage: { input: number; output: number } | undefined;
  private readonly calls: ToolCall[] = [];
  constructor(private readonly emit: (text: string) => void) {}
  consume(data: string): void {
    if (data === "[DONE]") return;
    const event = JSON.parse(data) as Record<string, any>;
    if (event.type === "response.output_text.delta" && typeof event.delta === "string" && event.delta) {
      this.text += event.delta;
      this.emit(event.delta);
    }
    if (event.type === "response.output_item.done" && event.item?.type === "function_call")
      this.calls.push({ id: String(event.item.call_id ?? event.item.id ?? ""), name: String(event.item.name ?? ""), arguments: String(event.item.arguments ?? "{}") });
    if (event.type === "response.completed" && event.response?.usage)
      this.usage = {
        input: Math.trunc(event.response.usage.input_tokens ?? 0),
        output: Math.trunc(event.response.usage.output_tokens ?? 0),
      };
  }
  result(): Completion {
    return { content: this.text, toolCalls: this.calls, ...(this.usage ? { usage: this.usage } : {}) };
  }
}
