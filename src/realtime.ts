import type { ConnectOptions, NetworkPolicy } from "./network-policy.js";

/**
 * A live conversation with a model: sound goes up while it is being spoken and comes back while it
 * is being said, rather than a recording being sent off and an answer waited for. Two services
 * offer this and they speak different words for the same things, so everything below is written in
 * Branch's own words and each service's adapter translates.
 *
 * Nothing here opens a microphone, plays a sound, or stores one. Sound arrives as chunks of PCM16
 * and leaves the same way; whoever holds the session decides where it goes.
 */

/** A piece of what was said, by one side or the other. `final` marks the end of a sentence. */
export interface TranscriptPart {
  who: "person" | "assistant";
  text: string;
  final: boolean;
}
/** Something the model wants one of Branch's tools to do, mid-conversation. */
export interface RealtimeToolCall {
  id: string;
  name: string;
  /** The arguments exactly as the model wrote them, still JSON text. */
  arguments: string;
}
/** What a turn cost, as the service reports it. Zeroes when it reports nothing. */
export interface RealtimeUsage {
  inputTokens: number;
  outputTokens: number;
}
/** One tool the model may ask for, in Branch's own words; each adapter puts it in its own shape. */
export interface RealtimeTool {
  name: string;
  description: string;
  /** A JSON Schema object, as the tool registry already produces for the ordinary loop. */
  parameters: Record<string, unknown>;
}
export interface RealtimeSettings {
  model: string;
  /** The voice the owner chose, or empty for the service's usual one. */
  voice: string;
  /** The standing rules the owner set, which the model is told before anything else. */
  instructions: string;
  /** Let the service decide when the person has stopped speaking. Off means Branch says when. */
  serverVoiceDetection: boolean;
  tools: RealtimeTool[];
}

export interface RealtimeAudioItem { itemId: string; contentIndex: number }
export interface RealtimePlaybackItem extends RealtimeAudioItem { audioEndMs: number }

/**
 * What a live conversation can do, whichever service is behind it. The names are the plain ones: a
 * person speaks (`sendAudio`), types (`sendText`), cuts in (`interrupt`) or stops (`close`).
 */
export interface RealtimeSession {
  readonly service: "openai" | "gemini";
  open(): Promise<void>;
  /** One chunk of what the person is saying, as PCM16 at 16kHz. */
  sendAudio(chunk: Uint8Array): void;
  /** The person has stopped speaking. Only needed when the service is not listening for silence. */
  commit(): void;
  /** A line typed mid-conversation, which the model answers in the same voice. */
  sendText(text: string): void;
  /** Bucket 17: a picture shown mid-conversation (a still from a camera, a screenshot). Base64. */
  sendImage?(image: { mediaType: string; data: string }): void;
  /** What one of Branch's tools did, handed back so the model can carry on. */
  toolResult(callId: string, name: string, result: unknown): void;
  /** Stop talking now: the answer is cancelled and whatever was heard so far is thrown away. */
  interrupt(playback?: readonly RealtimePlaybackItem[]): void;
  close(reason?: string): void;
  onTranscript: (part: TranscriptPart) => void;
  onAudio: (pcm16: Uint8Array, item?: RealtimeAudioItem) => void;
  onSpeechStarted?: () => void;
  onToolCall: (call: RealtimeToolCall) => void;
  onUsage: (usage: RealtimeUsage) => void;
  onClosed: (reason: string) => void;
  onError: (message: string) => void;
}

/**
 * The half of a session that is the same for both services: holding the connection open, sending
 * JSON down it, and reading JSON back off it. Each service fills in the three blanks below.
 */
export abstract class SocketSession implements RealtimeSession {
  abstract readonly service: "openai" | "gemini";
  protected socket: WebSocket | null = null;
  onTranscript: (part: TranscriptPart) => void = () => undefined;
  onAudio: (pcm16: Uint8Array, item?: RealtimeAudioItem) => void = () => undefined;
  onSpeechStarted: () => void = () => undefined;
  onToolCall: (call: RealtimeToolCall) => void = () => undefined;
  onUsage: (usage: RealtimeUsage) => void = () => undefined;
  onClosed: (reason: string) => void = () => undefined;
  onError: (message: string) => void = () => undefined;

  constructor(
    protected readonly policy: NetworkPolicy,
    protected readonly settings: RealtimeSettings,
  ) {}

  /** The address and headers this service wants, and what is said about the connection. */
  protected abstract address(): { url: string; connect: ConnectOptions };
  /** Whatever has to be said first: which voice, which rules, which tools. */
  protected abstract greet(): void;
  /** One message from the service, already parsed. */
  protected abstract receive(message: Record<string, unknown>): void;

  async open(): Promise<void> {
    const { url, connect } = this.address();
    const socket = await this.policy.connect(url, connect);
    this.socket = socket;
    socket.addEventListener("message", (event: MessageEvent) => this.read(event.data));
    socket.addEventListener("close", (event: CloseEvent) => {
      this.socket = null;
      this.onClosed(event.reason || "The connection closed");
    });
    socket.addEventListener("error", () => this.onError("The live connection had a problem"));
    if (socket.readyState !== 1) await once(socket, "open");
    this.greet();
  }
  private read(data: unknown): void {
    const text = typeof data === "string" ? data
      : data instanceof ArrayBuffer ? Buffer.from(data).toString("utf8")
      : ArrayBuffer.isView(data) ? Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8") : "";
    if (!text) return;
    let message: unknown;
    try { message = JSON.parse(text); } catch { this.onError("The service sent something Branch could not read"); return; }
    if (message && typeof message === "object") this.receive(message as Record<string, unknown>);
  }
  protected send(message: unknown): void {
    if (this.socket?.readyState === 1) this.socket.send(JSON.stringify(message));
  }
  close(reason = "The conversation ended"): void {
    const socket = this.socket;
    this.socket = null;
    try { socket?.close(1000, reason.slice(0, 120)); } catch { /* already gone */ }
    this.onClosed(reason);
  }
  abstract sendAudio(chunk: Uint8Array): void;
  abstract commit(): void;
  abstract sendText(text: string): void;
  abstract toolResult(callId: string, name: string, result: unknown): void;
  abstract interrupt(playback?: readonly RealtimePlaybackItem[]): void;
}

/** Waits for one event on a socket, and gives up rather than hanging for ever. */
export function once(socket: WebSocket, name: string, ms = 15000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error("The live connection did not answer in time")); }, ms);
    const done = (): void => { cleanup(); resolve(); };
    const failed = (): void => { cleanup(); reject(new Error("The live connection could not be opened")); };
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.removeEventListener(name, done);
      socket.removeEventListener("error", failed);
      socket.removeEventListener("close", failed);
    };
    socket.addEventListener(name, done);
    socket.addEventListener("error", failed);
    socket.addEventListener("close", failed);
  });
}

export const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");
export const fromBase64 = (value: string): Uint8Array => new Uint8Array(Buffer.from(value, "base64"));
/** Reads a string out of a message without trusting its shape. */
export const textAt = (value: unknown): string => (typeof value === "string" ? value : "");
