import { z } from "zod";
import type { Store } from "./store.js";
import { safeTitle } from "./history-ideas.js";

const key = "home-conversation";
export const HomeConversationChange = z.discriminatedUnion("action", [
  z.object({ action: z.literal("pin"), sessionId: z.string().uuid() }).strict(),
  z.object({ action: z.literal("create") }).strict(),
  z.object({ action: z.literal("unpin") }).strict(),
]);

/** Metadata only. An empty owned conversation is eligible; every retained task must have local owner provenance. */
function eligible(store: Store, owner: string, sessionId?: string) {
  return store.sqlite.prepare(`SELECT s.id AS sessionId, c.title, s.created_at AS createdAt
    FROM sessions s LEFT JOIN conversation_marks c ON c.session_id=s.id AND c.owner=s.owner
    WHERE s.owner=? AND s.temporary=0 AND c.deleted_at IS NULL AND c.archived_at IS NULL
      AND (? IS NULL OR s.id=?)
      AND NOT EXISTS (SELECT 1 FROM conversation_shares x WHERE x.session_id=s.id)
      AND NOT EXISTS (SELECT 1 FROM session_origins x WHERE x.session_id=s.id)
      AND NOT EXISTS (SELECT 1 FROM session_branches x WHERE x.session_id=s.id)
      AND NOT EXISTS (SELECT 1 FROM settings x WHERE x.owner=s.owner AND x.id GLOB 'channel-session:*'
        AND (json_extract(x.data,'$.sessionId')=s.id OR EXISTS (SELECT 1 FROM json_each(x.data,'$.earlier') old WHERE old.value=s.id)))
      AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.session_id=s.id AND (t.owner<>s.owner OR
        NOT EXISTS (SELECT 1 FROM events e WHERE e.run_id=t.id AND e.kind='run.started'
          AND json_extract(e.data,'$.source')='owner' AND json_extract(e.data,'$.callerKind')='owner-here'
          AND json_extract(e.data,'$.parentRunId') IS NULL AND json_extract(e.data,'$.personProfileId') IS NULL
          AND json_extract(e.data,'$.shortLivedKey') IS NULL AND json_extract(e.data,'$.lentTo') IS NULL
          AND json_extract(e.data,'$.originFrom') IS NULL)
        OR EXISTS (SELECT 1 FROM events e WHERE e.run_id=t.id AND e.kind='run.aside')))
    ORDER BY s.created_at DESC LIMIT 100`).all(owner, sessionId ?? null, sessionId ?? null);
}

export function homeConversation(store: Store, owner: string, hide: (text: string) => string) {
  const saved = store.get("settings", owner, key)?.data as { sessionId?: unknown } | undefined;
  const id = typeof saved?.sessionId === "string" ? saved.sessionId : null;
  const rows = eligible(store, owner).map((row) => ({ sessionId: String(row.sessionId), createdAt: String(row.createdAt),
    title: safeTitle(typeof row.title === "string" ? row.title : "", hide) || "Untitled conversation" }));
  // Resolve a saved pin independently of the bounded chooser so older valid pins remain openable.
  const pinned = id ? eligible(store, owner, id)[0] : undefined;
  return { pinned: pinned ? { sessionId: String(pinned.sessionId), title: safeTitle(String(pinned.title ?? ""), hide) || "Home conversation" } : null,
    unavailable: !!id && !pinned, conversations: rows };
}

export function changeHomeConversation(store: Store, owner: string, input: unknown): void {
  const change = HomeConversationChange.parse(input);
  store.atomically(() => {
    if (change.action === "unpin") { store.delete("settings", owner, key); return; }
    const sessionId = change.action === "create" ? store.createSession(owner) : change.sessionId;
    if (!eligible(store, owner, sessionId).length) throw new Error("Choose an existing private, retained local-owner conversation. This conversation is unavailable for Home.");
    store.save("settings", owner, key, { sessionId });
  });
}
