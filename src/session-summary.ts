import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { Message } from "./contracts.js";

/**
 * What a long conversation leaves behind. When older turns are folded away, the assistant keeps a
 * structured note of it — what we are trying to do, what was decided, what is still open, which
 * files were touched — instead of a paragraph nobody can check. The owner can also pin a message
 * so it is never folded away, however long the conversation runs.
 */
const entry = z.string().trim().min(1).max(300);
/** long-work: how many entries each list keeps once merged; a model's own reply may bring up to the same. */
export const summaryCaps = { goals: 10, decisions: 40, instructions: 20, openQuestions: 10, todos: 20, filesTouched: 40 } as const;
export const SessionSummarySchema = z.object({
  goals: z.array(entry).max(summaryCaps.goals).default([]),
  decisions: z.array(entry).max(summaryCaps.decisions).default([]),
  /** long-work: what the person told the assistant to always or never do, in their words; never folded away. */
  instructions: z.array(entry).max(summaryCaps.instructions).default([]),
  openQuestions: z.array(entry).max(summaryCaps.openQuestions).default([]),
  /** long-work: what is still to be done, in order. */
  todos: z.array(entry).max(summaryCaps.todos).default([]),
  filesTouched: z.array(entry).max(summaryCaps.filesTouched).default([]),
}).strict();
export type SessionSummary = z.infer<typeof SessionSummarySchema>;
export interface SavedSummary { sessionId: string; summary: SessionSummary | null; text: string; createdAt: string }
export interface PinnedMessage { messageId: number; sourceId: number; role: string; content: string; createdAt: string }

/** The model's answer as a structured summary, when it replied with the shape we asked for. */
export function parseSessionSummary(reply: string): SessionSummary | null {
  const start = reply.indexOf("{"), end = reply.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = SessionSummarySchema.safeParse(JSON.parse(reply.slice(start, end + 1)) as unknown);
    if (!parsed.success) return null;
    const value = parsed.data;
    return Object.values(value).some((list) => list.length) ? value : null;
  } catch { return null; }
}
/** The lists a reply really stated (an explicit `[]` included), which the schema's defaults cannot tell apart from omitted ones. */
export function statedLists(reply: string): Set<string> {
  const start = reply.indexOf("{"), end = reply.lastIndexOf("}");
  if (start < 0 || end <= start) return new Set();
  try {
    const parsed = JSON.parse(reply.slice(start, end + 1)) as unknown;
    return new Set(parsed && typeof parsed === "object" && !Array.isArray(parsed) ? Object.keys(parsed) : []);
  } catch { return new Set(); }
}
/** The same summary written out for the model to read back at the top of the conversation. */
export function summaryText(summary: SessionSummary): string {
  const section = (title: string, items: string[]) => (items.length ? `${title}:\n${items.map((i) => `- ${i}`).join("\n")}` : "");
  return [
    section("What we are trying to do", summary.goals),
    section("What was decided", summary.decisions),
    section("What the person asked you to always or never do", summary.instructions),
    section("Still to do", summary.todos),
    section("Still open", summary.openQuestions),
    section("Files touched", summary.filesTouched),
  ].filter(Boolean).join("\n\n").slice(0, 6000);
}

/**
 * long-work: a fold never loses what an earlier fold kept. Decisions, instructions, goals and files touched are the
 * earlier summary's followed by the new one's, each once; when a list is full the oldest entries and the newest stay
 * and the middle goes, so the decision from the start of a long conversation is still there at its end. To-dos and
 * open questions are the current state: the newest summary's when it stated the list (`stated`, an explicit empty
 * list clears it: everything was done or answered), else the earlier one's; `known` (read from the record itself: the
 * files the task's tools touched, the open to-dos) is always added.
 */
export function mergeSummaries(previous: SessionSummary | null, next: SessionSummary | null, known: Partial<SessionSummary> = {},
  stated: ReadonlySet<string> = new Set()): SessionSummary {
  const merged = {} as SessionSummary;
  for (const key of Object.keys(summaryCaps) as (keyof SessionSummary)[]) {
    const current = key === "todos" || key === "openQuestions"
      ? (next && (stated.has(key) || next[key].length) ? next[key] : previous?.[key] ?? [])
      : [...(previous?.[key] ?? []), ...(next?.[key] ?? [])];
    merged[key] = keepEnds(unique([...current, ...(known[key] ?? [])]), summaryCaps[key]);
  }
  return merged;
}
const unique = (items: string[]): string[] => {
  const seen = new Set<string>();
  return items.filter((item) => { const key = item.trim().toLowerCase(); if (!key || seen.has(key)) return false; seen.add(key); return true; });
};
/** At most `cap` entries: the oldest quarter and the newest rest, so both ends of a long conversation survive. */
function keepEnds(items: string[], cap: number): string[] {
  if (items.length <= cap) return items;
  const head = Math.max(1, Math.floor(cap / 4));
  return [...items.slice(0, head), ...items.slice(items.length - (cap - head))];
}

export class SessionSummaries {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS session_summaries(session_id TEXT PRIMARY KEY, owner TEXT NOT NULL,
        data TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS session_pins(session_id TEXT NOT NULL, source_id INTEGER NOT NULL,
        created_at TEXT NOT NULL, PRIMARY KEY(session_id, source_id));`);
  }
  save(owner: string, sessionId: string, summary: SessionSummary | null, text: string): SavedSummary {
    const createdAt = new Date().toISOString();
    this.db.prepare(`INSERT INTO session_summaries VALUES(?,?,?,?,?) ON CONFLICT(session_id)
      DO UPDATE SET data=excluded.data, text=excluded.text, created_at=excluded.created_at`)
      .run(sessionId, owner, JSON.stringify(summary), text.slice(0, 6000), createdAt);
    return { sessionId, summary, text, createdAt };
  }
  get(sessionId: string): SavedSummary | null {
    const row = this.db.prepare("SELECT * FROM session_summaries WHERE session_id=?").get(sessionId);
    if (!row) return null;
    const parsed = SessionSummarySchema.safeParse(JSON.parse(String(row.data)) as unknown);
    return { sessionId, summary: parsed.success ? parsed.data : null, text: String(row.text), createdAt: String(row.created_at) };
  }

  /** Marks one message to be kept in front of the model however long the conversation runs. */
  setPinned(sessionId: string, messageId: number, pinned: boolean): { messageId: number; pinned: boolean } {
    const row = this.db.prepare("SELECT source_id, body FROM messages WHERE id=? AND session_id=?").get(messageId, sessionId);
    if (!row) throw new Error("That message is not in this conversation");
    const message = JSON.parse(String(row.body)) as Message;
    if (pinned && (message.role === "tool" || message.toolCalls?.length || message.role === "system"))
      throw new Error("Only something you or the assistant said can be kept; a tool result cannot be kept on its own");
    const sourceId = Number(row.source_id ?? messageId);
    if (pinned) this.db.prepare("INSERT OR IGNORE INTO session_pins VALUES(?,?,?)").run(sessionId, sourceId, new Date().toISOString());
    else this.db.prepare("DELETE FROM session_pins WHERE session_id=? AND source_id=?").run(sessionId, sourceId);
    return { messageId, pinned };
  }
  /**
   * Pins are held against the message's lasting identity, not its row, because a conversation's
   * rows are rewritten whenever an interrupted transcript is repaired.
   */
  pins(sessionId: string): PinnedMessage[] {
    return this.db.prepare(`SELECT m.id, m.source_id, m.body, p.created_at FROM session_pins p
      JOIN messages m ON m.source_id=p.source_id AND m.session_id=p.session_id
      WHERE p.session_id=? ORDER BY m.id LIMIT 50`).all(sessionId).map((row) => {
      const message = JSON.parse(String(row.body)) as Message;
      return { messageId: Number(row.id), sourceId: Number(row.source_id), role: message.role,
        content: message.content.slice(0, 2000), createdAt: String(row.created_at) };
    });
  }
  pinnedMessageIds(sessionId: string): Set<number> {
    return new Set(this.pins(sessionId).map((pin) => pin.messageId));
  }
}
