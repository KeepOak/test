import { parseImages } from "./contracts.js";
import type { LiveConversation, LiveConversations, LiveOutput } from "./realtime-voice.js";
import type { RunSocketHooks, RunSocketWriter } from "./ws.js";
import type { RealtimePlaybackItem } from "./realtime.js";

/**
 * A live conversation carried on the socket the browser already has open for a task. Sound goes up
 * as binary frames and comes back as binary frames; everything else — starting, stopping, cutting
 * in, a line typed while the assistant is talking — is one short line of JSON either way.
 *
 * Sound never goes through the event log on its way down. The event log is read by a poll a few
 * times a second and is kept on disk, and a live conversation's sound is neither fast enough for
 * one nor meant to be kept at all.
 */

/** What the browser may say on a live conversation's socket. Anything else is ignored. */
export type LiveCommand =
  | { live: "start" }
  | { live: "stop" }
  | { live: "interrupt"; playback?: RealtimePlaybackItem[] }
  | { live: "done" }
  | { live: "say"; text: string }
  /** Bucket 17: a picture shown while talking, checked like any attached picture. */
  | { live: "picture"; mediaType: string; data: string; name?: string | undefined };

/** Each chunk of sound going down carries its place in the order, so nothing plays out of turn. */
export function audioFrame(sequence: number, pcm16: Uint8Array): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(sequence >>> 0);
  return Buffer.concat([head, Buffer.from(pcm16)]);
}
/** The other half of the same, for the browser's side and for the tests. */
export function readAudioFrame(payload: Buffer): { sequence: number; pcm16: Buffer } {
  return { sequence: payload.readUInt32BE(0), pcm16: payload.subarray(4) };
}

/** Reads one line the browser sent, without trusting its shape. */
export function parseCommand(payload: Buffer): LiveCommand | null {
  let value: unknown;
  try { value = JSON.parse(payload.toString("utf8")); } catch { return null; }
  if (!value || typeof value !== "object") return null;
  const live = (value as { live?: unknown }).live;
  if (live === "start" || live === "stop" || live === "done") return { live };
  if (live === "interrupt") return { live, playback: playbackItems((value as Record<string, unknown>)["playback"]) };
  if (live === "say") {
    const text = String((value as { text?: unknown }).text ?? "").slice(0, 4000).trim();
    return text ? { live: "say", text } : null;
  }
  if (live === "picture") {
    const { mediaType, data, name } = value as Record<string, unknown>;
    try {
      const [picture] = parseImages([{ mediaType, data, ...(typeof name === "string" ? { name: name.slice(0, 200) } : {}) }]);
      return picture ? { live: "picture", ...picture } : null;
    } catch { return null; }
  }
  return null;
}

function playbackItems(value: unknown): RealtimePlaybackItem[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 32).flatMap((item: unknown) => {
    if (!item || typeof item !== "object") return [];
    const { itemId, contentIndex, audioEndMs } = item as Record<string, unknown>;
    if (typeof itemId !== "string" || !itemId || itemId.length > 256) return [];
    if (typeof contentIndex !== "number" || !Number.isInteger(contentIndex) || contentIndex < 0) return [];
    if (typeof audioEndMs !== "number" || !Number.isFinite(audioEndMs) || audioEndMs < 0) return [];
    return [{ itemId, contentIndex, audioEndMs: Math.min(3_600_000, Math.floor(audioEndMs)) }];
  });
}

/** Where a live conversation writes to when it is being carried on a run's socket. */
export function socketOutput(reply: RunSocketWriter): LiveOutput {
  let sequence = 0;
  return {
    audio: (pcm16) => reply.binary(audioFrame(sequence++, pcm16)),
    notice: (kind, data) => reply.text(JSON.stringify({ kind, data })),
  };
}

/**
 * The hooks a run's socket is served with. A task that never asks for a live conversation costs
 * nothing extra: nothing is opened until the browser says "start".
 */
export function liveHooks(live: LiveConversations, runId: string, sessionId: string): RunSocketHooks {
  let conversation: LiveConversation | undefined;
  const handle = (payload: Buffer, binary: boolean, reply: RunSocketWriter): void => {
    if (binary) { conversation?.audio(new Uint8Array(payload)); return; }
    const command = parseCommand(payload);
    if (!command) return;
    if (command.live === "start") { void begin(reply); return; }
    if (!conversation) { reply.text(JSON.stringify({ kind: "voice.live.problem", data: { message: "No live conversation is open." } })); return; }
    if (command.live === "stop") { live.stop(runId, "You ended the conversation"); conversation = undefined; return; }
    if (command.live === "interrupt") { conversation.interrupt(command.playback); return; }
    if (command.live === "done") { conversation.done(); return; }
    try { if (command.live === "picture") conversation.show(command); else conversation.say(command.text); }
    catch (error) { reply.text(JSON.stringify({ kind: "voice.live.problem", data: { message: (error as Error).message } })); }
  };
  const begin = async (reply: RunSocketWriter): Promise<void> => {
    try {
      const started = await live.start(runId, sessionId, socketOutput(reply));
      conversation = started.conversation;
      reply.text(JSON.stringify({ kind: "voice.live.ready", data: { service: started.plan.service, reason: started.plan.reason } }));
    } catch (error) {
      // A refusal is the ordinary answer here, not a failure: "keep sound on this computer" is on,
      // or the connection cannot hold a live conversation. The person is told which, in words.
      reply.text(JSON.stringify({ kind: "voice.live.refused", data: { message: (error as Error).message } }));
    }
  };
  return {
    onClientFrame: handle,
    liveOpen: () => conversation?.open === true,
    onClose: () => { if (conversation) { live.stop(runId, "The window closed"); conversation = undefined; } },
  };
}
