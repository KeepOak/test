import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  Completion,
  CompletionRequest,
  Message,
  Provider,
  ToolCall,
  Usage,
} from "../contracts.js";
import { rejectedHttpResponse } from "../provider-retry.js";
import { readEventStream } from "../provider-stream.js";
import { wireName, restoreToolNames } from "../providers.js";
import { refuseSignInForTrunk } from "../accounts/context.js"; // mac7/lockdown-fix

interface GeminiOptions {
  endpoint: string;
  model: string;
  apiKey: string;
  /**
   * True when `apiKey` is a sign-in token from Google rather than an API key. A token goes in the
   * ordinary Authorization header; a key goes in the header Google documents for keys. Neither is
   * ever put in the address itself, where it would end up in logs.
   */
  bearer?: boolean;
  /** The fetch every request goes through; the factory supplies a guarded, watched one. */
  fetchImpl?: typeof globalThis.fetch | undefined;
}

function validateOptions(options: GeminiOptions): void {
  if (!options.model || !options.apiKey)
    throw new Error("Gemini model and API key are required");

  const url = new URL(options.endpoint);
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    )
  ) {
    throw new Error(
      "Gemini endpoint requires HTTPS (HTTP is allowed only on loopback)",
    );
  }
}

async function post(
  options: GeminiOptions,
  path: string,
  body: unknown,
  signal: AbortSignal,
  consume?: (data: string) => void,
): Promise<unknown> {
  const url = new URL(options.endpoint.replace(/\/$/, "") + path);
  const call = options.fetchImpl ?? globalThis.fetch;
  const response = await call(url.toString(), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-client": "gl-node/20.0 gapic/2.4.0",
      ...(options.bearer
        ? { authorization: `Bearer ${options.apiKey}` }
        : { "x-goog-api-key": options.apiKey }),
    },
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
 * Gemini matches a function's answer to its call by the function's name, so a tool result carries the name of the call
 * it answers: found by the call's id among the calls the model made earlier in the conversation.
 */
export function geminiMessages(messages: readonly Message[]): Record<string, unknown>[] {
  const names = new Map<string, string>();
  for (const message of messages) for (const call of message.toolCalls ?? []) names.set(call.id, call.name);
  return messages.map((message) => geminiMessage(message, message.toolCallId ? names.get(message.toolCallId) : undefined));
}
function geminiMessage(message: Message, calledName?: string): Record<string, unknown> {
  if (message.role === "tool") {
    return {
      role: "user",
      parts: [
        {
          functionResponse: {
            name: calledName ? wireName(calledName) : "unknown",
            response: { result: message.content },
          },
        },
      ],
    };
  }
  const parts: Record<string, unknown>[] = [];
  if (message.content) {
    parts.push({ text: message.content });
  }
  if (message.toolCalls) {
    for (const call of message.toolCalls) {
      parts.push({
        functionCall: {
          name: wireName(call.name),
          args: JSON.parse(call.arguments),
        },
      });
    }
  }
  return {
    role: message.role === "user" ? "user" : "model",
    parts,
  };
}

function geminiToolSchema(params: Record<string, unknown>): Record<string, unknown> {
  // Remove unsupported keywords that Gemini doesn't accept in JSON schema
  const clean = (obj: unknown): unknown => {
    if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return obj;
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (!["$schema", "additionalProperties", "id", "$id", "$comment"].includes(key)) {
        result[key] = clean(value);
      }
    }
    return result;
  };
  return clean(params) as Record<string, unknown>;
}

const geminiResponse = z.object({
  candidates: z
    .array(
      z.object({
        content: z.object({
          parts: z.array(
            z.union([
              z.object({ text: z.string() }),
              z.object({
                functionCall: z.object({
                  name: z.string(),
                  args: z.record(z.string(), z.unknown()).optional(),
                }),
              }),
            ]),
          ),
        }),
        finishReason: z.string().optional(),
      }),
    )
    .min(1),
  usageMetadata: z
    .object({
      promptTokenCount: z.number().int().nonnegative().optional(),
      candidatesTokenCount: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

export class GeminiProvider implements Provider {
  readonly name = "gemini";

  constructor(private readonly options: GeminiOptions) {
    validateOptions(options);
  }
  get model(): string { return this.options.model; }

  /**
   * Gemini writes speech out and reads text aloud through the same address, so the voice service
   * is handed the same details. `bearer` tells it which header to put the credential in.
   */
  audio(): { endpoint: string; apiKey: string; bearer: boolean } {
    return { endpoint: this.options.endpoint, apiKey: this.options.apiKey, bearer: this.options.bearer === true };
  }

  /** Gemini makes pictures through the same address, asking generateContent for an image. */
  images(): { kind: "gemini"; endpoint: string; apiKey: string; bearer: boolean; defaultModel: string } {
    return {
      kind: "gemini",
      endpoint: this.options.endpoint,
      apiKey: this.options.apiKey,
      bearer: this.options.bearer === true,
      defaultModel: "gemini-2.5-flash-image",
    };
  }

  async complete(request: CompletionRequest): Promise<Completion> {
    if (this.options.bearer) refuseSignInForTrunk(); // mac7/lockdown-fix: Gemini signed in with Google, only for work the owner is behind
    const systemInstruction = request.messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n");

    const userMessages = request.messages.filter((m) => m.role !== "system");
    const messages = geminiMessages(userMessages);

    const tools = request.tools.length
      ? [
          {
            functionDeclarations: request.tools.map((t) => ({
              name: wireName(t.name),
              description: t.description,
              parameters: geminiToolSchema(t.parameters),
            })),
          },
        ]
      : [];

    const body = {
      model: this.options.model,
      systemInstruction: systemInstruction || undefined,
      contents: messages,
      generationConfig: {
        maxOutputTokens: request.maxTokens,
        temperature: 1, // Gemini requires temperature for text generation
      },
      ...(tools.length ? { tools } : {}),
    };

    if (request.onTextDelta) {
      const stream = new GeminiStream(request.onTextDelta);
      try {
        await post(
          this.options,
          `/v1beta/models/${this.options.model}:streamGenerateContent`,
          body,
          request.signal,
          (data) => stream.consume(data),
        );
        return restoreToolNames(stream.result(), request);
      } catch (error) {
        throw stream.failure(error);
      }
    }

    const response = geminiResponse.parse(
      await post(
        this.options,
        `/v1beta/models/${this.options.model}:generateContent`,
        body,
        request.signal,
      ),
    );

    const candidate = response.candidates[0]!;
    const content = candidate.content.parts
      .filter((p) => "text" in p)
      .map((p) => (p as { text: string }).text)
      .join("\n");

    const toolCalls = candidate.content.parts
      .filter((p) => "functionCall" in p)
      .map((p) => {
        const fc = (p as { functionCall: { name: string; args?: Record<string, unknown> } })
          .functionCall;
        return {
          id: createHash("sha256").update(fc.name).digest("hex").slice(0, 24),
          name: fc.name,
          arguments: JSON.stringify(fc.args ?? {}),
        };
      });

    return {
      content,
      toolCalls,
      ...(response.usageMetadata
        ? {
            usage: {
              input: response.usageMetadata.promptTokenCount ?? 0,
              output: response.usageMetadata.candidatesTokenCount ?? 0,
            },
          }
        : {}),
    };
  }
}

class GeminiStream {
  private content = "";
  private calls = new Map<number, ToolCall>();
  private usage: Usage | undefined;
  private done = false;

  constructor(private readonly emit: (text: string) => void) {}

  consume(data: string): void {
    if (this.done) throw new Error("Provider sent data after stream completion");
    if (data === "[DONE]") {
      this.done = true;
      return;
    }

    const response = geminiResponse.parse(JSON.parse(data));
    if (response.usageMetadata) {
      this.usage = {
        input: response.usageMetadata.promptTokenCount ?? 0,
        output: response.usageMetadata.candidatesTokenCount ?? 0,
      };
    }

    const candidate = response.candidates[0];
    if (!candidate) return;

    for (let i = 0; i < candidate.content.parts.length; i++) {
      const part = candidate.content.parts[i]!;
      if ("text" in part) {
        const text = (part as { text: string }).text;
        this.content += text;
        this.emit(text);
      } else if ("functionCall" in part) {
        const fc = (part as { functionCall: { name: string; args?: Record<string, unknown> } })
          .functionCall;
        const call: ToolCall = {
          id: createHash("sha256").update(fc.name).digest("hex").slice(0, 24),
          name: fc.name,
          arguments: JSON.stringify(fc.args ?? {}),
        };
        this.calls.set(i, call);
      }
    }

    if (candidate.finishReason && ["STOP", "MAX_TOKENS", "FUNCTION_CALLING"].includes(candidate.finishReason)) {
      this.done = true;
    }
  }

  result(): Completion {
    if (!this.done) throw new Error("Provider stream ended without a complete response");
    return {
      content: this.content,
      toolCalls: [...this.calls].sort(([a], [b]) => a - b).map(([, call]) => call),
      ...(this.usage ? { usage: this.usage } : {}),
    };
  }

  failure(cause: unknown): Error {
    return new Error(`Gemini stream failed: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}
