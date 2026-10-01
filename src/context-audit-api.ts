import type { IncomingMessage } from "node:http";
import { z } from "zod";
import type { createBranch } from "./index.js";
import { HttpError } from "./server-http.js";
import { currentPerson } from "./people/context.js";
import { startedWithShortLivedKey } from "./key-context.js";

type Branch = Awaited<ReturnType<typeof createBranch>>;
export const contextAuditRoute = /^\/api\/sessions\/([a-f0-9-]{36})\/context-audit$/;
const Change = z.object({ runId: z.string().uuid(), requestId: z.string().uuid(), callId: z.string().min(1).max(500),
  out: z.boolean(), confirmed: z.literal(true) }).strict();
function guard(app: Branch, owner: string, id: string): void {
  if (app.sessionLock.locked()) throw new HttpError(423, "Unlock Branch to inspect model context.");
  if (currentPerson() || startedWithShortLivedKey() || !app.store.profiles.isOwner() || app.store.profiles.scope() !== owner)
    throw new HttpError(403, "Context audit needs the owner in the current profile.");
  if (!app.store.ownsSession(owner, id)) throw new HttpError(404, "Conversation not found.");
}
export async function contextAuditApi(app: Branch, request: IncomingMessage, path: string, readBody: () => Promise<unknown>) {
  const owner = app.store.profiles.scope(), id = contextAuditRoute.exec(path)![1]!;
  guard(app, owner, id);
  if (request.method === "GET") return app.runtime.contextAudit.read(app.store, owner, id);
  if (request.method !== "POST") throw new HttpError(404, "Endpoint not found.");
  // A profile switch or lock while the body arrives revokes the write, even if switched back or unlocked by then.
  let revoked = false;
  const revoke = () => { revoked = true; };
  const release = [app.store.profiles.onSwitched(revoke), app.sessionLock.onLocked(revoke)];
  try {
    const input = Change.parse(await readBody());
    guard(app, owner, id);
    if (revoked) throw new HttpError(403, "The person using Branch or the app lock changed. Refresh the context audit.");
    app.runtime.contextAudit.change(app.store, owner, id, input.runId, input.requestId, input.callId, input.out);
  } finally { for (const stop of release) stop(); }
  return app.runtime.contextAudit.read(app.store, owner, id);
}
