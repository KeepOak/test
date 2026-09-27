/**
 * Bucket 19: where the new kinds of key may go. Every list fails closed: an address not written
 * down is refused, including any added later.
 *
 * - A person's key reaches only the person's own page (`/api/people/me…`, their conversations and
 *   what was shared with them). Everything else in Branch reads the owner's records, so none of it
 *   is on the list, and the profile check in each route is a second wall behind this one.
 * - A set-up key (from the owner's one-time code) reaches only "set a new PIN", "register a passkey",
 *   "who am I" and "sign out".
 * - A key handed to another device for one conversation reaches that conversation, the tasks in it,
 *   and nothing else of the owner's.
 */
const idPattern = "[a-f0-9-]{36}";
// Where a person's key and a set-up key reach is decided in src/caller-policy.ts, with every other check about the caller.
export { personDoors, personDoorRefusal, personKeyRefusal, setupKeyRefusal } from "../caller-policy.js";

export const boundKeyRefusal = "This key only reaches the conversation it was handed over with.";

/** A key held to one conversation: its own conversation's addresses, the tasks in it, and starting one there. */
export function boundDoorRefusal(
  sessionId: string, method: string, path: string, sessionOfRun: (runId: string) => string | null,
): string | null {
  const session = new RegExp(`^/api/sessions/(${idPattern})(/(followups|summary|model|goal|export))?$`).exec(path);
  if (session) return session[1] === sessionId ? null : boundKeyRefusal;
  const run = new RegExp(`^/api/runs/(${idPattern})(/(cancel|resume|steer|plan|stream|timeline|receipts))?$`).exec(path);
  if (run) return sessionOfRun(run[1]!) === sessionId ? null : boundKeyRefusal;
  // Starting a task and answering a question name the conversation in the body; the route checks it
  // against the key (server.ts, "bucket 19" hooks).
  if (method === "POST" && (path === "/api/run" || path === "/api/policy/approve")) return null;
  if (method === "GET" && path === "/api/people/handoff") return null;
  return boundKeyRefusal;
}

/** For a route that names a conversation in its body: refuses a key held to a different one. */
export function requireBoundSession(bound: string | undefined, sessionId: string | undefined): void {
  if (bound && bound !== sessionId) throw new Error(boundKeyRefusal);
}
