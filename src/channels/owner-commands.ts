import { z } from "zod";
import { audit } from "../audit.js";
import type { Store } from "../store.js";
import { argumentFingerprint } from "../question-fingerprint.js";

/**
 * Commands from the owner's own chat (parity with Hermes Agent, which runs commands from Telegram).
 *
 * A chat's task never runs a program on this computer (src/channels/chat-permissions.ts), because a chat app cannot
 * prove who is typing. This is the one narrow exception, and every part of it holds at once:
 * - it is off until the owner turns it on, at this computer, with the owner's PIN where one is set (it loosens safety);
 * - only on apps whose own servers prove who sent a message (Telegram, Discord, Slack, Matrix), never on email, SMS,
 *   IRC or a posted webhook, where the sender can be made up;
 * - only in a direct chat with one of the accounts the owner named exactly (the app's own id and the account's id);
 * - never for a message fetched after a restart, and never under Lockdown or while Branch is locked;
 * - only the one permission to run the programs the owner already set up (`shell.execute`), nothing else;
 * - every command still asks first: a chat's task never has a standing yes (src/policy.ts `cappedPolicy`), and the
 *   yes has to be the Yes button on that exact command, pressed in that same chat by that same account
 *   (src/channels/router.ts `answerApproval`), after the whole command was shown (`commandShown`).
 */
export const commandPermission = "shell.execute";
/** Apps whose servers vouch for the sender of every message: a bot token, a signed session or an access token. */
export const vouchedSenderKinds: readonly string[] = ["telegram", "discord", "slack", "matrix"];
const Account = z.object({
  channel: z.string().trim().min(1).max(64),
  sender: z.string().trim().min(1).max(120).refine((value) => value !== "*" && !value.includes("*"), "Name one account, not everybody"),
}).strict();
export const OwnerCommandsSchema = z.object({
  on: z.boolean().default(false),
  accounts: z.array(Account).max(10).default([]),
}).strict();
export type OwnerCommands = z.infer<typeof OwnerCommandsSchema>;
const settingKey = "chat-owner-commands";

/** The saved setting; anything unreadable is off. */
export function ownerCommands(store: Pick<Store, "get">, owner: string): OwnerCommands {
  const parsed = OwnerCommandsSchema.safeParse(store.get("settings", owner, settingKey)?.data ?? {});
  return parsed.success ? parsed.data : OwnerCommandsSchema.parse({});
}
/** Saves the whole setting and writes down that it changed. The caller has already checked who is asking. */
export function saveOwnerCommands(store: Store, owner: string, input: unknown): OwnerCommands {
  store.profiles.requireOwner("Commands from your own chat");
  const next = OwnerCommandsSchema.parse(input);
  store.save("settings", owner, settingKey, next);
  audit(store, owner, { action: "policy.changed", actor: owner, subject: "commands from your own chat",
    reason: next.on ? `${next.accounts.length} of your own chat account(s) may ask to run your programs, each command asked first` : "No chat may run commands",
    outcome: next.on ? "on" : "off" });
  return next;
}

export interface ChatSender {
  channel: string;
  /** The adapter's kind ("telegram"), which says whether the app vouches for its senders. */
  kind: string;
  senderId: string;
  chatKind: "direct" | "group";
  caughtUp?: boolean | undefined;
}
/**
 * Whether this message is the owner's own, in a direct chat, on an app that proves who sent it, with the part on, and
 * nothing holding it back (`held`: Lockdown or the App lock).
 */
export function ownerCommandsHere(settings: OwnerCommands, sender: ChatSender, held: boolean): boolean {
  return settings.on && !held && sender.chatKind === "direct" && sender.caughtUp !== true
    && vouchedSenderKinds.includes(sender.kind)
    && settings.accounts.some((account) => account.channel === sender.channel && account.sender === sender.senderId);
}

/** Characters that change how text is drawn without being seen: direction marks, zero-width and other invisibles. */
const invisible = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ￰-￸]/u;
/** The longest command a chat is shown in full; a longer one is approved in the window. */
export const shownAtMost = 1500;
const quoted = (arg: string) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : JSON.stringify(arg));
/**
 * The whole command a question is about, exactly as it will run, for the chat to show before its Yes: the program's
 * name, every argument (quoted where it has spaces or signs), where it runs and which saved keys it is handed. Null
 * when it cannot be shown faithfully (it could not be read, it is too long, or it holds characters that would draw it
 * differently from what runs), and then the Yes belongs in the window.
 */
export function commandShown(bytes: string | undefined): string | null {
  if (!bytes) return null;
  let input: { executable?: unknown; args?: unknown; cwd?: unknown; secrets?: unknown; timeoutMs?: unknown; netless?: unknown };
  try { input = JSON.parse(bytes) as typeof input; } catch { return null; }
  if (typeof input.executable !== "string" || !input.executable) return null;
  const args = input.args === undefined ? [] : input.args;
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string")) return null;
  const lines = [[input.executable, ...args].map(quoted).join(" ")];
  if (typeof input.cwd === "string" && input.cwd && input.cwd !== ".") lines.push(`in ${input.cwd}`);
  if (Array.isArray(input.secrets) && input.secrets.length) lines.push(`with the saved keys ${input.secrets.map(String).join(", ")}`);
  if (typeof input.timeoutMs === "number") lines.push(`timeout ${input.timeoutMs} ms`);
  if (typeof input.netless === "boolean") lines.push(`no internet (best effort): ${input.netless ? "yes" : "no"}`);
  const shown = lines.join("\n");
  return shown.length <= shownAtMost && !invisible.test(shown) ? shown : null;
}

/**
 * The question's bytes are the exact request, not a scrubbed or shortened copy: the runtime hides key-shaped values
 * and private details in the bytes it hands out, and a chat must never approve a command whose shown words differ from
 * what runs. The keyed fingerprint is of the request as sent, so only the untouched bytes reproduce it.
 */
export function commandBytesExact(tool: string, bytes: string | undefined, fingerprint: string | undefined): boolean {
  return !!bytes && !!fingerprint && argumentFingerprint(tool, bytes) === fingerprint;
}
