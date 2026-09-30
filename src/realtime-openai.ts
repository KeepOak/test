import type { ConnectOptions, NetworkPolicy } from "./network-policy.js";
import {
  SocketSession, fromBase64, textAt, toBase64,
  type RealtimeSettings, type RealtimeTool,
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
  /** Cutting in stops the answer and throws away what was heard, so nothing is answered twice. */
  interrupt(): void {
    this.send({ type: "response.cancel" });
    this.send({ type: "input_audio_buffer.clear" });
  }
  protected receive(message: Record<string, unknown>): void {
    const type = textAt(message["type"]);
    // Beta and GA names adapted from OpenClaw realtime-voice-events.ts, 1794d8b4ef8 (MIT).
    if (["response.audio.delta", "response.output_audio.delta", "conversation.output_audio.delta"].includes(type))
      { this.onAudio(fromBase64(textAt(message["delta"]) || textAt(message["data"]))); return; }
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
    if (type === "response.done") { this.readUsage(message["response"]); return; }
    if (type === "error") {
      const error = message["error"];
      this.onError(textAt((error as Record<string, unknown> | undefined)?.["message"]) || "The service reported a problem");
    }
  }
  private readUsage(response: unknown): void {
    const usage = (response as { usage?: Record<string, unknown> } | undefined)?.usage;
    if (!usage) return;
    const number = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
    this.onUsage({ inputTokens: number(usage["input_tokens"]), outputTokens: number(usage["output_tokens"]) });
  }
}
