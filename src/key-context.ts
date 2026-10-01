import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Whether the work in progress was asked for with a short-lived key (`branch token create`) rather
 * than this computer's own key. The server marks a request the moment such a key is accepted, and
 * the mark follows everything that request starts, including the task and its "finished" event.
 * A feature that must stay the owner's alone — sending work to GitHub, for one — reads it here.
 */
/**
 * bucket 19: which key it was (`keyId`), so a question a task asks can be answered only by the key
 * that started it, and the one conversation a handed-over key was made for (`sessionId`).
 */
export interface KeyMark { keyId?: string; sessionId?: string }
const scope = new AsyncLocalStorage<{ shortLivedKey: true } & KeyMark>();

/** Marks the rest of the current request as started with a short-lived key. */
export function markShortLivedKey(mark: KeyMark = {}): void {
  scope.enterWith({ shortLivedKey: true, ...mark });
}
/** Runs `work` as if it had been asked for with a short-lived key (for tests and for callers that know). */
export function underShortLivedKey<T>(work: () => T, mark: KeyMark = {}): T {
  return scope.run({ shortLivedKey: true, ...mark }, work);
}
export function startedWithShortLivedKey(): boolean {
  return scope.getStore()?.shortLivedKey === true;
}
/** bucket 19: the short-lived key behind this request, and the conversation it is held to, if any. */
export function shortLivedKeyMark(): KeyMark {
  const found = scope.getStore();
  return found ? { ...(found.keyId ? { keyId: found.keyId } : {}), ...(found.sessionId ? { sessionId: found.sessionId } : {}) } : {};
}

/**
 * Integration review (bucket 18): what a task wrote down about where it came from, when it started.
 * A mark on the request alone is lost by anything that starts later — a follow-up message, a queued
 * task, a background specialist, a continued task — so each task records it on its own
 * `run.started`, and this reads it back, following the parent and the task it continued.
 */
export interface RunOrigin {
  /** Started with a short-lived key, or started by something that was. */
  shortLivedKey: boolean;
  /** Who started the task at the top of the chain (parents, resumed tasks, carried-on tasks): "owner", "schedule", "trigger", "mcp", ... */
  source: string;
  /** What the task itself was allowed to use; null when it recorded nothing. */
  permissions: string[] | null;
  /** The task that started this one, when it is a specialist's. */
  parentRunId: string | null;
  /** bucket 19: every short-lived key written down along the chain (empty for the owner's own work). */
  keyIds: string[];
  /** bucket 19: the household person the task was started for, so a resumed task is held to their role. */
  personProfileId: string | null;
  /** bucket 19 (integration review): whose own conversation it is, when it was lent to the assistant. */
  lentTo: string | null;
  /** owner-dm-full: the owner's work because it came from the owner's own verified direct chat, checked just now. */
  ownerChat?: boolean;
}
export type EventReader = { events(runId: string): { kind: string; data: Record<string, unknown> }[] };
const startOf = (store: EventReader, runId: string) => store.events(runId).find((event) => event.kind === "run.started")?.data;

/**
 * Who a task is for, as one word: its source, the household person it belongs to, and any key it was started with.
 * Dogfood A6 (NAS 4a4d7b1): a "Yes, just now" is used only by a task of the same asker, because one conversation
 * (a Trunk's room) can hold the owner's turns, a household person's and a key's.
 */
export function askerOf(origin: RunOrigin): string {
  return [origin.source, origin.personProfileId ?? "", origin.lentTo ?? "", origin.shortLivedKey ? "key" : "", ...origin.keyIds].join("\u0000");
}
/**
 * owner-dm-full: whether a chat's task came only from the owner's own verified direct chat, asked afresh every time
 * (the chat router's `ownerFullRun`: the "Your own chats have your full access" switch on, no Lockdown, no App lock, and
 * every chat message along the chain from an account the owner named as theirs, one to one, on an app that vouches for
 * its senders). Kept per store, so one copy of Branch never answers for another's tasks; with nothing registered, no.
 * This is OpenClaw's "main" session (sandbox mode "non-main", `shouldSandboxSession` in
 * src/agents/sandbox/runtime-status.ts, MIT): the owner's direct chat runs as the owner, everything else is held back.
 */
/**
 * owner-dm-full (gaps): the mark a task started by a command from the owner's own direct chat carries (`/bg`, each
 * round of `/goal`), with the chat it came from, in place of the chat message a plain message's task carries. It counts
 * as a chat along the chain, so the task is the owner's only while that chat is still checked to be the owner's.
 */
export const ownerChatMark = "channel.owner-command";
const ownerChatChecks = new WeakMap<object, (runId: string) => boolean>();
export function setOwnerChatCheck(store: EventReader, check: ((runId: string) => boolean) | null): void {
  if (check) ownerChatChecks.set(store, check);
  else ownerChatChecks.delete(store);
}
function ownerChat(store: EventReader, runId: string): boolean {
  try { return ownerChatChecks.get(store)?.(runId) === true; } catch { return false; }
}
export function runOrigin(store: EventReader, runId: string): RunOrigin {
  const own = startOf(store, runId);
  const origin: RunOrigin = {
    shortLivedKey: false, source: typeof own?.source === "string" ? own.source : "owner",
    permissions: Array.isArray(own?.permissions) ? own.permissions.map(String) : null,
    parentRunId: typeof own?.parentRunId === "string" ? own.parentRunId : null, keyIds: [], personProfileId: null, lentTo: null,
  };
  const seen = new Set<string>();
  const queue = [runId];
  // A chat message's task carries source "channel"; one saved before that said "owner" and only carried
  // the "channel.inbound" mark the chat router writes, so that mark still means "channel". A chat seen
  // anywhere along the chain wins, whatever order the rest is read in: a chat cannot prove who is typing.
  let chat = false, elsewhere = false;
  while (queue.length && seen.size < 20) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const events = store.events(id);
    const data = events.find((event) => event.kind === "run.started")?.data;
    if (events.some((event) => event.kind === "channel.inbound" || event.kind === ownerChatMark)) chat = true;
    if (!data) continue;
    if (data.shortLivedKey === true) origin.shortLivedKey = true;
    if (typeof data.shortLivedKeyId === "string" && !origin.keyIds.includes(data.shortLivedKeyId)) origin.keyIds.push(data.shortLivedKeyId);
    if (typeof data.personProfileId === "string") origin.personProfileId ??= data.personProfileId;
    if (typeof data.source === "string" && data.source !== "owner") origin.source = data.source;
    if (typeof data.source === "string" && !["owner", "channel"].includes(data.source)) elsewhere = true;
    if (data.source === "channel") chat = true;
    // mac7/outside-resume: `originFrom` is the earlier task a follow-up or a "Do this again" carries on for.
    for (const next of [data.parentRunId, data.resumedFrom, data.originFrom]) if (typeof next === "string") queue.push(next);
  }
  // owner-dm-full: the owner's own verified direct chat is the owner, as their window is; anything else a chat touched
  // (another program, a schedule, a trigger along the way) stays a chat's.
  if (chat) origin.source = !elsewhere && ownerChat(store, runId) ? "owner" : "channel";
  if (chat && origin.source === "owner") origin.ownerChat = true;
  origin.lentTo = lentAlong(store, runId);
  return origin;
}

/** The lent conversation's person along a task's own resumptions (never a parent's: a specialist's conversation is not theirs). */
function lentAlong(store: EventReader, runId: string): string | null {
  const seen = new Set<string>();
  for (let id: unknown = runId; typeof id === "string" && !seen.has(id);) {
    seen.add(id);
    const data = startOf(store, id);
    if (typeof data?.lentTo === "string") return data.lentTo;
    id = data?.resumedFrom;
  }
  return null;
}

/** Q226: the same rule for a stop, in words about stopping. */
export const otherKeysStopRefusal =
  "A short-lived key can only stop tasks it started itself. Stop this one in the app window.";
/** Q226: whether the short-lived key behind this request may stop the task `runId`: only one it started, as with answering. */
export function keyStopRefusal(store: EventReader, runId: string): string | null {
  return keyAnswerRefusal(store, runId) ? otherKeysStopRefusal : null;
}
export const otherKeysQuestionRefusal =
  "A short-lived key can only answer questions from tasks it started itself. Answer this one in the app window.";
/**
 * bucket 19: whether the short-lived key behind this request may answer a question the task `runId`
 * asked. Only the key that started the task (or its parent) may; a task the owner started, or one an
 * older key started before keys were written down, is answered in the app window. Null means yes.
 */
export function keyAnswerRefusal(store: EventReader, runId: string | undefined): string | null {
  if (!startedWithShortLivedKey()) return null;
  const { keyId } = shortLivedKeyMark();
  if (!keyId || !runId) return otherKeysQuestionRefusal;
  return runOrigin(store, runId).keyIds.includes(keyId) ? null : otherKeysQuestionRefusal;
}

/**
 * Whether a chat message started this work, or started the task it belongs to. A chat cannot prove who
 * is typing, so such work never gets what only the owner may do.
 *
 * The record is always read, never the context alone: a helper's context is built by hand and often
 * carries no source at all, so a guard that believed the context would let a chat's helper through.
 * Passing the store is therefore not optional (mac7/chat-source integration review).
 */
export function startedFromChat(context: { source?: string | undefined; runId?: string | undefined }, store: EventReader): boolean {
  if (context.source === "channel") return true;
  return !!context.runId && runOrigin(store, context.runId).source === "channel";
}
/**
 * Whether the chat this task, or the task that started it, came from is one with several people in it, where a
 * message may be anybody's. Read along the same chain as runOrigin, since a helper's own task carries no chat mark.
 */
export function fromGroupChat(store: EventReader, runId: string): boolean {
  const seen = new Set<string>(), queue = [runId];
  while (queue.length && seen.size < 20) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const chat = store.events(id).find((event) => event.kind === "channel.inbound")?.data;
    if (chat) return chat.chatKind !== "direct";
    const data = startOf(store, id);
    for (const next of [data?.parentRunId, data?.resumedFrom, data?.originFrom]) if (typeof next === "string") queue.push(next);
  }
  return false;
}
/** The refusal a chat message's task gets for something only the owner may do. */
export function chatOwnerOnly(what: string): Error {
  return new Error(`${what} is for the owner only, and a message from a chat app cannot prove who is typing. Do it in the Branch app.`);
}

/**
 * Q134: the morning brief is gathered from the owner's own schedules, tasks, documents, watches and memory, and
 * sent to the owner's chat, so a Trunk (in its turn or in work it set going) or a delegated specialist is refused
 * every brief tool before anything is gathered or changed, as the to-do list does.
 */
const ownersBriefOnly = "The morning brief is the owner's, gathered from their own schedules, tasks, documents and memory, so only the owner's own tasks can read or change it.";
export function briefOwnerOnly(context: { agent?: string | undefined; trunk?: string | undefined }): void {
  if (context.agent || context.trunk) throw new Error(ownersBriefOnly);
}
