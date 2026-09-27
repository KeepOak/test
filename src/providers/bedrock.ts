import { z } from "zod";
import type { Completion, CompletionRequest, Message, Provider, ToolCall } from "../contracts.js";
import { ProviderStreamError, estimateTokens } from "../contracts.js";
import { rejectedHttpResponse } from "../provider-retry.js";
import { restoreToolNames, wireName } from "../providers.js";
import { AwsEventFraming } from "./aws-event-stream.js";
import { signRequest } from "./sigv4.js";

/**
 * Amazon Bedrock over its Converse route. Bedrock is the one service that does not take a key at
 * all: every request is signed with the owner's AWS keys, and the secret never leaves this
 * computer. Streaming arrives as Amazon's own binary frames rather than as text events.
 */
export interface BedrockOptions {
  /** https://bedrock-runtime.<region>.amazonaws.com */
  endpoint: string;
  model: string;
  region: string;
  accessKeyId: string;
  /** The AWS secret access key. Used to sign; never sent. */
  secretAccessKey: string;
  sessionToken?: string | undefined;
  fetchImpl?: typeof globalThis.fetch;
  now?: () => Date;
}

const contentBlock = z.union([
  z.object({ text: z.string() }).loose(),
  z.object({ toolUse: z.object({ toolUseId: z.string(), name: z.string(), input: z.unknown() }) }).loose(),
  z.object({}).loose(),
]);
const converseResponse = z.object({
  output: z.object({ message: z.object({ content: z.array(contentBlock).default([]) }).loose() }).loose(),
  usage: z.object({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative() }).loose().optional(),
}).loose();

const imageFormats: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpeg", "image/gif": "gif", "image/webp": "webp",
};

/** One turn as Bedrock wants it: words, pictures, tool requests and tool results all as blocks. */
function bedrockMessage(message: Message): Record<string, unknown> {
  if (message.role === "tool")
    return { role: "user", content: [{ toolResult: { toolUseId: message.toolCallId, content: [{ text: message.content }] } }] };
  const content: Record<string, unknown>[] = [];
  if (message.content) content.push({ text: message.content });
  for (const image of message.images ?? []) {
    const format = imageFormats[image.mediaType];
    if (format) content.push({ image: { format, source: { bytes: image.data } } });
  }
  for (const call of message.toolCalls ?? [])
    content.push({ toolUse: { toolUseId: call.id, name: wireName(call.name), input: JSON.parse(call.arguments) as unknown } });
  return { role: message.role === "assistant" ? "assistant" : "user", content };
}

/** The whole request body. Instructions travel separately from the conversation, as Bedrock asks. */
export function converseBody(request: CompletionRequest): Record<string, unknown> {
  const system = request.messages.filter((m) => m.role === "system").map((m) => ({ text: m.content }));
  const messages = mergeSameRole(request.messages.filter((m) => m.role !== "system").map(bedrockMessage));
  return {
    messages,
    ...(system.length ? { system } : {}),
    inferenceConfig: { maxTokens: request.maxTokens },
    ...(request.tools.length
      ? {
          toolConfig: {
            tools: request.tools.map((tool) => ({
              toolSpec: { name: wireName(tool.name), description: tool.description, inputSchema: { json: tool.parameters } },
            })),
          },
        }
      : {}),
  };
}
/** Bedrock refuses two turns in a row from the same side, so neighbours are folded together. */
function mergeSameRole(messages: Record<string, unknown>[]): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  for (const message of messages) {
    const previous = result.at(-1);
    if (previous && previous.role === message.role)
      (previous.content as unknown[]).push(...(message.content as unknown[]));
    else result.push({ ...message, content: [...(message.content as unknown[])] });
  }
  return result;
}

export class BedrockProvider implements Provider {
  readonly name = "bedrock";
  readonly acceptsImages = true;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly clock: () => Date;
  /** The model this connection asks for (src/contracts.ts Provider.model). */
  get model(): string { return this.options.model; }
  constructor(private readonly options: BedrockOptions) {
    if (!options.model || !options.secretAccessKey || !options.accessKeyId || !options.region)
      throw new Error("Bedrock needs a model, a region, an access key id and a secret access key");
    const url = new URL(options.endpoint);
    if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
      throw new Error("Bedrock endpoint requires HTTPS (HTTP is allowed only on loopback)");
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.clock = options.now ?? (() => new Date());
  }
  audio(): null { return null; }
  images(): null { return null; }
  supportsImages(): boolean { return true; }
  /** Bedrock lists what an account may use through a different service, so there is no list here. */
  modelsList(): null { return null; }

  private address(action: "converse" | "converse-stream"): URL {
    return new URL(`${this.options.endpoint.replace(/\/$/, "")}/model/${encodeURIComponent(this.options.model)}/${action}`);
  }
  private async send(action: "converse" | "converse-stream", body: unknown, signal: AbortSignal): Promise<Response> {
    const url = this.address(action), text = JSON.stringify(body);
    const signed = signRequest({
      method: "POST", url, body: text, region: this.options.region, service: "bedrock",
      accessKeyId: this.options.accessKeyId, secretAccessKey: this.options.secretAccessKey,
      sessionToken: this.options.sessionToken, now: this.clock(),
      headers: { "content-type": "application/json", accept: action === "converse" ? "application/json" : "application/vnd.amazon.eventstream" },
    });
    const response = await this.fetchImpl(url.toString(), { method: "POST", headers: signed.headers, body: text, signal, redirect: "error" });
    if (!response.ok) throw await rejectedHttpResponse(response, signal);
    if (!response.body) throw new Error("Provider returned empty body");
    return response;
  }
  async complete(request: CompletionRequest): Promise<Completion> {
    if (request.onTextDelta) return this.stream(request);
    const response = await this.send("converse", converseBody(request), request.signal);
    const parsed = converseResponse.parse(await response.json());
    return restoreToolNames(readCompletion(parsed), request);
  }
  private async stream(request: CompletionRequest): Promise<Completion> {
    const response = await this.send("converse-stream", converseBody(request), request.signal);
    const framing = new AwsEventFraming();
    const state = new ConverseStreamState(request.onTextDelta!);
    const reader = response.body!.getReader();
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        for (const event of framing.push(part.value)) state.consume(event.type, event.payload);
      }
      if (!framing.complete) throw new Error("Amazon's reply stopped part way through");
    } catch (error) {
      throw new ProviderStreamError(error, estimateTokens(state.text), state.usage);
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    return restoreToolNames(state.result(), request);
  }
}

function readCompletion(parsed: z.infer<typeof converseResponse>): Completion {
  const blocks = parsed.output.message.content as Record<string, unknown>[];
  const toolCalls: ToolCall[] = [];
  let content = "";
  for (const block of blocks) {
    if (typeof block.text === "string") content += (content ? "\n" : "") + block.text;
    const use = block.toolUse as { toolUseId: string; name: string; input: unknown } | undefined;
    if (use) toolCalls.push({ id: use.toolUseId, name: use.name, arguments: JSON.stringify(use.input ?? {}) });
  }
  return {
    content, toolCalls,
    ...(parsed.usage ? { usage: { input: parsed.usage.inputTokens, output: parsed.usage.outputTokens } } : {}),
  };
}

/** Puts a streamed reply back together from Amazon's frames: words, tool requests and the tally. */
class ConverseStreamState {
  text = "";
  usage: { input: number; output: number } | undefined;
  private readonly blocks = new Map<number, { id: string; name: string; input: string }>();
  private readonly calls: ToolCall[] = [];
  constructor(private readonly emit: (text: string) => void) {}
  consume(type: string, payload: unknown): void {
    const body = (payload ?? {}) as Record<string, any>;
    if (type === "contentBlockStart" && body.start?.toolUse)
      this.blocks.set(Number(body.contentBlockIndex ?? 0), { id: String(body.start.toolUse.toolUseId), name: String(body.start.toolUse.name), input: "" });
    if (type === "contentBlockDelta") {
      if (typeof body.delta?.text === "string" && body.delta.text) { this.text += body.delta.text; this.emit(body.delta.text); }
      const partial = body.delta?.toolUse?.input;
      const block = this.blocks.get(Number(body.contentBlockIndex ?? 0));
      if (typeof partial === "string" && block) block.input += partial;
    }
    if (type === "contentBlockStop") {
      const block = this.blocks.get(Number(body.contentBlockIndex ?? 0));
      if (block) { this.calls.push({ id: block.id, name: block.name, arguments: block.input || "{}" }); this.blocks.delete(Number(body.contentBlockIndex ?? 0)); }
    }
    if (type === "metadata" && body.usage)
      this.usage = { input: Number(body.usage.inputTokens ?? 0), output: Number(body.usage.outputTokens ?? 0) };
  }
  result(): Completion {
    return { content: this.text, toolCalls: this.calls, ...(this.usage ? { usage: this.usage } : {}) };
  }
}
