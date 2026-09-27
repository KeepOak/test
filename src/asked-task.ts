import { runOrigin, type EventReader } from "./key-context.js";

/**
 * Q050: what a task that stopped to ask is waiting on, read from its own record, so an answer reaches that task and
 * nothing else. A yes to a request goes through the approvals route (POST /api/policy/approve), bound to the request's
 * fingerprint; a reply to the task's own question (user.ask) is the person's next message in its conversation.
 */

/** Whether the task's newest question is its own (user.ask), which the person's next message answers. */
export function waitsForReply(store: EventReader, runId: string): boolean {
  const events = store.events(runId);
  const asked = events.filter((event) => event.kind === "attention.needed").at(-1)?.data.callId;
  if (typeof asked !== "string") return false;
  // A request stopped by the approval policy is answered by Allow or Deny, never by a message.
  if (events.some((event) => event.kind === "policy.ask" && event.data.id === asked)) return false;
  return events.some((event) => event.kind === "tool.started" && event.data.id === asked && event.data.name === "user.ask");
}

/**
 * The owner's own task, started at the owner's window or command line: never a key's (it records source "owner" too),
 * a household person's, one lent to a person, a helper, or one that came from elsewhere (NAS 618407c). Only such a
 * task is carried on by the owner's answer given at the window.
 */
export function ownersOwnTask(store: EventReader, runId: string): boolean {
  const origin = runOrigin(store, runId);
  return origin.source === "owner" && !origin.shortLivedKey && !origin.keyIds.length
    && !origin.personProfileId && !origin.lentTo && !origin.parentRunId;
}
