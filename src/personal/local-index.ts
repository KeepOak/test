import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { FeatureModeSchema } from "../feature-switches.js";
import { lockdownActive } from "../lockdown.js";
import type { ToolRegistry } from "../registry.js";
import type { Store } from "../store.js";
import { byCard, recordedWrite } from "../settings-kit/recorded-write.js";
import { clip, outsideTextNote, personalMode, type PersonalPart } from "./settings.js";
import { localIndexKey, localIndexShipsAs } from "./local-index-switch.js";
export { localIndexKey, localIndexShipsAs, localIndexTools } from "./local-index-switch.js";

/**
 * RES-718: a local index of the owner's mail and calendars, built and kept on this computer so a search answers from
 * here instead of asking each server every time (Settings › Advanced › "A local index of mail and calendars").
 *
 * It ships on ("when needed"): a capped copy of the owner's own mail on the owner's own disk is none of (a)–(f). It
 * runs only for sources that are already connected and switched on; every half hour it brings each up to date: the inbox the email channel
 * reads (IMAP), Gmail and Outlook, and Google and Outlook calendars. Only through their own connectors, so each part's
 * own switch, its sign-in and Lockdown still decide; a source that is switched off or signed out has its rows dropped at
 * the next run. At most 200 new items a source a run, the days chosen (30, 90 or 365; events also 60 days ahead) and
 * 20,000 rows in all; per item the sender, the subject, the date and at most 2,000 characters of text.
 *
 * Chat apps' messages are not copied here: they are already in Branch's own history, which has its own search.
 * The rows are a cache that can be built again from the sources, so no backup carries them (src/backup.ts lists the
 * tables a backup takes); "Delete the index" removes them all.
 */
export interface IndexItem { id: string; at: string | null; who: string; title: string; body: string; address: string }
export const indexSources = ["inbox", "gmail", "outlook", "google-calendar", "outlook-calendar"] as const;
export type IndexSourceId = (typeof indexSources)[number];
export interface IndexSource {
  id: IndexSourceId;
  /** The personal part whose switch decides whether this source is read (src/personal/settings.ts). */
  part: PersonalPart;
  /** Set up to be read: signed in, or the inbox's server named. */
  ready(): Promise<boolean>;
  fetch(days: number, known: ReadonlySet<string>): Promise<IndexItem[]>;
}

export const localIndexStateKey = "local-index-state";
export const LocalIndexSettingsSchema = z.object({
  mode: FeatureModeSchema.default(localIndexShipsAs),
  days: z.union([z.literal(30), z.literal(90), z.literal(365)]).default(90),
}).strict();
const StateSchema = z.object({ lastRunAt: z.number().nullable().default(null), problems: z.record(z.string(), z.string()).default({}) }).strip();
export const everyMs = 30 * 60_000;
export const perSourceRun = 200;
export const rowCap = 20_000;

export const IndexSearchSchema = z.object({
  text: z.string().trim().min(1).max(200),
  source: z.enum(indexSources).optional(),
  max: z.number().int().min(1).max(50).default(15),
}).strict();

type Reader = Pick<Store, "get">;
export function localIndexSettings(store: Reader, owner: string): z.infer<typeof LocalIndexSettingsSchema> {
  const saved = LocalIndexSettingsSchema.safeParse(store.get("settings", owner, localIndexKey)?.data ?? {});
  return saved.success ? saved.data : { mode: "off", days: 90 };
}
export const localIndexOn = (store: Reader, owner: string): boolean => localIndexSettings(store, owner).mode !== "off";

export class LocalIndex {
  private readonly db: DatabaseSync;
  private readonly fts: boolean;
  private running: Promise<unknown> | null = null;

  constructor(private readonly deps: { store: Store; owner: string; sources: IndexSource[] }) {
    this.db = deps.store.sqlite;
    this.db.exec(`CREATE TABLE IF NOT EXISTS local_index(id INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL, source TEXT NOT NULL,
      item_id TEXT NOT NULL, at TEXT, seen_at TEXT NOT NULL, who TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
      address TEXT NOT NULL, UNIQUE(owner,source,item_id))`);
    this.fts = this.makeSearch();
  }
  private makeSearch(): boolean {
    const available = this.db.prepare("PRAGMA compile_options").all().some((row) => String(row.compile_options).toUpperCase() === "ENABLE_FTS5");
    if (!available) return false;
    try { this.db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS local_index_search USING fts5(title, who, body, tokenize='unicode61 remove_diacritics 2')"); return true; } catch { return false; }
  }

  settings() { return localIndexSettings(this.deps.store, this.deps.owner); }
  save(input: unknown) {
    const next = LocalIndexSettingsSchema.parse({ ...this.settings(), ...(input as object) });
    const { store, owner } = this.deps;
    recordedWrite(store, owner, byCard("local-index"), [localIndexKey], () => store.save("settings", owner, localIndexKey, next));
    return next;
  }
  private state() { return StateSchema.parse(this.deps.store.get("settings", this.deps.owner, localIndexStateKey)?.data ?? {}); }

  /** Brings every source up to date, at most every half hour unless asked now; one run at a time. */
  run(now = Date.now(), force = false): Promise<unknown> {
    if (!localIndexOn(this.deps.store, this.deps.owner)) return Promise.resolve({ ran: false });
    // Lockdown reads every part as off; the index waits it out rather than taking that as "signed out" and dropping rows.
    if (lockdownActive(this.deps.store, this.deps.owner)) return Promise.resolve({ ran: false });
    const last = this.state().lastRunAt;
    if (!force && last !== null && now - last < everyMs) return Promise.resolve({ ran: false });
    this.running ??= this.runAll(now).finally(() => { this.running = null; });
    return this.running;
  }

  private async runAll(now: number): Promise<{ ran: true }> {
    const { store, owner, sources } = this.deps, { days } = this.settings(), problems: Record<string, string> = {};
    for (const source of sources) {
      if (personalMode(store, owner, source.part) === "off" || !(await source.ready().catch(() => false))) { this.drop(source.id); continue; }
      try { this.keep(source.id, await source.fetch(days, this.known(source.id)), now); } catch (error) { problems[source.id] = clip((error as Error).message, 300); }
    }
    this.prune(now, days);
    store.save("settings", owner, localIndexStateKey, { lastRunAt: now, problems });
    return { ran: true };
  }

  private known(source: IndexSourceId): Set<string> {
    return new Set(this.db.prepare("SELECT item_id FROM local_index WHERE owner=? AND source=?").all(this.deps.owner, source).map((row) => String(row.item_id)));
  }
  private keep(source: IndexSourceId, items: IndexItem[], now: number): void {
    const insert = this.db.prepare(`INSERT OR IGNORE INTO local_index(owner,source,item_id,at,seen_at,who,title,body,address) VALUES(?,?,?,?,?,?,?,?,?)`);
    const search = this.fts ? this.db.prepare("INSERT INTO local_index_search(rowid,title,who,body) VALUES(?,?,?,?)") : null;
    const seen = new Date(now).toISOString();
    for (const item of items.slice(0, perSourceRun)) {
      const made = insert.run(this.deps.owner, source, item.id, item.at, seen, clip(item.who, 300), clip(item.title, 300), clip(item.body, 2000), clip(item.address, 500));
      if (made.changes && search) search.run(Number(made.lastInsertRowid), clip(item.title, 300), clip(item.who, 300), clip(item.body, 2000));
    }
  }
  private remove(where: string, ...values: (string | number)[]): number {
    const ids = this.db.prepare(`SELECT id FROM local_index WHERE owner=? AND ${where}`).all(this.deps.owner, ...values).map((row) => Number(row.id));
    if (!ids.length) return 0;
    for (const id of ids) {
      if (this.fts) this.db.prepare("DELETE FROM local_index_search WHERE rowid=?").run(id);
      this.db.prepare("DELETE FROM local_index WHERE id=?").run(id);
    }
    return ids.length;
  }
  private drop(source: IndexSourceId): void { this.remove("source=?", source); }
  /** Older than the days chosen goes; events still to come stay. Above the row cap, the oldest go first. */
  private prune(now: number, days: number): void {
    this.remove("COALESCE(at, seen_at) < ?", new Date(now - days * 86_400_000).toISOString());
    const over = Number(this.db.prepare("SELECT COUNT(*) AS n FROM local_index WHERE owner=?").get(this.deps.owner)?.n ?? 0) - rowCap;
    if (over > 0) this.remove("id IN (SELECT id FROM local_index WHERE owner=? ORDER BY COALESCE(at, seen_at) LIMIT ?)", this.deps.owner, over);
  }

  /** "Delete the index": every row, at once. What the sources hold is not touched. */
  clear(): number { return this.remove("1=1"); }

  search(input: unknown) {
    if (!localIndexOn(this.deps.store, this.deps.owner)) throw new Error("The local index of mail and calendars is switched off. The owner can switch it on in Settings › Advanced.");
    const { text, source, max } = IndexSearchSchema.parse(input);
    const words = text.split(/\s+/).filter(Boolean).slice(0, 8);
    const bySource = source ? " AND l.source=?" : "", extra = source ? [source] : [];
    const rows = this.fts
      ? this.db.prepare(`SELECT l.*, snippet(local_index_search, 2, '', '', '…', 16) AS snip FROM local_index_search JOIN local_index l ON l.id = local_index_search.rowid
          WHERE local_index_search MATCH ? AND l.owner=?${bySource} ORDER BY rank LIMIT ?`).all(words.map((w) => `"${w.replace(/"/g, '""')}"`).join(" "), this.deps.owner, ...extra, max)
      : this.db.prepare(`SELECT l.*, substr(l.body,1,160) AS snip FROM local_index l WHERE l.owner=?${bySource} AND ${words.map(() => "(l.title||' '||l.who||' '||l.body) LIKE ?").join(" AND ")}
          ORDER BY COALESCE(l.at, l.seen_at) DESC LIMIT ?`).all(this.deps.owner, ...extra, ...words.map((w) => `%${w}%`), max);
    return { note: outsideTextNote, found: rows.map((row) => ({ source: String(row.source), id: String(row.item_id), at: row.at === null ? null : String(row.at),
      who: String(row.who), title: String(row.title), snippet: String(row.snip ?? ""), address: String(row.address) })) };
  }

  view() {
    const counts = Object.fromEntries(indexSources.map((id) => [id, 0])) as Record<IndexSourceId, number>;
    for (const row of this.db.prepare("SELECT source, COUNT(*) AS n FROM local_index WHERE owner=? GROUP BY source").all(this.deps.owner))
      counts[String(row.source) as IndexSourceId] = Number(row.n);
    const size = Number(this.db.prepare("SELECT COALESCE(SUM(length(title)+length(who)+length(body)+length(address)),0) AS b FROM local_index WHERE owner=?").get(this.deps.owner)?.b ?? 0);
    const { lastRunAt, problems } = this.state();
    return { settings: this.settings(), counts, total: Object.values(counts).reduce((a, b) => a + b, 0), bytes: size,
      lastRunAt: lastRunAt === null ? null : new Date(lastRunAt).toISOString(), problems, running: this.running !== null };
  }
}

export function registerLocalIndex(registry: Pick<ToolRegistry, "register">, index: LocalIndex): void {
  registry.register({
    name: "index.search", permission: "index.read", group: "personal",
    description: "Search the owner's mail and calendars in the local index kept on this computer (inbox, Gmail, Outlook, Google and Outlook calendars), fastest first stop for 'find the email about…'.",
    // What it touches is this computer's copy, of one source or of all of them.
    target: (args) => `the local index${args.source ? ` (${args.source})` : ""}`,
    parameters: IndexSearchSchema, execute: async (input) => index.search(input),
  });
}

export class LocalIndexApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export const handlesLocalIndexPath = (path: string): boolean => ["/api/local-index", "/api/local-index/update", "/api/local-index/delete"].includes(path);

/**
 *   GET  /api/local-index          the switch, the days, what is kept per source, its size and the last run
 *   POST /api/local-index          { mode?, days? } (the owner only); switching on starts a first run
 *   POST /api/local-index/update   {} brings it up to date now (the owner only)
 *   POST /api/local-index/delete   {} deletes every row of the index (the owner only)
 */
export async function localIndexApi(deps: { index: LocalIndex; requireOwner: (what: string) => void }, method: string, path: string, body: () => Promise<unknown>): Promise<unknown> {
  const { index } = deps;
  if (method === "GET" && path === "/api/local-index") return index.view();
  if (method !== "POST") throw new LocalIndexApiError(405, "Read the local index with GET, or change it with POST.");
  deps.requireOwner("The local index of your mail and calendars");
  if (path === "/api/local-index/update") { z.object({}).strict().parse(await body()); await index.run(Date.now(), true); return index.view(); }
  if (path === "/api/local-index/delete") { z.object({}).strict().parse(await body()); index.clear(); return index.view(); }
  const saved = index.save(await body());
  if (saved.mode !== "off") void index.run(Date.now(), true).catch(() => undefined);
  return index.view();
}
