import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

/**
 * Pass 17, "Unread": which conversations and Inbox items the person has seen, per profile.
 *
 * Messages carry no times, so a conversation is unread when an assistant message was written after
 * the newest message it held when last read (message rows only ever count up), or when the person
 * marked it unread. A baseline taken when this table is first made, and moved by "Mark all read",
 * keeps an upgraded install from lighting up every conversation it already had.
 *
 * Inbox items are named by the window (`ask:<session>:<fingerprint>`, `run:<id>`, …) and each has a
 * time or not; this keeps the names read or marked unread, and the time before which everything is
 * read. Marking read never answers or dismisses anything. Reading never marks anything: the window
 * says when something was opened.
 */
const itemKey = z.string().regex(/^[a-z]{2,12}:[A-Za-z0-9:_-]{1,200}$/, "An Inbox item is named like run:<id>");
export const ReadMarkSchema = z.union([
  z.object({ conversation: z.string().uuid(), unread: z.boolean() }).strict(),
  z.object({ inbox: itemKey, unread: z.boolean() }).strict(),
  z.object({ all: z.enum(["conversations", "inbox"]) }).strict(),
]);

export interface InboxMarks { since: string; read: string[]; unread: string[] }

export class ReadMarks {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS read_marks(owner TEXT NOT NULL, kind TEXT NOT NULL, item TEXT NOT NULL,
        read_through INTEGER NOT NULL DEFAULT 0, unread INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, PRIMARY KEY(owner, kind, item));
      CREATE TABLE IF NOT EXISTS read_baselines(owner TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(owner, kind));`);
    // Everyone's starting point: what already existed when unread marks arrived counts as read.
    const top = Number(db.prepare("SELECT COALESCE(MAX(id),0) AS id FROM messages").get()?.id ?? 0);
    db.prepare("INSERT OR IGNORE INTO read_baselines VALUES('*','conversations',?)").run(String(top));
    db.prepare("INSERT OR IGNORE INTO read_baselines VALUES('*','inbox',?)").run(new Date().toISOString());
  }

  private baseline(owner: string, kind: "conversations" | "inbox"): string {
    const row = this.db.prepare("SELECT value FROM read_baselines WHERE owner=? AND kind=?").get(owner, kind)
      ?? this.db.prepare("SELECT value FROM read_baselines WHERE owner='*' AND kind=?").get(kind);
    return String(row?.value ?? "");
  }

  /** Whether a conversation has something the person has not seen. */
  unread(owner: string, sessionId: string): boolean {
    const mark = this.db.prepare("SELECT read_through, unread FROM read_marks WHERE owner=? AND kind='conversation' AND item=?").get(owner, sessionId);
    if (Number(mark?.unread ?? 0) === 1) return true;
    const through = Math.max(Number(mark?.read_through ?? 0), Number(this.baseline(owner, "conversations")) || 0);
    const latest = this.db.prepare("SELECT MAX(id) AS id FROM messages WHERE session_id=? AND json_extract(body,'$.role')='assistant'").get(sessionId);
    return Number(latest?.id ?? 0) > through;
  }

  inbox(owner: string): InboxMarks {
    const rows = this.db.prepare("SELECT item, unread FROM read_marks WHERE owner=? AND kind='inbox' ORDER BY updated_at DESC LIMIT 2000").all(owner);
    return { since: this.baseline(owner, "inbox"), read: rows.filter((r) => Number(r.unread) === 0).map((r) => String(r.item)),
      unread: rows.filter((r) => Number(r.unread) === 1).map((r) => String(r.item)) };
  }

  /** One mark, or everything of one kind read; `owns` says whether a conversation is this person's. */
  mark(owner: string, input: unknown, owns: (sessionId: string) => boolean): { ok: true } {
    const wanted = ReadMarkSchema.parse(input), now = new Date().toISOString();
    if ("all" in wanted) {
      const value = wanted.all === "conversations"
        ? String(this.db.prepare("SELECT COALESCE(MAX(id),0) AS id FROM messages").get()?.id ?? 0) : now;
      this.db.prepare("INSERT INTO read_baselines VALUES(?,?,?) ON CONFLICT(owner,kind) DO UPDATE SET value=excluded.value").run(owner, wanted.all, value);
      this.db.prepare("DELETE FROM read_marks WHERE owner=? AND kind=?").run(owner, wanted.all === "conversations" ? "conversation" : "inbox");
      return { ok: true };
    }
    if ("conversation" in wanted) {
      if (!owns(wanted.conversation)) throw new Error("Conversation not found");
      const top = Number(this.db.prepare("SELECT COALESCE(MAX(id),0) AS id FROM messages WHERE session_id=?").get(wanted.conversation)?.id ?? 0);
      this.upsert(owner, "conversation", wanted.conversation, top, wanted.unread, now);
      return { ok: true };
    }
    this.upsert(owner, "inbox", wanted.inbox, 0, wanted.unread, now);
    return { ok: true };
  }

  private upsert(owner: string, kind: string, item: string, through: number, unread: boolean, now: string): void {
    this.db.prepare(`INSERT INTO read_marks VALUES(?,?,?,?,?,?) ON CONFLICT(owner,kind,item) DO UPDATE SET
      read_through=CASE WHEN excluded.unread=1 THEN read_marks.read_through ELSE excluded.read_through END,
      unread=excluded.unread, updated_at=excluded.updated_at`).run(owner, kind, item, through, Number(unread), now);
  }

  forgetSession(sessionId: string): void {
    this.db.prepare("DELETE FROM read_marks WHERE kind='conversation' AND item=?").run(sessionId);
  }
}
