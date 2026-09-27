import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { Message } from "./contracts.js";

/**
 * Pass 17, "Leave out of context": a message the owner keeps in the conversation, shown as it was,
 * but never sent to the model again. The mark is held against the message's lasting identity
 * (source_id), like a pin, so it survives a transcript being repaired; a branch of the conversation
 * has its own messages and so its own marks.
 *
 * Only something the owner or the assistant said can be left out. A reply that asked for tools is
 * refused: leaving it out would leave its tool results answering a request the model never sees,
 * which providers reject. Leaving out a pinned message unpins it, since a pin exists to keep a
 * message in front of the model.
 */
export const LeftOutSchema = z.object({
  /** The message's lasting identity, as GET /api/sessions/<id> gives it (messageId). */
  messageId: z.number().int().positive(),
  out: z.boolean(),
}).strict();

export class LeftOutMessages {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS session_left_out(session_id TEXT NOT NULL, source_id INTEGER NOT NULL,
      created_at TEXT NOT NULL, PRIMARY KEY(session_id, source_id))`);
  }

  /** Leaves one message out of what the model sees, or puts it back. */
  set(sessionId: string, input: unknown): { messageId: number; out: boolean; unpinned: boolean } {
    const { messageId, out } = LeftOutSchema.parse(input);
    const row = this.db.prepare("SELECT body FROM messages WHERE session_id=? AND COALESCE(source_id,id)=?").get(sessionId, messageId);
    if (!row) throw new Error("That message is not in this conversation");
    const message = JSON.parse(String(row.body)) as Message;
    if (out && (!["user", "assistant"].includes(message.role) || message.toolCalls?.length))
      throw new Error("Only something you or the assistant said can be left out; a step that used tools cannot");
    let unpinned = false;
    if (out) {
      this.db.prepare("INSERT OR IGNORE INTO session_left_out VALUES(?,?,?)").run(sessionId, messageId, new Date().toISOString());
      unpinned = Number(this.db.prepare("DELETE FROM session_pins WHERE session_id=? AND source_id=?").run(sessionId, messageId).changes) > 0;
    } else this.db.prepare("DELETE FROM session_left_out WHERE session_id=? AND source_id=?").run(sessionId, messageId);
    return { messageId, out, unpinned };
  }

  /** The lasting identities of every message left out in one conversation. */
  ids(sessionId: string): Set<number> {
    return new Set(this.db.prepare("SELECT source_id FROM session_left_out WHERE session_id=?").all(sessionId).map((r) => Number(r.source_id)));
  }
}
