import type { Store } from "../store.js";

/**
 * defaulttrunk: a chat app's chat is one thread, like iMessage. Each chat (a direct chat, a group, a forum topic, a
 * channel) keeps ONE conversation with the Trunk it is routed to, in its `channel-session:<channel>:<chatId>` record,
 * and every message carries on that same conversation. "/new" (or "/reset", "/clear") starts a fresh one; the one before
 * is kept in history, listed in `earlier`, newest first, and never deleted.
 *
 * Which Trunk a new thread goes to: the chat's own binding (lane chatparity, src/channels/routes.ts), else the default
 * Trunk (src/trunks/defaults.ts). A thread keeps its Trunk; a binding changed later starts a fresh thread (freshThread).
 */
export interface ChatThread {
  channel: string;
  chatId: string;
  title: string;
  updatedAt: string;
  /** The conversation this chat carries on now; absent after "/new" until the next message. */
  sessionId?: string;
  /** Pointed at an existing conversation by the owner (ChannelRouter.link). */
  linked?: boolean;
  /** The Trunk this chat's conversation is with. */
  trunkId?: string;
  /** Earlier conversations of this chat, newest first, kept in history. */
  earlier?: string[];
}
/** How many earlier conversations one chat's record names; older ones stay in history, just not listed here. */
const earlierKept = 200;
export const chatThreadKey = (channel: string, chatId: string): string => `channel-session:${channel}:${chatId}`;

export function chatThread(store: Pick<Store, "get">, owner: string, channel: string, chatId: string): ChatThread | undefined {
  return store.get("settings", owner, chatThreadKey(channel, chatId))?.data as ChatThread | undefined;
}

/** Saves a change to a chat's thread, keeping every field it does not name. */
export function saveChatThread(store: Pick<Store, "get" | "save">, owner: string, channel: string, chatId: string,
  change: { [K in keyof ChatThread]?: ChatThread[K] | undefined }): ChatThread {
  const saved = chatThread(store, owner, channel, chatId);
  const next = { title: chatId, updatedAt: new Date().toISOString(), ...saved, ...change, channel, chatId } as ChatThread;
  // A conversation that was this chat's and is no longer the one it carries on is kept in `earlier`.
  if (saved?.sessionId && saved.sessionId !== next.sessionId) next.earlier = keep([saved.sessionId, ...(next.earlier ?? [])]);
  if (next.sessionId) next.earlier = (next.earlier ?? []).filter((id) => id !== next.sessionId);
  store.save("settings", owner, chatThreadKey(channel, chatId), { ...next });
  return next;
}
const keep = (ids: string[]): string[] => [...new Set(ids)].slice(0, earlierKept);

/**
 * "/new", "/reset", or a new binding (chatparity): the chat's next message starts a fresh conversation, with the Trunk
 * the chat is routed to then. The conversation it had stays in history and in `earlier`.
 */
export function freshThread(store: Pick<Store, "get" | "save">, owner: string, channel: string, chatId: string): void {
  const saved = chatThread(store, owner, channel, chatId);
  if (!saved) return;
  const { sessionId, trunkId: _trunk, linked: _linked, ...rest } = saved;
  store.save("settings", owner, chatThreadKey(channel, chatId),
    { ...rest, updatedAt: new Date().toISOString(), earlier: keep([...(sessionId ? [sessionId] : []), ...(saved.earlier ?? [])]) });
}

/**
 * The migration: every conversation a chat started before threads existed (each "/new" made one) joins that chat's
 * thread as an earlier conversation, newest first, and the thread says which Trunk it is with. Nothing is merged, moved
 * or deleted; only the chat's own record is written. Idempotent.
 */
export function linkChatThreads(store: Store, owner: string, trunkOf: (sessionId: string) => string | null): number {
  const db = store.sqlite;
  const rows = db.prepare(`SELECT json_extract(e.data,'$.channel') AS channel, json_extract(e.data,'$.chatId') AS chat,
      t.session_id AS s, MAX(e.id) AS last FROM events e JOIN tasks t ON t.id=e.run_id JOIN sessions x ON x.id=t.session_id
    WHERE e.kind='channel.inbound' AND t.owner=? AND x.temporary=0 GROUP BY channel, chat, s ORDER BY last DESC`).all(owner);
  const byChat = new Map<string, { channel: string; chatId: string; sessions: string[] }>();
  for (const row of rows) {
    const channel = String(row.channel ?? ""), chatId = String(row.chat ?? "");
    if (!channel || !chatId) continue;
    const key = `${channel}\u0000${chatId}`;
    const entry = byChat.get(key) ?? { channel, chatId, sessions: [] };
    entry.sessions.push(String(row.s));
    byChat.set(key, entry);
  }
  let changed = 0;
  store.atomically(() => {
    for (const { channel, chatId, sessions } of byChat.values()) {
      const saved = chatThread(store, owner, channel, chatId);
      if (!saved) continue; // a chat the owner took out of the list stays out
      const earlier = keep([...(saved.earlier ?? []), ...sessions.filter((id) => id !== saved.sessionId)]);
      const trunkId = saved.sessionId ? trunkOf(saved.sessionId) ?? undefined : undefined;
      if (earlier.length === (saved.earlier ?? []).length && (trunkId ?? null) === (saved.trunkId ?? null)) continue;
      store.save("settings", owner, chatThreadKey(channel, chatId), { ...saved, earlier, ...(trunkId ? { trunkId } : {}) });
      changed++;
    }
  });
  return changed;
}
