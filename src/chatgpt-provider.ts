import { z } from "zod";
import type { Completion, CompletionRequest, Message, Provider, ToolCall, Usage } from "./contracts.js";
import { estimateTokens, ProviderStreamError } from "./contracts.js";
import { rejectedHttpResponse } from "./provider-retry.js";
import { readEventStream } from "./provider-stream.js";
import { restoreToolNames, wireName } from "./providers.js";
import { chatgptAccountId, chatgptDefaults, type ChatGPTAuth } from "./chatgpt-auth.js";
import { refuseSignInForTrunk } from "./accounts/context.js"; // mac7/lockdown-fix

/** Models the ChatGPT subscription route serves; the first is the suggested default. */
export const chatgptModels = [
  // Checked against a real ChatGPT account on 2026-09-17: plain gpt-5.6 and gpt-5.4 are refused with
  // "not supported when using Codex with a ChatGPT account"; these four answer. On 2026-09-24 the account's own model
  // list (as the Codex CLI reads it) added the GPT-6 family, and GPT-6 Sol at medium is the owner's choice. GPT-6 Astra
  // is left out on purpose: it spends the plan fastest, and every model here is also a fallback when one runs out.
  { id: "gpt-6-sol", label: "GPT-6 Sol", reasoning: "medium" },
  { id: "gpt-6-luna", label: "GPT-6 Luna", reasoning: "medium" },
  { id: "gpt-5.6-sol", label: "GPT-5.6 Sol (light)", reasoning: "low" },
  { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", reasoning: "medium" },
  { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", reasoning: "medium" },
  { id: "gpt-5.5", label: "GPT-5.5", reasoning: "medium" },
] as const;

export interface ChatGPTProviderOptions {
  model: string;
  apiBase?: string;
  userAgent?: string;
  fetch?: typeof fetch;
}
/** Responses API over the ChatGPT subscription backend. Requests always stream; Branch identifies itself. */
export class ChatGPTProvider implements Provider {
  readonly name = "chatgpt";
  private readonly apiBase: string;
  private readonly userAgent: string;
  private readonly fetch: typeof fetch;
  constructor(private readonly auth: ChatGPTAuth, private readonly options: ChatGPTProviderOptions) {
    this.apiBase = (options.apiBase ?? chatgptDefaults.apiBase).replace(/\/$/, "");
    this.userAgent = options.userAgent ?? "BranchAgent";
    this.fetch = options.fetch ?? globalThis.fetch;
  }
  audio(): null {
    return null;
  }
  async complete(request: CompletionRequest): Promise<Completion> {
    refuseSignInForTrunk(); // mac7/lockdown-fix: a ChatGPT sign-in never answers for a Trunk
    const stream = new ResponsesStream(request.onTextDelta ?? (() => {}), request.onReasoningDelta);
    try {
      const response = await this.send(request);
      await readEventStream(response, (data) => stream.consume(data));
      return restoreToolNames(stream.result(), request);
    } catch (error) {
      throw stream.failure(error);
    }
  }
  private async send(request: CompletionRequest): Promise<Response> {
    const token = await this.auth.accessToken();
    const accountId = chatgptAccountId(token);
    const response = await this.fetch(`${this.apiBase}/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "text/event-stream",
        originator: chatgptDefaults.originator,
        "user-agent": this.userAgent,
        ...(accountId ? { "chatgpt-account-id": accountId } : {}),
      },
      body: JSON.stringify(responsesBody(request, this.options.model)),
      signal: request.signal,
      redirect: "error",
    });
    if (!response.ok) throw await rejectedHttpResponse(response, request.signal);
    return response;
  }
}

export function responsesBody(request: CompletionRequest, model: string): Record<string, unknown> {
  const system = request.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
  return {
    model,
    instructions: system,
    input: request.messages.filter((m) => m.role !== "system").flatMap(inputItems),
    store: false,
    stream: true,
    ...(request.tools.length ? {
      tools: request.tools.map((t) => ({
        type: "function", name: wireName(t.name), description: t.description, parameters: t.parameters,
      })),
      tool_choice: "auto",
      parallel_tool_calls: true,
    } : {}),
    // Dogfood B1: a summary of the thinking is asked for too, so the owner can watch it think (when shown).
    ...(request.reasoning ? { reasoning: { effort: request.reasoning, summary: "auto" } } : {}),
  };
}
function inputItems(message: Message): Record<string, unknown>[] {
  if (message.role === "tool")
    return [{ type: "function_call_output", call_id: message.toolCallId, output: message.content }];
  if (message.role === "user")
    return [{ role: "user", content: [{ type: "input_text", text: message.content }] }];
  return [
    ...(message.content ? [{ role: "assistant", content: [{ type: "output_text", text: message.content }] }] : []),
    ...(message.toolCalls ?? []).map((call) => ({
      type: "function_call", call_id: call.id, name: wireName(call.name), arguments: call.arguments,
    })),
  ];
}

const count = z.number().int().nonnegative();
const responsesEvent = z.object({
  type: z.string(),
  delta: z.string().optional(),
  item: z.object({
    type: z.string(),
    call_id: z.string().optional(),
    name: z.string().optional(),
    arguments: z.string().optional(),
  }).passthrough().optional(),
  response: z.object({
    status: z.string().optional(),
    // mac7/speed: what the service's own prompt cache served. Every other provider in this product
    // reads this (src/providers.ts, src/providers/openai-responses.ts); this one did not, so a
    // round on the plan reported no cached tokens at all — `cachedInput` was null on all 185 rounds
    // of the five-way window, which reads as "nothing was cached" when what it meant was "nobody
    // looked". The field arrives either way; the outer object is `.passthrough()`, so it was simply
    // thrown away. Nothing about the request changes.
    usage: z.object({
      input_tokens: count, output_tokens: count,
      input_tokens_details: z.object({ cached_tokens: count.optional() }).loose().optional(),
    }).nullable().optional(),
    error: z.object({ message: z.string().optional() }).nullable().optional(),
    incomplete_details: z.object({ reason: z.string().optional() }).nullable().optional(),
  }).passthrough().optional(),
}).passthrough();

export class ResponsesStream {
  private content = "";
  private readonly calls: ToolCall[] = [];
  private usage: Usage | undefined;
  private completed = false;
  constructor(private readonly emit: (text: string) => void, private readonly think?: (text: string) => void) {}
  consume(data: string): void {
    if (data === "[DONE]") return;
    if (this.completed) throw new Error("Provider sent data after stream completion");
    const event = responsesEvent.parse(JSON.parse(data));
    switch (event.type) {
      case "response.output_text.delta":
        if (event.delta) { this.content += event.delta; this.emit(event.delta); }
        return;
      // Dogfood B1: the thinking's summary, as it is written; heard for the silence clock, shown when the owner shows it.
      case "response.reasoning_summary_text.delta":
        if (event.delta) this.think?.(event.delta);
        return;
      case "response.output_item.done":
        if (event.item?.type === "function_call")
          this.calls.push({ id: event.item.call_id ?? "", name: event.item.name ?? "", arguments: event.item.arguments ?? "{}" });
        return;
      case "response.completed":
        this.completed = true;
        if (event.response?.usage) {
          const said = event.response.usage;
          this.usage = { input: said.input_tokens, output: said.output_tokens,
            ...(said.input_tokens_details?.cached_tokens !== undefined
              ? { cachedInput: Math.trunc(said.input_tokens_details.cached_tokens) } : {}) };
        }
        return;
      case "response.failed":
        throw new Error(event.response?.error?.message || "ChatGPT reported a failed response");
      case "response.incomplete":
        throw new Error(`ChatGPT stopped early (${event.response?.incomplete_details?.reason ?? "unknown reason"})`);
      default:
        return;
    }
  }
  result(): Completion {
    if (!this.completed) throw new Error("Provider stream ended without a complete response");
    if (this.calls.some((call) => !call.id || !call.name)) throw new Error("Provider returned an incomplete tool call");
    return { content: this.content, toolCalls: this.calls, ...(this.usage ? { usage: this.usage } : {}) };
  }
  failure(cause: unknown): ProviderStreamError {
    const observed = this.content || this.calls.length;
    return new ProviderStreamError(cause, observed ? estimateTokens({ content: this.content, toolCalls: this.calls }) : 0, this.usage);
  }
}
