import type { IncomingMessage } from "node:http";
import type { createBranch } from "./index.js";
import { HttpError } from "./server-http.js";
import { PathBranchSchema } from "./conversation-paths.js";

/**
 * Pass 17's conversation routes (design/redesign/pass17/FEATURES17C.md §2, §3, §7):
 *   POST /api/sessions/<id>/branch    a named path from one message, with its own model if chosen
 *   GET  /api/sessions/<id>/paths     every path of the tree that conversation belongs to
 *   POST /api/sessions/<id>/left-out  leave one message out of what the model sees, or put it back
 *   GET  /api/read-marks              the Inbox's read marks (a conversation's own is `unread` in GET /api/sessions)
 *   POST /api/read-marks              mark one conversation or Inbox item read or unread, or all of one kind read
 * All of them act on the conversations of whoever's profile is switched on.
 */
type Branch = Awaited<ReturnType<typeof createBranch>>;
export const conversationPathsRoute = /^\/api\/sessions\/[a-f0-9-]{36}\/(branch|paths|left-out)$/;
export const readMarksPath = "/api/read-marks";

/**
 * Per-conversation choices a path keeps, so a branch is never looser than the conversation it came off: its model,
 * its pinned skill and its mode. Each key is written out whole so tests/settings-history-writers.test.mjs can read
 * it; none of them is a setting in the Settings catalogue (each belongs to one conversation), so the copy leaves no
 * change record, and that test checks nothing in the catalogue moves when a path is made.
 */
function carryChoices(store: Branch["store"], who: string, from: string, to: string): void {
  const model = store.get("settings", who, `session-model:${from}`);
  if (model) store.save("settings", who, `session-model:${to}`, model.data);
  const skill = store.get("settings", who, `pinned-skill:${from}`);
  if (skill) store.save("settings", who, `pinned-skill:${to}`, skill.data);
  const mode = store.get("settings", who, `conversation-mode:${from}`);
  if (mode) store.save("settings", who, `conversation-mode:${to}`, mode.data);
}

export async function conversationPathsApi(app: Branch, request: IncomingMessage, path: string, readBody: () => Promise<unknown>): Promise<unknown> {
  const owner = app.store.profiles.scope(), method = request.method ?? "GET";
  if (path === readMarksPath) {
    if (method === "GET") return { inbox: app.store.readMarks.inbox(owner) };
    if (method === "POST") return app.store.readMarks.mark(owner, await readBody(), (id) => app.store.ownsSession(owner, id));
    throw new HttpError(404, "Endpoint not found");
  }
  const [, , , id, part] = path.split("/") as [string, string, string, string, string];
  if (!app.store.ownsSession(owner, id)) throw new HttpError(404, "Session not found");
  if (part === "paths" && method === "GET") return app.store.paths.list(owner, id);
  if (part === "left-out" && method === "POST") return app.store.leftOut.set(id, await readBody());
  if (part === "branch" && method === "POST") return branchPath(app, owner, id, await readBody());
  throw new HttpError(404, "Endpoint not found");
}

async function branchPath(app: Branch, owner: string, parentId: string, body: unknown) {
  const wanted = PathBranchSchema.parse(body);
  const kind = app.trunks.conversations.kind(parentId);
  if (kind === "member") throw new Error("A room seat's conversation cannot be branched; branch from the room instead.");
  if (wanted.preset && !app.runtime.models.presets.has(wanted.preset)) throw new Error(`Unknown model preset ${wanted.preset}`);
  const point = app.store.sessionView(owner, parentId).messages.find((m) => m.messageId === wanted.messageId);
  if (!point) throw new Error("Branch message not found");
  const before = point.role === "user";
  if (kind === "room") app.trunks.require("rooms");
  const made = kind === "room" ? await app.trunks.rooms.branch(parentId, wanted.messageId, wanted.name, before)
    : await app.store.branchSession(owner, { sessionId: parentId, messageId: wanted.messageId }, undefined, before);
  for (const who of new Set([owner, app.runtime.owner])) carryChoices(app.store, who, parentId, made.sessionId);
  if (app.store.memorySuppressed(owner, parentId)) app.store.setMemorySuppressed(owner, made.sessionId, true);
  if ("roomId" in made && typeof made.roomId === "string") carryRoomChoices(app, owner, parentId, made.roomId, wanted.preset);
  app.trunks.conversations.carryTo(parentId, made.sessionId);
  if (wanted.preset) app.runtime.models.configureSession(owner, made.sessionId, { preset: wanted.preset });
  const split = before ? "before" : "after";
  app.store.paths.record(made.sessionId, wanted.name, wanted.preset, split, made.copiedMessages);
  return { ...made, name: wanted.name, preset: wanted.preset, split, again: before ? point.content : null };
}

function carryRoomChoices(app: Branch, owner: string, from: string, roomId: string, preset: string | null): void {
  const source = app.trunks.rooms.list().find((r) => r.sessionId === from)!;
  const room = app.trunks.rooms.get(roomId);
  for (const member of room.members) {
    const seat = room.memberSessions[member]!, previous = source.memberSessions[member]!;
    carryChoices(app.store, owner, previous, seat);
    if (app.store.memorySuppressed(owner, from) || app.store.memorySuppressed(owner, previous))
      app.store.setMemorySuppressed(owner, seat, true);
    if (preset) app.runtime.models.configureSession(owner, seat, { preset });
  }
}
