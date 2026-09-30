import { z } from "zod";
import { audit } from "../audit.js";
import type { Store } from "../store.js";
import { platformSettings } from "../reach/platform.js";
import { ownerCommands } from "./owner-commands.js";
import type { InboundMessage } from "./router.js";

/**
 * The owner's home chat (CHAT-190, Hermes' `/sethome`): the one chat that schedule results, heartbeat news, watches and
 * the morning brief go to when they are sent "home" rather than to a chat named outright. A delivery target of
 * `{ channel: "home", chatId: "home" }` is read at the moment it is sent, so moving home moves every one of them.
 *
 * Only the owner sets it. From a chat app that is `/sethome`, taken only in a direct chat from one of the owner's own
 * accounts (the same exact list `/platform` uses, src/reach/platform.ts), never from a group, never for a message
 * fetched after a restart. Otherwise a paired friend could have the owner's results sent to them.
 */
export const homeName = "home";
const HomeSchema = z.object({
  channel: z.string().min(1).max(64),
  chatId: z.string().min(1).max(64),
  title: z.string().max(200),
  setAt: z.string().max(40),
}).strict();
export type HomeChat = z.infer<typeof HomeSchema>;
const settingsKey = "chat-home";

export function homeChat(store: Pick<Store, "get">, owner: string): HomeChat | null {
  const parsed = HomeSchema.safeParse(store.get("settings", owner, settingsKey)?.data);
  return parsed.success ? parsed.data : null;
}

/** Sets or (with null) forgets home, and writes down who did it from where. */
export function setHomeChat(store: Store, owner: string, home: Omit<HomeChat, "setAt"> | null, by: string): HomeChat | null {
  const next = home ? HomeSchema.parse({ ...home, setAt: new Date().toISOString() }) : null;
  store.save("settings", owner, settingsKey, next ?? {});
  audit(store, owner, { action: "policy.changed", actor: owner, subject: "your home chat",
    reason: next ? `Results sent home now go to ${next.title} on ${next.channel} (${by})` : `Home chat forgotten (${by})`, outcome: "saved" });
  return next;
}

/** A delivery target with "home" read as the home chat; null when "home" is asked for and none is set. */
export function resolveHome(store: Pick<Store, "get">, owner: string, channel: string, chatId: string): { channel: string; chatId: string } | null {
  if (channel !== homeName) return { channel, chatId };
  const home = homeChat(store, owner);
  return home ? { channel: home.channel, chatId: home.chatId } : null;
}
export const noHome = "No chat is set as home yet. Send /sethome from your own account in the chat that should get these.";

/**
 * One of the owner's own chat accounts, named exactly (never a wildcard): the list `/platform` uses, or the paired
 * accounts the owner marked as their own under Settings › Chat apps › Commands from your own chat. Being named there
 * is who the account is; whether it may run programs is that card's own switch, which this does not read.
 */
export function ownerAccount(store: Pick<Store, "get">, owner: string, message: Pick<InboundMessage, "channel" | "senderId">): boolean {
  const named = (account: { channel: string; sender: string }) => account.channel === message.channel && account.sender === message.senderId;
  return platformSettings(store, owner).owners.some(named) || ownerCommands(store, owner).accounts.some(named);
}
/** True for a direct chat with one of the owner's own accounts, not fetched after a restart. */
export function ownerAccountHere(store: Pick<Store, "get">, owner: string,
  message: Pick<InboundMessage, "channel" | "senderId" | "chatKind" | "caughtUp">): boolean {
  return message.chatKind === "direct" && !message.caughtUp && ownerAccount(store, owner, message);
}

const fromWindow = "Choose it from the Branch window instead: /sethome <chat app> [chat], for a chat that has talked to Branch.";

/** What `/sethome` in a chat does: sets this chat as home, or with "off" forgets it. */
export function setHomeFromChat(store: Store, owner: string, argument: string,
  message: Pick<InboundMessage, "channel" | "chatId" | "senderId" | "chatKind" | "caughtUp" | "chatTitle" | "senderName">): string {
  if (!ownerAccountHere(store, owner, message))
    return `Only the owner chooses the home chat, and from a chat only in a direct chat with one of the owner's own accounts (Settings › Chat apps › Commands from your own chat). ${fromWindow}`;
  const word = argument.trim().toLowerCase();
  if (word === "off") { setHomeChat(store, owner, null, `from a chat on ${message.channel}`); return "This chat is no longer home. Results sent home wait until a home is chosen."; }
  if (word && word !== "here") return "Send /sethome to make this chat home, or /sethome off.";
  const title = message.chatTitle ?? message.senderName ?? message.chatId;
  setHomeChat(store, owner, { channel: message.channel, chatId: message.chatId, title }, `from a chat on ${message.channel}`);
  return "This chat is home now. Schedule results, heartbeat news and watches sent home arrive here.";
}

/**
 * The router's first look at a message, beside `platformGate`: `/sethome` or `/sethome off` from one of the owner's own
 * accounts in a direct chat is carried out here and answered; the same sent while Branch was closed is let go in
 * silence. Anything else, and the same line from anybody else, carries on as an ordinary message.
 */
export function homeGate(store: Store, owner: string, message: InboundMessage): { reply: string | null } | null {
  const command = /^\/sethome(?:@[\w.-]+)?(?:\s+(off|here))?\s*$/i.exec(message.text.trim());
  if (!command || message.chatKind !== "direct") return null;
  if (!ownerAccount(store, owner, message)) return null;
  if (message.caughtUp) return { reply: null };
  return { reply: setHomeFromChat(store, owner, command[1] ?? "", message) };
}

/** Chats that have talked to Branch (the router's own list, read from the same records), newest first. */
function knownChats(store: Pick<Store, "list">, owner: string): { channel: string; chatId: string; title: string; updatedAt: string }[] {
  return store.list("settings", owner).flatMap((record) => {
    if (!record.id.startsWith("channel-session:")) return [];
    const data = record.data as { channel?: unknown; chatId?: unknown; title?: unknown; updatedAt?: unknown };
    if (typeof data.channel !== "string" || typeof data.chatId !== "string") return [];
    return [{ channel: data.channel, chatId: data.chatId, title: typeof data.title === "string" ? data.title : data.chatId,
      updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : record.updatedAt }];
  }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * `/sethome` at the window, phone or terminal, which are the owner's: on its own, where home is; `off` forgets it;
 * `<chat app> [chat]` makes that chat home, the most recent one on that app when no chat is named.
 */
export function homeLine(store: Store, owner: string, argument: string): string {
  const words = argument.trim().split(/\s+/).filter(Boolean);
  if (!words.length) {
    const home = homeChat(store, owner);
    return home ? `Home is ${home.title} on ${home.channel}, since ${home.setAt.slice(0, 10)}. Results sent home arrive there.`
      : "No chat is home yet. Send /sethome <chat app> [chat] here, or /sethome from your own account in that chat.";
  }
  if (words[0]!.toLowerCase() === "off") { setHomeChat(store, owner, null, "from the window"); return "No chat is home now. Results sent home wait until a home is chosen."; }
  const app = words[0]!.toLowerCase(), named = words.slice(1).join(" ").toLowerCase();
  const found = knownChats(store, owner).filter((chat) => chat.channel.toLowerCase() === app)
    .find((chat) => !named || chat.chatId.toLowerCase() === named || chat.title.toLowerCase() === named);
  if (!found) return named ? `No chat called ${words.slice(1).join(" ")} on ${words[0]} has talked to Branch.` : `No chat on ${words[0]} has talked to Branch yet. Send the bot a message there first.`;
  setHomeChat(store, owner, { channel: found.channel, chatId: found.chatId, title: found.title }, "from the window");
  return `Home is ${found.title} on ${found.channel} now. Schedule results, heartbeat news and watches sent home arrive there.`;
}
