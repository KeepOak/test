/**
 * Bucket 19: where the two new kinds of key may go. Both lists fail closed: an address not written
 * here is refused, including any added later.
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
interface Door { method: "GET" | "POST"; pattern: RegExp }
const door = (method: Door["method"], path: string): Door => ({ method, pattern: new RegExp(`^${path}$`) });

export const personDoors: readonly Door[] = [
  door("GET", "/api/people/me"),
  door("POST", "/api/people/me/sign-out"),
  door("POST", "/api/people/me/pin"),
  door("GET", "/api/people/me/passkeys"),
  door("POST", "/api/people/me/passkeys/(begin|finish)"),
  door("POST", "/api/people/me/passkeys/remove"),
  door("GET", "/api/people/conversations"),
  door("POST", "/api/people/conversations"),
  door("GET", `/api/people/conversations/${idPattern}`),
  door("POST", `/api/people/conversations/${idPattern}/message`),
];
const setupDoors: readonly Door[] = [
  door("GET", "/api/people/me"),
  door("POST", "/api/people/me/sign-out"),
  door("POST", "/api/people/me/pin"),
  door("GET", "/api/people/me/passkeys"),
  door("POST", "/api/people/me/passkeys/(begin|finish)"),
];

export const personKeyRefusal = "A person's sign-in reaches only their own page. Everything else is the owner's.";
export const setupKeyRefusal = "This short sign-in may only set a new PIN or register a passkey. Then sign in again.";

/** Why a person's key may not use this address, or null. */
export function personDoorRefusal(method: string | undefined, path: string, setupOnly: boolean): string | null {
  const doors = setupOnly ? setupDoors : personDoors;
  if (doors.some((each) => each.method === (method ?? "GET") && each.pattern.test(path))) return null;
  return setupOnly ? setupKeyRefusal : personKeyRefusal;
}

export const boundKeyRefusal = "This key only reaches the conversation it was handed over with.";

/** A key held to one conversation: its own conversation's addresses, the tasks in it, and starting one there. */
export function boundDoorRefusal(
  sessionId: string, method: string, path: string, sessionOfRun: (runId: string) => string | null,
): string | null {
  const session = new RegExp(`^/api/sessions/(${idPattern})(/(followups|summary|model|goal|export))?$`).exec(path);
  if (session) return session[1] === sessionId ? null : boundKeyRefusal;
  const run = new RegExp(`^/api/runs/(${idPattern})(/(cancel|pause|resume|steer|plan|stream|timeline|receipts))?$`).exec(path);
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
