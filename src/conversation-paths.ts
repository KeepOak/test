import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { Message } from "./contracts.js";

/**
 * Pass 17, "Branch from here": parallel paths of one conversation, each named, each with its own
 * model if the owner chose one. A path is an ordinary branch (src/sessions.ts: its own copy of every
 * message and file, recorded in session_branches with the conversation and the message it came
 * off); this adds its name, its model and how many messages it began with, and lists a whole tree
 * of paths so the window can switch between them and compare their answers.
 *
 * Nothing that waits for the owner is copied. A question a task stopped on belongs to that task,
 * and tasks are never copied, so a yes or no is one decision whichever path shows it.
 */
export const PathBranchSchema = z.object({
  /** The message branched from, by its lasting identity (messageId in GET /api/sessions/<id>). */
  messageId: z.number().int().positive(),
  name: z.string().trim().min(1).max(80),
  /** A model preset for the new path; null keeps the model the conversation had. */
  preset: z.string().trim().min(1).max(120).nullable().default(null),
}).strict();
export type PathBranch = z.infer<typeof PathBranchSchema>;

export interface ConversationPath {
  sessionId: string;
  parentSessionId: string | null;
  /** The parent's message the path came off, and whether the path began just before it (answered again) or after it. */
  branchPointMessageId: number | null;
  split: "after" | "before" | null;
  /** How many messages the path began with; its own messages from there on are what differs. */
  copied: number;
  name: string | null;
  preset: string | null;
  createdAt: string;
  messages: number;
  lastAnswer: string;
}

export class ConversationPaths {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS conversation_paths(session_id TEXT PRIMARY KEY, name TEXT NOT NULL, preset TEXT,
      split TEXT NOT NULL, copied INTEGER NOT NULL, created_at TEXT NOT NULL)`);
  }

  record(sessionId: string, name: string, preset: string | null, split: "after" | "before", copied: number): void {
    this.db.prepare("INSERT OR REPLACE INTO conversation_paths VALUES(?,?,?,?,?,?)")
      .run(sessionId, name, preset, split, copied, new Date().toISOString());
  }

  /** Every path of the tree a conversation belongs to, root first, each after its parent. */
  list(owner: string, sessionId: string): { current: string; paths: ConversationPath[] } {
    if (!this.owned(owner, sessionId)) throw new Error("Conversation not found");
    const out: ConversationPath[] = [];
    const walk = (id: string, depth: number) => {
      if (depth > 30 || out.length >= 200 || out.some((p) => p.sessionId === id) || !this.owned(owner, id)) return;
      out.push(this.describe(id));
      for (const child of this.db.prepare("SELECT session_id FROM session_branches WHERE parent_session_id=? ORDER BY created_at").all(id))
        walk(String(child.session_id), depth + 1);
    };
    walk(this.rootOf(sessionId), 0);
    return { current: sessionId, paths: out };
  }

  private describe(id: string): ConversationPath {
    const branch = this.db.prepare("SELECT parent_session_id, branch_point_message_id FROM session_branches WHERE session_id=?").get(id);
    const path = this.db.prepare("SELECT * FROM conversation_paths WHERE session_id=?").get(id);
    const created = this.db.prepare("SELECT created_at FROM sessions WHERE id=?").get(id);
    return {
      sessionId: id,
      parentSessionId: branch ? String(branch.parent_session_id) : null,
      branchPointMessageId: branch ? Number(branch.branch_point_message_id) : null,
      split: path ? (String(path.split) === "before" ? "before" : "after") : branch ? "after" : null,
      copied: path ? Number(path.copied) : 0,
      name: path ? String(path.name) : null,
      preset: path?.preset ? String(path.preset) : null,
      createdAt: String(created?.created_at ?? ""),
      messages: Number(this.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id=?").get(id)?.n ?? 0),
      lastAnswer: this.lastAnswer(id),
    };
  }

  private lastAnswer(id: string): string {
    for (const row of this.db.prepare("SELECT body FROM messages WHERE session_id=? ORDER BY id DESC LIMIT 200").all(id)) {
      const message = JSON.parse(String(row.body)) as Message;
      if (message.role === "assistant" && !message.toolCalls?.length && message.content.trim()) return message.content.trim().slice(0, 4000);
    }
    return "";
  }

  private rootOf(id: string): string {
    const seen = new Set([id]);
    let current = id;
    for (;;) {
      const row = this.db.prepare("SELECT parent_session_id FROM session_branches WHERE session_id=?").get(current);
      if (!row || seen.has(String(row.parent_session_id))) return current;
      current = String(row.parent_session_id);
      seen.add(current);
    }
  }

  private owned(owner: string, id: string): boolean {
    return !!this.db.prepare("SELECT id FROM sessions WHERE id=? AND owner=?").get(id, owner);
  }

  forgetSession(sessionId: string): void {
    this.db.prepare("DELETE FROM conversation_paths WHERE session_id=?").run(sessionId);
  }
}
