import { trunksFor } from "../trunks/index.js";
import { carryChoices } from "../conversation-paths-api.js";
import type { CommandContext } from "./chat-commands.js";

/** Leading --here parsing is adapted from Hermes slash_commands_branch_thread.py (MIT). */
function branchName(argument: string): string {
  const text = argument.trim();
  return text.replace(/^--here(?:\s+|$)/i, "").trim();
}

export async function chatBranchCommand(argument: string, context: CommandContext): Promise<string> {
  try { return await forkHere(argument, context); }
  catch (error) { return context.runtime.hideSecrets(error instanceof Error ? error.message : String(error)); }
}
async function forkHere(argument: string, context: CommandContext): Promise<string> {
  if (!context.ownerDm) return "Branch this conversation from your own live direct chat on Telegram, Discord, Slack or Matrix.";
  const { runtime, sessionId } = context, store = runtime.store, owner = runtime.owner;
  store.profiles.requireOwner("Branching a chat conversation");
  if (context.turn) return "Something is working here. Send /stop first, then /branch [name].";
  if (!sessionId || !store.ownsSession(owner, sessionId)) return "This chat has no conversation to branch yet.";
  if (!context.branchRefusal || !context.bindBranch) return "Branching is unavailable from this chat.";
  const refusal = context.branchRefusal();
  if (refusal) return refusal;
  const name = branchName(argument) || "Chat branch";
  if (name.length > 80 || /[\u0000-\u001f]/.test(name)) return "Give the branch a name of up to 80 characters on one line.";
  const trunks = trunksFor(runtime), kind = trunks?.conversations.kind(sessionId);
  if (kind === "room" || kind === "member") return "Branch a room conversation in the Branch app.";
  const messages = store.sessionView(owner, sessionId).messages;
  const last = [...messages].reverse().find((message) => ["user", "assistant"].includes(message.role) && !message.toolCalls?.length);
  if (!last) return "This chat has no message to branch from yet.";
  const made = await store.branchSession(owner, { sessionId, messageId: last.messageId });
  carryLeftOut(context, sessionId, made.sessionId, messages.slice(0, made.copiedMessages).map((message) => message.messageId));
  // The same narrowing choices the window's branch route carries (model, pinned skill, mode), for each owner scope.
  for (const who of new Set([owner, store.profiles.scope()])) carryChoices(store, who, sessionId, made.sessionId);
  if (store.memorySuppressed(owner, sessionId)) store.setMemorySuppressed(owner, made.sessionId, true);
  trunks?.conversations.carryTo(sessionId, made.sessionId);
  store.paths.record(made.sessionId, name, null, "after", made.copiedMessages);
  store.renameConversation(owner, made.sessionId, { title: name });
  if (!context.bindBranch(sessionId, made.sessionId))
    return `Made "${name}" in the Branch app, but this chat changed while it was copied, so its conversation was kept.`;
  return `Branched here as "${name}". Your next message follows the copy; the original remains in this chat's history and the Branch app. No new chat-app thread was opened.`;
}

/** A message excluded by the owner stays excluded in the copy under its new lasting identity. */
function carryLeftOut(context: CommandContext, from: string, to: string, oldIds: number[]): void {
  const store = context.runtime.store, excluded = store.leftOut.ids(from);
  if (!excluded.size) return;
  const copied = store.sessionView(context.runtime.owner, to).messages;
  if (copied.length !== oldIds.length) throw new Error("The branch's context marks could not be copied; this chat was kept.");
  copied.forEach((message, index) => { if (excluded.has(oldIds[index]!)) store.leftOut.set(to, { messageId: message.messageId, out: true }); });
}
