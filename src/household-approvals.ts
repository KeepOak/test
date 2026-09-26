import { runOrigin } from "./key-context.js";
import type { Store } from "./store.js";
import { lentOwner } from "./people/lending.js";

/**
 * Q259: a household person's own conversation: filed under their profile (profiles.scope()), or lent to the owner for
 * as long as one of their tasks works in it (src/collab-server.ts runForCurrentPerson writes `lentTo` on that task).
 */
export function personConversation(store: Store, owner: string, sessionId: string): boolean {
  const scope = store.profiles.scope();
  return store.ownsSession(scope, sessionId) || (store.ownsSession(owner, sessionId) && lentOwner(store, sessionId) === scope);
}

/** Q261: whose records file a conversation the person at the window may use: theirs, or the owner's while it is lent. */
export function conversationHolder(store: Store, owner: string, sessionId: string): string {
  const scope = store.profiles.scope();
  return store.ownsSession(scope, sessionId) ? scope : owner;
}

/**
 * Q257: whose waiting questions a person at the window may see and answer. The owner sees and answers every one.
 * A household person (the window switched to their profile, or a person signed in) only those of their own tasks:
 * a run started for them (`run.started` personProfileId, along its chain) in a conversation that is theirs
 * (profiles.scope(), as the activity list and the event stream follow it since #324 and #339). Everything else is
 * left out of what they read and refused where they answer, before anything about the question is looked at.
 *
 * This is decided at the window's routes, not in Runtime.approve: a chat app, the terminal and the voice answer call
 * that too, and the window being switched to somebody else says nothing about who pressed an answer there.
 */
export function mayAnswerHere(store: Store, asked: { runId?: string | undefined; sessionId: string }): boolean {
  const profiles = store.profiles;
  if (profiles.isOwner()) return true;
  const person = profiles.active();
  if (!person || !asked.runId) return false;
  return runOrigin(store, asked.runId).personProfileId === person.id && store.ownsSession(profiles.scope(), asked.sessionId);
}

/**
 * Q258: whether a task was started for whoever is at the window (the owner: every task). A task that is working has
 * its conversation lent to the owner for as long as it works (src/collab-server.ts runForCurrentPerson), so while it
 * works only where it was started from says whose it is; `/status` counts working tasks with this.
 */
export function startedForHere(store: Store, runId: string): boolean {
  const profiles = store.profiles;
  if (profiles.isOwner()) return true;
  const person = profiles.active();
  return person !== null && runOrigin(store, runId).personProfileId === person.id;
}

/**
 * What a household person is told when a question is not theirs to answer: the words the engine already says when
 * nothing is waiting (src/safety-extras/api.ts), with the same 404, so a live question, one answered already, a
 * made-up fingerprint and a conversation that does not exist all read the same, and nothing is learned by asking.
 */
export const nothingWaitingRefusal = "Nothing in this conversation is waiting for your answer.";

/** Q257: an answer with no fingerprint to a question that has one; the window always sends the one it showed. */
export const unnamedAnswerRefusal = "Say which request this answer is for: look at what it wants to do now and answer again.";
