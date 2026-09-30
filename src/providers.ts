import { createHash } from "node:crypto";
import { openRouterBodyPart } from "./model-savings/openrouter.js"; // R17-046
import { z } from "zod";
import { ProviderStreamError } from "./contracts.js";
import type {
  BatchApi,
  Completion,
  CompletionRequest,
  Message,
  Provider,
  ToolCall,
} from "./contracts.js";
import { anthropicBatchApi, openaiBatchApi } from "./provider-batch.js";
import { DemoProvider, demoProviderName } from "./demo.js";
import { ProviderHttpError, rejectedHttpResponse } from "./provider-retry.js";
import { anthropicUsage, AnthropicUsageSchema } from "./anthropic-usage.js";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { onOwnNetwork } from "./network-policy.js";
import { AnthropicStream, OpenAIStream, readEventStream, thinkingText } from "./provider-stream.js";
import type { ModelPreset } from "./models.js";
export { GeminiProvider } from "./providers/gemini.js";

export interface ProviderOptions {
  endpoint: string;
  model: string;
  apiKey: string;
  /**
   * The fetch every request goes through. The factory hands in one wrapped by the owner's network
   * rules and by the health record, so a completion is checked and written down like anything else.
   */
  fetchImpl?: typeof globalThis.fetch | undefined;
  /** How a host name is looked up to decide how tools are named (see `wireRuleFor`); the system's own when left out. */
  lookupImpl?: NameLookup | undefined;
}
const usageNumber = z.number().int().nonnegative();
const openaiResponse = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullable().optional(),
          // mac7/empty-completion: the thinking a reasoning model returns beside its answer.
          // integrate/empty-completion: read loosely; only text counts (src/provider-stream.ts).
          reasoning_content: z.unknown().optional(),
          reasoning: z.unknown().optional(),
          tool_calls: z
            .array(
              z.object({
                id: z.string(),
                function: z.object({ name: z.string(), arguments: z.string() }),
              }),
            )
            .optional(),
        }),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: usageNumber,
      completion_tokens: usageNumber,
      /** OpenAI-shaped endpoints report their automatic prefix cache here when they have one. */
      prompt_tokens_details: z.object({ cached_tokens: usageNumber.optional() }).loose().optional(),
    })
    .optional(),
});
const anthropicResponse = z.object({
  content: z.array(
    z.discriminatedUnion("type", [
      z.object({ type: z.literal("text"), text: z.string() }),
      z.object({
        type: z.literal("tool_use"),
        id: z.string(),
        name: z.string(),
        input: z.record(z.string(), z.unknown()),
      }),
      // integrate/empty-completion: extended thinking, counted and never kept.
      z.object({ type: z.literal("thinking"), thinking: z.string().optional() }),
      z.object({ type: z.literal("redacted_thinking") }),
    ]),
  ),
  /** Tokens in and out, and what prompt caching wrote and read on this call (src/anthropic-usage.ts). */
  usage: AnthropicUsageSchema.optional(),
});
/**
 * How a tool's name travels to a model service. "cloud": a hash, which every service accepts. "local": the name the
 * model reads everywhere else (the tool index, the instructions, a search's answer), so a small model that calls
 * `files.read` calls a tool that is really there. Ollama drops a call whose name matches no offered tool and returns
 * an empty reply (QA Q066), so on a model running on this computer the readable name is what makes tools work at all.
 */
export type WireRule = "cloud" | "local";
// Every registered tool name fits this (src/registry.ts allows [a-z][a-z0-9_.-]{0,99}), so every tool travels under the
// very name the model reads in the index, the instructions and Branch's notes.
const readableWire = /^[A-Za-z_][A-Za-z0-9_.-]{0,99}$/;
/**
 * The tail a sanitised name ends with. Its capital X can never be in a registered name, and a name that already ends
 * like this never travels as itself, so a readable name and a sanitised one can never meet.
 */
const sanitisedTail = /_X[0-9a-f]{8}$/;
const digest = (name: string, length: number): string => createHash("sha256").update(name).digest("hex").slice(0, length);
export function wireName(name: string, rule: WireRule = "cloud"): string {
  if (rule === "cloud") return "branch_" + digest(name, 24);
  if (readableWire.test(name) && !sanitisedTail.test(name)) return name;
  // Anything else keeps what it can of the name and takes a short hash of the whole of it.
  const kept = name.replace(/[^A-Za-z0-9_.-]/g, "_").replace(/^([^A-Za-z_])/, "_$1").slice(0, 90);
  return `${kept}_X${digest(name, 8)}`;
}
/**
 * The mark on a call that names no tool the request offered. No tool can be registered under a name carrying it ("?"
 * and ":" are not allowed in one), so a marked call can never reach a tool; the runtime answers it instead.
 */
export const unofferedMark = "?unoffered:";
/**
 * The tool a model's call names, read strictly against the tools that request offered: its wire name, or the offered
 * tool's own name when the model wrote that instead. A name matching no offered tool, or more than one, comes back
 * marked (`unofferedMark`), so the runtime tells the model what it can call and runs nothing (see `Runtime.loop`).
 */
export function originalName(wire: string, request: Pick<CompletionRequest, "tools">, rule: WireRule = "cloud"): string {
  const byWire = request.tools.filter((t) => wireName(t.name, rule) === wire);
  if (byWire.length === 1) return byWire[0]!.name;
  const named = byWire.length ? undefined : request.tools.find((t) => t.name === wire);
  return named ? named.name : unofferedMark + wire.slice(0, 80);
}
/** Tailscale's addresses: 100.64.0.0/10 and its IPv6 block. Named here for tool naming only, never for reaching anything. */
const tailscaleRanges = new BlockList();
tailscaleRanges.addSubnet("100.64.0.0", 10, "ipv4");
tailscaleRanges.addSubnet("fd7a:115c:a1e0::", 48, "ipv6");
/** Names only a home or private network gives out: mDNS, Tailscale's MagicDNS and a home router's own. */
const homeSuffixes = [".local", ".ts.net", ".lan"];
/** Whether one address is this computer, the owner's own network or their Tailscale network. */
export function homeAddress(address: string): boolean {
  const host = address.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
  const kind = isIP(host);
  if (!kind) return false;
  return onOwnNetwork(host) || tailscaleRanges.check(host, kind === 4 ? "ipv4" : "ipv6");
}
export type NameLookup = (host: string) => Promise<string[]>;
const systemLookup: NameLookup = async (host) => (await lookup(host, { all: true })).map((entry) => entry.address);
/**
 * "local" for a model server at home: this computer, an address on the owner's own or Tailscale network, a name ending
 * in .local, .ts.net or .lan, or a name whose every address is one of those. "cloud" for anything public, and for a name
 * that cannot be looked up. This decides only how tools are named, never whether an address may be reached.
 */
export async function wireRuleFor(endpoint: string, resolve: NameLookup = systemLookup): Promise<WireRule> {
  let host: string;
  try { host = new URL(endpoint).hostname.replace(/^\[|\]$/g, "").toLowerCase(); } catch { return "cloud"; }
  if (homeAddress(host)) return "local";
  if (isIP(host)) return "cloud";
  if (homeSuffixes.some((suffix) => host.endsWith(suffix))) return "local";
  try {
    const addresses = await resolve(host);
    return addresses.length && addresses.every(homeAddress) ? "local" : "cloud";
  } catch {
    return "cloud";
  }
}
/**
 * Connections that refused readable tool names (a proxy on this computer that forwards to a cloud service, which allows
 * only [A-Za-z0-9_-]): by address and model, they get hashed names from then on. Kept while Branch runs; after a
 * restart the first refused request finds it again.
 */
const hashedOnly = new Set<string>();
/** Whether a refusal is about the tools' names, so the same request with hashed names may be tried once. */
export function refusedToolNames(error: unknown): boolean {
  const cause = error instanceof ProviderStreamError ? error.cause : error;
  return cause instanceof ProviderHttpError && (cause.status === 400 || cause.status === 422) && cause.aboutToolNames;
}
/**
 * The rule every provider address follows: HTTPS, or plain HTTP only on this computer or the owner's own network (QA
 * Q003: a model server at home; the network rules still decide whether it may be reached), and nothing extra in it.
 */
export function assertProviderEndpoint(endpoint: string): URL {
  const url = new URL(endpoint);
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || onOwnNetwork(url.hostname))
    )
  )
    throw new Error(
      "Provider endpoint requires HTTPS (HTTP is allowed only on loopback)",
    );
  if (url.username || url.password || url.hash)
    throw new Error(
      "Provider endpoint must not contain credentials or fragment",
    );
  // Allow api-version query parameter for Azure OpenAI only
  if (url.search && !url.hostname.endsWith(".openai.azure.com"))
    throw new Error(
      "Provider endpoint must not contain query string",
    );
  return url;
}
function validateOptions(options: ProviderOptions): void {
  assertProviderEndpoint(options.endpoint);
  if (!options.model || !options.apiKey)
    throw new Error("Provider model and API key are required");
}
/**
 * Whether a connection can be shown a picture. Providers say so themselves; anything that does
 * not answer is treated as text only, so a picture is refused in plain words rather than dropped.
 */
/**
 * The addresses known to take a whole set of questions at once. OpenAI's entry is also the gate for
 * `service_tier` (see `serviceTierPart`), so edit it with both in mind.
 */
export const openaiBatchHosts = ["api.openai.com", ".openai.azure.com"];
export const anthropicBatchHosts = ["api.anthropic.com"];
/**
 * Whether this address is one of them. An exact host, or a suffix when the entry begins with a dot,
 * so one Azure deployment of many matches without every other address matching too.
 */
export function offersBatch(endpoint: string, hosts: readonly string[]): boolean {
  let host: string;
  try { host = new URL(endpoint).host.toLowerCase(); } catch { return false; }
  return hosts.some((known) => (known.startsWith(".") ? host.endsWith(known) : host === known));
}

/**
 * R17-S12 / R17-045 (integration review): `service_tier` is OpenAI's own field. Only OpenAI's
 * address and Azure deployments of it are sent one; every other OpenAI-shaped service is not.
 */
export function serviceTierPart(endpoint: string, tier: CompletionRequest["serviceTier"]): { service_tier?: "priority" | "flex" } {
  return tier && offersBatch(endpoint, openaiBatchHosts) ? { service_tier: tier } : {};
}

export function supportsImages(provider: Provider): boolean {
  const said = provider as { supportsImages?: () => boolean; acceptsImages?: boolean };
  if (typeof said.supportsImages === "function") return said.supportsImages.call(provider) === true;
  return said.acceptsImages === true;
}
/** Address and key for a provider's other OpenAI-shaped routes, such as `/embeddings`. */
export interface EmbeddingEndpoint { endpoint: string; apiKey: string; fetchImpl?: typeof fetch }
/** The embeddings route of a provider that offers one; every other provider gives nothing. */
export function providerEmbeddings(provider: Provider): EmbeddingEndpoint | null {
  const accessor = (provider as { embeddings?: () => EmbeddingEndpoint | null }).embeddings;
  return typeof accessor === "function" ? accessor.call(provider) : null;
}
async function post(
  options: ProviderOptions,
  path: string,
  body: unknown,
  headers: Record<string, string>,
  signal: AbortSignal,
  consume?: (data: string) => void,
): Promise<unknown> {
  const call = options.fetchImpl ?? globalThis.fetch;
  const response = await call(options.endpoint.replace(/\/$/, "") + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal,
    redirect: "error",
  });
  if (!response.ok) {
    throw await rejectedHttpResponse(response, signal);
  }
  if (!response.body) throw new Error("Provider returned empty body");
  if (consume) return readEventStream(response, consume);
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 1048576) throw new Error("Provider response exceeds 1 MiB");
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}
/**
 * An OpenAI-shaped reply turned into a completion. Shared with the Azure adapter, which speaks the
 * same shape at a different address, so both read a reply exactly the same way.
 */
export function openaiCompletion(body: unknown, request: CompletionRequest, rule: WireRule = "cloud"): Completion {
  const response = openaiResponse.parse(body);
  const message = response.choices[0]!.message;
  return {
    content: message.content ?? "",
    toolCalls: (message.tool_calls ?? []).map((c) => ({
      id: c.id, name: originalName(c.function.name, request, rule), arguments: c.function.arguments,
    })),
    ...(response.usage
      ? {
          usage: {
            input: response.usage.prompt_tokens,
            output: response.usage.completion_tokens,
            ...(response.usage.prompt_tokens_details?.cached_tokens !== undefined
              ? { cachedInput: response.usage.prompt_tokens_details.cached_tokens }
              : {}),
          },
        }
      : {}),
  };
}
/** Reads a response body with a cap on its size, so one reply cannot fill this computer's memory. */
export async function readJsonBody(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("Provider returned empty body");
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 1048576) throw new Error("Provider response exceeds 1 MiB");
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}
/** OpenAI-shaped picture parts: a data URL alongside the text of the same message. */
function openaiContent(message: Message): unknown {
  if (!message.images?.length) return message.content;
  return [
    ...(message.content ? [{ type: "text", text: message.content }] : []),
    ...message.images.map((image) => ({
      type: "image_url",
      image_url: { url: `data:${image.mediaType};base64,${image.data}` },
    })),
  ];
}
function openaiMessage(message: Message, rule: WireRule = "cloud"): Record<string, unknown> {
  if (message.role === "tool")
    return {
      role: "tool",
      content: message.content,
      tool_call_id: message.toolCallId,
    };
  return {
    role: message.role,
    content: openaiContent(message),
    ...(message.toolCalls
      ? {
          tool_calls: message.toolCalls.map((c) => ({
            id: c.id,
            type: "function",
            function: { name: wireName(c.name, rule), arguments: c.arguments },
          })),
        }
      : {}),
  };
}
/** A turn with pictures becomes a list of parts: the words first, then each picture as a data URL. */
function openaiParts(message: Message): Record<string, unknown>[] {
  return [
    ...(message.content ? [{ type: "text", text: message.content }] : []),
    ...(message.images ?? []).map((image) => ({ type: "image_url", image_url: { url: `data:${image.mediaType};base64,${image.data}` } })),
  ];
}
export class OpenAIProvider implements Provider {
  readonly name = "openai-compatible";
  /** OpenAI-shaped endpoints take a picture as a data URL in the message. */
  readonly acceptsImages = true;
  /** Readable tool names for a model server at home, worked out once; see `wireRuleFor`. */
  private rule: Promise<WireRule> | undefined;
  constructor(private readonly options: ProviderOptions) {
    validateOptions(options);
  }
  private get refusedKey(): string { return `${this.options.endpoint}\u0000${this.options.model}`; }
  private async wireRule(): Promise<WireRule> {
    if (hashedOnly.has(this.refusedKey)) return "cloud";
    this.rule ??= wireRuleFor(this.options.endpoint, this.options.lookupImpl);
    return this.rule;
  }
  get model(): string { return this.options.model; }
  audio(): { endpoint: string; apiKey: string } | null {
    return { endpoint: this.options.endpoint, apiKey: this.options.apiKey };
  }
  /** This provider speaks the OpenAI shape, so the same address and key also serve `/embeddings`. */
  embeddings(): EmbeddingEndpoint | null {
    return { endpoint: this.options.endpoint, apiKey: this.options.apiKey };
  }
  /** The same address and key also serve `/images/generations` and `/images/edits`. */
  images(): { kind: "openai"; endpoint: string; apiKey: string; defaultModel: string } {
    return { kind: "openai", endpoint: this.options.endpoint, apiKey: this.options.apiKey, defaultModel: "gpt-image-1" };
  }
  /** The OpenAI shape carries pictures as message parts, so this connection can be shown one. */
  supportsImages(): boolean {
    return true;
  }
  /**
   * A whole set of questions at once, but only where the address really is OpenAI's own or an Azure
   * deployment of it. Plenty of services speak the OpenAI shape for ordinary questions without
   * having a set endpoint at all, and saying they do would only make every set fail and fall back.
   */
  batch(): BatchApi | null {
    return offersBatch(this.options.endpoint, openaiBatchHosts) ? openaiBatchApi(this.options) : null;
  }
  async complete(request: CompletionRequest): Promise<Completion> {
    const rule = await this.wireRule();
    try {
      return await this.completeAs(request, rule);
    } catch (error) {
      // A server that allows only [A-Za-z0-9_-] in a tool's name (a proxy to a cloud service): the same request once more
      // with hashed names, and hashed names for this connection from then on.
      if (rule !== "local" || !request.tools.length || !refusedToolNames(error)) throw error;
      hashedOnly.add(this.refusedKey);
      return this.completeAs(request, "cloud");
    }
  }
  private async completeAs(request: CompletionRequest, rule: WireRule): Promise<Completion> {
    // R17-046: OpenRouter company preferences, added only when this address is openrouter.ai.
    // R17-S12 (integration review): the tier goes only to OpenAI's own address or Azure.
    const { service_tier: _tier, ...plain } = openaiBody(request, this.options.model, rule);
    const body = { ...plain, ...serviceTierPart(this.options.endpoint, request.serviceTier),
      ...openRouterBodyPart(this.options.endpoint, request.providerRouting, this.options.model) };
    if (request.onTextDelta) {
      // mac7/empty-completion: thinking goes to its own listener, never to the page.
      const stream = new OpenAIStream(request.onTextDelta, request.onReasoningDelta);
      try {
        await post(this.options, "/chat/completions",
          { ...body, stream: true, stream_options: { include_usage: true } },
          { authorization: `Bearer ${this.options.apiKey}` }, request.signal,
          (data) => stream.consume(data));
        return restoreToolNames(stream.result(), request, rule);
      } catch (error) { throw stream.failure(error); }
    }
    const response = openaiResponse.parse(
      await post(
        this.options,
        "/chat/completions",
        body,
        { authorization: `Bearer ${this.options.apiKey}` },
        request.signal,
      ),
    );
    const message = response.choices[0]!.message;
    const thought = thinkingText(message.reasoning_content, message.reasoning).length;
    return {
      content: message.content ?? "",
      toolCalls: (message.tool_calls ?? []).map((c) => ({
        id: c.id,
        name: originalName(c.function.name, request, rule),
        arguments: c.function.arguments,
      })),
      ...(thought ? { reasoningChars: thought } : {}),
      ...(response.usage
        ? {
            usage: {
              input: response.usage.prompt_tokens,
              output: response.usage.completion_tokens,
              ...(response.usage.prompt_tokens_details?.cached_tokens !== undefined
                ? { cachedInput: response.usage.prompt_tokens_details.cached_tokens }
                : {}),
            },
          }
        : {}),
    };
  }
}
/**
 * OpenAI-shaped endpoints cache the longest matching prefix of a request automatically, so the
 * parts that do not change between rounds — the tools and the instructions — go first, and the
 * conversation, which grows every round, goes last.
 */
/**
 * OpenAI has a setting of its own for a fixed reply shape, so a declared shape is sent as the
 * service's `json_schema` response format and the model is genuinely constrained rather than
 * merely asked. `strict` is left off: it would require every property to be required and no extras
 * anywhere, which a shape written in zod need not be, and a refused request is worse than a reply
 * that has to be checked. The check afterwards runs either way.
 */
export function openaiBody(request: CompletionRequest, model: string, rule: WireRule = "cloud"): Record<string, unknown> {
  const shape = request.responseFormat;
  return {
    model,
    max_tokens: request.maxTokens,
    ...(shape ? { response_format: { type: "json_schema", json_schema: { name: shape.name, schema: shape.schema } } } : {}),
    ...(request.reasoning ? { reasoning_effort: request.reasoning } : {}),
    ...(request.serviceTier ? { service_tier: request.serviceTier } : {}), // R17-S12
    ...(request.tools.length ? {
      tools: request.tools.map((t) => ({
        type: "function",
        function: { name: wireName(t.name, rule), description: t.description, parameters: t.parameters },
      })),
    } : {}),
    messages: request.messages.map((message) => openaiMessage(message, rule)),
  };
}
function anthropicMessages(messages: Message[]): Record<string, unknown>[] {
  const result: { role: string; content: Record<string, unknown>[] }[] = [];
  for (const message of messages.filter((m) => m.role !== "system")) {
    const role = message.role === "tool" ? "user" : message.role;
    const content: Record<string, unknown>[] =
      message.role === "tool"
        ? [
            {
              type: "tool_result",
              tool_use_id: message.toolCallId,
              content: message.content,
            },
          ]
        : [
            ...(message.content
              ? [{ type: "text", text: message.content }]
              : []),
            ...(message.images ?? []).map((image) => ({
              type: "image",
              source: { type: "base64", media_type: image.mediaType, data: image.data },
            })),
            ...(message.toolCalls ?? []).map((c: ToolCall) => ({
              type: "tool_use",
              id: c.id,
              name: wireName(c.name),
              input: JSON.parse(c.arguments) as unknown,
            })),
          ];
    const previous = result.at(-1);
    if (previous?.role === role) previous.content.push(...content);
    else result.push({ role, content });
  }
  // selfdev/prompt-cache: the history up to the model's last answer is exactly what the next round sends again, so it
  // is marked too (tools, instructions and this: three of Claude's four marks). Each round then reads the one before
  // from the cache and pays in full only for what is new since.
  const answered = result.findLastIndex((message, at) => message.role === "assistant" && at < result.length - 1);
  const last = answered < 0 ? undefined : result[answered]!.content.at(-1);
  if (last) Object.assign(last, cacheMarker);
  return result;
}
export class AnthropicProvider implements Provider {
  readonly name: string = "anthropic";
  /** Claude models take a picture as a base64 image block. */
  readonly acceptsImages = true;
  constructor(private readonly options: ProviderOptions) {
    validateOptions(options);
  }
  get model(): string { return this.options.model; }
  audio(): null {
    return null;
  }
  /** Anthropic has no picture-making route, so the media tools refuse in plain words instead. */
  images(): null {
    return null;
  }
  /** Anthropic messages carry pictures as base64 image blocks, so this connection can be shown one. */
  supportsImages(): boolean {
    return true;
  }
  /** A whole set of questions at once, where the address really is Anthropic's own. */
  batch(): BatchApi | null {
    return offersBatch(this.options.endpoint, anthropicBatchHosts) ? anthropicBatchApi(this.options) : null;
  }
  async complete(request: CompletionRequest): Promise<Completion> {
    const body = anthropicBody(request, this.options.model);
    if (request.onTextDelta) {
      const stream = new AnthropicStream(request.onTextDelta, request.onReasoningDelta);
      try {
        await post(this.options, "/messages", { ...body, stream: true },
          { "x-api-key": this.options.apiKey, "anthropic-version": "2023-06-01" },
          request.signal, (data) => stream.consume(data));
        return restoreToolNames(stream.result(), request);
      } catch (error) { throw stream.failure(error); }
    }
    const response = anthropicResponse.parse(
      await post(
        this.options,
        "/messages",
        body,
        { "x-api-key": this.options.apiKey, "anthropic-version": "2023-06-01" },
        request.signal,
      ),
    );
    return {
      content: response.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n"),
      toolCalls: response.content
        .filter((c) => c.type === "tool_use")
        .map((c) => ({
          id: c.id,
          name: originalName(c.name, request),
          arguments: JSON.stringify(c.input),
        })),
      ...anthropicThought(response.content),
      // The cache reads and writes are part of what the call used; Anthropic counts them apart from input_tokens.
      ...(response.usage ? { usage: anthropicUsage(response.usage) } : {}),
    };
  }
}
const thinkingBudgets = { low: 1024, medium: 4096, high: 8192 } as const;
/** integrate/empty-completion: how much a non-streamed reply thought. The thinking itself is dropped. */
function anthropicThought(content: z.infer<typeof anthropicResponse>["content"]): { reasoningChars?: number } {
  const chars = content.reduce((sum, block) => sum + (block.type === "thinking" ? (block.thinking ?? "").length : 0), 0);
  return chars ? { reasoningChars: chars } : {};
}
/**
 * integrate/empty-completion: Anthropic refuses a request with thinking on whose last assistant
 * turn used a tool without the signed thinking block that preceded it. Branch never keeps the
 * thinking, so it cannot send it back; a round that continues a tool loop asks for no thinking.
 */
function continuesToolLoop(messages: Message[]): boolean {
  const last = [...messages].reverse().find((message) => message.role === "assistant");
  return Boolean(last?.toolCalls?.length);
}
/** Anthropic extended thinking needs a budget of at least 1024 tokens below max_tokens; otherwise it is omitted. */
function anthropicThinking(request: CompletionRequest): Record<string, unknown> {
  if (!request.reasoning || continuesToolLoop(request.messages)) return {};
  const budget = Math.min(thinkingBudgets[request.reasoning], request.maxTokens - 256);
  return budget >= 1024 ? { thinking: { type: "enabled", budget_tokens: budget } } : {};
}
/** Marks a block as the end of the part of the request that stays the same from round to round. */
const cacheMarker = { cache_control: { type: "ephemeral" } } as const;
/**
 * Claude caches a request's prefix in the order tools, then instructions, then the conversation, so
 * the body is written in that order and the two stable parts are marked. Rounds after the first are
 * billed as cache reads instead of a fresh copy of the whole catalog.
 */
/**
 * Anthropic has no response-format setting. Its own way of fixing a reply's shape is a tool the
 * model is made to call, so a declared shape is sent as exactly that: one tool holding the shape,
 * and `tool_choice` naming it. That only works when the request carries no other tools, which is
 * true of the shaped pass — it runs with no permissions, so the catalog is empty. A request that
 * does have tools keeps them and falls back to asking in words; see src/answer-shape.ts.
 */
export function anthropicBody(request: CompletionRequest, model: string): Record<string, unknown> {
  const instructions = request.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
  const shape = request.tools.length ? undefined : request.responseFormat;
  const tools = shape
    ? [{ name: shape.name, description: "Give your answer by calling this with the fields it asks for.", input_schema: shape.schema, ...cacheMarker }]
    : request.tools.map((t, at) => ({
        name: wireName(t.name), description: t.description, input_schema: t.parameters,
        ...(at === request.tools.length - 1 ? cacheMarker : {}),
      }));
  return {
    model,
    max_tokens: request.maxTokens,
    ...anthropicThinking(request),
    // R17-S12: Claude's own word for "use the faster tier when there is room"; it has no flex tier.
    // "auto" is also Anthropic's documented default (platform.claude.com/docs/en/api/service-tiers,
    // read 2026-09-17), so this never asks for more than an unmarked request would.
    ...(request.serviceTier === "priority" ? { service_tier: "auto" } : {}),
    tools,
    ...(shape ? { tool_choice: { type: "tool", name: shape.name } } : {}),
    ...(instructions ? { system: [{ type: "text", text: instructions, ...cacheMarker }] } : {}),
    messages: anthropicMessages(request.messages),
  };
}
export function restoreToolNames(completion: Completion, request: CompletionRequest, rule: WireRule = "cloud"): Completion {
  return {
    ...completion,
    toolCalls: completion.toolCalls.map((call) => ({ ...call, name: originalName(call.name, request, rule) })),
  };
}
/**
 * The connection named by BRANCH_PROVIDER, or null when none is named: then no model is set up, and the model router
 * refuses every request in plain words until one is added (src/no-model.ts). "demo" is the scripted test fixture
 * (src/demo.ts); only a test names it, and nothing ever falls back to it.
 */
export function providerFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Provider | null {
  const kind = env.BRANCH_PROVIDER;
  if (!kind) return null;
  if (kind === "demo") return new DemoProvider();
  if (kind !== "openai" && kind !== "anthropic")
    throw new Error("BRANCH_PROVIDER must be openai or anthropic");
  const required = [
    "BRANCH_ENDPOINT",
    "BRANCH_MODEL",
    "BRANCH_API_KEY",
  ] as const;
  for (const key of required)
    if (!env[key]) throw new Error(`${key} is required for a real provider`);
  const options = {
    endpoint: env.BRANCH_ENDPOINT!,
    model: env.BRANCH_MODEL!,
    apiKey: env.BRANCH_API_KEY!,
  };
  return kind === "openai"
    ? new OpenAIProvider(options)
    : new AnthropicProvider(options);
}

const presetEnvSchema = z.array(z.object({
  id: z.string().min(1).max(64),
  name: z.string().trim().min(1).max(80),
  provider: z.enum(["demo", "openai", "anthropic"]),
  endpoint: z.string().max(2048).optional(),
  model: z.string().max(256).optional(),
  apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/).optional(),
  reasoning: z.enum(["low", "medium", "high"]).optional(),
}).strict()).min(1).max(16);
/**
 * Named presets from BRANCH_MODEL_PRESETS (JSON). Keys are read from the named environment variable
 * and never stored. The first entry is the default. Without the variable, the single configured
 * provider becomes the only preset, and with none configured there are no presets at all.
 */
export function presetsFromEnv(env: NodeJS.ProcessEnv = process.env): ModelPreset[] {
  if (!env.BRANCH_MODEL_PRESETS) {
    const provider = providerFromEnv(env);
    return provider ? [defaultPreset(provider, env.BRANCH_MODEL)] : [];
  }
  let parsed: unknown;
  try { parsed = JSON.parse(env.BRANCH_MODEL_PRESETS); } catch { throw new Error("BRANCH_MODEL_PRESETS must be JSON"); }
  return presetEnvSchema.parse(parsed).map((entry) => {
    const provider = providerFromEnv({
      BRANCH_PROVIDER: entry.provider, BRANCH_ENDPOINT: entry.endpoint, BRANCH_MODEL: entry.model,
      BRANCH_API_KEY: entry.apiKeyEnv ? env[entry.apiKeyEnv] : undefined,
    })!;
    return { id: entry.id, name: entry.name, provider, model: entry.model ?? "demo",
      ...(entry.reasoning ? { reasoning: entry.reasoning } : {}) };
  });
}
/** What a preset is called when no model was named for it (`defaultPreset`): never shown as a model's name. */
export const unnamedModels: ReadonlySet<string> = new Set(["configured", "demo"]);
export function defaultPreset(provider: Provider, model?: string): ModelPreset {
  const fixture = provider.name === demoProviderName;
  return { id: "default", name: fixture ? "Test fixture" : "Default connection",
    provider, model: model ?? provider.model ?? (fixture ? "demo" : "configured") };
}
