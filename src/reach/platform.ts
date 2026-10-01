import { z } from "zod";
import { audit } from "../audit.js";
import { lockedDown } from "../lockdown.js";
import type { InboundMessage } from "../channels/router.js";
import type { Store } from "../store.js";
import { reachMode, reachRecord, requireReach } from "./settings.js";

/**
 * R17-081: `branch send` (a script's output into a chat) and pausing a chat app.
 *
 * Sending goes only to a chat that has already talked to Branch (the router's own list), through the
 * router's ordinary delivery, so the outbound check, splitting and retries all apply. A paused chat
 * app is not sent to.
 *
 * Pausing is the owner's alone. In the window it is a switch per chat app. From a chat it is
 * `/platform pause|resume|status [chat app]`, and it is taken only from a direct chat with one of
 * the owner's own accounts, which the owner names exactly (chat app and sender id, no wildcards)
 * in the window. The ordinary sender list cannot say who the owner is, so this list is separate
 * and never widened by it. While a chat app is paused its messages are let go without an answer —
 * except the owner's own `/platform resume`. Switching this part off puts every chat app back.
 *
 * The ideas are Hermes Agent's `/platform` command and "pipe script output" guide (MIT); this is an
 * independent implementation.
 */
const Account = z.object({ channel: z.string().trim().min(1).max(64), sender: z.string().trim().min(1).max(120).refine((v) => v !== "*", "Name one account, not everybody") }).strict();
export const PlatformSettingsSchema = z.object({
  owners: z.array(Account).max(10).default([]),
  paused: z.array(z.string().trim().min(1).max(64)).max(64).default([]),
}).strict();
export type PlatformSettings = z.infer<typeof PlatformSettingsSchema>;
const settingsKey = "reach-platform-settings";

export function platformSettings(store: Pick<Store, "get">, owner: string): PlatformSettings {
  return reachRecord(store, owner, settingsKey, PlatformSettingsSchema);
}
export function saveOwnerAccounts(store: Store, owner: string, input: unknown): PlatformSettings {
  const owners = PlatformSettingsSchema.shape.owners.parse(input);
  const next = { ...platformSettings(store, owner), owners };
  store.save("settings", owner, settingsKey, next);
  audit(store, owner, { action: "policy.changed", actor: owner, subject: "your own chat accounts",
    reason: `${owners.length} account(s) may pause and resume chat apps from a chat`, outcome: "saved" });
  return next;
}

export function setPaused(store: Store, owner: string, channel: string, paused: boolean, by: string): string[] {
  const current = platformSettings(store, owner);
  const set = new Set(current.paused);
  if (paused) set.add(channel); else set.delete(channel);
  const next = { ...current, paused: [...set].slice(0, 64) };
  store.save("settings", owner, settingsKey, next);
  audit(store, owner, { action: "policy.changed", actor: owner, subject: `the chat app ${channel}`,
    reason: `${paused ? "paused" : "resumed"} ${by}`, outcome: "saved" });
  return next.paused;
}

/** Paused only counts while the switch is on: switching the part off puts every chat app back. */
export const isPaused = (store: Pick<Store, "get">, owner: string, channel: string): boolean =>
  reachMode(store, owner, "platform-pause") !== "off" && platformSettings(store, owner).paused.includes(channel);

const isOwnerAccount = (s: PlatformSettings, m: Pick<InboundMessage, "channel" | "senderId" | "chatKind">): boolean =>
  m.chatKind === "direct" && s.owners.some((a) => a.channel === m.channel && a.sender === m.senderId);

export interface GateAnswer { reply: string | null }

/**
 * The router's first look at a message (the marked hook in src/channels/router.ts). Null: carry on
 * as usual. Otherwise the message stops here, with a reply for the owner's own command. A message
 * that arrived while Branch was closed never carries out the command.
 */
export function platformGate(store: Store, owner: string, message: InboundMessage): GateAnswer | null {
  if (reachMode(store, owner, "platform-pause") === "off") return null;
  const s = platformSettings(store, owner);
  const command = /^\/platform(?:@[\w.-]+)?(?:\s+(pause|resume|status))?(?:\s+([a-z0-9._-]{1,64}))?\s*$/i.exec(message.text.trim());
  // mac7/reach-leftovers: a message fetched after a restart (src/channels/catch-up.ts) is old news.
  // It is let go in silence, exactly as a stranger's caught-up message is, so a `/platform pause`
  // sent while Branch was closed cannot pause a chat app hours later. Pausing itself still applies
  // below, so a paused app does not answer its backlog either.
  if (command && isOwnerAccount(s, message) && message.caughtUp) return { reply: null };
  if (command && isOwnerAccount(s, message)) {
    const word = (command[1] ?? "status").toLowerCase(), channel = command[2] ?? message.channel;
    if (word === "status") return { reply: s.paused.length ? `Paused: ${s.paused.join(", ")}.` : "No chat app is paused." };
    setPaused(store, owner, channel, word === "pause", `from a chat on ${message.channel}`);
    return { reply: word === "pause" ? `${channel} is paused. Send /platform resume ${channel} from here to turn it back on.` : `${channel} is answering again.` };
  }
  return s.paused.includes(message.channel) ? { reply: null } : null;
}

export const SendSchema = z.object({
  channel: z.string().trim().min(1).max(64),
  chat: z.string().trim().min(1).max(120),
  text: z.string().min(1).max(16000),
}).strict();

export interface ChatSender {
  chats(owner: string): { channel: string; chatId: string }[];
  deliver(channel: string, chatId: string, text: string, key?: string): Promise<{ messageId?: string | undefined; queued: number }>;
}

/** A script's words into a chat that already talks to Branch. */
export async function sendToChat(store: Store, owner: string, router: ChatSender, input: unknown): Promise<{ channel: string; chat: string; queued: number }> {
  if (lockedDown(store, owner)) throw new Error("Lockdown is on, so nothing is sent out.");
  requireReach(store, owner, "send");
  const { channel, chat, text } = SendSchema.parse(input);
  if (!router.chats(owner).some((c) => c.channel === channel && c.chatId === chat))
    throw new Error("Branch only sends to a chat that has already talked to it. Send it a message from that chat first.");
  if (isPaused(store, owner, channel)) throw new Error(`${channel} is paused. Resume it first.`);
  const sent = await router.deliver(channel, chat, text, `reach-send:${Date.now()}:${Math.random().toString(16).slice(2)}`);
  return { channel, chat, queued: sent.queued };
}

/** `branch send <channel> <chat> [words…]`; with no words, what was piped in is sent. */
export function parseSendArgs(argv: readonly string[], piped: string): { channel: string; chat: string; text: string } {
  const [channel, chat, ...words] = argv;
  if (!channel || !chat) throw new Error("Usage: branch send <chat app> <chat> [words]   (or pipe the words in)");
  const text = words.length ? words.join(" ") : piped;
  if (!text.trim()) throw new Error("Nothing to send: give the words, or pipe them in.");
  return SendSchema.parse({ channel, chat, text: text.slice(0, 16000) });
}
