import { z } from "zod";
import { runOrigin } from "../key-context.js";
import type { Store } from "../store.js";

export const chatPersonalities = ["none", "helpful", "concise", "technical", "creative", "teacher"] as const;
const ToneSchema = z.enum(chatPersonalities);
type Tone = z.infer<typeof ToneSchema>;
const SelectionSchema = z.object({ tone: ToneSchema }).strict();
const SnapshotSchema = z.object({ tone: ToneSchema, channel: z.string().min(1).max(64), chatId: z.string().min(1).max(200) }).strict();
const keyFor = (channel: string, chatId: string) => `chat-personality:${channel}:${chatId}`;
/** Neutral-name resolution adapted from Hermes hermes_cli/personality.py (MIT). */
export function resolveChatPersonality(argument: string): Tone {
  const name = argument.trim().toLowerCase();
  return ToneSchema.parse(["", "none", "default", "neutral", "off"].includes(name) ? "none" : name);
}
export function chatPersonality(store: Store, owner: string, channel: string, chatId: string): Tone {
  const parsed = SelectionSchema.safeParse(store.get("settings", owner, keyFor(channel, chatId))?.data);
  return parsed.success ? parsed.data.tone : "none";
}
export function saveChatPersonality(store: Store, owner: string, channel: string, chatId: string, tone: Tone): void {
  store.profiles.requireOwner("Choosing this chat's reply tone");
  store.save("settings", owner, keyFor(channel, chatId), SelectionSchema.parse({ tone }));
}
/** Only called by the router after a live owner DM starts; never accepts an incoming prompt's instructions. */
export function recordChatPersonality(store: Store, owner: string, runId: string, channel: string, chatId: string): void {
  const parsed = SnapshotSchema.safeParse({ tone: chatPersonality(store, owner, channel, chatId), channel, chatId });
  if (parsed.success) store.event(runId, "channel.personality", parsed.data);
}
const templates: Record<Tone, string> = {
  none: "",
  helpful: "Use a welcoming, practical tone. Explain the next useful step clearly.",
  concise: "Prefer a short answer. Keep the facts and necessary caveats; omit repetition.",
  technical: "Use precise technical terms when useful. Explain assumptions and the evidence behind conclusions.",
  creative: "Offer varied ideas when the request calls for them. Keep invented ideas distinct from factual claims.",
  teacher: "Explain unfamiliar concepts patiently, building from a simple example to the details needed.",
};
/** A fixed presentation hint, snapshotted per task; follow only its own same-session resumption chain. */
export function chatPersonalityForRun(store: Store, owner: string, runId: string): string {
  const origin = runOrigin(store, runId), session = store.run(runId)?.sessionId;
  if (origin.source !== "channel" || origin.shortLivedKey || origin.personProfileId || origin.lentTo || !session) return "";
  const seen = new Set<string>();
  for (let id: unknown = runId; typeof id === "string" && !seen.has(id) && seen.size < 8;) {
    seen.add(id);
    const run = store.run(id);
    if (!run || run.owner !== owner || run.sessionId !== session) return "";
    const events = store.events(id), snapshot = events.find((event) => event.kind === "channel.personality");
    const inbound = events.find((event) => event.kind === "channel.inbound")?.data;
    if (snapshot) {
      const parsed = SnapshotSchema.safeParse(snapshot.data);
      if (!parsed.success || parsed.data.channel !== inbound?.channel || parsed.data.chatId !== inbound?.chatId) return "";
      const hint = templates[parsed.data.tone];
      return hint ? `\n\nReply tone chosen for this chat (presentation only; keep your identity, permissions and approval rules):\n${hint}` : "";
    }
    if (inbound) return "";
    const start = events.find((event) => event.kind === "run.started")?.data;
    id = start?.resumedFrom ?? start?.originFrom;
  }
  return "";
}
