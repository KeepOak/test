import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { isPrivateAddress, type ConnectOptions, type NetworkPolicy } from "./network-policy.js";
import { once, SocketSession, textAt, type RealtimeSettings } from "./realtime.js";

export const chatgptLiveModel = "gpt-live-1-codex";
export const chatgptCallUrl = "https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas";
const voiceNames = ["arbor", "breeze", "cove", "ember", "juniper", "maple", "sol", "spruce", "vale"];
const problem = "The ChatGPT live conversation could not be opened. Check the selected account's live voice access.";

/** Adapted from OpenClaw's MIT audio-only SDP admission; active data/video is refused. */
export function audioOnlySdp(sdp: string, remote = false): void {
  if (!sdp.startsWith("v=0") || Buffer.byteLength(sdp) > 256 * 1024) throw new Error(problem);
  const lines = sdp.split(/\r\n|\n|\r/);
  if (lines.length > 4096 || lines.some(line => Buffer.byteLength(line) > 4096)) throw new Error(problem);
  let audio = 0, media = 0;
  for (const line of lines) {
    if (line.startsWith("m=")) {
      const section = /^m=([A-Za-z0-9-]+)\s+(\d+)(?:\s|$)/.exec(line);
      if (!section || ++media > 8) throw new Error(problem);
      if (section[1] === "audio") audio += Number(section[2] !== "0");
      else if (section[1] !== "application" || section[2] !== "0") throw new Error(problem);
    }
    if (remote && line.startsWith("a=candidate:")) {
      const address = line.trim().split(/\s+/)[4] ?? "";
      if (!isIP(address) || isPrivateAddress(address)) throw new Error(problem);
    }
  }
  if (audio !== 1) throw new Error(problem);
}

async function boundedSdp(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error(problem);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 256 * 1024) throw new Error(problem);
      chunks.push(part.value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

interface SubscriptionOptions {
  token: string; accountId: string; offer: string; runId: string;
  signal: AbortSignal; fetch: typeof globalThis.fetch;
}

/** Adapted from OpenClaw's MIT Quicksilver wire/session/events contracts at 1794d8b4ef8dde46f39a16da2bdbcf0bf2b519ef.
 * OAuth stays server-side. Browser media uses the answer SDP; the sideband carries only control/transcripts.
 */
export class ChatGPTRealtimeSession extends SocketSession {
  readonly service = "openai" as const;
  private callId = "";
  private answer = "";
  private closed = false;
  private readonly controller = new AbortController();
  private readonly requestIds = { "session-id": randomUUID(), "thread-id": randomUUID(), "x-session-id": randomUUID() };
  private readonly delegations = new Set<string>();
  onAgentConsult: (request: { id: string; question: string }) => void = () => undefined;
  get answerSdp(): string { return this.answer; }

  constructor(policy: NetworkPolicy, settings: RealtimeSettings, private readonly options: SubscriptionOptions) {
    super(policy, settings);
  }

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.options.token}`, "chatgpt-account-id": this.options.accountId,
      "OpenAI-Alpha": "quicksilver=v2", ...this.requestIds };
  }

  async open(): Promise<void> {
    const abort = () => this.close();
    this.options.signal.addEventListener("abort", abort, { once: true });
    try {
      if (this.options.signal.aborted || this.closed) throw new Error(problem);
      await this.createCall();
      if (this.options.signal.aborted || this.closed) throw new Error(problem);
      await this.openSideband();
      if (this.options.signal.aborted || this.closed) throw new Error(problem);
    } catch { this.close(); throw new Error(problem); }
    finally { this.options.signal.removeEventListener("abort", abort); }
  }

  private async openSideband(): Promise<void> {
    const { url, connect } = this.address();
    const socket = await this.policy.connect(url, connect);
    if (this.closed || this.options.signal.aborted) { socket.close(); throw new Error(problem); }
    this.socket = socket;
    socket.addEventListener("message", (event: MessageEvent) => {
      if (this.closed || this.socket !== socket || typeof event.data !== "string") return;
      if (event.data.length > 256 * 1024) { this.close(); return; }
      try {
        const message: unknown = JSON.parse(event.data);
        if (message && typeof message === "object" && !Array.isArray(message)) this.receive(message as Record<string, unknown>);
      } catch { this.close(); }
    });
    socket.addEventListener("error", () => { if (!this.closed) { this.onError("The ChatGPT live connection had a problem."); this.close(); } });
    socket.addEventListener("close", () => { if (!this.closed) this.close(); });
    if (socket.readyState !== 1) await once(socket, "open");
  }

  private async createCall(): Promise<void> {
    audioOnlySdp(this.options.offer);
    const voice = voiceNames.includes(this.settings.voice) ? this.settings.voice : "cove";
    const response = await this.policy.guard(this.options.fetch)(chatgptCallUrl, {
      method: "POST", redirect: "error", headers: { ...this.headers(), "content-type": "application/json" },
      signal: AbortSignal.any([this.controller.signal, this.options.signal, AbortSignal.timeout(30_000)]),
      body: JSON.stringify({ sdp: this.options.offer, session: { model: chatgptLiveModel,
        instructions: `${this.settings.instructions.slice(0, 8000)}\nDelegate requests requiring Branch actions to the client. Wait for Branch's result or exact approval card; never claim an action succeeded before that result.`,
        audio: { output: { voice } }, delegation: { type: "client" } } }),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error(problem); }
    const location = response.headers.get("location") ?? "";
    if (location.length > 512) { await response.body?.cancel(); throw new Error(problem); }
    const candidates = [response.headers.get("openai-session-id") ?? "", ...location.split(/[/?#]/)];
    this.callId = candidates.find(id => /^(?:rtc_[\w-]{1,120}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i.test(id)) ?? "";
    if (!this.callId) { await response.body?.cancel(); throw new Error(problem); }
    this.answer = await boundedSdp(response);
    if (this.answer.includes(this.options.token) || this.answer.includes(this.options.accountId)) throw new Error(problem);
    audioOnlySdp(this.answer, true);
  }

  protected address(): { url: string; connect: ConnectOptions } {
    return { url: `wss://api.openai.com/v1/live/${this.callId}`,
      connect: { headers: this.headers(), what: "a ChatGPT subscription live conversation", runId: this.options.runId,
        // End or App lock while the address was being checked: no socket is made and no sign-in header is sent.
        proceed: () => !this.closed && !this.options.signal.aborted } };
  }
  protected greet(): void {}

  protected receive(message: Record<string, unknown>): void {
    if (this.closed) return;
    const type = textAt(message.type);
    const item = message.item && typeof message.item === "object" ? message.item as Record<string, unknown> : {};
    if (type === "input_transcript.added" || type === "output_transcript.added") {
      this.onTranscript({ who: type === "input_transcript.added" ? "person" : "assistant", text: textAt(item.text).slice(0, 8000), final: false });
    } else if (type === "turn.done") {
      const turn = message.turn && typeof message.turn === "object" ? message.turn as Record<string, unknown> : {};
      if (turn.role === "user" || turn.role === "assistant")
        this.onTranscript({ who: turn.role === "user" ? "person" : "assistant", text: textAt(turn.transcript).slice(0, 8000), final: true });
    } else if (type === "delegation.created" && item.type === "delegation" && item.target === "client") {
      const id = textAt(item.id);
      if (!id || id.length > 200 || this.delegations.has(id)) return;
      if (this.delegations.size >= 128) { this.close("The conversation reached its action limit"); return; }
      this.delegations.add(id);
      const parts = Array.isArray(item.content) ? item.content : [];
      const question = parts.slice(0, 32).flatMap((part: unknown) => {
        if (!part || typeof part !== "object") return [];
        const content = part as Record<string, unknown>;
        return content.type === "input_text" ? [textAt(content.text).slice(0, 4000)] : [];
      }).join("").slice(0, 4000);
      this.onAgentConsult({ id, question });
    } else if (type === "error") { this.onError("The ChatGPT live connection had a problem."); this.close(); }
    else if (type === "session.closed") this.close();
  }

  private context(text: string, id?: string): void {
    // Upstream bounds each append to 500 UTF-8 bytes, preserving complete characters.
    let chunk = "";
    for (const character of text.slice(0, 4000)) {
      if (Buffer.byteLength(chunk + character) > 500) { this.append(chunk, id); chunk = ""; }
      chunk += character;
    }
    if (chunk) this.append(chunk, id);
  }
  private append(text: string, id?: string): void {
    if (!this.closed) this.send({ type: id ? "delegation.context.append" : "session.context.append",
      ...(id ? { delegation_item_id: id } : {}), channel: "speakable", content: [{ type: "input_text", text }] });
  }
  sendAudio(_chunk: Uint8Array): void {}
  commit(): void {}
  sendText(text: string): void { this.context(text); }
  toolResult(_id: string, _name: string, _result: unknown): void {}
  agentConsultResult(id: string, text: string): void { if (this.delegations.has(id)) this.context(text, id); }
  interrupt(): void { this.onError("This ChatGPT voice controls interruption when you speak."); }
  close(reason = "The conversation ended"): void {
    if (this.closed) return;
    this.send({ type: "session.close" });
    this.closed = true; this.controller.abort();
    super.close(reason);
  }
}
