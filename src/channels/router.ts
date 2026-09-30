import { randomBytes, randomInt } from "node:crypto";
import { diagnose } from "../diagnostic-log.js"; // mac7/diagnostics
import { z } from "zod";
import type { Store } from "../store.js";
import type { MiniAppUser } from "../miniapp/init-data.js";
import { heldReplay } from "../never-break/resume.js"; // mac3/never-break
import type { Runtime } from "../runtime.js";
import { carryable } from "../carry-on.js"; // QA R1 follow-up
/** One question a task is waiting on, as the runtime lists them. */
type WaitingQuestion = ReturnType<Runtime["waitingApprovals"]>[number];
import type { PolicyRemember } from "../policy.js";
import { Deliveries } from "./deliveries.js";
import { audit } from "../audit.js";
import { ArtifactTooLarge, maxArtifactBytes, maxArtifactName } from "../artifacts.js";
import { decide, readSenderAllowlist } from "./allowlist.js";
import type { Run } from "../contracts.js";
import { LiveStatus, defaultLiveTiming, statusEmoji, type LiveTiming, type StepsSource } from "./live-status.js";
import { chatSteps, compactSummary, pageChatSteps, renderChatSteps, type ChatStepsView, type RichSpan } from "./progress-render.js";
import { stepsBehaviour, stepsCapsOf } from "./steps-caps.js";
import { saveStepsSettings, stepsDisplayFor, stepsSettings, type StepsDisplay, type StepsSettings } from "./steps-display.js";
import { liveSteps, specialistName } from "../live-steps.js";
import { readChatIntake, albumWaitMs, presenceWords, type ChatIntake } from "./intake-settings.js"; // Settings › Chat apps
import { channelFormatting, installChannelFormatting } from "./formatting-settings.js";
import { chatLiveSwitches, commandsInPairedDm, saveChatLiveSwitches, type ChatLiveSwitches } from "./chat-live-settings.js";
// mac7/chat-allowlist: the short list a chat's task may use, and the owner's additions to it.
import { approveInWindow, chatMayApprove, chatPermissionsOf as chatPermissionsAllowed, chatExtraPermissions,
  chatApprovablePermissions, standingYesInWindow,
  readChatPermissionSettings as chatPermissionSettings,
  saveChatPermissionSettings, type ChatPermissionSettings } from "./chat-permissions.js";
import { commandMode } from "../commands/settings.js";
import { savedLine } from "../commands/saved.js";
import { chatCommandSpec, chatCommandsFor, parseChatCommand, runChatCommand, usageFooter, usageShown, type ChatCommand, type ChatTurn } from "./chat-commands.js";
import { chatAppName } from "../environment.js";
import { platformGate, platformSettings } from "../reach/platform.js"; // r17-i
import { ownerAccountNamed, ownerDmCommand, ownerDmHere, ownerDmRefusal } from "./owner-dm-commands.js"; // CHAT-185
import { chatFailureLine } from "./failure-reason.js"; // owner-dm-signin
import { executeCommand } from "../commands/execute.js";
import type { CommandHost } from "../commands/handlers.js";
import { hostname } from "node:os";
import { assistantIdentity } from "../identity.js";
import { freshThread, saveChatThread, type ChatThread } from "./threads.js"; // defaulttrunk
import { lockedDown } from "../lockdown.js";
import { ownerChatMark, setOwnerChatCheck } from "../key-context.js"; // owner-dm-full
import { conversationModeSettings, looserThan, readConversationMode, type ConversationMode } from "../conversation-mode.js"; // owner-dm-full
import { readPolicy } from "../policy.js"; // owner-dm-full
import { commandBytesExact, commandPermission, commandShown, ownerCommands, ownerCommandsHere, saveOwnerCommands, vouchedSenderKinds } from "./owner-commands.js";
import { ReplyStream, type PlacedReply } from "./reply-stream.js";
import { nextQuote, quoteState, replyStyle, type QuoteState, type ReplyStyle } from "./reply-style.js";
import { ModelPicker, staleModelMenu } from "./model-picker.js";
import { listModels } from "../model-switch.js";

/**
 * Messaging channels (Telegram first) deliver messages from chats into conversations. Each chat
 * keeps its own conversation; unknown senders must pair once with a code the owner approves;
 * group chats answer only when addressed unless configured otherwise. Channel tasks never get
 * host command execution.
 */
export interface InboundMessage {
  channel: string;
  chatId: string;
  chatKind: "direct" | "group";
  chatTitle?: string;
  senderId: string;
  senderName: string;
  text: string;
  addressed: boolean;
  messageId: string;
  /** The message a reaction goes on, where it differs from `messageId` (a Slack thread reply). */
  reactTo?: string;
  /**
   * mac6/bucket-16 integration: the message arrived while Branch was closed and was fetched after a
   * restart (src/channels/catch-up.ts). A stranger's such message is let go without a pairing code.
   */
  caughtUp?: boolean;
  /**
   * A voice note, when the person sent one instead of typing. The bytes are fetched only if the
   * message gets as far as being answered, so a stranger cannot make Branch download anything.
   */
  attachments?: { name: string; sourceId: string; mediaType: string; kind: "picture" | "video" | "document"; size?: number; bytes: () => Promise<Uint8Array> }[];
  voice?: {
    mediaType: string;
    seconds?: number | undefined;
    bytes: () => Promise<Uint8Array>;
  };
  /** Settings › Chat apps › Edited messages: this is a new version of the message `messageId` names. */
  edited?: boolean;
  /** Photo albums as one message: the album this photo came in (Telegram's media_group_id). */
  groupId?: string;
}
/** What a channel says about itself, in words the owner can act on. */
/**
 * What a task started from a chat may use, out of everything registered. Kept here under its old
 * name because that is where the reference points; the list itself lives in chat-permissions.ts,
 * where it is a short list of what is allowed rather than a list of what is taken away.
 */
export { chatPermissionsOf } from "./chat-permissions.js";

export interface ChannelHealth {
  state: "connected" | "reconnecting" | "needs attention";
  reason?: string;
}
/** mac3/never-break: how long a pairing code can be used; the sender gets a new one after that. */
const pairingCodeMs = 60 * 60_000;
/** owner-dm-signin: the task sources a chat's chain may hold and still be the owner's own (never MCP, ACP or A2A). */
const ownersOrChat = new Set(["owner", "channel", "schedule", "trigger"]);
const pairingCodeFresh = (pair: { requestedAt?: string }): boolean => Date.now() - Date.parse(pair.requestedAt ?? "") <= pairingCodeMs;
export interface ChannelAdapter {
  readonly id: string;
  readonly kind: string;
  /** Longest single message this channel accepts; the ledger splits replies to fit. */
  readonly maxTextLength?: number;
  /** A transport may reserve space for literal-text escaping in its message limit. */
  configureFormatting?(mode: () => "native" | "plain"): void;
  /**
   * True where every message sent costs the owner money (SMS). Nothing is added to a reply there that was not asked
   * for, such as the steps line an app without edits gets above its reply.
   */
  readonly paidPerMessage?: boolean;
  /**
   * True where passing `replyToMessageId` only quotes the person's message (Telegram, Discord, WhatsApp): then the
   * owner's quoting choice decides whether it is passed (src/channels/reply-style.ts). Absent means the id carries the
   * conversation itself (a Slack thread, an email thread, a Mastodon reply) and is always passed.
   */
  readonly replyQuotes?: boolean;
  /**
   * True when the service will not let the assistant write to anybody outside the owner's own team
   * until that service has reviewed the app. Shown in Connections so it is not a surprise.
   */
  readonly needsAppReview?: boolean;
  botName(): string | null;
  /** Connection state in plain language, shown in Settings -> Channels. */
  health?(): ChannelHealth;
  /**
   * Settings › Chat apps › Staying connected: when the app last answered Branch at all (a poll that came back, even
   * empty), in milliseconds since the epoch. An app that has it is watched for stalling (intake-settings.ts).
   */
  lastContact?(): number;
  /** Starts the app again after a stall, with the same handler; throws in plain words when it cannot. */
  restart?(onMessage: (message: InboundMessage) => Promise<void>): Promise<void>;
  /** Presence: the bot's short description, "Online" or "Offline, back soon" (or empty to clear it). */
  setPresence?(words: string): Promise<void>;
  start(onMessage: (message: InboundMessage) => Promise<void>): Promise<void>;
  /**
   * `format` (optional): which parts of `text` are code, and whether the message should arrive without a
   * notification sound. An app that cannot show code differently leaves it out and sends the words as they are.
   */
  send(chatId: string, text: string, replyToMessageId?: string, format?: MessageFormat): Promise<string | undefined>;
  /**
   * The app's own command picker (Discord's slash commands; Telegram's "/" menu in #590), filled from the same catalog
   * every surface reads. An empty list clears it. Absent means the app keeps its commands elsewhere (Slack's are in the
   * app's settings) or has none.
   */
  setCommands?(commands: { command: string; description: string }[]): Promise<void>;
  /** Sends a spoken reply, on the channels that accept one. Absent means this channel cannot. */
  sendVoice?(chatId: string, audio: Uint8Array, mediaType: string, replyToMessageId?: string): Promise<string | undefined>;
  /**
   * Sends a question with buttons to press, on the channels that have them. Absent means this
   * channel has none, and the question goes out as words with "reply y / a / n" instead.
   */
  sendButtons?(chatId: string, text: string, buttons: ApprovalButton[], replyToMessageId?: string, format?: MessageFormat): Promise<string | undefined>;
  /**
   * True where `sendButtons` shows a list of up to 25 choices and a press comes back carrying the button's own value
   * (Telegram, Discord, Slack), so a choice like `/model`'s can be a menu. Absent: buttons are for yes and no only.
   */
  readonly listButtons?: boolean;
  // ---- Optional live-status methods (wave mac2, chat-live; used by live-status.ts) -------------
  // Any adapter may add any of these three; leave one out and the chat simply goes without it.
  // Rules every adapter follows (Telegram, Slack, Discord and Matrix are the worked examples):
  // - Absent means "this app cannot". Never add a method that does nothing.
  // - A failure must throw. The live status counts failures and leaves a part alone after two in a
  //   row; it never fails the task, so there is no need to swallow errors yourself.
  // - The router calls them only for paired or allowed senders, never under Lockdown or quiet hours,
  //   and every word passes the same outbound check as a reply before it reaches `edit` or `send`.
  // - `send` must return the id of the message it sent, or the progress message cannot be edited
  //   and the finished reply is sent the ordinary way instead.
  // - A reply inside a thread sets `InboundMessage.reactTo` to the person's own message, so the
  //   reaction lands on it rather than on the thread's first message (see slack.ts).
  /**
   * Shows "typing…" in the chat for a few seconds, on the apps that have it. The router asks again
   * every few seconds while the task works, so one call only needs to cover a short while.
   */
  sendTyping?(chatId: string): Promise<void>;
  /**
   * Puts `emoji` (one of `statusEmoji` in live-status.ts) on a message. Apps that keep several
   * reactions side by side (Slack, Discord) take `previous` off first; apps where a new reaction
   * replaces the old one (Telegram) may ignore it. An app that names reactions in words maps the
   * emoji itself and throws for one it has no name for. Absent means this app has no reactions and
   * the status shows only as typing and progress.
   */
  react?(chatId: string, messageId: string, emoji: string, previous?: string): Promise<void>;
  /**
   * An app without buttons that reads reactions: from now on, a thumbs up (or check) or thumbs down (or cross) by
   * `senderId` on the question message `messageId` in this chat comes back as the answer to that question
   * (`y:<fingerprint>` or `n:<fingerprint>`), once (src/channels/reaction-answers.ts). Absent means answers are typed.
   */
  watchAnswers?(chatId: string, messageId: string, senderId: string, fingerprint: string): void;
  /**
   * The app's own working-status line in a thread (Slack's assistant status, "is thinking…"): `words` says what the
   * task is doing now, "" clears it. `threadId` is the person's message, as the reply threads under it. Absent means
   * the app has none; typing and the reaction carry the status there.
   */
  setStatus?(chatId: string, threadId: string, words: string): Promise<void>;
  /**
   * Replaces the words of a message this adapter sent, cut to the app's own limit. An app that
   * refuses an edit because the words did not change must treat that as success (see telegram.ts).
   * Absent means there is no progress message and replies are not streamed.
   */
  edit?(chatId: string, messageId: string, text: string, format?: MessageFormat): Promise<void>;
  /**
   * Removes a message this adapter sent (the owner's "remove the steps message after a good answer",
   * src/channels/steps-display.ts `cleanup`). Absent means this app cannot, and the message stays.
   */
  deleteMessage?(chatId: string, messageId: string): Promise<void>;
  // ---- R17-C (R17-022): a file delivered into the chat as the app's own attachment -------------
  // Absent means "this app cannot". A failure must throw. Only `chat.send_file`
  // (src/personal/chat-files.ts) calls it, after the owner, recipient, size and leak checks.
  /** The largest file this app takes from a bot, in bytes. */
  readonly maxFileBytes?: number;
  /** Sends one file with an optional caption, and returns the id of the message it made. */
  sendFile?(chatId: string, file: OutgoingFile, replyToMessageId?: string): Promise<string | undefined>;
  // ---- end R17-C ----
  // ---- A picture kept up to date in place (the live browser in a chat, SCREEN-103/104) -------------
  // Both or neither. A failure must throw. `buttons` go under the picture and come back as a press, like sendButtons'.
  /** Sends a picture (shown inline, not as a document) with its caption and buttons; returns its message id. */
  sendPicture?(chatId: string, file: OutgoingFile, buttons: ApprovalButton[], replyToMessageId?: string): Promise<string | undefined>;
  /** Replaces the picture, caption and buttons of a message `sendPicture` made. */
  editPicture?(chatId: string, messageId: string, file: OutgoingFile, buttons: ApprovalButton[]): Promise<void>;
  /**
   * The Telegram Mini App's signed launch data, checked with this bot's own token (src/miniapp/init-data.ts): the user
   * who opened it. Throws when it was not made by this bot or is too old.
   */
  miniAppUser?(initData: string): MiniAppUser;
  stop(): Promise<void>;
}
/**
 * How a message's words are shown (src/channels/progress-render.ts): the parts that are code, and whether it arrives
 * quietly. A progress message arrives quietly; the finished reply that follows it is the one that rings.
 */
export interface MessageFormat { spans?: RichSpan[] | undefined; quiet?: boolean | undefined; plain?: boolean | undefined }
/** R17-C (R17-022): one file on its way into a chat. */
export interface OutgoingFile { name: string; mediaType: string; bytes: Uint8Array; caption?: string;
  /** A spoken reply, for the apps that mark a voice message apart from an audio file (Matrix). */
  voice?: boolean }

/** One answer on an approval question, as a button. `value` is what comes back when it is pressed. */
export interface ApprovalButton {
  label: string;
  value: string;
  /** Telegram only: the button opens this HTTPS address as the bot's Mini App instead of sending `value`. */
  webApp?: string;
}

/**
 * The three answers an approval question offers in a chat app, and the letters that stand for them
 * where there are no buttons. "Yes always" is only offered for a task the owner started themselves,
 * the same rule the app's own approval card follows.
 */
export function approvalButtons(fingerprint: string, canAlways: boolean): ApprovalButton[] {
  const answers: [string, string][] = [["Yes", "y"], ...(canAlways ? [["Yes always", "a"] as [string, string]] : []), ["No", "n"]];
  // A button carries its answer and the fingerprint of the exact request, so a yes cannot be
  // replayed against a different one. Telegram allows 64 bytes here and this is at most 34.
  return answers.map(([label, letter]) => ({ label, value: `${letter}:${fingerprint.slice(0, 32)}` }));
}

/** Reads a pressed button, or a typed letter, back into a decision. */
export function readApprovalAnswer(value: string): { decision: "allow" | "deny"; remember: PolicyRemember; fingerprint: string; nonce?: string } | null {
  const [letter, fingerprint = "", nonce] = String(value ?? "").trim().toLowerCase().split(":");
  const identity = { fingerprint, ...(nonce ? { nonce } : {}) };
  if (letter === "y") return { decision: "allow", remember: "session", ...identity };
  if (letter === "a") return { decision: "allow", remember: "always", ...identity };
  if (letter === "n") return { decision: "deny", remember: "session", ...identity };
  return null;
}

/**
 * The words that go out with the buttons, and on their own where a channel has no buttons.
 *
 * Integration review (mac7/chat-approvals): this note is only ever sent to a chat, and a chat may
 * never give a standing yes, so the letter for one is not offered. It used to be, and typing it did
 * not refuse in words — it fell through and sent the assistant the letter "a".
 */
export const approvalFallbackNote = "Reply y for yes, or n for no (or send /approve or /deny).";
/**
 * CHAT-066 (Hermes and OpenClaw): `/approve` and `/deny` typed, for an app with no buttons or a person who would rather
 * type. They answer exactly as a pressed Yes or No does ("y" and "n"), so every rule for a chat's yes still holds.
 */
export function typedApproval(text: string): "y" | "n" | null {
  const match = /^\/(approve|yes|deny|no)(?:@[\w.-]+)?\s*$/i.exec(text.trim());
  if (!match) return null;
  return ["approve", "yes"].includes(match[1]!.toLowerCase()) ? "y" : "n";
}
export const nothingToApprove = "Nothing here is waiting for a yes or no.";
/** Added where the app reads reactions on the question (src/channels/reaction-answers.ts). */
export const reactionNote = "Or react \u{1F44D} or \u{1F44E} to this message.";
/** PR #289: a typed answer that cannot be matched to the question this chat was shown, while several wait. */
export const severalWaitingInChat = "More than one request is waiting in this conversation. Answer them with their own buttons, or in the app.";
/** PR #289: the question the chat was shown no longer waits, so a "y" cannot answer it. */
export const shownQuestionEnded = "That question is no longer waiting. Here is the question waiting now:";
/**
 * A pressed button, as opposed to a typed letter: it carries the fingerprint of the exact request.
 * Pressing the same button again must not become a new task saying "y:8f3a…", so a payload of this
 * shape that answered nothing is answered with words instead of being run.
 *
 * It covers two cases that look the same from here and must not be told apart wrongly: the question
 * has gone, and the button belongs to a different request from the one waiting now. The words
 * therefore promise neither — they say the button no longer fits and what to do next.
 */
const buttonPayload = /^[yan]:[0-9a-f]{1,32}(?::[0-9a-f]{12})?$/;
export const staleButtonNote =
  "That button does not match the question waiting here. Send me a message and I will ask again.";
export const ChannelPolicySchema = z.object({
  activation: z.enum(["mention", "always"]).default("mention"),
  pairing: z.boolean().default(true),
  allowlist: z.array(z.string().min(1).max(64)).max(64).default([]),
}).strict();
export type ChannelPolicy = z.infer<typeof ChannelPolicySchema>;
export type Outcome = "replied" | "ignored" | "pairing" | "rejected" | "failed";
const pairSchema = z.object({
  status: z.enum(["pending", "approved"]), code: z.string().length(6), name: z.string().max(120),
  requestedAt: z.string(), approvedAt: z.string().optional(),
}).strict();
type Pair = z.infer<typeof pairSchema>;

/**
 * A message passed to a running task. `pending` is true while a voice note is still being written
 * out: it keeps its place in the line, so a quicker message sent after it cannot overtake it.
 */
interface TurnNote { text: string; message: InboundMessage; passed?: boolean; late?: boolean; pending?: boolean }
/** One chat's task while it gathers messages and works. */
interface ChatTurnState extends ChatTurn {
  phase: "gathering" | "running";
  dropped: boolean;
  messages: InboundMessage[];
  notes: TurnNote[];
  waiters: ((outcome: Outcome) => void)[];
  live: LiveStatus | null;
  reply: ReplyStream | null;
  /** Whether this answer's messages quote the person's message (src/channels/reply-style.ts). */
  quote: QuoteState;
}
const chatKey = (message: InboundMessage): string => `${message.channel}\u0001${message.chatId}`;
/** Telegram's /start, alone or with its deep-link word, and addressed to this bot in a group ("/start@name"). */
const startCommand = /^\/start(?:@\w+)?(?:\s+\S{0,64})?$/i;
/** One turn gathers at most this many messages, and never more words than a task may start with. */
const turnMessages = 10, turnCharacters = 12000;
function fitsTurn(messages: InboundMessage[], next: InboundMessage): boolean {
  const size = [...messages, next].reduce((sum, m) => sum + m.text.length + (m.chatTitle?.length ?? 0) + m.senderName.length + 10, 0);
  return messages.length < turnMessages && size <= turnCharacters;
}
/**
 * Edited messages: a new version arriving once its message is already being answered is a message of its own. It keeps
 * the original as the one a reaction goes on, and gets an id of its own so it is not taken for a repeat.
 */
function editedAsNew(message: InboundMessage): InboundMessage {
  return { ...message, edited: false, reactTo: message.reactTo ?? message.messageId, messageId: `${message.messageId}:edited:${Date.now().toString(36)}` };
}
/** A note turned back into a message of its own, with the words already written out. */
function withText(note: TurnNote): InboundMessage {
  // A voice note still being written out goes on as it is, and the next turn writes it out itself.
  if (note.pending) return note.message;
  const { voice, ...rest } = note.message;
  void voice;
  return { ...rest, text: note.text };
}
/**
 * Who a note came from, as the task is told. A chat cannot prove who is typing, so a note from a chat
 * always names its sender and never speaks as the owner (see src/steer.ts).
 */
function noteSender(message: InboundMessage): string {
  const where = message.chatKind === "group" ? ` in ${message.chatTitle ?? "a group"}` : "";
  return `${message.senderName}${where} on ${message.channel}`;
}
/** A message that goes over the sender's ceiling is told so at most once in this many milliseconds. */
const ceilingNoticeMs = 60_000;

/** A stored file's name, cut to the store's longest, keeping a short extension such as `.pdf`. */
function fitName(prefix: string, name: string): string {
  const room = maxArtifactName - prefix.length;
  if (name.length <= room) return prefix + name;
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 && name.length - dot <= 10 ? name.slice(dot) : "";
  return prefix + name.slice(0, Math.max(1, room - extension.length)) + extension;
}

export class ChannelRouter {
  private readonly adapters = new Map<string, { adapter: ChannelAdapter; policy: ChannelPolicy }>();
  /** PR #289: the question each chat was last shown (its conversation and fingerprint), so a typed "y" answers that one and no other. */
  private readonly shownInChat = new Map<string, { sessionId: string; fingerprint: string }>();
  private readonly shownCommands = new Map<string, string>();
  readonly deliveries: Deliveries;
  private pump: ReturnType<typeof setInterval> | undefined;
  private flushing: Promise<void> = Promise.resolve();
  /**
   * The last look at a message before it leaves this computer: personal details are hidden and,
   * when the owner has switched it on, the provider's content check runs. `createBranch` connects
   * the real check; on its own this lets everything through unchanged.
   */
  outboundGuard: (text: string) => Promise<{ text: string; blocked: boolean; reason?: string }> =
    async (text) => ({ text, blocked: false });
  /**
   * R17-A (Trunks): a plain refusal when a chat app may not reach the Trunk whose conversation this
   * chat is linked to (src/trunks/). `createBranch` connects it; on its own every chat is answered.
   */
  trunkReach: (channel: string, sessionId: string) => string | null = () => null;
  /** The name of the Trunk whose conversation this chat is linked to, for the /start welcome; null uses the assistant's. */
  trunkName: (sessionId: string) => string | null = () => null;
  // ---- defaulttrunk: one thread per chat, with the Trunk the chat is routed to (src/channels/threads.ts) ----
  /**
   * Lane chatparity's binding for this chat (src/channels/routes.ts: exact chat, its parent, the whole app), or null.
   * `createBranch` connects it; on its own no chat is bound.
   */
  bindingFor: (channel: string, chatId: string) => string | null = () => null;
  /** The Trunk a chat with no binding starts its thread with: the default Trunk. `createBranch` connects it. */
  defaultTrunk: () => string | null = () => null;
  /** Like trunkReach, for a Trunk a new thread is about to start with. */
  trunkIdReach: (channel: string, trunkId: string) => string | null = () => null;
  /** The Trunk a conversation is a thread with, written on the chat's record. */
  trunkOfConversation: (sessionId: string) => string | null = () => null;
  /** The Trunk a chat's next new thread goes to. */
  chatTrunk(channel: string, chatId: string): string | null {
    return this.bindingFor(channel, chatId) ?? this.defaultTrunk();
  }
  // ---- end defaulttrunk ----
  /**
   * Batch 26 (wave 8): the ceiling the owner set for one person messaging from outside. `createBranch`
   * connects the real counter; on its own nothing is limited. Somebody who reaches it is told so in
   * one sentence and their message is let go rather than queued behind everybody else's, because a
   * stranger waiting silently for a minute looks exactly like Branch being broken.
   */
  senderCeiling: ((channel: string, senderId: string) => { ok: boolean; reason: string }) | undefined;
  /**
   * Turns a voice note into words. `createBranch` connects the real voice service; on its own this
   * says plainly that nothing is set up, so a voice note is never silently dropped.
   */
  transcribeVoice: (clip: { bytes: Uint8Array; mediaType: string; name: string; seconds?: number | undefined }) => Promise<string> =
    async () => { throw new Error("Voice notes are not set up on this computer yet"); };
  /**
   * Reads a reply aloud so it can be sent back as a voice note, but only when the owner has asked
   * for that. Returning null means "send the words instead", which is what happens by default.
   */
  speakReply: (text: string) => Promise<{ bytes: Uint8Array; mediaType: string } | null> = async () => null;
  /**
   * Messages from one chat that arrive within this many milliseconds of the first become one
   * turn, so a thought typed as three quick messages is answered once.
   */
  mergeWindowMs = 1000;
  /** How often the chat's typing, reaction and progress message are refreshed. */
  liveTiming: LiveTiming = defaultLiveTiming;
  /** The fewest milliseconds between two edits of a progress message in a group (Telegram: about 20 messages a minute). */
  groupEditEveryMs = 3000;
  /**
   * Whether typing, reactions and progress messages may be shown at all. `createBranch` turns them
   * off while Lockdown is on, as it does every other outbound message.
   */
  liveAllowed: () => boolean = () => true;
  /** A masked picture of this task's own Branch browser window now, or null (none open, or a borrowed browser). */
  browserPicture: (runId: string) => Promise<{ frame: Uint8Array; url: string; title: string } | null> = async () => null;
  /**
   * Take over or Hand back a chat task's browser from the chat (src/index.ts wires it to the browser controls): "take"
   * pauses the task at its next browser step for the owner; "give" lets it carry on. Resolves with who holds it now, or
   * throws the plain reason it cannot. `held` says who holds it without changing anything.
   */
  browserHold: ((runId: string, op: "take" | "give" | "held") => Promise<"owner" | "task" | "none">) | undefined;
  /** The Telegram Mini App's address for this task's browser, while the owner's phone can reach it; null otherwise. */
  miniAppUrl: ((runId: string) => string | null) | undefined;
  /** Whether Branch is locked (the App lock). `createBranch` connects it; commands from a chat stop while it is. */
  appLocked: () => boolean = () => false;
  /**
   * Hides key-shaped values and known secrets in what the live status shows (step labels, streamed
   * text). `createBranch` connects the leak guard; on its own this changes nothing.
   */
  hideLeaks: (text: string) => string = (text) => text;
  private readonly ceilingNotices = new Map<string, number>();
  /** The newest message each chat sent that was let in, so an answer knows a newer one came in before it went out. */
  private readonly latest = new Map<string, string>();
  private readonly turns = new Map<string, ChatTurnState>();
  /** How many chats may have a task working at the same time. */
  maxChatTasks = 4;
  private chatTasks = 0;
  private readonly slotWaiters: (() => void)[] = [];
  constructor(private readonly store: Store, private readonly runtime: Runtime, public pumpMs = 10000) {
    this.deliveries = new Deliveries(store, runtime.owner);
    this.deliveries.splitting = () => this.switches().splitting;
    // owner-dm-full: the owner's own verified direct chat is the owner along its whole task (src/key-context.ts).
    setOwnerChatCheck(store, (runId) => this.ownerFullRun(runId));
  }
  async attach(adapter: ChannelAdapter, policy: ChannelPolicy): Promise<void> {
    if (this.adapters.has(adapter.id)) throw new Error(`Channel ${adapter.id} is already attached`);
    installChannelFormatting(adapter, () => channelFormatting(this.store, this.runtime.owner, adapter.kind));
    this.adapters.set(adapter.id, { adapter, policy: ChannelPolicySchema.parse(policy) });
    // This resolves once the message has been dealt with. An adapter that reads messages one by one
    // must not wait for it, or a note sent to a running task could never get through (see telegram.ts).
    try { await adapter.start(this.handlerFor()); }
    catch (error) {
      // A channel that did not start is not connected: left in the list, it would be reported as
      // connected and every later attempt to connect it again would be refused as a second copy.
      if (this.adapters.get(adapter.id)?.adapter === adapter) this.adapters.delete(adapter.id);
      throw error;
    }
    if (!this.pump) { this.pump = setInterval(() => void this.flush(), this.pumpMs); this.pump.unref(); }
    void this.refreshCommandMenus(); // CHAT-161: the app's own command picker lists what this chat can send
    if (!this.watchdog) { this.watchdog = setInterval(() => void this.watchTick(), this.watchdogMs); this.watchdog.unref(); }
    if (this.intake().presence) void this.presence(adapter, presenceWords.online);
    await this.flush();
  }
  /** What every app hands its messages to; the same one is handed again when a stalled app is started again. */
  private handlerFor(): (message: InboundMessage) => Promise<void> {
    return (message) => this.handle(message).then(() => undefined);
  }
  /** Presence as saved; a store already closed (Branch shutting down after it) says nothing, so nothing is sent. */
  private presenceOn(): boolean {
    try { return this.intake().presence; } catch { return false; }
  }
  /** Settings › Chat apps (intake-settings.ts): read fresh each time. */
  intake(): ChatIntake { return readChatIntake(this.store, this.runtime.owner); }
  /**
   * Presence: says "Online" or "Offline, back soon" in the bot's short description, on the apps that have one. Never
   * while Lockdown is on (nothing goes out then); a failure is written to the diagnostics, never thrown.
   */
  async presence(adapter: ChannelAdapter, words: string): Promise<void> {
    if (!adapter.setPresence || !this.liveAllowed()) return;
    await adapter.setPresence(words).catch((error: unknown) =>
      diagnose("channels", "warn", `${adapter.kind} would not take its online status: ${error instanceof Error ? error.message : String(error)}`));
  }
  /** Presence switched on or off in Settings: says so on every connected app now ("" clears the description). */
  async presenceChanged(on: boolean): Promise<void> {
    await Promise.allSettled([...this.adapters.values()].map(({ adapter }) => this.presence(adapter, on ? presenceWords.online : "")));
  }
  /**
   * The watchdog (Settings › Chat apps › Staying connected), every `watchdogMs`: an app with no contact for the
   * owner's "stalled after" is stalled; stalled for "reconnect after", it is started again (at most once per that
   * wait), and one still stalled after being started again, or that could not start, says so on its card. An app
   * that is reached with nothing new is never restarted.
   */
  /**
   * CHAT-134: one beat of the watchdog. A beat that comes far later than it should means this computer slept: every
   * connection is then started again at once (a socket or long poll from before a sleep usually never says it died),
   * rather than waiting for "stalled after" to pass. Otherwise the usual stall check.
   */
  async watchTick(now = Date.now()): Promise<void> {
    const slept = this.lastBeat !== 0 && now - this.lastBeat > Math.max(60_000, this.watchdogMs * 4);
    this.lastBeat = now;
    if (slept && this.intake().watchdog) await this.wake();
    else await this.checkStalled(now);
  }
  private lastBeat = 0;
  /** After a sleep: every connected app that can start again does, each on its own so one failure stops no other. */
  async wake(): Promise<void> {
    await Promise.allSettled([...this.adapters].map(async ([id, { adapter }]) => {
      if (!adapter.restart) return;
      const state = this.watch.get(id) ?? { restarts: [], lastRestartAt: 0, problem: null };
      this.watch.set(id, state);
      try { await adapter.restart(this.handlerFor()); state.lastRestartAt = Date.now(); state.problem = null; }
      catch (error) { state.problem = `${adapter.kind} could not reconnect after this computer woke: ${error instanceof Error ? error.message : String(error)}`; }
      if (this.adapters.get(id)?.adapter !== adapter) await adapter.stop().catch(() => undefined);
    }));
  }
  async checkStalled(now = Date.now()): Promise<void> {
    const intake = this.intake();
    for (const [id, { adapter }] of this.adapters) {
      const last = adapter.lastContact?.();
      if (last === undefined || !adapter.restart) continue;
      const state = this.watch.get(id) ?? { restarts: [], lastRestartAt: 0, problem: null };
      this.watch.set(id, state);
      const stalledMs = intake.stalledAfterSeconds * 1000, quiet = now - last, stalled = quiet >= stalledMs;
      if (!intake.watchdog || !stalled) { state.problem = null; continue; }
      // "Reconnect after" counts from when it became stalled, not from its last contact.
      const wait = intake.reconnectMinutes * 60_000;
      if (quiet < stalledMs + wait || now - state.lastRestartAt < wait) continue;
      if (state.lastRestartAt && last < state.lastRestartAt)
        state.problem = `${adapter.kind === "telegram" ? "Telegram" : adapter.kind} stopped receiving, and starting it again did not bring it back. Branch keeps trying.`;
      state.lastRestartAt = now;
      const today = Date.now(); // the count on the card is by the wall clock
      state.restarts = [...state.restarts.filter((at) => today - at < 86_400_000), today];
      try { await adapter.restart(this.handlerFor()); }
      catch (error) {
        state.problem = `${adapter.kind === "telegram" ? "Telegram" : adapter.kind} stopped receiving, and Branch could not start it again: ${error instanceof Error ? error.message : String(error)}`;
      }
      // Taken out (its token replaced, or Branch stopping) while it was being started again: stop what the restart
      // began, or a second poller would keep running for an app that is no longer connected.
      if (this.adapters.get(id)?.adapter !== adapter) await adapter.stop().catch(() => undefined);
    }
  }
  /** How often the watchdog looks. */
  watchdogMs = 15_000;
  private watchdog: ReturnType<typeof setInterval> | undefined;
  private readonly watch = new Map<string, { restarts: number[]; lastRestartAt: number; problem: string | null }>();
  /** The connected channel with this id, for routes that must hand a request to one. */
  adapter(id: string): ChannelAdapter | undefined { return this.adapters.get(id)?.adapter; }
  /** Stops one channel and takes it out, so it can be connected again (a Telegram bot token replaced on its card). */
  async detach(id: string): Promise<void> {
    const attached = this.adapters.get(id);
    if (!attached) return;
    this.adapters.delete(id);
    this.watch.delete(id); // a new connection under this id starts with a clean watchdog card
    await attached.adapter.stop();
  }
  async detachAll(): Promise<void> {
    if (this.pump) clearInterval(this.pump);
    this.pump = undefined;
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = undefined;
    if (this.presenceOn())
      await Promise.allSettled([...this.adapters.values()].map(({ adapter }) => this.presence(adapter, presenceWords.offline)));
    const stops = [...this.adapters.values()].map(({ adapter }) => adapter.stop());
    this.adapters.clear();
    await Promise.allSettled(stops);
  }
  /** Sends every due chunk on every connected channel, one flush at a time. */
  flush(): Promise<void> {
    return (this.flushing = this.flushing.then(async () => {
      for (const [id, { adapter }] of this.adapters)
        await this.deliveries.flush(id, (chatId, text, replyTo) => adapter.send(chatId, text, replyTo))
          .catch((error: unknown) => diagnose("channels", "warn", `Messages waiting for ${adapter.kind} could not be sent: ${error instanceof Error ? error.message : String(error)}`)); // mac7/diagnostics
    }));
  }
  /** Outbound messages that are waiting or gave up, for the owner to see and retry. */
  outstanding() {
    return this.deliveries.outstanding().map((d) => ({ id: d.id, channel: d.channel, chatId: d.chatId, status: d.status, attempts: d.attempts,
      lastError: d.lastError, nextAt: d.nextAt, preview: d.text.slice(0, 120), createdAt: d.createdAt }));
  }
  async retryDelivery(id: string) {
    const row = this.deliveries.retry(id);
    await this.flush();
    return this.deliveries.list().find((d) => d.id === row.id) ?? row;
  }
  summary() {
    const owner = this.runtime.owner;
    return {
      channels: [...this.adapters.values()].map(({ adapter, policy }) => ({ id: adapter.id, kind: adapter.kind, botName: adapter.botName(),
        health: this.watch.get(adapter.id)?.problem ? { state: "needs attention" as const, reason: this.watch.get(adapter.id)!.problem! } : adapter.health?.() ?? { state: "connected" as const },
        // Staying connected: when the app last answered, and how often the watchdog started it again today.
        ...(adapter.lastContact ? { watchdog: { lastContactAt: new Date(adapter.lastContact()).toISOString(),
          reconnectsToday: (this.watch.get(adapter.id)?.restarts ?? []).filter((at) => Date.now() - at < 86_400_000).length } } : {}),
        ...(adapter.needsAppReview ? { needsAppReview: true } : {}), ...(adapter.replyQuotes ? { replyQuotes: true } : {}), ...policy })),
      pending: this.pairs(owner).filter((p) => p.status === "pending"),
      approved: this.pairs(owner).filter((p) => p.status === "approved"),
      chats: this.chats(owner),
      live: this.switches(),
      intake: this.intake(), // Settings › Chat apps: what the Trunk sees, staying connected
      // mac7/chat-allowlist: what a chat's task may use beyond talking, for the Chat apps card.
      permissions: this.permissionSettings(),
      ownerCommands: ownerCommands(this.store, owner),
      // owner-dm-signin: whether any chat account is named as the owner's yet, so approving a pairing may offer "this is me".
      ownerNamed: ownerAccountNamed(this.store, owner),
      // Settings › Chat apps › Show steps in chats: the knobs, for every app and for each (src/channels/steps-display.ts).
      steps: this.stepsView(),
    };
  }
  /** The steps knobs with what each connected app can do and what it will show, for the Chat apps card. */
  stepsView() {
    return { settings: this.stepsSettings(), apps: [...this.adapters.values()].map(({ adapter }) => {
      const caps = stepsCapsOf(adapter.kind), display = this.stepsDisplay(adapter.id);
      const name = caps ? (adapter.id === adapter.kind ? caps.name : `${caps.name} (${adapter.id})`) : adapter.id;
      return { id: adapter.id, kind: adapter.kind, name, edit: !!adapter.edit, display,
        shows: caps ? stepsBehaviour(caps, display) : stepsBehaviour({ kind: adapter.kind, name: adapter.kind, edit: !!adapter.edit,
          code: "plain", maxText: adapter.maxTextLength ?? 3500, reactions: !!adapter.react, typing: !!adapter.sendTyping, replies: false,
          ...(adapter.paidPerMessage ? { paid: true } : {}) }, display) };
    }) };
  }
  /** Changes the chat extras' switches (chat-live-settings.ts); the ones not named stay as they are. */
  setSwitches(input: unknown): ChatLiveSwitches {
    const switches = saveChatLiveSwitches(this.store, this.runtime.owner, input);
    void this.refreshCommandMenus();
    return switches;
  }
  private menuChain: Promise<void> = Promise.resolve();
  /**
   * CHAT-161: every connected app's own command picker, from the one command table: the commands a chat can send with
   * the owner's switches as they are now, and none while chat commands are off, so a picker never offers a command
   * that would be read as an ordinary message. One refresh at a time; a failure is written down, never thrown.
   */
  refreshCommandMenus(): Promise<void> {
    return this.menuChain = this.menuChain.then(async () => {
      const commands = this.switches().commands === "off" ? [] : chatCommandsFor(commandMode(this.store, this.runtime.owner))
        .map((one) => ({ command: one.name, description: one.description }));
      const unique = [...new Map(commands.filter((one) => /^[a-z0-9_-]{1,32}$/.test(one.command)).map((one) => [one.command, one])).values()].slice(0, 100);
      await Promise.all([...this.adapters.values()].map(async ({ adapter }) => {
        try { await adapter.setCommands?.(unique); }
        catch (error) { diagnose("channels", "warn", `The command menu could not be updated on ${adapter.kind}: ${error instanceof Error ? error.message : String(error)}`); }
      }));
    });
  }
  setOwnerCommandSettings(input: unknown) {
    return saveOwnerCommands(this.store, this.runtime.owner, input);
  }
  /**
   * Queues text for a chat and sends it if the channel is up. The key makes a repeat call a no-op,
   * so a task finished while the channel was down is delivered once, in order, after reconnect.
   */
  async deliver(channel: string, chatId: string, text: string, key = `delivery:${Date.now()}:${randomInt(1e9)}`, replyTo?: string): Promise<{ messageId?: string | undefined; queued: number; sent: boolean }> {
    const target = this.adapters.get(channel);
    if (!target) throw new Error(`Channel ${channel} is not connected`);
    const checked = await this.outboundGuard(text);
    if (checked.blocked) throw new Error(checked.reason ?? "The message was held back before it was sent");
    this.deliveries.enqueue(channel, chatId, checked.text, key, replyTo, target.adapter.maxTextLength);
    await this.flush();
    const now = this.deliveries.list().filter((d) => d.key === key);
    const first = now.find((d) => d.seq === 0);
    if (first?.status === "dead") throw new Error(`Could not deliver to ${channel}: ${first.lastError ?? "unknown error"}`);
    // PR #289 review 2: `sent` is true once every chunk reached the chat, whether or not the app returns a message id.
    return { messageId: first?.messageId ?? undefined, queued: now.filter((d) => d.status === "pending").length,
      sent: now.length > 0 && now.every((d) => d.status === "sent") };
  }
  /** Points a chat at an existing conversation so both surfaces share one ordered history. */
  link(owner: string, input: unknown) {
    const { channel, chatId, sessionId } = z.object({ channel: z.string().min(1).max(64), chatId: z.string().min(1).max(64), sessionId: z.string().uuid() }).strict().parse(input);
    if (!this.store.ownsSession(owner, sessionId)) throw new Error("Session not found");
    const trunkId = this.trunkOfConversation(sessionId);
    // defaulttrunk: the conversation the chat had before is kept in its thread's history (src/channels/threads.ts).
    saveChatThread(this.store, owner, channel, chatId, { sessionId, updatedAt: new Date().toISOString(), linked: true,
      ...(trunkId ? { trunkId } : { trunkId: undefined }) });
    audit(this.store, owner, { action: "channel.paired", actor: owner, subject: `${chatId} on ${channel}`,
      reason: "A chat was pointed at one of your conversations, so both share one history", outcome: "saved" });
    return { channel, chatId, sessionId };
  }
  /** Chats that have talked to the assistant, usable as delivery targets. */
  chats(owner: string) {
    return this.store.list("settings", owner).flatMap((record) => {
      if (!record.id.startsWith("channel-session:")) return [];
      const data = record.data as Partial<ChatThread>;
      return data.channel && data.chatId ? [{ channel: data.channel, chatId: data.chatId, title: data.title ?? data.chatId, updatedAt: data.updatedAt ?? record.updatedAt, sessionId: data.sessionId ?? null,
        trunkId: data.trunkId ?? null, earlier: data.earlier ?? [] }] : []; // defaulttrunk
    });
  }
  async handle(message: InboundMessage): Promise<Outcome> {
    const entry = this.adapters.get(message.channel);
    if (!entry) return "ignored";
    if (message.edited && !this.intake().edited) return "ignored"; // Settings › Chat apps › Edited messages, off
    const { adapter, policy } = entry;
    if (message.chatKind === "group" && policy.activation === "mention" && !message.addressed) return "ignored";
    // ---- r17-i: a chat app the owner paused, and /platform from the owner's own account (src/reach/platform.ts) ----
    const held = platformGate(this.store, this.runtime.owner, message);
    if (held) {
      if (held.reply) await adapter.send(message.chatId, held.reply, this.quoteFor(message)).catch(() => undefined);
      return "ignored";
    }
    // ---- end r17-i ----
    const access = this.access(message, policy);
    if (access !== "allowed") {
      if (message.caughtUp) return "ignored"; // mac6/bucket-16 integration
      const text = access === "pairing"
        ? `I don't know you yet. Ask my owner to approve code ${this.pairingCode(message)} under Settings → Channels, then message me again.`
        : "This assistant is private.";
      await adapter.send(message.chatId, text, this.quoteFor(message));
      return access;
    }
    this.latest.set(chatKey(message), message.messageId);
    // Checked without waiting, so messages from one chat still reach `answer` in the order they came.
    if (this.overCeiling(message)) return "rejected";
    return this.answer(message);
  }
  /**
   * Batch 26 (wave 8), enforced here since wave mac2: somebody who has sent as much as the owner allows
   * for one person is told so once a minute, and the message is let go. "/stop" always gets through, so
   * nobody is left unable to stop their own task. With no ceiling set, nobody is limited.
   */
  private overCeiling(message: InboundMessage): boolean {
    if (!this.senderCeiling || this.commandIn(message)?.name === "stop") return false;
    const verdict = this.senderCeiling(message.channel, message.senderId);
    if (verdict.ok) return false;
    const key = `${message.channel}\u0001${message.senderId}`, now = Date.now();
    if ((this.ceilingNotices.get(key) ?? 0) + ceilingNoticeMs <= now) {
      this.ceilingNotices.set(key, now);
      void this.deliver(message.channel, message.chatId, verdict.reason, `ceiling:${message.channel}:${message.messageId}`, this.quoteFor(message))
        .catch(() => undefined);
    }
    return true;
  }
  /**
   * A voice note becomes an ordinary message: the words are written out first, and the transcript
   * is quoted back so the person can see what was heard before reading the answer.
   */
  private async spoken(message: InboundMessage): Promise<string> {
    if (!message.voice) return message.text;
    const bytes = await message.voice.bytes();
    const text = await this.transcribeVoice({
      bytes, mediaType: message.voice.mediaType, name: `voice-note-${message.messageId}`, seconds: message.voice.seconds,
    });
    return [message.text, text].filter(Boolean).join("\n").trim();
  }
  /**
   * Answers a voice note with a voice note, when the owner has switched that on and the channel
   * accepts one. The words have already been sent, so a failure here changes nothing for the person.
   */
  private async voiceReply(message: InboundMessage, text: string, replyTo: string | undefined): Promise<void> {
    const adapter = this.adapters.get(message.channel)?.adapter;
    if (!adapter?.sendVoice) return;
    const checked = await this.outboundGuard(text);
    if (checked.blocked) return;
    const spoken = await this.speakReply(checked.text);
    if (!spoken) return;
    await adapter.sendVoice(message.chatId, spoken.bytes, spoken.mediaType, replyTo);
  }
  /** The conversation this chat is carrying on, when there is one. */
  private sessionFor(channel: string, chatId: string): string | undefined {
    const owner = this.runtime.owner;
    const saved = this.store.get("settings", owner, `channel-session:${channel}:${chatId}`)?.data as { sessionId?: string } | undefined;
    return saved?.sessionId && this.store.ownsSession(owner, saved.sessionId) ? saved.sessionId : undefined;
  }

  /**
   * Answers the question a paused task in this chat's conversation stopped on. It is the same
   * approval route the app uses, bound to the same exact-bytes fingerprint, and the record of what
   * the assistant was allowed to do says which chat app the answer came from.
   *
   * Returns null when this chat has nothing waiting, so an ordinary message that happens to be the
   * single letter "n" is still an ordinary message.
   */
  async answerApproval(
    channel: string, chatId: string, value: string,
    /** Who typed it and whether this is a one-to-one chat (mac7/chat-approvals); both are needed
     *  before a chat's own yes may answer a question about what one of the owner's lines granted. */
    from?: { senderId?: string; chatKind?: InboundMessage["chatKind"]; caughtUp?: boolean | undefined },
  ): Promise<{ decision: string; tool: string; refusal?: string; sessionId?: string; show?: WaitingQuestion | undefined; runId?: string } | null> {
    const read = readApprovalAnswer(value);
    if (!read) return null;
    const sessionId = this.sessionFor(channel, chatId);
    const waiting = sessionId ? this.runtime.waitingApprovals(sessionId) : [];
    if (!sessionId || !waiting.length) return null;
    // mac7/chat-allowlist (integration review): a yes from the chat only answers a question about
    // what every chat may already do. Anything one of the owner's lines granted is approved in the
    // window, unless that same line is one the owner switched on for this person (mac7/chat-approvals).
    // PR #289: a "y" with no code answers only the question this chat was shown (askInChat puts the newest) while it
    // still waits. A chat that was shown nothing, or whose question no longer waits, is shown the one waiting now
    // instead of answering it; with several waiting and none of them the one shown, it is refused in words.
    // A question shown while this chat was pointed at another conversation was not shown for this one.
    const record = this.shownInChat.get(`${channel}\u0000${chatId}`);
    const shown = record?.sessionId === sessionId ? record.fingerprint : undefined;
    const named = read.fingerprint || shown;
    const asked = named ? waiting.find((one) => one.fingerprint === named) : undefined;
    // PR #289 review 2: a button (or typed code) naming a request that no longer waits is left to the stale-button note.
    if (read.fingerprint && !asked) return null;
    // PR #289: the question shown was answered elsewhere or timed out, so a "y" is not about anything waiting now.
    if (shown && !asked && !read.fingerprint) {
      if (waiting.length === 1) {
        return { decision: "show-waiting-question", tool: "", refusal: shownQuestionEnded, sessionId, show: waiting[0] };
      }
      return { decision: "in-window", tool: "", refusal: severalWaitingInChat };
    }
    // PR #289: nothing was shown to this chat (or it restarted since), so the one waiting is shown before any yes.
    if (!asked && !shown && waiting.length === 1) {
      return { decision: "show-waiting-question", tool: "", refusal: "", sessionId, show: waiting[0] };
    }
    if (!asked) return { decision: "in-window", tool: "", refusal: severalWaitingInChat };
    // mac7/chat-approvals (integration review): "a" is a standing yes and never comes from a chat,
    // whatever the owner's lines say. It is answered here, in a sentence, rather than left to throw
    // inside Runtime.approve where the caller's catch turned it back into "not an answer" and the
    // letter went on to the assistant as an ordinary message.
    if (read.remember === "always")
      return { decision: "in-window", tool: asked.tool, refusal: standingYesInWindow };
    const permission = this.runtime.registry.permissionOf(asked.tool);
    const mayApprove = permission === commandPermission
      ? this.commandYesHere(channel, chatId, asked.runId, read.fingerprint, from)
        && !!read.nonce && this.shownCommands.get(`${channel}\u0000${chatId}\u0000${asked.fingerprint}`) === read.nonce
        && commandShown(asked.bytes) !== null && commandBytesExact(asked.tool, asked.bytes, asked.fingerprint)
      : (!!from?.senderId && this.ownerFullFrom({ channel, senderId: from.senderId, chatKind: from.chatKind ?? "group" }))
        || chatMayApprove(permission, this.chatApprovals(channel, from));
    if (read.decision === "allow" && !mayApprove)
      return { decision: "in-window", tool: asked.tool, refusal: approveInWindow(asked.label || asked.tool) };
    // PR #289 second review: the yes lands on exactly the question vetted above, so it still answers while another waits.
    const remember = permission === commandPermission && read.decision === "allow" ? "never" : read.remember;
    const result = this.runtime.approve(sessionId, read.decision, remember, asked.fingerprint, channel);
    this.shownCommands.delete(`${channel}\u0000${chatId}\u0000${asked.fingerprint}`);
    return { decision: result.decision, tool: result.tool, runId: asked.runId };
  }
  /**
   * mac7/chat-approvals: what this person on this app may say yes to from the chat, out of what
   * their own switched-on lines granted. Empty for a sender nobody named, which is the old rule.
   *
   * Only one to one, for the same reason a standing yes is only offered one to one a few lines
   * below: in a group anybody paired may press the button, and a line the owner wrote naming one
   * person — or naming `*` — was not them handing the yes to whoever else is in the room. A group
   * gets what it got before: No, and the sentence saying where the yes belongs.
   */
  private chatApprovals(channel: string, from?: { senderId?: string; chatKind?: InboundMessage["chatKind"] }): string[] {
    if (!from?.senderId || from.chatKind !== "direct") return [];
    return chatApprovablePermissions(chatPermissionSettings(this.store, this.runtime.owner), channel, from.senderId);
  }

  /**
   * Puts a paused task's question to the chat, with buttons where the channel has them and the
   * words "reply y / a / n" where it has not. Sent directly rather than through the waiting line,
   * because the waiting line only knows how to send plain words. PR #289: the question counts as shown
   * to this chat only once the guard let it through and it was sent.
   */
  /**
   * PR #289 review 2: `waiting` is the one question being shown, and its own words go out with its own buttons, so what
   * the chat reads, what its buttons answer and what is recorded as shown are the same request. `lead` goes before it
   * (a quoted message). `key` is the delivery's own: a question shown again gets a new one, so it is sent again.
   */
  private async askInChat(message: InboundMessage, sessionId: string, waiting: WaitingQuestion, lead: string, key: string,
    replyTo: string | undefined = this.quoteFor(message)): Promise<void> {
    const adapter = this.adapters.get(message.channel)?.adapter;
    if (!adapter) return;
    // A command from the owner's own chat is shown whole, as a code block, before its Yes (src/channels/owner-commands.ts).
    const permission = this.runtime.registry.permissionOf(waiting.tool);
    const command = permission === commandPermission && (this.ownerCommandsFrom(message) || this.ownerFullFrom(message))
      && commandBytesExact(waiting.tool, waiting.bytes, waiting.fingerprint) ? commandShown(waiting.bytes) : null;
    const asked = command ? `${lead}${waiting.question}\n\n` : lead + waiting.question;
    const checked = await this.outboundGuard(this.hideLeaks(command ? asked + command : asked));
    if (checked.blocked) return;
    // The command is shown exactly as it will run, or its Yes belongs in the window: a last look that changed any of
    // the words means the chat would be approving something other than what it sees.
    const faithful = command !== null && checked.text === asked + command
      && checked.text.length + 16 <= (adapter.maxTextLength ?? 3500)
      && this.commandYesHere(message.channel, message.chatId, waiting.runId, waiting.fingerprint ?? "", message)
      && !(adapter.kind === "discord" && command.includes("`"))
      // Slack reads <…> as links and mentions and & as an escape even in code, and a backtick breaks the fence.
      && !(adapter.kind === "slack" && /[<>&`]/.test(command));
    // In a group anybody paired may press the button, so a standing yes is only offered one to one.
    // mac7/chat-approvals (integration review): a chat is never offered "Yes always", because a chat
    // may never give one — offering it is offering a button whose only answer is a refusal.
    const canAlways = false;
    // mac7/chat-allowlist (integration review): a question about something one of the owner's lines
    // granted is answered in the window, so the chat is not offered a Yes it cannot give — only No,
    // with the sentence saying where the yes belongs. mac7/chat-approvals: unless the owner switched
    // that line on for this person on this app, in which case the Yes is theirs to press.
    const mayApprove = permission === commandPermission ? faithful
      : this.ownerFullFrom(message) || chatMayApprove(permission, this.chatApprovals(message.channel, message));
    const buttons = approvalButtons(waiting.fingerprint ?? "", canAlways && mayApprove)
      .filter((button) => mayApprove || button.value.startsWith("n"));
    const nonce = permission === commandPermission && faithful ? randomBytes(6).toString("hex") : null;
    if (nonce) for (const button of buttons) button.value += `:${nonce}`;
    const text = mayApprove ? checked.text : `${checked.text}\n\n${approveInWindow(waiting.label || waiting.tool || "that")}`;
    const format = faithful && mayApprove ? { spans: [{ offset: asked.length, length: command!.length, kind: "block" as const, language: "shell" }] } : undefined;
    // An app without buttons that reads reactions (src/channels/reaction-answers.ts) takes a thumbs up or down too.
    const reacts = !adapter.sendButtons && !!adapter.watchAnswers && !!waiting.fingerprint;
    const note = `${mayApprove ? approvalFallbackNote : "Reply n (or /deny) for no."}${reacts ? ` ${mayApprove ? reactionNote : "Or react \u{1F44E}."}` : ""}`;
    let questionId: string | undefined;
    const sent = adapter.sendButtons
      ? await adapter.sendButtons(message.chatId, text, buttons, replyTo, format).then(() => true, () => false)
      : await this.deliver(message.channel, message.chatId, `${text}\n\n${note}`, key, replyTo)
        .then((done) => { questionId = done.messageId; return done.sent; }, () => false);
    // Q259: a question answered elsewhere while it was being sent is not recorded as shown.
    const still = this.runtime.waitingApprovals(sessionId).some((one) => one.fingerprint === waiting.fingerprint && one.runId === waiting.runId);
    if (sent && still && waiting.fingerprint)
      this.shownInChat.set(`${message.channel}\u0000${message.chatId}`, { sessionId, fingerprint: waiting.fingerprint });
    if (sent && still && reacts && questionId) adapter.watchAnswers!(message.chatId, questionId, message.senderId, waiting.fingerprint!);
    if (sent && still && faithful && waiting.fingerprint && nonce) {
      if (this.shownCommands.size >= 1000) this.shownCommands.delete(this.shownCommands.keys().next().value!);
      this.shownCommands.set(`${message.channel}\u0000${message.chatId}\u0000${waiting.fingerprint}`, nonce);
    }
  }

  private async answer(message: InboundMessage): Promise<Outcome> {
    // Telegram sends /start when somebody opens the bot: a welcome, answered here without asking the model.
    if (startCommand.test(message.text.trim()) && !message.voice) return this.welcome(message);
    // ---- bucket 12: one of the owner's saved commands becomes the message it stands for ----
    const saved = this.switches().commands === "off" || message.voice ? null : savedLine(this.store, this.runtime.owner, message.text);
    if (saved && !("text" in saved)) {
      const said = "problem" in saved ? saved.problem : saved.reply;
      await this.deliver(message.channel, message.chatId, said, `saved:${message.messageId}`, this.quoteFor(message)).catch(() => undefined);
      return "replied";
    }
    if (saved) message = { ...message, text: saved.text };
    // ---- end of the bucket 12 hook ----
    // CHAT-185: the owner's own commands from their own direct chat, before the chat's own list.
    const ownerDm = await this.ownerDmLine(message);
    if (ownerDm) return ownerDm;
    // A press on /model's menu is /model with that connection, by the same rules as typing it.
    // The live browser's own buttons in a chat: Take over, and Hand back.
    const hold = /^br:([tg]):([0-9a-f-]{36})$/.exec(message.text.trim());
    if (hold) return this.pressHold(message, hold[1] === "t" ? "take" : "give", hold[2]!);
    const picked = this.modelPicker.read(chatKey(message), this.sessionFor(message.channel, message.chatId), message.text);
    if (picked) return this.pickModel(message, picked);
    const command = this.commandIn(message);
    if (command) return this.command(message, command);
    // A bare "y", "a" or "n" answers whatever this chat's conversation is waiting on, rather than
    // starting a new task. Anything longer is an ordinary message, whatever it happens to say.
    const typed = typedApproval(message.text);
    const answered = await this.answerApproval(message.channel, message.chatId, typed ?? message.text.trim(), message).catch(() => null);
    if (!answered && typed) {
      await this.deliver(message.channel, message.chatId, nothingToApprove, `answer-none:${message.messageId}`, this.quoteFor(message)).catch(() => undefined);
      return "replied";
    }
    if (answered) {
      // PR #289: if the shown question no longer waits, re-show the waiting one instead of answering.
      if (answered.decision === "show-waiting-question" && answered.sessionId && answered.show) {
        const decided = answered.show;
        if (answered.refusal) await this.deliver(message.channel, message.chatId, answered.refusal, `answer-stale:${message.messageId}`, this.quoteFor(message)).catch(() => undefined);
        // PR #289 review 2: the question decided on above, if it still waits after that await, and no other.
        const waiting = this.runtime.waitingApprovals(answered.sessionId).find((one) => one.runId === decided.runId && one.fingerprint === decided.fingerprint);
        if (waiting) await this.askInChat(message, answered.sessionId, waiting, "", `reshow:${message.channel}:${message.messageId}`);
        return "replied";
      }
      // QA R1 follow-up: a yes carries the chat's own waiting task on, and the engine runs the approved call itself.
      const waiting = answered.decision === "allow" && !answered.refusal ? carryable(this.runtime, answered.runId, "channel") : null;
      if (waiting) return this.carryTurn(message, waiting.id);
      if (answered.decision === "allow" && this.runtime.registry.permissionOf(answered.tool) === commandPermission)
        return this.startTurn([{ ...message, text: "Continue with the exact command I just approved." }]);
      await this.deliver(message.channel, message.chatId,
        answered.refusal ? answered.refusal
          : answered.decision === "allow"
            ? `Noted. Send your next message and I will carry on.`
            : `Noted. I will not do that.`,
        `answered:${message.messageId}`, this.quoteFor(message)).catch(() => undefined);
      return "replied";
    }
    // A button pressed twice, pressed after the question went away, or carrying the fingerprint of
    // some other request: say so rather than treating the button's own value as something the
    // person typed and running it as a task.
    if (buttonPayload.test(message.text.trim().toLowerCase())) {
      await this.deliver(message.channel, message.chatId, staleButtonNote,
        `stale:${message.messageId}`, this.quoteFor(message)).catch(() => undefined);
      return "replied";
    }
    const turn = this.turns.get(chatKey(message));
    if (turn) return this.joinTurn(turn, message);
    return this.startTurn([message.edited ? editedAsNew(message) : message]);
  }
  /**
   * The answer to /start: who is answering, where, and how to talk to it, in one short message. Hermes Agent takes
   * /start as a ping and says nothing; a person who just opened the bot is better served by a line saying it works.
   */
  private async welcome(message: InboundMessage): Promise<Outcome> {
    const sessionId = this.sessionFor(message.channel, message.chatId);
    let name = "Branch";
    try { name = (sessionId ? this.trunkName(sessionId) : null) ?? assistantIdentity(this.store, this.runtime.owner).name; } catch { /* the plain name */ }
    // The commands this person may use here, as the router reads them (the switch, or the owner's own paired DM).
    const reads = (text: string) => this.commandIn({ ...message, text }) !== null;
    const hint = reads("/help") ? "Tap Menu or type / for commands: /new starts afresh, /stop stops a task, /help lists the rest."
      : this.switches().commands === "when-needed" ? "While I work, /stop stops me and /status says what I am doing." : "";
    // The computer's name is for the owner's own chats; a group only hears that this is Branch.
    const where = message.chatKind === "direct" ? ` on ${hostname()}` : "";
    const text = [`Hi, I'm ${name}, running in Branch${where}.`,
      "Ask me anything or give me something to do, and I will answer here.", hint].filter(Boolean).join(" ");
    await this.deliver(message.channel, message.chatId, text, `start:${message.channel}:${message.messageId}`, this.quoteFor(message)).catch(() => undefined);
    return "replied";
  }
  /** The owner's on / off / when-needed switches for the chat extras (chat-live-settings.ts). */
  switches(): ChatLiveSwitches {
    return chatLiveSwitches(this.store, this.runtime.owner);
  }
  /** One of the accounts the owner named as their own: in "Commands from your own chat" or as a /platform owner. */
  private ownAccount(channel: string, senderId: string): boolean {
    const same = (account: { channel: string; sender: string }) => account.channel === channel && account.sender === senderId;
    return ownerCommands(this.store, this.runtime.owner).accounts.some(same) || platformSettings(this.store, this.runtime.owner).owners.some(same);
  }
  /** The command a message is, if commands are switched on for this moment. */
  private commandIn(message: InboundMessage): ChatCommand | null {
    // Starting a fresh conversation is part of the thread model, even when optional slash commands are off.
    if (!message.voice && /^\/(?:new|reset|clear)(?:@[a-z0-9_]+)?\s*$/i.test(message.text.trim()))
      return { name: "new", argument: "" };
    const setting = this.switches().commands;
    // As shipped, the owner's own paired direct chat reads commands even with the switch off (chat-live-settings.ts).
    // Only an account the owner named as their own (Commands from your own chat, or /platform's owners) counts:
    // a paired friend or household member keeps the switch as it is.
    const pairedDm = setting === "off" && message.chatKind === "direct" && this.pair(message.channel, message.senderId)?.status === "approved"
      && this.ownAccount(message.channel, message.senderId) && commandsInPairedDm(this.store, this.runtime.owner);
    if ((setting === "off" && !pairedDm) || message.voice) return null;
    // Wave mac3 (commands): which of the shared table's commands a chat may read follows the owner's switch.
    const command = parseChatCommand(message.text, commandMode(this.store, this.runtime.owner));
    if (!command || setting === "on" || pairedDm) return command;
    // "When needed": only the commands for a task that is working, and only while one is; and, at any time, "/new"
    // (or "/reset"), which starts a fresh thread in this chat and keeps the one before (defaulttrunk, src/channels/threads.ts).
    const busy = this.turns.has(chatKey(message));
    return (busy && chatCommandSpec(command.name).whileWorking) || command.name === "new" ? command : null;
  }
  /**
   * What a task started from a chat may use: the short safe list (src/channels/chat-permissions.ts),
   * plus whatever the owner has allowed this chat app and this person. Everything else is refused,
   * including any permission added to Branch later.
   *
   * owner-dm-full: the one exception is the owner's own verified direct chat with "Your own chats have your full
   * access" on (`ownerFullFrom`): that is the owner, so it gets everything a task the owner starts in the window gets,
   * as OpenClaw's main session does. A paired friend, a household person, a group or an app that cannot vouch for its
   * senders keeps the short list.
   */
  private chatPermissions(from?: Pick<InboundMessage, "channel" | "senderId" | "chatKind" | "caughtUp">): string[] {
    if (from && this.ownerFullFrom(from)) return this.runtime.registry.permissions();
    const settings = chatPermissionSettings(this.store, this.runtime.owner);
    const extra = from ? chatExtraPermissions(settings, from.channel, from.senderId) : [];
    const allowed = chatPermissionsAllowed(this.runtime.registry.permissions(), extra);
    // The one exception to "a chat never runs a program": the owner's own account, in a direct chat, on an app that
    // proves who sent it, with the part on (src/channels/owner-commands.ts). Every command still asks.
    return from && this.ownerCommandsFrom(from) && this.runtime.registry.permissions().includes(commandPermission)
      ? [...allowed, commandPermission] : allowed;
  }
  /**
   * owner-dm-full: whether this chat message is the owner's own, with the owner's full access, now (read afresh every
   * time): the switch on, no Lockdown and no App lock, one of the owner's own named accounts in a direct chat on an app
   * that vouches for its senders (`ownerDmHere`), still allowed to talk to Branch. A message fetched after a restart is
   * the same person's (the app vouched for it), so its freshness is not asked, as `ownerDmRun` does.
   */
  private ownerFullFrom(from: Pick<InboundMessage, "channel" | "senderId" | "chatKind" | "caughtUp">): boolean {
    if (!this.ownerChatsOn()) return false;
    const kind = this.adapters.get(from.channel)?.adapter.kind ?? "";
    return ownerDmHere(this.store, this.runtime.owner, kind, { channel: from.channel, senderId: from.senderId, chatKind: from.chatKind, caughtUp: false })
      && this.senderAllowed(from.channel, from.senderId);
  }
  /** owner-dm-full: the same for a whole task, along its chain (src/key-context.ts asks this for `runOrigin`). */
  ownerFullRun(runId: string): boolean {
    return this.ownerChatsOn() && this.ownerDmRun(runId);
  }
  /**
   * owner-dm-full: the owner's own chat's conversation starts on what a new conversation in the window starts on
   * (Settings › Permissions › New conversations, e.g. Full access). A conversation that already exists is given it once,
   * only when it has no mode of its own and the start is looser than the owner's setting (so it never freezes one on
   * something stricter); one the owner picked is never changed. Null when it follows the owner's setting, or the
   * conversation is new (then returned for the task to start it with).
   */
  private ownerChatMode(sessionId: string | undefined): ConversationMode | null {
    const wanted = conversationModeSettings(this.store, this.runtime.owner).newConversation;
    if (wanted === "follow") return null;
    if (!sessionId) return wanted;
    if (!readConversationMode(this.store, this.runtime.owner, sessionId) && looserThan(wanted, readPolicy(this.store, this.runtime.owner).preset))
      this.runtime.startMode(sessionId, wanted);
    return null;
  }
  /** owner-dm-full: the switch is on and nothing holds the app (Lockdown, the App lock). */
  private ownerChatsOn(): boolean {
    return chatPermissionSettings(this.store, this.runtime.owner).ownerChats
      && !lockedDown(this.store, this.runtime.owner) && !this.appLocked();
  }
  /** Whether this chat message is the owner's own and may ask to run a command, now (read afresh every time). */
  private ownerCommandsFrom(from: Pick<InboundMessage, "channel" | "senderId" | "chatKind" | "caughtUp">): boolean {
    const adapter = this.adapters.get(from.channel)?.adapter;
    const kind = adapter?.kind ?? "";
    const held = lockedDown(this.store, this.runtime.owner) || this.appLocked();
    return ownerCommandsHere(ownerCommands(this.store, this.runtime.owner),
      { channel: from.channel, kind, senderId: from.senderId, chatKind: from.chatKind, caughtUp: from.caughtUp }, held)
      && this.pair(from.channel, from.senderId)?.status === "approved"
      && !!adapter?.sendButtons
      && this.senderAllowed(from.channel, from.senderId);
  }
  /** Recheck the originating sender at execution, including continued tasks and helpers. */
  commandRunAllowed(runId: string): boolean {
    const queue = [runId], seen = new Set<string>();
    while (queue.length && seen.size < 100) {
      const id = queue.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const events = this.store.events(id);
      const came = events.find((event) => event.kind === "channel.inbound")?.data;
      if (came && typeof came.channel === "string" && typeof came.senderId === "string" && came.chatKind === "direct")
        return this.ownerCommandsFrom({ channel: came.channel, senderId: came.senderId, chatKind: "direct", caughtUp: came.caughtUp === true });
      const started = events.find((event) => event.kind === "run.started")?.data;
      for (const next of [started?.parentRunId, started?.resumedFrom, started?.originFrom]) if (typeof next === "string") queue.push(next);
    }
    return false;
  }
  /**
   * owner-dm-signin: whether a chat's task came only from the owner's own account, so the owner's sign-in accounts may
   * answer it (Runtime.trunkSignIns). Every chat message along the task's chain (parent, resumed, carried on) must pass
   * `ownerDmHere` (an account the owner named as their own, in a direct chat, on an app whose servers vouch for the
   * sender) and still be allowed to talk to Branch; nothing along it may come from another program. A message fetched
   * after a restart is the same person's (the app still vouched for it), so its freshness is not asked, as `ownerDmLine`
   * does. Pairing alone is never enough: a friend or a household member pairs the same way. Anything unread: no.
   */
  ownerDmRun(runId: string): boolean {
    const queue = [runId], seen = new Set<string>();
    let chats = 0;
    while (queue.length && seen.size < 100) {
      const id = queue.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const events = this.store.events(id);
      for (const event of events) {
        if (event.kind !== "channel.inbound" && event.kind !== ownerChatMark) continue; // owner-dm-full: /bg, /goal
        const came = event.data;
        if (typeof came.channel !== "string" || typeof came.senderId !== "string" || came.chatKind !== "direct") return false;
        const kind = this.adapters.get(came.channel)?.adapter.kind ?? "";
        if (!ownerDmHere(this.store, this.runtime.owner, kind, { channel: came.channel, senderId: came.senderId, chatKind: "direct", caughtUp: false })
          || !this.senderAllowed(came.channel, came.senderId)) return false;
        chats++;
      }
      const started = events.find((event) => event.kind === "run.started")?.data;
      if (typeof started?.source === "string" && !ownersOrChat.has(started.source)) return false;
      for (const next of [started?.parentRunId, started?.resumedFrom, started?.originFrom]) if (typeof next === "string") queue.push(next);
    }
    return chats > 0 && !queue.length;
  }
  /**
   * A command is approved in a chat only with its own Yes button (the exact request's fingerprint), pressed by the
   * owner's own account, in the very chat the task came from. A typed "y" is not enough: it answers whatever this chat
   * was last shown. Another chat pointed at the same conversation (a linked group) can never say yes to it.
   */
  private commandYesHere(channel: string, chatId: string, runId: string, fingerprint: string,
    from?: { senderId?: string; chatKind?: InboundMessage["chatKind"]; caughtUp?: boolean | undefined }): boolean {
    if (!fingerprint || !from?.senderId || from.chatKind !== "direct") return false;
    // owner-dm-full: the owner's own verified direct chat with full access may press it too, still for these exact bytes.
    if (!this.ownerCommandsFrom({ channel, senderId: from.senderId, chatKind: from.chatKind, ...(from.caughtUp ? { caughtUp: true } : {}) })
      && !this.ownerFullFrom({ channel, senderId: from.senderId, chatKind: from.chatKind })) return false;
    const came = this.store.events(runId).find((event) => event.kind === "channel.inbound")?.data;
    return came?.channel === channel && came?.chatId === chatId;
  }
  /** The owner's setting for what chats may do beyond talking (src/channels/chat-permissions.ts). */
  permissionSettings(): ChatPermissionSettings {
    return chatPermissionSettings(this.store, this.runtime.owner);
  }
  /** Changes that setting; whatever is left out keeps the value it has. */
  setPermissionSettings(input: unknown): ChatPermissionSettings {
    return saveChatPermissionSettings(this.store, this.runtime.owner, input);
  }
  // ---- chat-live (wave mac2): one task per chat, notes steer it, commands control it ----------
  /** Carries out a chat command and sends its answer back. */
  private async command(message: InboundMessage, command: ChatCommand): Promise<Outcome> {
    const { channel, chatId } = message;
    if (command.name === "model" && !command.argument.trim() && await this.offerModels(message)) return "replied";
    const turn = this.turns.get(chatKey(message));
    // CHAT-192: /steer is a note to the working task, by the same path as typing while it works: named as its sender's,
    // held back when the owner turned steering off, and answered as the next turn if the task never read it.
    if (command.name === "steer" && turn && command.argument.trim()) return this.joinTurn(turn, { ...message, text: command.argument.trim() });
    // A side question, folding and a question for the handbook all ask the model, so they count
    // against the chats working at once (`/help` and `/help all` only list).
    const question = command.name === "help" && !["", "all"].includes(command.argument.trim().toLowerCase());
    const asks = command.name === "btw" || command.name === "compact" || question;
    const work = () => runChatCommand(command, {
      runtime: this.runtime, channel, chatId, turn,
      sessionId: this.sessionFor(channel, chatId), permissions: this.chatPermissions(message),
      from: { senderId: message.senderId, senderName: message.senderName, messageId: message.messageId },
      dropWaiting: () => {
        if (!turn || turn.runId) return false;
        turn.dropped = true;
        return true;
      },
      forget: () => this.forgetSession(channel, chatId),
    });
    const reply = asks ? await this.withSlot(work) : await work();
    await this.deliver(channel, chatId, reply, `command:${chatId}:${message.messageId}`, this.quoteFor(message)).catch(() => undefined);
    return "replied";
  }
  /** What the owner-DM commands can reach: the whole app's command host, set by createBranch. Without it they are not read. */
  ownerDmHost: (() => CommandHost) | null = null;
  /**
   * CHAT-185 (src/channels/owner-dm-commands.ts): one of the window's commands from the owner's own account in a direct
   * chat, carried out through the one command table with that chat's conversation and permissions. Null when the line is
   * not one, or the sender is not the owner there, so it goes on as an ordinary message.
   */
  private async ownerDmLine(message: InboundMessage): Promise<Outcome | null> {
    const adapter = this.adapters.get(message.channel)?.adapter;
    const dm = message.voice ? null : ownerDmCommand(message.text);
    if (!dm || !adapter || !this.ownerDmHost || !ownerDmHere(this.store, this.runtime.owner, adapter.kind, { ...message, caughtUp: false })) return null;
    if (message.caughtUp) return "ignored"; // the owner's command sent while Branch was closed is old news, never carried out
    const refused = ownerDmRefusal(this.store, this.runtime.owner, this.appLocked(), dm.name, dm.argument);
    const key = `owner-dm:${message.chatId}:${message.messageId}`;
    if (refused) { await this.deliver(message.channel, message.chatId, refused, key, this.quoteFor(message)).catch(() => undefined); return "replied"; }
    const work = async () => (await executeCommand({ ...this.ownerDmHost!(), lockdownOffRefusal: "Lockdown can only be switched off in the app on this computer." }, {
      surface: "chat", line: message.text, sessionId: this.sessionFor(message.channel, message.chatId), access: "full",
      permissions: this.chatPermissions(message), ownerDm: true,
      // owner-dm-full: with full access on, what these commands start is the owner's own, as a plain message's task is.
      ...(this.ownerFullFrom(message) ? { ownerChat: { channel: message.channel, senderId: message.senderId } } : {}),
    }))?.text ?? "I do not know that command.";
    const reply = ["goal", "bg", "health"].includes(dm.name) ? await this.withSlot(work) : await work();
    await this.deliver(message.channel, message.chatId, reply, key, this.quoteFor(message)).catch(() => undefined);
    return "replied";
  }
  /** `/model` menus sent to chats, so a press can be read back (src/channels/model-picker.ts). */
  private readonly modelPicker = new ModelPicker();
  /**
   * CHAT-079: `/model` on its own, where the app's buttons carry a list: the connections as buttons, this chat's own
   * marked. False when the chat has no conversation yet or the app has no such buttons; the list then goes as words.
   */
  private async offerModels(message: InboundMessage): Promise<boolean> {
    const adapter = this.adapters.get(message.channel)?.adapter;
    const sessionId = this.sessionFor(message.channel, message.chatId);
    if (!adapter?.sendButtons || !adapter.listButtons || !sessionId) return false;
    const { active, choices } = listModels(this.runtime.models, this.runtime.owner, sessionId);
    if (!choices.length) return false;
    const now = choices.find((choice) => choice.id === active);
    const checked = await this.outboundGuard(`Which model answers in this chat?${now ? ` Now: ${now.name}.` : ""} Pick one, or type /model and a name.`);
    if (checked.blocked) return false;
    const buttons = this.modelPicker.offer(chatKey(message), sessionId, choices, active);
    return adapter.sendButtons(message.chatId, checked.text, buttons, this.quoteFor(message)).then(() => true, () => false);
  }
  /** A press on a `/model` menu: typed `/model <that one>` in effect, if this person may still use `/model` here. */
  private async pickModel(message: InboundMessage, picked: { preset: string } | { stale: true }): Promise<Outcome> {
    const command = "stale" in picked ? null : this.commandIn({ ...message, text: `/model ${picked.preset}` });
    if (!command) {
      await this.deliver(message.channel, message.chatId, staleModelMenu, `model-stale:${message.channel}:${message.messageId}`, this.quoteFor(message))
        .catch(() => undefined);
      return "replied";
    }
    return this.command(message, command);
  }
  /** Keeps the chat in the list of chats, but pointed at no conversation. */
  private forgetSession(channel: string, chatId: string): void {
    freshThread(this.store, this.runtime.owner, channel, chatId); // defaulttrunk: the conversation it had is kept in `earlier`
  }
  /**
   * A message for a chat that already has a task going. While the task is still gathering, the
   * message joins it as part of the same turn. Once it is working, the message is passed to it as a
   * note it reads before its next step (the same path as the app's "steer" button).
   */
  private async joinTurn(turn: ChatTurnState, message: InboundMessage): Promise<Outcome> {
    // Edited messages: a new version of a message still being gathered takes its place, so the latest one is answered.
    if (message.edited) {
      const at = turn.messages.findIndex((m) => m.messageId === message.messageId);
      if (turn.phase === "gathering" && at >= 0) { turn.messages[at] = { ...turn.messages[at]!, text: message.text }; return "ignored"; }
      message = editedAsNew(message);
    }
    // A service that hands over the same message twice gets one answer.
    if ([...turn.messages, ...turn.notes.map((note) => note.message)].some((m) => m.messageId === message.messageId)) return "ignored";
    // Wait for messages split in two / albums: while the turn is still gathering, a message that fits joins it. Only the
    // same person's live messages are joined that way (steering "on" gathers everyone's, as it always has).
    // With no split wait, a turn gathering only for an album takes only that album's photos (Codex P2).
    const first = turn.messages[0], sameAlbum = !!message.groupId && message.groupId === first?.groupId;
    const joins = this.switches().steering === "on"
      || (message.senderId === first?.senderId && !message.caughtUp && (this.intake().splitWaitMs > 0 || sameAlbum));
    if (turn.phase === "gathering" && joins && fitsTurn(turn.messages, message)) {
      turn.messages.push(message);
      return new Promise((resolve) => turn.waiters.push(resolve));
    }
    const steering = this.switches().steering;
    if (steering === "off") {
      // Not steering: the message waits for the task to finish and is then answered on its own.
      await new Promise<void>((resolve) => turn.waiters.push(() => resolve()));
      const next = this.turns.get(chatKey(message));
      return next ? this.joinTurn(next, message) : this.startTurn([message]);
    }
    // The note takes its place before a voice note is written out, so later messages queue behind it.
    const note: TurnNote = { text: "", message, pending: true };
    turn.notes.push(note);
    let heard = "";
    try {
      heard = (await this.spoken(message)).trim();
    } catch {
      heard = "";
    }
    note.text = heard;
    note.pending = false;
    if (!heard) {
      turn.notes.splice(turn.notes.indexOf(note), 1);
      if (turn.runId) this.passNotes(turn);
      return message.voice ? "failed" : "ignored";
    }
    if (turn.runId) this.passNotes(turn);
    const adapter = this.adapters.get(message.channel)?.adapter;
    if (adapter?.react && this.style(message).react && this.liveOn() && this.switches().liveStatus !== "off") await adapter.react(message.chatId, message.reactTo ?? message.messageId, statusEmoji.queued).catch(() => undefined);
    else await this.deliver(message.channel, message.chatId, "Noted. I will take that into account as I go.",
      `noted:${message.chatId}:${message.messageId}`, this.quoteFor(message)).catch(() => undefined);
    return "replied";
  }
  /** Hands the waiting notes to the running task; a note it can no longer take waits for the next turn. */
  private passNotes(turn: ChatTurnState): void {
    for (const note of turn.notes) {
      if (note.pending) break; // keep the order: nothing overtakes a voice note still being written out
      if (note.passed || note.late) continue;
      try {
        this.runtime.steer(turn.runId!, note.text, noteSender(note.message));
        note.passed = true;
        turn.passed++;
      } catch {
        note.late = true;
      }
    }
  }
  /**
   * Notes the task never read: sent too late, or passed just as it wrote its last answer. They
   * become the next turn rather than being lost.
   */
  private unreadNotes(turn: ChatTurnState): ChatTurnState["notes"] {
    const read = turn.runId ? this.store.events(turn.runId).filter((e) => e.kind === "run.steer_applied")
      .reduce((sum, e) => sum + Number(e.data.notes ?? 0), 0) : 0;
    const passed = turn.notes.filter((note) => note.passed);
    return [...passed.slice(read), ...turn.notes.filter((note) => !note.passed)];
  }
  /** Opens a turn for a chat, waits briefly for more messages, then runs them as one task. */
  private async startTurn(all: InboundMessage[], followUp = false): Promise<Outcome> {
    const first = all[0]!, key = chatKey(first);
    // Notes left over from the last task become this one; what does not fit is passed in as notes.
    const messages = followUp ? all.filter((m, index) => index === 0 || fitsTurn(all.slice(0, index), m)) : all;
    const notes = all.filter((m) => !messages.includes(m)).map((message) => ({ text: message.text, message }));
    const turn: ChatTurnState = { phase: "gathering", runId: null, startedAt: Date.now(), passed: 0, dropped: false,
      messages, notes, waiters: [], live: null, reply: null, quote: this.quoteStateFor(first, () => turn.messages) };
    turn.live = this.liveFor(first, () => turn.runId, turn);
    turn.reply = this.replyFor(first, turn);
    this.turns.set(key, turn);
    turn.live?.start();
    const wait = this.gatherMs(first);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait).unref());
    let outcome: Outcome = "ignored";
    try {
      // A dropped message only gets the "Dropped that" words; nothing more is shown for it.
      if (turn.dropped) { turn.live?.cancel(); turn.reply?.cancel(); }
      else { turn.phase = "running"; outcome = await this.withSlot(() => this.runTurn(turn)); }
    } finally {
      this.turns.delete(key);
      for (const resolve of turn.waiters) resolve(outcome);
    }
    const unread = turn.dropped ? [] : this.unreadNotes(turn);
    if (unread.length) void this.startTurn(unread.map(withText), true).catch(() => undefined);
    return outcome;
  }
  /**
   * QA R1 follow-up: after the chat's yes, the task that asked carries on as itself (the engine runs the approved call),
   * shown and answered in the chat as a turn is: progress while it works, then its reply or its next question.
   */
  private async carryTurn(message: InboundMessage, runId: string): Promise<Outcome> {
    const key = chatKey(message);
    const turn: ChatTurnState = { phase: "running", runId, startedAt: Date.now(), passed: 0, dropped: false,
      messages: [message], notes: [], waiters: [], live: null, reply: null, quote: this.quoteStateFor(message, () => turn.messages) };
    turn.live = this.liveFor(message, () => turn.runId);
    turn.reply = this.replyFor(message);
    this.turns.set(key, turn);
    turn.live?.start();
    const off = this.store.onEvent((id, kind, data) => {
      if (id !== turn.runId) return;
      turn.live?.event(kind, data);
      if (kind === "model.started") turn.reply?.round();
    });
    let outcome: Outcome = "failed";
    try {
      outcome = await this.withSlot(async () => {
        const run = await this.runtime.continueAsked(runId, {
          onStarted: () => { turn.startedAt = Date.now(); turn.live?.thinking(); this.passNotes(turn); },
          onTextDelta: (delta) => turn.reply?.text(delta),
        });
        return this.finishTurn(turn, run, "");
      });
    } catch {
      await turn.live?.finish("error");
      await this.deliver(message.channel, message.chatId, "Something went wrong on my side; the owner can see the details in Activity.",
        `carry-error:${message.channel}:${message.messageId}`, message.messageId).catch(() => undefined);
    } finally {
      off();
      turn.reply?.cancel();
      this.turns.delete(key);
      for (const resolve of turn.waiters) resolve(outcome);
    }
    const unread = this.unreadNotes(turn);
    if (unread.length) void this.startTurn(unread.map(withText), true).catch(() => undefined);
    return outcome;
  }
  /**
   * How long a new turn gathers before it runs: the steering window ("on"), the owner's "Wait for messages split in
   * two", and at least `albumWaitMs` for a photo that came in an album while albums are joined. `mergeWindowMs` 0 turns
   * all gathering off (tests that want each message on its own).
   */
  private gatherMs(first: InboundMessage): number {
    if (this.mergeWindowMs <= 0) return 0;
    const intake = this.intake(), steering = this.switches().steering === "on" ? this.mergeWindowMs : 0;
    if (first.caughtUp) return steering; // messages fetched after a restart are old ones, each already whole
    return Math.max(steering, intake.splitWaitMs, first.groupId && intake.albums ? albumWaitMs : 0);
  }
  /** Runs one turn's messages as a task and sends the answer, showing progress while it works. */
  private async runTurn(turn: ChatTurnState): Promise<Outcome> {
    const message = turn.messages[0]!, live = turn.live;
    // Where a chat's answer spent its time, written on the task so "Look inside" can show it (src/inspect.ts timing):
    // from the message being taken in (the turn opened; `startedAt` moves to the task's start once it starts).
    const receivedAt = turn.startedAt;
    let firstWords = false;
    const heard = await this.heardAll(turn.messages);
    if (typeof heard === "string") { live?.cancel(); return this.voiceFailed(message, heard); }
    // mac3/never-break: a message whose earlier task may already have reached the outside is not done twice.
    const held = heldReplay(this.store, this.runtime.owner, message);
    if (held) {
      live?.cancel();
      await this.deliver(message.channel, message.chatId, held, `replay-held:${message.channel}:${message.messageId}`, this.quoteIn(turn)).catch(() => undefined);
      return "ignored";
    }
    const off = this.store.onEvent((runId, kind, data) => {
      if (runId !== turn.runId) return;
      live?.event(kind, data);
      if (kind === "model.started") turn.reply?.round();
    });
    try {
      const sessionId = this.sessionFor(message.channel, message.chatId);
      // defaulttrunk: a chat with no conversation yet starts its one thread with the Trunk it is routed to.
      const trunkId = sessionId ? null : this.chatTrunk(message.channel, message.chatId);
      // R17-A (Trunks): a chat linked to a Trunk's conversation is answered only where that Trunk may reach.
      const trunkRefusal = sessionId ? this.trunkReach(message.channel, sessionId) : trunkId ? this.trunkIdReach(message.channel, trunkId) : null;
      if (trunkRefusal) {
        await live?.finish("error");
        await this.deliver(message.channel, message.chatId, trunkRefusal, `trunk-reach:${message.channel}:${message.messageId}`, this.quoteIn(turn)).catch(() => undefined);
        return "rejected";
      }
      const images: { mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/gif"; data: string; name: string }[] = [];
      const files: string[] = [];
      for (const inbound of turn.messages) for (const attachment of inbound.attachments ?? []) {
        const tooLarge = async () => {
          await live?.finish("error");
          await this.deliver(message.channel, message.chatId, `That file is larger than ${maxArtifactBytes / 1024 / 1024} MB, so it was not used`,
            `file-size:${message.channel}:${message.messageId}`, this.quoteIn(turn)).catch(() => undefined);
          return "failed" as const;
        };
        if (attachment.size !== undefined && attachment.size > maxArtifactBytes) return await tooLarge();
        // A chat app that did not say how big the file is finds out while fetching it, and says so the same way.
        const bytes = await attachment.bytes().catch((error: unknown) => { if (error instanceof ArtifactTooLarge) return null; throw error; });
        if (!bytes) return await tooLarge();
        if (attachment.kind === "picture" && ["image/jpeg", "image/png", "image/webp", "image/gif"].includes(attachment.mediaType)) {
          if (bytes.byteLength > 5 * 1024 * 1024) throw new Error("Telegram picture exceeds the runtime's 5 MB picture limit");
          images.push({ mediaType: attachment.mediaType as "image/jpeg" | "image/png" | "image/webp" | "image/gif", data: Buffer.from(bytes).toString("base64"), name: attachment.name });
        } else {
          if (!this.runtime.artifacts) throw new Error("Runtime artifact storage is unavailable");
          // Cut to fit where it is stored (fitName), which keeps its extension; the prompt names it in full, up to 200.
          const safe = attachment.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200).replace(/^[^a-zA-Z0-9]+/, "") || "file";
          // A forum topic's chat is "<group>:<topic>", and a stored file's folder takes only letters, digits, dots, dashes
          // and underscores. The sign stays, so a group and a person whose ids differ only by it keep separate folders.
          const cleanedChatId = message.chatId.replace(/[^a-zA-Z0-9._-]/g, "_");
          const stored = fitName(`${message.messageId}-${attachment.sourceId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12)}-`, safe);
          const artifact = await this.runtime.artifacts.write(`inbound-${message.channel}-${cleanedChatId}`, stored, attachment.mediaType, Buffer.from(bytes));
          files.push(`${safe}: ${artifact.path}`);
        }
      }
      // owner-dm-full: the owner's own verified direct chat runs as the owner, with the Access level a conversation
      // started in the window gets; every other chat cannot prove who is typing, so its task is never the owner's own.
      const owners = this.ownerFullFrom(message);
      const mode = owners ? this.ownerChatMode(sessionId) : null;
      const run = await this.runtime.run({
        prompt: [heard.prompt, ...files.map((file) => `[attached file: ${file}]`)].filter(Boolean).join("\n") || "Please inspect the attached picture.", ...(images.length ? { images } : {}), ...(sessionId ? { sessionId } : trunkId ? { trunkId } : {}), permissions: this.chatPermissions(message),
        source: owners ? "owner" : "channel", ...(mode ? { conversationMode: mode } : {}),
        // Which app it came in on, for the model's line saying where it runs (src/environment.ts).
        channel: chatAppName(this.adapters.get(message.channel)?.adapter.kind ?? message.channel),
        onStarted: (started) => {
          // mac3/never-break: a task a chat started is left for the chat app to send again after a restart.
          this.store.event(started.id, "channel.inbound", { channel: message.channel, chatId: message.chatId, messageId: message.messageId,
            senderId: message.senderId, chatKind: message.chatKind, caughtUp: message.caughtUp === true,
            waitedMs: Date.now() - receivedAt }); // gathering split messages and waiting for a free slot
          turn.runId = started.id;
          turn.startedAt = Date.now();
          live?.thinking();
          if (turn.dropped) this.runtime.cancel(started.id);
          this.passNotes(turn);
        },
        onTextDelta: (delta) => {
          if (!firstWords && turn.runId) { firstWords = true; this.store.event(turn.runId, "channel.first_words", { ms: Date.now() - receivedAt }); }
          turn.reply?.text(delta);
        },
      });
      const outcome = await this.finishTurn(turn, run, heard.quoted);
      this.store.event(run.id, "channel.sent", { ms: Date.now() - receivedAt });
      return outcome;
    } catch (error) {
      await live?.finish("error");
      // Messages per conversation per hour: that refusal is said as it is, since no task started to show in Activity.
      const said = (error as { conversationRate?: boolean }).conversationRate ? (error as Error).message : "Something went wrong on my side; the owner can see the details in Activity.";
      await this.deliver(message.channel, message.chatId, said, `reply-error:${message.channel}:${message.messageId}`, this.quoteIn(turn)).catch(() => undefined);
      void error;
      return "failed";
    } finally {
      off();
      turn.reply?.cancel();
    }
  }
  /**
   * The words of every message in the turn, voice notes written out first. A voice note that cannot
   * be made out ends the turn with the reason, as a single message always did.
   */
  private async heardAll(messages: InboundMessage[]): Promise<{ prompt: string; quoted: string } | string> {
    const parts: string[] = [], spokenParts: string[] = [];
    for (const message of messages) {
      let heard: string;
      try {
        heard = await this.spoken(message);
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      if (message.voice) spokenParts.push(heard);
      parts.push(message.chatKind === "group" ? `[${message.senderName} in ${message.chatTitle ?? "a group"}] ${heard}` : heard);
    }
    const quoted = spokenParts.length ? `You said (from your voice note): "${spokenParts.join(" ")}"\n\n` : "";
    return { prompt: parts.join("\n"), quoted };
  }
  private async voiceFailed(message: InboundMessage, reason: string): Promise<Outcome> {
    await this.deliver(message.channel, message.chatId, `I could not make out that voice note: ${reason}`,
      `voice-failed:${message.channel}:${message.messageId}`, this.quoteFor(message)).catch(() => undefined);
    return "failed";
  }
  /** Writes down which conversation the chat is on, then sends the answer or the question. */
  private async finishTurn(turn: ChatTurnState, run: Run, quoted: string): Promise<Outcome> {
    const message = turn.messages[0]!, live = turn.live;
    // defaulttrunk: the chat's one thread, with the Trunk it is with; whatever else the record holds is kept.
    const trunkId = this.trunkOfConversation(run.sessionId);
    saveChatThread(this.store, this.runtime.owner, message.channel, message.chatId, { sessionId: run.sessionId,
      title: message.chatKind === "group" ? (message.chatTitle ?? message.chatId) : message.senderName, updatedAt: run.updatedAt,
      ...(trunkId ? { trunkId } : {}) });
    // hot-update: a newer engine took this task over and carries it on; its answer goes to the chat from there
    // (carryOnReply), so nothing is said from here: no "could not finish", and no second answer.
    if (run.status === "interrupted" && this.handedOver(run.id)) { live?.cancel(); turn.reply?.cancel(); return "replied"; }
    const said = run.status === "completed" ? run.output || "(no reply)" : run.status === "needs_input" ? run.output
      : run.status === "cancelled" ? "Stopped."
      // owner-dm-signin: the task's own reason, scrubbed and kept short, rather than the bare status.
      : chatFailureLine(run.status, run.output ?? "", message.chatKind, (text) => this.hideLeaks(this.runtime.hideSecrets(text)));
    // A task that stopped to ask goes out as a question with buttons, not as words to read.
    // PR #289 review 2: its own question, not whichever one is newest in the conversation.
    const own = run.status === "needs_input" ? this.runtime.waitingApprovals(run.sessionId).find((one) => one.runId === run.id) : undefined;
    if (own) {
      await live?.finish("done");
      if (turn.reply) await turn.reply.finish("Waiting for your answer.");
      await this.askInChat(message, run.sessionId, own, quoted, `ask:${run.id}:${own.fingerprint ?? "none"}`, this.quoteIn(turn));
      return "replied";
    }
    const footer = usageShown(this.runtime, message.channel, message.chatId) ? usageFooter(this.runtime, run.id) : null;
    const ok = run.status === "completed" || run.status === "needs_input";
    const steps = this.stepsLine(message, run, ok);
    const text = (steps ? `${steps}\n\n` : "") + quoted + said + (footer ? `\n\n${footer}` : "");
    await live?.finish(ok ? "done" : "error");
    const delivered = await this.sendReply(message, run.id, text, await turn.reply?.finish(text) ?? null, turn);
    // The owner's "remove the steps message after a good answer"; a failed task keeps it as the record.
    if (ok && delivered && this.stepsDisplay(message.channel).cleanup) await live?.remove();
    if (message.voice) await this.voiceReply(message, said, this.quoteIn(turn)).catch(() => undefined);
    return ok ? "replied" : "failed";
  }
  /**
   * hot-update: resolves once no chat's turn is still finishing (its answer written down and sent) and no send is under
   * way, or after `ms`; answers whether all were done. An engine handing over waits for this before it lets go.
   */
  async settle(ms: number): Promise<boolean> {
    const until = Date.now() + ms;
    while (this.turns.size > 0 && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 25));
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([this.flushing, new Promise((resolve) => { timer = setTimeout(resolve, Math.max(0, until - Date.now())); })]);
    clearTimeout(timer);
    return this.turns.size === 0;
  }
  /**
   * The chat message a task began from, through every engine it was carried on in: each carried-on task names the one
   * it carried on (`resumedFrom`), and only the first holds the chat's mark (`channel.inbound`).
   */
  private chatOrigin(runId: string): { channel?: unknown; chatId?: unknown; messageId?: unknown } | undefined {
    let id: string | undefined = runId;
    for (let hops = 0; id && hops < 50; hops++) {
      const events = this.store.events(id);
      const inbound = events.find((event) => event.kind === "channel.inbound");
      if (inbound) return inbound.data as { channel?: unknown; chatId?: unknown; messageId?: unknown };
      const from = events.find((event) => event.kind === "run.started")?.data.resumedFrom;
      id = typeof from === "string" ? from : undefined;
    }
    return undefined;
  }
  private handedOver(runId: string): boolean {
    return !!this.store.sqlite.prepare("SELECT 1 FROM events WHERE run_id=? AND kind='run.handed_over' LIMIT 1").get(runId);
  }
  /**
   * hot-update: a chat's task that an older engine handed to this one (src/never-break/resume.ts resumeHandedOver)
   * answers the chat from here once it finishes, in reply to the message that started it. The older engine said
   * nothing for it (finishTurn), and a chat app that sent its message once never sends it again.
   */
  async carryOnReply(runId: string, resumed: Promise<Run | undefined>): Promise<boolean> {
    const inbound = this.chatOrigin(runId);
    if (typeof inbound?.channel !== "string" || typeof inbound.chatId !== "string") return false;
    const run = await resumed ?? this.store.run(runId);
    if (!run || run.status === "interrupted") return false; // handed on again: the next engine answers it
    const said = run.status === "completed" ? run.output || "(no reply)" : run.status === "needs_input" ? run.output
      : run.status === "cancelled" ? "Stopped." : `I could not finish that (${run.status}).`;
    await this.deliver(inbound.channel, inbound.chatId, said, `reply:${run.id}`, typeof inbound.messageId === "string" ? inbound.messageId : undefined);
    return true;
  }
  /**
   * Batch 20 (wave 8): the message going back out is the last step of the task, so it hangs off the
   * same trace even though the task itself has already settled. When the progress message already
   * became the reply, it is only written down.
   */
  private async sendReply(message: InboundMessage, runId: string, text: string, placed: PlacedReply | null, turn: ChatTurnState): Promise<boolean> {
    const span = this.runtime.tracer.startAfter(runId, "delivery", `branch.delivery ${message.channel}`, {
      "branch.channel": message.channel, "branch.delivery.characters": text.length,
    });
    if (placed) {
      this.deliveries.recordSent(message.channel, message.chatId, placed.text, `reply:${runId}`, placed.messageId, message.messageId);
      for (const [index, part] of (placed.rest ?? []).entries())
        await this.deliver(message.channel, message.chatId, part, `reply:${runId}:rest:${index}`, this.quoteIn(turn));
      span?.end("ok", "", { "branch.delivery.queued": 0 });
      return true;
    }
    return this.deliver(message.channel, message.chatId, text, `reply:${runId}`, this.quoteIn(turn))
      .then((sent) => { span?.end("ok", "", { "branch.delivery.queued": sent.queued }); return sent.sent; })
      .catch((error) => { span?.end("error", error instanceof Error ? error.message : String(error)); return false; });
  }
  /**
   * At most `maxChatTasks` chats have a task working at once. No adapter waits for one message
   * before reading the next, so this is what keeps a burst of messages from many chats from
   * starting a task for each of them at the same moment. The rest wait their turn.
   */
  private async withSlot<T>(work: () => Promise<T>): Promise<T> {
    while (this.chatTasks >= this.maxChatTasks) await new Promise<void>((resolve) => this.slotWaiters.push(resolve));
    this.chatTasks++;
    try {
      return await work();
    } finally {
      this.chatTasks--;
      this.slotWaiters.shift()?.();
    }
  }
  /** Who holds each chat task's browser, as its picture's buttons last showed it. */
  private readonly holders = new Map<string, "owner" | "task" | "none">();
  private holdButtons(runId: string | null, telegram: boolean): ApprovalButton[] {
    if (!runId) return [];
    void this.browserHold?.(runId, "held").then((who) => { this.holders.set(runId, who); }, () => undefined);
    const hold = this.holders.get(runId) === "owner"
      ? { label: "▶️ Hand back", value: `br:g:${runId}` } : { label: "✋ Take over", value: `br:t:${runId}` };
    // Where the owner's phone can reach the Mini App (src/miniapp/phone-access.ts), it opens the page to drive it there.
    const phone = telegram ? this.miniAppUrl?.(runId) ?? null : null;
    return phone ? [hold, { label: "📱 Drive it here", value: "", webApp: phone }] : [hold];
  }
  /**
   * A press on the live browser's Take over or Hand back. Only in the direct chat the task came from, by the person who
   * started it, who is still allowed to talk to Branch (paired or on the list); never under Lockdown or a locked Branch. Taking over
   * only ever stops the task at its next browser step; handing back lets it carry on as it would have. An allowlisted sender
   * counts the same as a paired one: the owner put either there, and both may already steer this task, which a pause gives
   * no more than. The page itself is driven only from Branch's window or app, never from the chat. A held step stops waiting
   * on its own after ten minutes (browser-control.ts agentTurn), and every press that changed hands is on the task's record.
   */
  private async pressHold(message: InboundMessage, op: "take" | "give", runId: string): Promise<Outcome> {
    const say = (text: string) => this.deliver(message.channel, message.chatId, text, `browser-hold:${message.messageId}`, message.messageId)
      .then(() => "replied" as const, () => "replied" as const);
    if (!this.browserHold || message.chatKind !== "direct" || !this.mayHoldBrowser(runId, message.channel, message.chatId, message.senderId)
      || !this.liveOn())
      return say("Only the person who started this task, in this chat, can take over its browser.");
    try {
      const who = await this.browserHold(runId, op);
      this.holders.set(runId, who);
      this.store.event(runId, "browser.hands", { from: "chat", channel: message.channel, pressed: op === "take" ? "take over" : "hand back", holder: who });
      const turn = this.turns.get(chatKey(message));
      if (turn?.runId === runId) turn.live?.refreshPicture();
      return say(who === "owner"
        ? "You have the browser. The task waits at its next browser step, for up to ten minutes. Drive it from Branch's window or app, then press Hand back."
        : "Handed back. The task carries on in the browser.");
    } catch (error) {
      return say(error instanceof Error ? error.message : String(error));
    }
  }
  /**
   * Whether this sender may take over this task's browser from outside Branch's window: the task came from this very
   * chat, sent by them, and they may still talk to Branch (paired, or on the owner's list).
   */
  mayHoldBrowser(runId: string, channel: string, chatId: string, senderId: string): boolean {
    const came = this.store.events(runId).find((event) => event.kind === "channel.inbound")?.data;
    return came?.channel === channel && came?.chatId === chatId && came?.senderId === senderId && this.senderAllowed(channel, senderId);
  }
  /** The chat app a task came from, as its first message recorded it, or null. */
  cameFrom(runId: string): { channel: string; chatId: string; senderId: string } | null {
    const came = this.store.events(runId).find((event) => event.kind === "channel.inbound")?.data;
    return typeof came?.channel === "string" && typeof came.chatId === "string" && typeof came.senderId === "string"
      ? { channel: came.channel, chatId: came.chatId, senderId: came.senderId } : null;
  }
  /** Whether a chat may be shown typing, reactions and progress right now. */
  private liveOn(): boolean {
    return !this.appLocked() && this.liveAllowed() && !this.deliveries.holdUntil(new Date());
  }
  /** This app's reply choices (Settings › Chat apps › Replies in each app). */
  private style(message: Pick<InboundMessage, "channel">): ReplyStyle {
    const kind = this.adapters.get(message.channel)?.adapter.kind ?? message.channel;
    try { return replyStyle(this.store, this.runtime.owner, kind); } catch { return { quote: "auto", react: true }; }
  }
  /**
   * An answer to these messages would be unclear without a quote: a newer message from the chat was let in after them,
   * or they were fetched late after a restart.
   */
  private interleaved(messages: readonly InboundMessage[]): boolean {
    const last = messages.at(-1);
    if (!last) return false;
    if (messages.some((m) => m.caughtUp)) return true;
    const newest = this.latest.get(chatKey(last));
    return newest !== undefined && !messages.some((m) => m.messageId === newest);
  }
  private quoteStateFor(message: InboundMessage, messages: () => readonly InboundMessage[]): QuoteState {
    return quoteState(this.style(message).quote, message.chatKind, () => this.interleaved(messages()));
  }
  /** Whether this app's reply id is only a quote, which the owner's choice may leave out (ChannelAdapter.replyQuotes). */
  private quotes(message: Pick<InboundMessage, "channel">): boolean {
    return this.adapters.get(message.channel)?.adapter.replyQuotes === true;
  }
  /** The message a turn's next message quotes, if any: the newest message it answers. */
  private quoteIn(turn: ChatTurnState, part: "answer" | "status" = "answer"): string | undefined {
    const first = turn.messages[0]!, last = turn.messages.at(-1)!;
    if (!this.quotes(first)) return first.messageId; // the thread it belongs in, as before
    return nextQuote(turn.quote, last.messageId, part);
  }
  /** The same rule for one message sent outside a turn (a command's answer, a refusal). */
  private quoteFor(message: InboundMessage): string | undefined {
    if (!this.quotes(message)) return message.messageId;
    return nextQuote(this.quoteStateFor(message, () => [message]), message.messageId);
  }
  private liveFor(message: InboundMessage, runOf: () => string | null = () => null, turn?: ChatTurnState): LiveStatus | null {
    const adapter = this.adapters.get(message.channel)?.adapter, switches = this.switches(), setting = switches.liveStatus;
    // An app with none of typing, reactions or edits still gets a message per step when the owner chose that for it.
    const eachStep = !!adapter && !adapter.edit && !adapter.paidPerMessage && message.chatKind === "direct" && switches.steps !== "off"
      && this.stepsDisplay(message.channel).noEdit === "each" && this.stepsDisplay(message.channel).detail !== "off";
    if (!adapter || setting === "off" || !this.liveOn() || (!adapter.sendTyping && !adapter.react && !adapter.edit && !eachStep)) return null;
    // A group shares one bot with other people: Telegram lets a bot post about 20 messages a minute there, edits included.
    const timing = message.chatKind === "group" ? { ...this.liveTiming, editEveryMs: Math.max(this.liveTiming.editEveryMs, this.groupEditEveryMs) } : this.liveTiming;
    // The steps name files and commands, so only a direct chat is shown them: this message already passed the sender check.
    const display = this.stepsDisplay(message.channel);
    const steps = switches.steps !== "off" && message.chatKind === "direct" && display.detail !== "off"
      && (adapter.edit || eachStep) ? this.stepsOf(runOf, display, !adapter.edit) : undefined;
    // A group gets counts of kinds of step, or (the owner's "no steps in groups") no progress message at all.
    // An app whose steps the owner turned off gets no progress message either: typing and the reaction still show.
    const progress = switches.steps === "off" || (message.chatKind === "group" ? display.groups !== "off" : display.detail !== "off");
    // Pictures of Branch's browser while the task works in it: a direct chat only, where the owner has them on.
    const pictures = message.chatKind === "direct" && switches.steps !== "off" && display.pictures !== "off" && !!adapter.sendFile && !adapter.paidPerMessage;
    const pictureButtons = pictures && this.browserHold && adapter.sendPicture ? () => this.holdButtons(runOf(), adapter.kind === "telegram") : undefined;
    const picture = pictures ? async () => {
      const runId = runOf(), seen = runId ? await this.browserPicture(runId) : null;
      if (!seen) return null;
      let host = "";
      try { host = new URL(seen.url).host; } catch { /* no address: the title alone */ }
      const words = this.hideLeaks(this.runtime.hideSecrets([seen.title.trim(), host].filter(Boolean).join(" · ")));
      return { bytes: seen.frame, caption: words ? `🌐 ${words}` : "" };
    } : undefined;
    return new LiveStatus({ adapter, chatId: message.chatId, messageId: message.messageId, reactTo: message.reactTo,
      allowed: () => this.liveOn(), kindsOnly: message.chatKind === "group", progress, react: this.style(message).react, picture, pictureButtons,
      ...(turn ? { quote: () => this.quoteIn(turn, "status"), adopt: () => turn.reply?.surrender() ?? Promise.resolve(null) } : {}) },
    (text) => this.outboundGuard(this.hideLeaks(text)), timing, setting === "when-needed", steps, true);
  }
  private replyFor(message: InboundMessage, turn?: ChatTurnState): ReplyStream | null {
    const adapter = this.adapters.get(message.channel)?.adapter;
    if (!adapter?.edit || message.chatKind !== "direct" || this.switches().liveStatus === "off" || !this.liveOn()) return null;
    return new ReplyStream({ adapter, chatId: message.chatId, messageId: message.messageId,
      ...(turn ? { quote: () => this.quoteIn(turn) } : {}),
      allowed: () => this.liveOn() && this.senderAllowed(message.channel, message.senderId) },
    (text) => this.outboundGuard(this.hideLeaks(text)), this.liveTiming.editEveryMs);
  }
  /**
   * "Show steps in chats" in an app that cannot edit a message (WhatsApp, Signal, iMessage, email…): one line above the
   * reply saying what kinds of step the task took and how it ended, for a task that worked long enough to have shown a
   * progress message elsewhere. It names nothing (src/channels/progress-render.ts compactSummary). Not in a group, and
   * never where each message costs money.
   */
  private stepsLine(message: InboundMessage, run: Run, ok: boolean): string | null {
    const adapter = this.adapters.get(message.channel)?.adapter;
    const display = this.stepsDisplay(message.channel);
    if (!adapter || adapter.edit || adapter.paidPerMessage || message.chatKind !== "direct" || this.switches().steps === "off"
      || display.detail === "off" || display.noEdit !== "summary") return null;
    if (Date.parse(run.updatedAt) - Date.parse(run.createdAt) < this.liveTiming.progressAfterMs) return null;
    const view = this.stepsOf(() => run.id).view();
    return this.hideLeaks(compactSummary(view, ok ? "done" : "error") ?? "") || null;
  }
  /**
   * "Show steps in chats": the task's lines as the window has them (src/live-steps.ts), read from its record when the
   * progress message is next edited, scrubbed as GET /api/runs/:id/live scrubs them, and each piece through the chat's
   * leak guard before it is placed (src/channels/progress-render.ts).
   */
  private stepsOf(runOf: () => string | null, display: StepsDisplay = stepsDisplayFor(stepsSettings(this.store, this.runtime.owner), { id: "", kind: "" }),
    cannotEdit = false): StepsSource & { view(): ChatStepsView } {
    const owner = this.runtime.owner;
    const deps = {
      thoughtsOf: () => [], // a chat is not shown the model's thoughts
      waiting: [], // questions go out as their own message, not as steps
      helperName: (agent: string, recorded?: string) => (agent.startsWith("mode:") ? agent.slice(5) : null)
        ?? specialistName(this.store, owner, agent) ?? (recorded?.trim() || "A helper"),
      scrub: (text: string) => this.runtime.hideSecrets(text),
    };
    const each = display.grouping === "each" || cannotEdit;
    const knobs = { scrub: (text: string) => this.hideLeaks(text), lineChars: display.lineChars, commands: display.commands,
      ...(display.detail === "off" ? {} : { detail: display.detail }) };
    const view = (): ChatStepsView => {
      const runId = runOf();
      return runId && this.store.run(runId) ? this.runtime.hideSecrets(liveSteps(this.store, runId, deps)) : { steps: [], seconds: null };
    };
    return {
      view,
      render: (limit, final) => renderChatSteps(view(), { ...knobs, limit, ...(final ? { final } : {}) }),
      // Hermes Agent's overflow (a new message) unless the owner keeps only the newest lines; `each` is a message a step.
      ...(display.overflow === "roll" || each ? { pages: (limit: number, final?: "done" | "error") =>
        pageChatSteps(view(), { ...knobs, limit, each, ...(final ? { final } : {}) }) } : {}),
      each,
      count: () => chatSteps(view().steps).length, // the steps the message would show, not Branch finding its tools
    };
  }
  /** The steps knobs for one connected app (Settings › Chat apps, src/channels/steps-display.ts). */
  stepsDisplay(channel: string): StepsDisplay {
    const adapter = this.adapters.get(channel)?.adapter;
    return stepsDisplayFor(stepsSettings(this.store, this.runtime.owner), { id: channel, kind: adapter?.kind ?? channel });
  }
  stepsSettings(): StepsSettings { return stepsSettings(this.store, this.runtime.owner); }
  setStepsSettings(input: unknown): StepsSettings { return saveStepsSettings(this.store, this.runtime.owner, input); }
  /** mac6/bucket-16 integration: whether a sender may use a connected chat app, without offering a code. */
  senderAllowed(channel: string, senderId: string): boolean {
    const entry = this.adapters.get(channel);
    return !!entry && !!senderId && this.access({ channel, senderId } as InboundMessage, entry.policy) === "allowed";
  }
  private access(message: Pick<InboundMessage, "channel" | "senderId">, policy: ChannelPolicy): "allowed" | "pairing" | "rejected" {
    // Batch 20 (wave 8): the one list for every chat app is read first, so "never this person"
    // holds everywhere at once. A channel's own list still works and is read after it.
    const list = readSenderAllowlist(this.store, this.runtime.owner);
    const said = decide(list, message.channel, message.senderId);
    if (said === "block") return "rejected";
    if (said === "allow") return "allowed";
    if (policy.allowlist.includes(message.senderId)) return "allowed";
    if (this.pair(message.channel, message.senderId)?.status === "approved") return "allowed";
    if (list.unknown === "block") return "rejected";
    return policy.pairing ? "pairing" : "rejected";
  }
  private pairingCode(message: InboundMessage): string {
    const existing = this.pair(message.channel, message.senderId);
    if (existing?.status === "pending" && pairingCodeFresh(existing)) return existing.code;
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    this.store.save("settings", this.runtime.owner, `channel-pair:${message.channel}:${message.senderId}`,
      { status: "pending", code, name: message.senderName.slice(0, 120), requestedAt: new Date().toISOString() } satisfies Pair);
    return code;
  }
  /** The owner approves a pending sender by typing the code the sender was shown. */
  /**
   * `firstOwner` (owner-dm-signin): the owner, in the window, said the sender is their own account. It is taken only while
   * no account is named as the owner's yet and only on an app that vouches for its senders; the caller has already
   * checked that this is the window on this computer (and the PIN, where one is set).
   */
  approve(owner: string, input: unknown, options: { firstOwner?: boolean } = {}) {
    if (options.firstOwner) this.store.profiles.requireOwner("Naming your own chat account");
    const approved = this.approveCode(owner, input);
    const madeOwner = options.firstOwner === true && this.nameFirstOwner(owner, approved.channel, approved.senderId);
    return { ...approved, madeOwner };
  }
  /**
   * owner-dm-signin: names this approved sender as the owner's own account, as the only one, in "Commands from your own
   * chat" (its switch left as it is). The model is OpenClaw's "Also make this sender the first command owner"
   * (github.com/openclaw/openclaw, docs/channels/pairing.md, MIT): offered only while no owner exists, never replacing
   * or adding to one; the code here is Branch's own. False when an owner is already named or the app cannot vouch.
   */
  private nameFirstOwner(owner: string, channel: string, senderId: string): boolean {
    const kind = this.adapters.get(channel)?.adapter.kind ?? "";
    if (!vouchedSenderKinds.includes(kind) || ownerAccountNamed(this.store, owner)) return false;
    saveOwnerCommands(this.store, owner, { ...ownerCommands(this.store, owner), accounts: [{ channel, sender: senderId }] });
    return true;
  }
  private approveCode(owner: string, input: unknown) {
    const { code } = z.object({ code: z.string().regex(/^\d{6}$/) }).strict().parse(input);
    // mac3/never-break (integration review): a code works once, only while fresh, never when two
    // requests share it, and a run of wrong guesses is slowed down.
    const now = Date.now();
    this.wrongCodes = this.wrongCodes.filter((at) => now - at < pairingCodeMs);
    if (this.wrongCodes.length >= 10) throw new Error("Too many wrong codes in a row. Wait a few minutes and try again.");
    const matches = this.pairs(owner).filter((p) => p.status === "pending" && p.code === code && pairingCodeFresh(p));
    if (matches.length > 1) throw new Error("Two requests have that code. Ask the person to write to the bot again for a new one.");
    const match = matches[0];
    if (!match) { this.wrongCodes.push(now); throw new Error("No pending request has that code"); }
    const approved: Pair = { status: "approved", code: match.code, name: match.name, requestedAt: match.requestedAt, approvedAt: new Date().toISOString() };
    this.store.save("settings", owner, `channel-pair:${match.channel}:${match.senderId}`, approved);
    audit(this.store, owner, { action: "channel.paired", actor: owner, subject: `${match.name} on ${match.channel}`,
      reason: "You approved this sender, so their messages now reach the assistant", outcome: "allowed" });
    return { ...approved, channel: match.channel, senderId: match.senderId };
  }
  remove(owner: string, input: unknown) {
    const { channel, senderId } = z.object({ channel: z.string().min(1).max(64), senderId: z.string().min(1).max(64) }).strict().parse(input);
    const removed = this.store.delete("settings", owner, `channel-pair:${channel}:${senderId}`);
    if (removed) audit(this.store, owner, { action: "channel.paired", actor: owner, subject: `${senderId} on ${channel}`,
      reason: "You disconnected this sender, so their messages no longer reach the assistant", outcome: "refused" });
    return { removed };
  }
  /** mac3/never-break: when wrong pairing codes were typed, for slowing down guessing. */
  private wrongCodes: number[] = [];
  private pair(channel: string, senderId: string): Pair | undefined {
    const parsed = pairSchema.safeParse(this.store.get("settings", this.runtime.owner, `channel-pair:${channel}:${senderId}`)?.data);
    return parsed.success ? parsed.data : undefined;
  }
  private pairs(owner: string) {
    return this.store.list("settings", owner).flatMap((record) => {
      if (!record.id.startsWith("channel-pair:")) return [];
      const parsed = pairSchema.safeParse(record.data);
      if (!parsed.success) return [];
      const [, channel, ...rest] = record.id.split(":");
      return [{ ...parsed.data, channel: channel!, senderId: rest.join(":") }];
    });
  }
}
