import type { ConnectOptions, NetworkPolicy } from "./network-policy.js";
import {
  SocketSession, fromBase64, textAt, toBase64,
  type RealtimeSettings, type RealtimeTool,
} from "./realtime.js";

/**
 * A live conversation over Gemini's BidiGenerateContent connection. Gemini's words for the same
 * things: `setup` first, `realtimeInput` for each chunk of sound, `clientContent` for a line typed
 * mid-conversation, `toolResponse` for what one of Branch's tools did. Gemini takes its key in the
 * address rather than a header, which is why nothing anywhere writes a whole address down.
 */
export interface GeminiLiveOptions {
  /** The service's ordinary https address; turned into a wss address here. */
  endpoint: string;
  apiKey: string;
  runId?: string | null;
}

const bidiPath = "/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
/** Gemini wants the tools grouped under one entry, each with its schema under `parameters`. */
const asTools = (tools: RealtimeTool[]): Record<string, unknown>[] =>
  tools.length ? [{ functionDeclarations: tools.map((tool) => ({
    name: tool.name, description: tool.description.slice(0, 500), parameters: tool.parameters,
  })) }] : [];

export class GeminiLiveSession extends SocketSession {
  readonly service = "gemini" as const;
  constructor(policy: NetworkPolicy, settings: RealtimeSettings, private readonly options: GeminiLiveOptions) {
    super(policy, settings);
  }
  protected address(): { url: string; connect: ConnectOptions } {
    const base = new URL(this.options.endpoint);
    const url = new URL(bidiPath, base);
    url.protocol = base.protocol === "http:" ? "ws:" : "wss:";
    url.searchParams.set("key", this.options.apiKey);
    return {
      url: url.href,
      connect: { what: "a live voice conversation with Gemini", runId: this.options.runId ?? null },
    };
  }
  protected greet(): void {
    this.send({
      setup: {
        model: this.settings.model.startsWith("models/") ? this.settings.model : `models/${this.settings.model}`,
        generationConfig: {
          responseModalities: ["AUDIO"],
          ...(this.settings.voice
            ? { speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: this.settings.voice } } } }
            : {}),
        },
        systemInstruction: { parts: [{ text: this.settings.instructions.slice(0, 8000) }] },
        ...(this.settings.tools.length ? { tools: asTools(this.settings.tools) } : {}),
        realtimeInputConfig: {
          automaticActivityDetection: this.settings.serverVoiceDetection ? {} : { disabled: true },
        },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
      },
    });
  }
  sendAudio(chunk: Uint8Array): void {
    this.send({ realtimeInput: { mediaChunks: [{ mimeType: "audio/pcm;rate=16000", data: toBase64(chunk) }] } });
  }
  /** With Gemini's own listening switched off, Branch says when the person stopped speaking. */
  commit(): void {
    if (!this.settings.serverVoiceDetection) this.send({ realtimeInput: { activityEnd: {} } });
  }
  sendText(text: string): void {
    this.send({ clientContent: { turns: [{ role: "user", parts: [{ text: text.slice(0, 4000) }] }], turnComplete: true } });
  }
  /** Bucket 17: a picture goes up the same live input as the sound, as one video frame. */
  sendImage(image: { mediaType: string; data: string }): void {
    this.send({ realtimeInput: { video: { mimeType: image.mediaType, data: image.data } } });
  }
  toolResult(callId: string, name: string, result: unknown): void {
    this.send({ toolResponse: { functionResponses: [{ id: callId, name, response: { result } }] } });
  }
  /**
   * Cutting in: Gemini is told the person has started speaking again, which ends the turn it was
   * in the middle of. Gemini also reports this itself as `serverContent.interrupted`.
   */
  interrupt(): void {
    this.send({ realtimeInput: { activityStart: {} } });
  }
  protected receive(message: Record<string, unknown>): void {
    if (message["setupComplete"]) return;
    if (message["toolCall"]) { this.readToolCalls(message["toolCall"]); return; }
    if (message["usageMetadata"]) this.readUsage(message["usageMetadata"]);
    const content = message["serverContent"] as Record<string, unknown> | undefined;
    if (!content) return;
    if (content["interrupted"]) { this.onSpeechStarted(); return; }
    const input = content["inputTranscription"] as { text?: unknown } | undefined;
    if (input) this.onTranscript({ who: "person", text: textAt(input.text), final: Boolean(content["turnComplete"]) });
    const output = content["outputTranscription"] as { text?: unknown } | undefined;
    if (output) this.onTranscript({ who: "assistant", text: textAt(output.text), final: Boolean(content["turnComplete"]) });
    this.readTurn(content["modelTurn"]);
  }
  private readTurn(turn: unknown): void {
    const parts = (turn as { parts?: unknown[] } | undefined)?.parts;
    if (!Array.isArray(parts)) return;
    for (const part of parts as Record<string, unknown>[]) {
      const inline = part["inlineData"] as { data?: unknown } | undefined;
      if (inline && typeof inline.data === "string") this.onAudio(fromBase64(inline.data));
      else if (typeof part["text"] === "string") this.onTranscript({ who: "assistant", text: part["text"], final: false });
    }
  }
  private readToolCalls(value: unknown): void {
    const calls = (value as { functionCalls?: unknown[] } | undefined)?.functionCalls;
    if (!Array.isArray(calls)) return;
    for (const call of calls as Record<string, unknown>[])
      this.onToolCall({
        id: textAt(call["id"]) || textAt(call["name"]),
        name: textAt(call["name"]),
        arguments: JSON.stringify(call["args"] ?? {}),
      });
  }
  private readUsage(value: unknown): void {
    const usage = value as Record<string, unknown>;
    const number = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    this.onUsage({
      inputTokens: number(usage["promptTokenCount"]),
      outputTokens: number(usage["responseTokenCount"]) || number(usage["candidatesTokenCount"]),
    });
  }
}
