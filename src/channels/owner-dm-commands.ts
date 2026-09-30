import type { Store } from "../store.js";
import { lockedDown } from "../lockdown.js";
import { platformSettings } from "../reach/platform.js";
import { lookup } from "../commands/catalog.js";
import { ownerCommands, vouchedSenderKinds } from "./owner-commands.js";
import type { InboundMessage } from "./router.js";

/**
 * CHAT-185: the window's commands the owner may also send from their own chat, as Hermes Agent takes them from the
 * owner's DM: working until a goal is met, a task on the side, what is remembered, the skills, a health check, the
 * waiting line, and Lockdown switched on. A chat app cannot prove who is typing, so every one of these is held to:
 *
 * - one of the owner's own accounts, named exactly (the `/platform` list, or the paired accounts marked as the owner's
 *   under Settings › Chat apps › Commands from your own chat), in a direct chat, on an app whose servers vouch for the
 *   sender (Telegram, Discord, Slack, Matrix; never email, SMS or a posted webhook, where a sender can be made up);
 * - never a message fetched after a restart, and under Lockdown or the App lock only `/lockdown` and `/lockdown on`;
 * - a task one of these starts (`/goal`, `/bg`) is given what an ordinary message from that chat is given: with
 *   "Your own chats have your full access" on (owner-dm-full, src/channels/chat-permissions.ts), it is the owner's own
 *   (source "owner", every permission, carrying the chat's mark so it is checked again at every step); with it off, it
 *   is the chat's task with the chat's short list;
 * - nothing that lasts beyond the conversation is made from a chat (the rule in docs/configuration.md: never an
 *   automation or a standing order from a chat), so `/loop`, `/heartbeat`, `/suggestions` and `/blueprint` only look,
 *   pause, resume or stop; switching Lockdown off stays in the app on this computer.
 *
 * From anybody else, in a group, or on any other app, the line is what it always was: an ordinary message.
 */
export const ownerDmCommandNames: readonly string[] = [
  "goal", "subgoal", "bg", "memory", "skills", "health", "sessions", "lockdown", "queue", "busy",
  "loop", "heartbeat", "suggestions", "blueprint",
];

/** One of the owner's own accounts, named exactly, on an app that vouches for its senders, in a direct chat, live. */
export function ownerDmHere(store: Pick<Store, "get">, owner: string, kind: string,
  message: Pick<InboundMessage, "channel" | "senderId" | "chatKind" | "caughtUp">): boolean {
  if (message.chatKind !== "direct" || message.caughtUp || !vouchedSenderKinds.includes(kind)) return false;
  const named = (account: { channel: string; sender: string }) => account.channel === message.channel && account.sender === message.senderId;
  return platformSettings(store, owner).owners.some(named) || ownerCommands(store, owner).accounts.some(named);
}

/**
 * owner-dm-signin: whether the owner has named any chat account as their own yet (Commands from your own chat, or
 * /platform's owners). Until then a pairing the owner approves in the window may also name that sender as theirs, once
 * (ChannelRouter.approve); after that, approving a pairing only lets the person talk to Branch.
 */
export function ownerAccountNamed(store: Pick<Store, "get">, owner: string): boolean {
  return ownerCommands(store, owner).accounts.length > 0 || platformSettings(store, owner).owners.length > 0;
}

/** The owner-DM command a line is, with what follows it, or null. */
export function ownerDmCommand(text: string): { name: string; argument: string } | null {
  const match = /^\/([a-z?][\w?-]*)(?:@[\w.-]+)?(?:\s+([\s\S]*))?$/i.exec(text.trim());
  const command = match ? lookup(match[1]!) : undefined;
  if (!command || !ownerDmCommandNames.includes(command.name)) return null;
  return { name: command.name, argument: (match![2] ?? "").trim() };
}

export const inTheApp = "A chat app cannot prove who is typing, so that is done in the Branch app on this computer.";
const looks = new Set(["", "status", "pause", "resume", "stop", "clear", "catalog", "catalogue"]);

/** Why this owner-DM command may not be carried out from a chat now, or null when it may. */
export function ownerDmRefusal(store: Store, owner: string, locked: boolean, name: string, argument: string): string | null {
  const word = argument.trim().toLowerCase().split(/\s+/)[0] ?? "";
  if (name === "lockdown") return word === "off" ? "Lockdown can only be switched off in the app on this computer." : null;
  if (locked || lockedDown(store, owner)) return "Lockdown or the App lock is on, so only /lockdown is taken from a chat.";
  if (["loop", "heartbeat", "suggestions", "blueprint"].includes(name) && !looks.has(word))
    return `Nothing that keeps running is set up from a chat. ${inTheApp}`;
  if (name === "sessions" && word) return "Open an earlier conversation in the Branch app.";
  return null;
}
