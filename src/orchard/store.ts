import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Store } from "../store.js";
import {
  maxBoards, maxCards, maxComments, maxHistory, oneLine,
  type Board, type Card, type CardNote, type Comment, type Lane,
} from "./model.js";

/**
 * Orchard's own tables, kept per household (the engine's owner id), beside everything else of the owner's. Nothing
 * here decides who may do what: src/orchard/index.ts does, and the caller layer (src/caller-policy.ts) before it.
 */
type Row = Record<string, unknown>;

/** Orchard's tables, in the order a backup writes and restores them (src/backup.ts). */
export const orchardTables = ["orchard_boards", "orchard_cards", "orchard_links", "orchard_comments"] as const;
/** Makes Orchard's tables when they are not there yet: at start, and before a restore puts rows in them. */
export function ensureOrchardTables(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS orchard_boards(id TEXT PRIMARY KEY, owner TEXT NOT NULL, project TEXT NOT NULL,
    name TEXT NOT NULL, at_once INTEGER NOT NULL DEFAULT 2, stop_after INTEGER NOT NULL DEFAULT 3,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  db.exec(`CREATE TABLE IF NOT EXISTS orchard_cards(id TEXT PRIMARY KEY, owner TEXT NOT NULL, board TEXT NOT NULL,
    title TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', lane TEXT NOT NULL, assignee TEXT NOT NULL DEFAULT '',
    planted INTEGER NOT NULL DEFAULT 0, posted_by TEXT NOT NULL, failures INTEGER NOT NULL DEFAULT 0,
    stuck INTEGER NOT NULL DEFAULT 0, run_id TEXT, session_id TEXT, history TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  db.exec(`CREATE TABLE IF NOT EXISTS orchard_links(owner TEXT NOT NULL, parent TEXT NOT NULL, child TEXT NOT NULL,
    PRIMARY KEY(owner, parent, child))`);
  db.exec(`CREATE TABLE IF NOT EXISTS orchard_comments(id TEXT PRIMARY KEY, owner TEXT NOT NULL, card TEXT NOT NULL,
    by TEXT NOT NULL, text TEXT NOT NULL, at TEXT NOT NULL)`);
  db.exec("CREATE INDEX IF NOT EXISTS orchard_cards_board ON orchard_cards(owner, board)");
  db.exec("CREATE INDEX IF NOT EXISTS orchard_cards_run ON orchard_cards(run_id)");
}
const now = (): string => new Date().toISOString();

export class OrchardStore {
  constructor(private readonly store: Store, private readonly owner: string) {
    ensureOrchardTables(store.sqlite);
  }
  private get db() { return this.store.sqlite; }

  /* ---------- boards ---------- */

  boards(): Board[] {
    return this.db.prepare("SELECT * FROM orchard_boards WHERE owner=? ORDER BY created_at").all(this.owner).map(toBoard);
  }
  board(id: string): Board {
    const row = this.db.prepare("SELECT * FROM orchard_boards WHERE owner=? AND id=?").get(this.owner, id);
    if (!row) throw new Error("That board is not in Orchard.");
    return toBoard(row);
  }
  addBoard(project: string, name: string): Board {
    if (this.boards().length >= maxBoards) throw new Error(`Orchard holds at most ${maxBoards} boards; remove one first.`);
    const id = randomUUID(), at = now();
    this.db.prepare("INSERT INTO orchard_boards(id,owner,project,name,at_once,stop_after,created_at,updated_at) VALUES(?,?,?,?,2,3,?,?)")
      .run(id, this.owner, project, oneLine(name, 80), at, at);
    return this.board(id);
  }
  editBoard(id: string, change: { name?: string | undefined; atOnce?: number | undefined; stopAfter?: number | undefined }): Board {
    const board = this.board(id);
    this.db.prepare("UPDATE orchard_boards SET name=?, at_once=?, stop_after=?, updated_at=? WHERE owner=? AND id=?")
      .run(change.name !== undefined ? oneLine(change.name, 80) : board.name, change.atOnce ?? board.atOnce,
        change.stopAfter ?? board.stopAfter, now(), this.owner, id);
    return this.board(id);
  }
  removeBoard(id: string): void {
    this.board(id);
    if (this.cards(id).length) throw new Error("This board still has cards. Remove or move them first.");
    this.db.prepare("DELETE FROM orchard_boards WHERE owner=? AND id=?").run(this.owner, id);
  }

  /* ---------- cards ---------- */

  cards(boardId?: string): Card[] {
    const rows = boardId
      ? this.db.prepare("SELECT * FROM orchard_cards WHERE owner=? AND board=? ORDER BY updated_at DESC").all(this.owner, boardId)
      : this.db.prepare("SELECT * FROM orchard_cards WHERE owner=? ORDER BY updated_at DESC").all(this.owner);
    return rows.map((row) => this.toCard(row));
  }
  card(id: string): Card {
    const row = this.db.prepare("SELECT * FROM orchard_cards WHERE owner=? AND id=?").get(this.owner, id);
    if (!row) throw new Error("That card is not in Orchard.");
    return this.toCard(row);
  }
  /** The card, or null when it is not (or no longer) in Orchard. */
  find(id: string): Card | null {
    const row = this.db.prepare("SELECT * FROM orchard_cards WHERE owner=? AND id=?").get(this.owner, id);
    return row ? this.toCard(row) : null;
  }
  cardOfRun(runId: string): Card | null {
    const row = this.db.prepare("SELECT * FROM orchard_cards WHERE owner=? AND run_id=?").get(this.owner, runId);
    return row ? this.toCard(row) : null;
  }
  addCard(value: { board: string; title: string; notes: string; assignee: string; planted: boolean; by: string; lane?: Lane }): Card {
    const count = Number(this.db.prepare("SELECT COUNT(*) AS n FROM orchard_cards WHERE owner=? AND board=?").get(this.owner, value.board)?.n ?? 0);
    if (count >= maxCards) throw new Error(`A board holds at most ${maxCards} cards; remove some that are picked first.`);
    const id = randomUUID(), at = now(), lane = value.lane ?? "seed";
    const history: CardNote[] = [{ at, by: value.by, what: `Posted to ${lane}` }];
    this.db.prepare(`INSERT INTO orchard_cards(id,owner,board,title,notes,lane,assignee,planted,posted_by,failures,stuck,run_id,session_id,history,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,0,0,NULL,NULL,?,?,?)`).run(id, this.owner, value.board, oneLine(value.title, 200), value.notes, lane,
      value.assignee, value.planted ? 1 : 0, value.by, JSON.stringify(history), at, at);
    return this.card(id);
  }
  /** Writes a change and one line of history saying who made it. */
  write(card: Card, change: Partial<Pick<Card, "title" | "notes" | "lane" | "assignee" | "planted" | "failures" | "stuck" | "runId" | "sessionId">>,
    by: string, what: string): Card {
    const next = { ...card, ...change };
    const history = [...card.history, { at: now(), by, what: oneLine(what, 600) }].slice(-maxHistory);
    this.db.prepare(`UPDATE orchard_cards SET title=?, notes=?, lane=?, assignee=?, planted=?, failures=?, stuck=?, run_id=?, session_id=?,
      history=?, updated_at=? WHERE owner=? AND id=?`).run(next.title, next.notes, next.lane, next.assignee, next.planted ? 1 : 0,
      next.failures, next.stuck ? 1 : 0, next.runId, next.sessionId, JSON.stringify(history), now(), this.owner, card.id);
    return this.card(card.id);
  }
  removeCard(id: string): boolean {
    this.db.prepare("DELETE FROM orchard_links WHERE owner=? AND (parent=? OR child=?)").run(this.owner, id, id);
    this.db.prepare("DELETE FROM orchard_comments WHERE owner=? AND card=?").run(this.owner, id);
    return Number(this.db.prepare("DELETE FROM orchard_cards WHERE owner=? AND id=?").run(this.owner, id).changes ?? 0) > 0;
  }

  /* ---------- links ---------- */

  parents(child: string): string[] {
    return this.db.prepare("SELECT parent FROM orchard_links WHERE owner=? AND child=?").all(this.owner, child).map((row) => String(row.parent));
  }
  children(parent: string): string[] {
    return this.db.prepare("SELECT child FROM orchard_links WHERE owner=? AND parent=?").all(this.owner, parent).map((row) => String(row.child));
  }
  link(parent: string, child: string): void {
    this.db.prepare("INSERT OR IGNORE INTO orchard_links(owner,parent,child) VALUES(?,?,?)").run(this.owner, parent, child);
  }
  unlink(parent: string, child: string): void {
    this.db.prepare("DELETE FROM orchard_links WHERE owner=? AND parent=? AND child=?").run(this.owner, parent, child);
  }

  /* ---------- comments ---------- */

  comments(card: string): Comment[] {
    return this.db.prepare("SELECT id, at, by, text FROM orchard_comments WHERE owner=? AND card=? ORDER BY at, rowid").all(this.owner, card)
      .map((row) => ({ id: String(row.id), at: String(row.at), by: String(row.by), text: String(row.text) }));
  }
  comment(card: string, by: string, text: string): Comment {
    const count = Number(this.db.prepare("SELECT COUNT(*) AS n FROM orchard_comments WHERE owner=? AND card=?").get(this.owner, card)?.n ?? 0);
    if (count >= maxComments) throw new Error(`A card holds at most ${maxComments} comments.`);
    const id = randomUUID(), at = now();
    this.db.prepare("INSERT INTO orchard_comments(id,owner,card,by,text,at) VALUES(?,?,?,?,?,?)").run(id, this.owner, card, by, text, at);
    return { id, at, by, text };
  }

  /** One comment on a card, or an error when that card holds no such comment. */
  commentOf(card: string, id: string): Comment {
    const row = this.db.prepare("SELECT id, at, by, text FROM orchard_comments WHERE owner=? AND card=? AND id=?").get(this.owner, card, id);
    if (!row) throw new Error("That comment is not on this card.");
    return { id: String(row.id), at: String(row.at), by: String(row.by), text: String(row.text) };
  }
  editComment(card: string, id: string, text: string): Comment {
    this.db.prepare("UPDATE orchard_comments SET text=? WHERE owner=? AND card=? AND id=?").run(text, this.owner, card, id);
    return this.commentOf(card, id);
  }
  removeComment(card: string, id: string): boolean {
    return Number(this.db.prepare("DELETE FROM orchard_comments WHERE owner=? AND card=? AND id=?").run(this.owner, card, id).changes ?? 0) > 0;
  }

  /**
   * The shared board's cards (the old Automations › Board, table `board_cards`) move into Orchard once: one board per
   * project they were on, named after it, with their lanes mapped. None is planted: on the old board only the owner
   * started work, so nothing moved here starts by itself. The old table is left where it is.
   */
  migrate(projectName: (id: string) => string): number {
    const done = this.store.get("settings", this.owner, "orchard-migrated");
    if (done) return 0;
    this.db.exec("SAVEPOINT orchard_migration");
    try {
      const moved = this.migrateCards(projectName);
      this.store.save("settings", this.owner, "orchard-migrated", { at: now(), moved });
      this.db.exec("RELEASE orchard_migration");
      return moved;
    } catch (error) {
      this.db.exec("ROLLBACK TO orchard_migration; RELEASE orchard_migration");
      throw error;
    }
  }

  private migrateCards(projectName: (id: string) => string): number {
    const old = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='board_cards'").get();
    let moved = 0;
    if (old) {
      const rows = this.db.prepare("SELECT * FROM board_cards WHERE owner=? ORDER BY created_at").all(this.owner);
      const boards = new Map<string, string>();
      const map: Record<string, Lane> = { todo: "seed", doing: "seed", review: "ripe", done: "picked", blocked: "blocked" };
      for (const row of rows) {
        const project = String(row.project);
        if (!boards.has(project)) boards.set(project, this.addBoard(project, projectName(project) || project).id);
        const at = String(row.created_at);
        const history = [...(JSON.parse(String(row.history ?? "[]")) as { at: string; by: string; what: string }[]),
          { at: now(), by: "owner", what: "Moved into Orchard" }].slice(-maxHistory);
        // A card that was being worked on when the engine stopped goes back to seed: its task is not followed here.
        this.db.prepare(`INSERT OR IGNORE INTO orchard_cards(id,owner,board,title,notes,lane,assignee,planted,posted_by,failures,stuck,run_id,session_id,history,created_at,updated_at)
          VALUES(?,?,?,?,?,?,'',0,?,?,?,NULL,NULL,?,?,?)`).run(String(row.id), this.owner, boards.get(project)!, String(row.title),
          String(row.notes ?? ""), map[String(row.lane)] ?? "seed", "owner", Number(row.failures ?? 0), Number(row.stuck ?? 0),
          JSON.stringify(history), at, String(row.updated_at ?? at));
        moved += 1;
      }
    }
    return moved;
  }

  private toCard(row: Row): Card {
    const id = String(row.id);
    return {
      id, board: String(row.board), title: String(row.title), notes: String(row.notes), lane: String(row.lane) as Lane,
      assignee: String(row.assignee ?? ""), planted: Number(row.planted) === 1, postedBy: String(row.posted_by),
      failures: Number(row.failures), stuck: Number(row.stuck) === 1,
      runId: row.run_id === null || row.run_id === undefined ? null : String(row.run_id),
      sessionId: row.session_id === null || row.session_id === undefined ? null : String(row.session_id),
      after: this.parents(id),
      comments: Number(this.db.prepare("SELECT COUNT(*) AS n FROM orchard_comments WHERE owner=? AND card=?").get(this.owner, id)?.n ?? 0),
      history: JSON.parse(String(row.history)) as CardNote[],
      createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    };
  }
}

function toBoard(row: Row): Board {
  return {
    id: String(row.id), project: String(row.project), name: String(row.name), atOnce: Number(row.at_once),
    stopAfter: Number(row.stop_after), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}
