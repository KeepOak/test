import type { DatabaseSync } from "node:sqlite";

/**
 * Telegram's inbox: every update is written down here before Telegram is told it arrived, so the saved row, not the
 * finished task, is what lets the read position move on. Telegram confirms an update, and never sends it again, "as
 * soon as getUpdates is called with an offset higher than its update_id" (https://core.telegram.org/bots/api#getupdates).
 * Holding that offset back until a whole task finished made the bot ask again and again for the update it was working
 * on, stall once 100 more were waiting, and after a crash run again every later update whose task had already finished.
 *
 * Here the committed row is the acknowledgement: the offset moves on as soon as the rows are saved, the updates are
 * worked through in the order they came, and a row is marked done once it was handled, so a restart picks up only
 * the ones that were not. Rows are kept per bot (the number before the colon in its token) and update id.
 *
 * Adapted from OpenClaw's Telegram ingress spool (https://github.com/openclaw/openclaw, MIT, Copyright (c) 2026
 * OpenClaw Foundation): `extensions/telegram/src/polling-session.ts`, where "the committed spool enqueue is the ACK
 * boundary", and `extensions/telegram/src/telegram-ingress-spool.ts`. Written afresh for Branch's own SQLite store.
 */
export interface InboxRow {
  updateId: number;
  update: unknown;
  /** It arrived while Branch was closed (or was cut off by a restart), so it is handled as old news. */
  caughtUp: boolean;
}
export interface TelegramInbox {
  /** Saves new updates as one piece; an update id already kept (handled or not) is left as it is. */
  add(rows: InboxRow[]): void;
  /** Updates not yet handled, oldest first. */
  pending(): InboxRow[];
  /** Marks an update handled; its words are dropped and only its number kept, so it is never taken in twice. */
  done(updateId: number): void;
  /** Marks every update still waiting as caught up: after a restart they are old news. */
  markCaughtUp(): void;
  /** The highest update id kept, or 0. */
  newest(): number;
  /**
   * Updates handed over in this process and not yet settled. Shared by every adapter for the same bot on the same
   * database, so a bot connected again while a task works does not hand that task's update over a second time.
   */
  readonly working: Set<number>;
}

/** How long a handled update's number is kept: Telegram keeps an unconfirmed update for 24 hours, so two days is ample. */
const keepDoneMs = 48 * 60 * 60 * 1000;

/** Per database and bot: the updates being handled in this process (TelegramInbox.working). */
const workingByDb = new WeakMap<DatabaseSync, Map<string, Set<number>>>();
function workingFor(db: DatabaseSync, bot: string): Set<number> {
  const bots = workingByDb.get(db) ?? new Map<string, Set<number>>();
  workingByDb.set(db, bots);
  const ids = bots.get(bot) ?? new Set<number>();
  bots.set(bot, ids);
  return ids;
}

class SqliteInbox implements TelegramInbox {
  readonly working: Set<number>;
  constructor(private readonly db: DatabaseSync, private readonly bot: string, private readonly isOpen: () => boolean) {
    db.exec(`CREATE TABLE IF NOT EXISTS telegram_inbox(bot TEXT NOT NULL, update_id INTEGER NOT NULL, body TEXT NOT NULL,
      caught_up INTEGER NOT NULL DEFAULT 0, received_at TEXT NOT NULL, done_at TEXT, PRIMARY KEY(bot, update_id))`);
    this.working = workingFor(db, bot);
  }
  add(rows: InboxRow[]): void {
    if (!rows.length) return;
    const now = new Date().toISOString();
    const insert = this.db.prepare("INSERT OR IGNORE INTO telegram_inbox(bot, update_id, body, caught_up, received_at) VALUES(?,?,?,?,?)");
    this.atomically(() => {
      this.db.prepare("DELETE FROM telegram_inbox WHERE bot=? AND done_at IS NOT NULL AND done_at < ?")
        .run(this.bot, new Date(Date.now() - keepDoneMs).toISOString());
      for (const row of rows) insert.run(this.bot, row.updateId, JSON.stringify(row.update), row.caughtUp ? 1 : 0, now);
    });
  }
  pending(): InboxRow[] {
    return this.db.prepare("SELECT update_id, body, caught_up FROM telegram_inbox WHERE bot=? AND done_at IS NULL ORDER BY update_id")
      .all(this.bot).map((row) => ({ updateId: Number(row.update_id), update: JSON.parse(String(row.body)), caughtUp: Number(row.caught_up) === 1 }));
  }
  done(updateId: number): void {
    // A task can settle after Branch closed its database; the row then stays waiting and is handled after the restart.
    if (!this.isOpen()) return;
    this.db.prepare("UPDATE telegram_inbox SET done_at=?, body='{}' WHERE bot=? AND update_id=?").run(new Date().toISOString(), this.bot, updateId);
  }
  markCaughtUp(): void {
    this.db.prepare("UPDATE telegram_inbox SET caught_up=1 WHERE bot=? AND done_at IS NULL").run(this.bot);
  }
  newest(): number {
    return Number(this.db.prepare("SELECT COALESCE(MAX(update_id), 0) AS id FROM telegram_inbox WHERE bot=?").get(this.bot)?.id ?? 0);
  }
  private atomically(work: () => void): void {
    if (this.db.isTransaction) { work(); return; }
    this.db.exec("BEGIN");
    try { work(); this.db.exec("COMMIT"); }
    catch (error) { if (this.db.isTransaction) this.db.exec("ROLLBACK"); throw error; }
  }
}

/** Without a saved-work database (a bot built on its own, in a test): the same order and deduplication, in memory. */
export class MemoryInbox implements TelegramInbox {
  readonly working = new Set<number>();
  private readonly rows = new Map<number, InboxRow & { done: boolean }>();
  add(rows: InboxRow[]): void {
    for (const row of rows) if (!this.rows.has(row.updateId)) this.rows.set(row.updateId, { ...row, done: false });
  }
  pending(): InboxRow[] {
    return [...this.rows.values()].filter((row) => !row.done).sort((a, b) => a.updateId - b.updateId)
      .map(({ updateId, update, caughtUp }) => ({ updateId, update, caughtUp }));
  }
  done(updateId: number): void {
    const row = this.rows.get(updateId);
    if (row) Object.assign(row, { done: true, update: {} });
  }
  markCaughtUp(): void { for (const row of this.rows.values()) if (!row.done) row.caughtUp = true; }
  newest(): number { return Math.max(0, ...this.rows.keys()); }
}

interface SqliteStore { sqlite: DatabaseSync; isOpen?: boolean }

/** The inbox for one bot in Branch's saved-work database, or undefined when there is none. */
export function telegramInbox(store: unknown, botId: string): TelegramInbox | undefined {
  const saved = store as Partial<SqliteStore> | null;
  const db = saved?.sqlite;
  if (!db || typeof db.prepare !== "function" || typeof db.exec !== "function") return undefined;
  return new SqliteInbox(db, botId, () => saved?.isOpen !== false);
}
