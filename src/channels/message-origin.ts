import type { Store } from "../store.js";
import { chatAppName } from "../environment.js";

/** Window-only projection of exact engine receipts; never supplied to a model or inferred from prompt text. */
export function channelMessageOrigins<T extends { messageId: number; role: string; from?: string }>(
  store: Pick<Store, "sqlite" | "ownsSession">, owner: string, sessionId: string, messages: readonly T[],
) {
  if (!store.ownsSession(owner, sessionId)) throw new Error("Conversation not found");
  const ids = [...new Set(messages.filter((message) => message.role === "user" && !message.from)
    .map((message) => message.messageId).filter((id) => Number.isSafeInteger(id) && id > 0))];
  // The transcript is already bounded to 1000 messages; batches keep SQLite parameter counts small.
  const kinds = new Map<number, string>();
  for (let at = 0; at < ids.length; at += 100) {
    const part = ids.slice(at, at + 100), marks = part.map(() => "?").join(",");
    const rows = store.sqlite.prepare(`SELECT json_extract(e.data,'$.userMessageId') AS message_id,
        json_extract(e.data,'$.channelKind') AS kind FROM events e JOIN tasks t ON t.id=e.run_id
        JOIN sessions s ON s.id=t.session_id WHERE e.kind='channel.inbound' AND s.owner=?
        AND t.session_id IN (SELECT session_id FROM messages WHERE id IN (${marks}))
        AND json_type(e.data,'$.userMessageId')='integer' AND json_extract(e.data,'$.userMessageId') IN (${marks})
        ORDER BY e.id ASC`).all(owner, ...part, ...part);
    for (const row of rows) {
      const id = Number(row.message_id), kind = typeof row.kind === "string" ? row.kind : "";
      if (!kinds.has(id) && /^[a-z][a-z0-9-]{0,63}$/.test(kind)) kinds.set(id, kind);
    }
  }
  return messages.map((message) => {
    const kind = message.role === "user" && !message.from ? kinds.get(message.messageId) : undefined;
    // Imported/provider message bodies cannot declare their own receipt metadata.
    return { ...message, channelOrigin: kind ? { kind, name: chatAppName(kind) } : undefined };
  });
}
