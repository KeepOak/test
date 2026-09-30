import type { ConnectOptions, NetworkPolicy } from "./network-policy.js";
import {
  SocketSession, fromBase64, textAt, toBase64,
  type RealtimeSettings, type RealtimeTool, type RealtimePlaybackItem,
} from "./realtime.js";

/**
 * A live conversation over OpenAI's Realtime connection. The words on the wire are OpenAI's own:
 * `session.update` to say which voice and which rules, `input_audio_buffer.append` for each chunk
 * of what the person is saying, `response.create` to ask for an answer, and `response.cancel` when
 * the person cuts in. Branch has been tried against a fake speaking those words, not against the
 * real service.
 */
export interface OpenAiRealtimeOptions {
  /** Where the service lives, usually https://api.openai.com/v1; turned into a wss address here. */
  endpoint: string;
  apiKey: string;
  runId?: string | null;
  /** Legacy preview models still use beta; gpt-realtime models use the GA session shape. */
  protocol?: "beta" | "ga";
}

/** OpenAI wants each tool as a flat entry with its schema under `parameters`. */
const asTool = (tool: RealtimeTool): Record<string, unknown> => ({
  type: "function", name: tool.name, description: tool.description.slice(0, 500), parameters: tool.parameters,
});

export class OpenAiRealtimeSession extends SocketSession {
  readonly service = "openai" as const;
  private cancelled = false;
  private responseActive = false;
  private responseId = "";
  private readonly retiredResponses = new Set<string>();
  private readonly audioBytes = new Map<string, number>();
  private get ga(): boolean { return this.options.protocol === "ga" ||
    (this.options.protocol !== "beta" && /^gpt-realtime(?:-|$)/.test(this.settings.model)); }
  constructor(policy: NetworkPolicy, settings: RealtimeSettings, private readonly options: OpenAiRealtimeOptions) {
    super(policy, settings);
  }
  protected address(): { url: string; connect: ConnectOptions } {
    const base = new URL(this.options.endpoint);
    const url = new URL("realtime", base.pathname.endsWith("/") ? base : new URL(base.href + "/"));
    url.protocol = base.protocol === "http:" ? "ws:" : "wss:";
    url.searchParams.set("model", this.settings.model);
    return {
      url: url.href,
      connect: {
        headers: { authorization: `Bearer ${this.options.apiKey}`, ...(this.ga ? {} : { "openai-beta": "realtime=v1" }) },
        what: "a live voice conversation with your model provider",
        runId: this.options.runId ?? null,
      },
    };
  }
  protected greet(): void {
    if (this.ga) { this.greetGa(); return; }
    this.send({
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions: this.settings.instructions.slice(0, 8000),
        ...(this.settings.voice ? { voice: this.settings.voice } : {}),
        input_audio_format: "pcm16",
        output_audio_format: "pcm16",
        input_audio_transcription: { model: "whisper-1" },
        turn_detection: this.settings.serverVoiceDetection ? { type: "server_vad" } : null,
        tools: this.settings.tools.map(asTool),
        tool_choice: "auto",
      },
    });
  }
  /** GA shape adapted from OpenClaw realtime-voice-session-policy.ts, 1794d8b4ef8 (MIT). */
  private greetGa(): void {
    this.send({ type: "session.update", session: {
      type: "realtime", model: this.settings.model, output_modalities: ["audio"],
      instructions: this.settings.instructions.slice(0, 8000),
      audio: {
        input: { format: { type: "audio/pcm", rate: 24000 }, transcription: { model: "whisper-1" },
          turn_detection: this.settings.serverVoiceDetection ? { type: "server_vad" } : null },
        output: { format: { type: "audio/pcm", rate: 24000 }, ...(this.settings.voice ? { voice: this.settings.voice } : {}) },
      },
      tools: this.settings.tools.map(asTool), tool_choice: "auto",
    } });
  }
  sendAudio(chunk: Uint8Array): void {
    this.send({ type: "input_audio_buffer.append", audio: toBase64(chunk) });
  }
  commit(): void {
    this.send({ type: "input_audio_buffer.commit" });
    this.send({ type: "response.create" });
  }
  sendText(text: string): void {
    this.send({
      type: "conversation.item.create",
      item: { type: "message", role: "user", content: [{ type: "input_text", text: text.slice(0, 4000) }] },
    });
    this.send({ type: "response.create" });
  }
  /** Bucket 17: a picture joins the conversation as an item; the person's next words ask about it. */
  sendImage(image: { mediaType: string; data: string }): void {
    this.send({
      type: "conversation.item.create",
      item: { type: "message", role: "user", content: [{ type: "input_image", image_url: `data:${image.mediaType};base64,${image.data}` }] },
    });
  }
  toolResult(callId: string, _name: string, result: unknown): void {
    this.send({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: callId, output: JSON.stringify(result).slice(0, 8000) },
    });
    this.send({ type: "response.create" });
  }
  /** Adapted from OpenClaw realtime-voice-protocol.ts (1794d8b4ef8, MIT).
   * Cancel output, truncate to the playback sink's actual clock, and preserve the person's input. */
  interrupt(playback: readonly RealtimePlaybackItem[] = []): void {
    this.cancelled = true;
    if (this.responseId) this.retiredResponses.add(this.responseId);
    if (this.retiredResponses.size > 32) this.retiredResponses.delete(this.retiredResponses.values().next().value!);
    if (this.responseActive) this.send({ type: "response.cancel" });
    this.responseActive = false;
    for (const item of playback) {
      const bytes = this.audioBytes.get(`${item.itemId}:${item.contentIndex}`);
      if (bytes === undefined) continue;
      this.send({ type: "conversation.item.truncate", item_id: item.itemId,
        content_index: item.contentIndex, audio_end_ms: Math.min(item.audioEndMs, Math.floor(bytes / 48)) });
    }
    this.audioBytes.clear();
  }
  protected receive(message: Record<string, unknown>): void {
    const type = textAt(message["type"]);
    if (type === "input_audio_buffer.speech_started") { this.onSpeechStarted(); return; }
    if (type === "response.created") {
      this.responseId = textAt((message["response"] as Record<string, unknown> | undefined)?.["id"]);
      this.cancelled = false;
      this.responseActive = true;
      return;
    }
    // Beta and GA names adapted from OpenClaw realtime-voice-events.ts, 1794d8b4ef8 (MIT).
    if (["response.audio.delta", "response.output_audio.delta", "conversation.output_audio.delta"].includes(type))
      { this.outputAudio(message); return; }
    if (type !== "response.done" && this.retiredResponses.has(textAt(message["response_id"]))) return;
    if (this.cancelled && type.startsWith("response.") && type !== "response.done") return;
    if (["response.audio_transcript.delta", "response.output_audio_transcript.delta", "response.text.delta",
      "response.output_text.delta", "conversation.output_transcript.delta"].includes(type))
      { this.onTranscript({ who: "assistant", text: textAt(message["delta"]), final: false }); return; }
    if (["response.audio_transcript.done", "response.output_audio_transcript.done", "response.text.done", "response.output_text.done"].includes(type))
      { this.onTranscript({ who: "assistant", text: textAt(message["transcript"]) || textAt(message["text"]), final: true }); return; }
    if (type === "conversation.item.input_audio_transcription.completed")
      { this.onTranscript({ who: "person", text: textAt(message["transcript"]), final: true }); return; }
    if (type === "response.function_call_arguments.done") {
      this.onToolCall({
        id: textAt(message["call_id"]) || textAt(message["item_id"]),
        name: textAt(message["name"]),
        arguments: textAt(message["arguments"]) || "{}",
      });
      return;
    }
    if (type === "response.done") {
      const response = message["response"] as Record<string, unknown> | undefined;
      if (!textAt(response?.["id"]) || textAt(response?.["id"]) === this.responseId) this.responseActive = false;
      this.readUsage(response); return;
    }
    if (type === "error") {
      const error = message["error"];
      this.onError(textAt((error as Record<string, unknown> | undefined)?.["message"]) || "The service reported a problem");
    }
  }
  private outputAudio(message: Record<string, unknown>): void {
    if (this.cancelled || this.retiredResponses.has(textAt(message["response_id"]))) return;
    const audio = fromBase64(textAt(message["delta"]) || textAt(message["data"]));
    this.responseActive = true;
    const itemId = textAt(message["item_id"]);
    const contentIndex = typeof message["content_index"] === "number" && Number.isInteger(message["content_index"])
      && message["content_index"] >= 0 ? message["content_index"] : 0;
    if (itemId) {
      const key = `${itemId}:${contentIndex}`;
      if (!this.audioBytes.has(key) && this.audioBytes.size >= 32) this.audioBytes.delete(this.audioBytes.keys().next().value!);
      this.audioBytes.set(key, (this.audioBytes.get(key) ?? 0) + audio.length);
    }
    this.onAudio(audio, itemId ? { itemId, contentIndex } : undefined);
  }
  private readUsage(response: unknown): void {
    const usage = (response as { usage?: Record<string, unknown> } | undefined)?.usage;
    if (!usage) return;
    const number = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
    this.onUsage({ inputTokens: number(usage["input_tokens"]), outputTokens: number(usage["output_tokens"]) });
  }
}
