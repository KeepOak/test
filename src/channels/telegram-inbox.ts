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
  /** The bot was disconnected for good (taken out, or its token replaced): everything it saved is dropped at once. */
  forget(): void;
}

/**
 * How long a handled update's number is kept for de-duplication (its words are dropped when it is handled): Telegram
 * keeps an unconfirmed update for 24 hours (https://core.telegram.org/bots/api#getting-updates), so a day is enough.
 */
export const keepDoneMs = 24 * 60 * 60 * 1000;

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
  constructor(private readonly db: DatabaseSync, private readonly bot: string, private readonly channel: string,
    private readonly isOpen: () => boolean) {
    db.exec(`CREATE TABLE IF NOT EXISTS telegram_inbox(bot TEXT NOT NULL, update_id INTEGER NOT NULL, channel TEXT NOT NULL,
      body TEXT NOT NULL, caught_up INTEGER NOT NULL DEFAULT 0, received_at TEXT NOT NULL, done_at TEXT, PRIMARY KEY(bot, update_id))`);
    // A table made before connections were named (an early build of this change) gains the column.
    if (!db.prepare("PRAGMA table_info(telegram_inbox)").all().some((column) => column.name === "channel"))
      db.exec("ALTER TABLE telegram_inbox ADD COLUMN channel TEXT NOT NULL DEFAULT ''");
    this.working = workingFor(db, bot);
    // A new token for this connection is a different bot: what the old bot saved is dropped at once, handled or not.
    db.prepare("DELETE FROM telegram_inbox WHERE channel=? AND bot<>?").run(channel, bot);
    this.prune();
  }
  add(rows: InboxRow[]): void {
    if (!rows.length) return;
    // Closed: throws, so the poll does not move Telegram's position past updates it could not keep.
    if (!this.isOpen()) throw new Error("Branch's saved-work database is closed");
    const now = new Date().toISOString();
    const insert = this.db.prepare("INSERT OR IGNORE INTO telegram_inbox(bot, update_id, channel, body, caught_up, received_at) VALUES(?,?,?,?,?,?)");
    this.atomically(() => {
      this.prune();
      for (const row of rows) insert.run(this.bot, row.updateId, this.channel, JSON.stringify(row.update), row.caughtUp ? 1 : 0, now);
    });
  }
  pending(): InboxRow[] {
    if (!this.isOpen()) return [];
    return this.db.prepare("SELECT update_id, body, caught_up FROM telegram_inbox WHERE bot=? AND done_at IS NULL ORDER BY update_id")
      .all(this.bot).map((row) => ({ updateId: Number(row.update_id), update: JSON.parse(String(row.body)), caughtUp: Number(row.caught_up) === 1 }));
  }
  done(updateId: number): void {
    // A task can settle after Branch closed its database (or a poll outlives it): the row then stays waiting and is
    // handled after the restart.
    if (!this.isOpen()) return;
    this.db.prepare("UPDATE telegram_inbox SET done_at=?, body='{}' WHERE bot=? AND update_id=?").run(new Date().toISOString(), this.bot, updateId);
  }
  markCaughtUp(): void {
    if (!this.isOpen()) return;
    this.db.prepare("UPDATE telegram_inbox SET caught_up=1 WHERE bot=? AND done_at IS NULL").run(this.bot);
  }
  newest(): number {
    if (!this.isOpen()) return 0;
    return Number(this.db.prepare("SELECT COALESCE(MAX(update_id), 0) AS id FROM telegram_inbox WHERE bot=?").get(this.bot)?.id ?? 0);
  }
  forget(): void {
    if (!this.isOpen()) return;
    this.db.prepare("DELETE FROM telegram_inbox WHERE bot=?").run(this.bot);
  }
  /** Handled rows past `keepDoneMs`, for every bot, so one no longer connected is tidied too. */
  private prune(): void {
    this.db.prepare("DELETE FROM telegram_inbox WHERE done_at IS NOT NULL AND done_at < ?").run(new Date(Date.now() - keepDoneMs).toISOString());
  }
  private atomically(work: () => void): void {
    if (this.db.isTransaction) { work(); return; }
    this.db.exec("BEGIN");
    try { work(); this.db.exec("COMMIT"); }
    catch (error) { if (this.db.isTransaction) this.db.exec("ROLLBACK"); throw error; }
  }
}

/**
 * Without a saved-work database (a bot built on its own, in a test): the same order and de-duplication, in memory. A
 * handled update is dropped at once; only its number is remembered, for the newest `dedupeWindow` handled ones.
 */
export class MemoryInbox implements TelegramInbox {
  readonly working = new Set<number>();
  private readonly rows = new Map<number, InboxRow>();
  private readonly handled = new Set<number>();
  private highest = 0;
  constructor(private readonly dedupeWindow = 1000) {}
  /** Rows and remembered numbers kept, for the tests that check memory stays bounded. */
  get size(): number { return this.rows.size + this.handled.size; }
  add(rows: InboxRow[]): void {
    for (const row of rows) {
      if (this.rows.has(row.updateId) || this.handled.has(row.updateId)) continue;
      this.rows.set(row.updateId, { ...row });
      this.highest = Math.max(this.highest, row.updateId);
    }
  }
  pending(): InboxRow[] {
    return [...this.rows.values()].sort((a, b) => a.updateId - b.updateId).map((row) => ({ ...row }));
  }
  done(updateId: number): void {
    if (!this.rows.delete(updateId)) return;
    this.handled.add(updateId);
    // A Set iterates in insertion order: the oldest remembered number goes first.
    for (const oldest of this.handled) { if (this.handled.size <= this.dedupeWindow) break; this.handled.delete(oldest); }
  }
  markCaughtUp(): void { for (const row of this.rows.values()) row.caughtUp = true; }
  newest(): number { return this.highest; }
  forget(): void { this.rows.clear(); this.handled.clear(); this.highest = 0; }
}

interface SqliteStore { sqlite: DatabaseSync; isOpen?: boolean }

/**
 * The inbox for one bot in Branch's saved-work database, or undefined when there is none. `channel` is the connection
 * it belongs to: opening it with another bot's id (a replaced token) drops what the previous bot saved there.
 */
export function telegramInbox(store: unknown, botId: string, channel: string): TelegramInbox | undefined {
  const saved = store as Partial<SqliteStore> | null;
  const db = saved?.sqlite;
  if (!db || typeof db.prepare !== "function" || typeof db.exec !== "function") return undefined;
  return new SqliteInbox(db, botId, channel, () => saved?.isOpen !== false);
}
