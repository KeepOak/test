import type { DatabaseSync } from "node:sqlite";

/**
 * defaulttrunk: which Trunk a conversation belongs to, when it is not a Trunk's own chat, a room or a room side.
 *
 * Like iMessage, every conversation is a thread with somebody: a Trunk the owner chose for it, the Trunk a chat app's
 * chat is routed to, the default Trunk for a new conversation that named nobody, or the Trunk that already answered in
 * it before threads existed. One row per conversation, in a table of its own: thousands of conversations would crowd
 * the `governance` records (read 500 at a time, newest first) and push the Trunks themselves out of sight.
 *
 * The owner's own choice (src/trunks/conversations.ts, `trunk-conversation:<id>`) is written here too, in the same
 * step, and keeps its record there only for who signed each reply. A row is removed with its conversation
 * (src/store.ts forgetConversationRows); nothing here ever removes a conversation or a message.
 */
export type ThreadHow = "chosen" | "default" | "routed" | "claimed" | "migrated" | "handed";
export interface ThreadRow { sessionId: string; trunkId: string; how: ThreadHow; at: string }

/** Made with the database (src/store.ts), since what a Trunk may look back on (src/history.ts) asks it from the start. */
export function ensureThreadTable(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS trunk_threads(session_id TEXT PRIMARY KEY, owner TEXT NOT NULL, trunk_id TEXT NOT NULL,
    how TEXT NOT NULL, at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS trunk_threads_trunk ON trunk_threads(owner, trunk_id)`);
}

export class TrunkThreads {
  constructor(private readonly db: DatabaseSync, private readonly owner: string) {
    ensureThreadTable(db);
  }
  /** Every conversation with its Trunk, for the in-memory map the runtime asks on every task. */
  all(): Map<string, string> {
    return new Map(this.db.prepare("SELECT session_id AS s, trunk_id AS t FROM trunk_threads WHERE owner=?").all(this.owner)
      .map((row) => [String(row.s), String(row.t)] as const));
  }
  get(sessionId: string): ThreadRow | undefined {
    const row = this.db.prepare("SELECT * FROM trunk_threads WHERE session_id=? AND owner=?").get(sessionId, this.owner);
    return row ? { sessionId: String(row.session_id), trunkId: String(row.trunk_id), how: String(row.how) as ThreadHow, at: String(row.at) } : undefined;
  }
  /** Puts a conversation with a Trunk, replacing whoever had it. */
  set(sessionId: string, trunkId: string, how: ThreadHow): void {
    this.db.prepare(`INSERT INTO trunk_threads VALUES(?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET trunk_id=excluded.trunk_id,
      how=excluded.how, at=excluded.at WHERE trunk_threads.owner=excluded.owner`).run(sessionId, this.owner, trunkId, how, new Date().toISOString());
  }
  /** Puts a conversation with a Trunk only when nobody has it yet; true when it was put. */
  claim(sessionId: string, trunkId: string, how: ThreadHow): boolean {
    return this.db.prepare("INSERT OR IGNORE INTO trunk_threads VALUES(?,?,?,?,?)")
      .run(sessionId, this.owner, trunkId, how, new Date().toISOString()).changes > 0;
  }
  /** Takes the owner's choice back: the conversation belongs to nobody until something puts it with a Trunk again. */
  clear(sessionId: string): void {
    this.db.prepare("DELETE FROM trunk_threads WHERE session_id=? AND owner=?").run(sessionId, this.owner);
  }
  /** The conversations one Trunk has, newest first. */
  of(trunkId: string): string[] {
    return this.db.prepare("SELECT session_id AS s FROM trunk_threads WHERE owner=? AND trunk_id=? ORDER BY at DESC").all(this.owner, trunkId)
      .map((row) => String(row.s));
  }
  /** Hands every conversation of one Trunk to another (a Trunk removed hands its threads to the default). */
  hand(from: string, to: string): number {
    return Number(this.db.prepare("UPDATE trunk_threads SET trunk_id=?, how='handed', at=? WHERE owner=? AND trunk_id=?")
      .run(to, new Date().toISOString(), this.owner, from).changes);
  }
}
