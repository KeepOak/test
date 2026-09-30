import { z } from "zod";
import type { Completion, CompletionRequest, Message, Provider, ToolCall, Usage } from "./contracts.js";
import { estimateTokens, ProviderStreamError } from "./contracts.js";
import { rejectedHttpResponse } from "./provider-retry.js";
import { readEventStream } from "./provider-stream.js";
import { restoreToolNames, wireName } from "./providers.js";
import { chatgptAccountId, chatgptDefaults, type ChatGPTAuth } from "./chatgpt-auth.js";
import { refuseSignInForTrunk } from "./accounts/context.js"; // mac7/lockdown-fix
import type { CodexImageEndpoint } from "./media-codex-images.js";
import { audioOnlySdp, chatgptCallUrl, ChatGPTRealtimeSession } from "./realtime-chatgpt.js";
import type { NetworkPolicy } from "./network-policy.js";
import type { RealtimeSession, RealtimeSettings } from "./realtime.js";

/** Models the ChatGPT subscription route serves; the first is the suggested default. */
export const chatgptModels = [
  // Checked against a real ChatGPT account on 2026-09-17: plain gpt-5.6 and gpt-5.4 are refused with
  // "not supported when using Codex with a ChatGPT account"; these four answer. On 2026-09-24 the account's own model
  // list (as the Codex CLI reads it) added the GPT-6 family, and GPT-6 Sol at medium is the owner's choice. GPT-6 Astra
  // is an explicit choice; src/chatgpt-presets.ts keeps it out of automatic fallbacks to preserve that spending choice.
  { id: "gpt-6-sol", label: "GPT-6 Sol", reasoning: "medium" },
  // On 2026-09-30 the account's model list added GPT-6.1 Sol ("latest workhorse"); offered next to the owner's default.
  { id: "gpt-6.1-sol", label: "GPT-6.1 Sol", reasoning: "medium" },
  { id: "gpt-6-luna", label: "GPT-6 Luna", reasoning: "medium" },
  { id: "gpt-5.6-sol", label: "GPT-5.6 Sol (light)", reasoning: "low" },
  { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", reasoning: "medium" },
  { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", reasoning: "medium" },
  { id: "gpt-5.5", label: "GPT-5.5", reasoning: "medium" },
  { id: "gpt-6-astra", label: "GPT-6 Astra", reasoning: "medium" },
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
  /**
   * The ChatGPT plan's models take pictures as the Codex app does (codex-rs core/src/client.rs: a user message's
   * `input_image` part with a data URL), so a screenshot pasted in the window is shown rather than kept unseen.
   */
  readonly acceptsImages = true;
  readonly realtimeTransport = "chatgpt-webrtc" as const;
  private readonly apiBase: string;
  private readonly userAgent: string;
  private readonly fetch: typeof fetch;
  /** The model this connection asks for (src/contracts.ts Provider.model). */
  get model(): string { return this.options.model; }
  constructor(private readonly auth: ChatGPTAuth, private readonly options: ChatGPTProviderOptions) {
    this.apiBase = (options.apiBase ?? chatgptDefaults.apiBase).replace(/\/$/, "");
    this.userAgent = options.userAgent ?? "BranchAgent";
    this.fetch = options.fetch ?? globalThis.fetch;
  }
  audio(): null {
    return null;
  }
  get signInImagesAvailable(): boolean { return this.apiBase === chatgptDefaults.apiBase; }
  /** The caller checks owner/source/account constraints before requesting this private route. */
  async signInImages(signal: AbortSignal): Promise<CodexImageEndpoint> {
    refuseSignInForTrunk(); signal.throwIfAborted();
    if (this.apiBase !== chatgptDefaults.apiBase) throw new Error("ChatGPT pictures cannot use a proxy or a different service address.");
    const token = await this.auth.accessToken();
    signal.throwIfAborted(); refuseSignInForTrunk();
    const accountId = chatgptAccountId(token);
    if (!accountId) throw new Error("The ChatGPT sign-in does not identify its account for making pictures.");
    return { endpoint: this.apiBase, token, accountId, originator: chatgptDefaults.originator, userAgent: this.userAgent };
  }
  supportsImages(): boolean { return true; }
  async realtime(policy: NetworkPolicy, settings: RealtimeSettings, offer: string, runId: string, signal: AbortSignal): Promise<RealtimeSession> {
    refuseSignInForTrunk();
    audioOnlySdp(offer);
    try {
      await policy.assertAllowed(new URL(chatgptCallUrl), "a ChatGPT live conversation");
      if (signal.aborted) throw new Error("Stopped");
      const token = await this.auth.accessToken();
      const accountId = chatgptAccountId(token);
      if (!accountId || signal.aborted) throw new Error("No selected account");
      return new ChatGPTRealtimeSession(policy, settings, { token, accountId, offer, runId, signal, fetch: this.fetch });
    } catch { throw new Error("The selected ChatGPT account could not open live voice."); }
  }
  async complete(request: CompletionRequest): Promise<Completion> {
    refuseSignInForTrunk(); // mac7/lockdown-fix: a ChatGPT sign-in answers a Trunk only for work the owner is behind
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
  if (message.role === "user") {
    const parts: Record<string, unknown>[] = [{ type: "input_text", text: message.content }];
    for (const image of message.images ?? [])
      parts.push({ type: "input_image", image_url: `data:${image.mediaType};base64,${image.data}` });
    return [{ role: "user", content: parts }];
  }
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
