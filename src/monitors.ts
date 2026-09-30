import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { errorText, type ToolContext } from "./contracts.js";
import type { Store } from "./store.js";
import type { ToolRegistry } from "./registry.js";
import type { WebAccess } from "./integrations/web.js";
import { applyContentPolicy, detectInjection } from "./content-guard.js";
import type { DeliveryHandler } from "./scheduler.js";
import { automationHealth, type Health, type HealthEntry } from "./heartbeat.js";
import { PriceConditionSchema, priceCondition, priceHistory, observePrice, priceSummary, type PriceCondition, type PricePoint } from "./monitor-price.js";

/**
 * Keeping an eye on a page or a search for the person. Each watch remembers what it saw last time;
 * when the words change the difference is described in plain language and sent wherever they asked
 * — a messaging chat, or the activity list in the app. Nothing is fetched outside the network
 * policy, and the remembered copy is bounded so a watch cannot grow without limit.
 */
const notifySchema = z.union([
  z.literal("activity"),
  z.object({ channel: z.string().min(1).max(64), chatId: z.string().min(1).max(64) }).strict(),
]);
export const MonitorSchema = z.object({
  url: z.string().url().max(2048).optional(),
  query: z.string().trim().min(2).max(300).optional(),
  /** How often to look: minutes, or a short phrase such as "30m", "6h" or "1d". At least 5 minutes. */
  every: z.union([z.number().int().min(5).max(43200), z.string().trim().regex(/^\d+\s*(m|h|d|min|mins|minutes?|hours?|days?)?$/i)]),
  notifyVia: notifySchema.default("activity"),
  label: z.string().trim().max(120).optional(),
  price: PriceConditionSchema.optional(),
}).strict().refine((value) => !!value.url !== !!value.query, "Watch either an address or a search, not both");
export type MonitorInput = z.infer<typeof MonitorSchema>;
export interface MonitorRecord {
  id: string; kind: "page" | "search"; target: string; label: string; everyMinutes: number;
  notifyVia: "activity" | { channel: string; chatId: string };
  lastCheckedAt: string | null; nextAt: string; changes: number;
  /** Healthy, failing or never run, from the last few looks. */
  health: Health; lastError: string | null;
  price?: PriceCondition | null; lastPrice?: PricePoint | null;
}
export interface MonitorCheck {
  id: string; changed: boolean; summary: string; delivered: string | null;
  /** Why the news was kept in the app instead of going to its chat. */
  held?: string;
}
const snapshotChars = 20000;

/**
 * Q141: what a watch asks about Trunks. src/index.ts connects each; on its own no call is a Trunk's work, and a
 * watch a Trunk made never sends to its chat.
 */
export interface WatchTrunks {
  /** The Trunk whose work is going on here, if any: a step or a box it set going (Q114). */
  atWork(): string | undefined;
  /** Whether that Trunk may send to chats now; false once it is gone. */
  maySend(trunkId: string): boolean;
  /** Why no watch a Trunk made sends to its chat now, while Trunks are switched off; null while they are on. */
  offReason(): string | null;
}
export const noWatchTrunks: WatchTrunks = { atWork: () => undefined, maySend: () => false, offReason: () => null };
export const trunkMayNotSend = "The Trunk that made this watch may no longer send to chats, so its news was kept here.";
export const trunksSwitchedOff = "Trunks are switched off, so this watch a Trunk made did not send to its chat; its news was kept here.";

/**
 * Q141: a watch that sends its news to a chat sends it as the owner's own bot, so pointing one at a chat asks what
 * sending now asks (channels.broadcast): the owner, and a caller that may send to chats. The app's own watch route
 * has no tool call behind it, so there only who is at the window is asked.
 */
export function requireMaySendToChats(store: Store, context: ToolContext | undefined): void {
  store.profiles.requireOwner("Sending messages to your chats");
  if (context && !context.permissions.has("channels.send")) throw new Error("Permission denied: channels.send");
}
/**
 * A2: whether a call may see a watch. The owner's own calls (and the app's routes and timer, which have no tool call
 * behind them) see every watch; a Trunk sees only the watches it made, and any other reads as not there.
 */
export function watchVisibleTo(context: ToolContext | undefined, trunks: WatchTrunks, madeBy: unknown): boolean {
  const asking = context ? watchMadeBy(context, trunks) : null;
  return !asking || madeBy === asking;
}
/** Q141: the Trunk a watch is made for: its turn, a specialist it handed work to, or work it set going. */
export function watchMadeBy(context: ToolContext | undefined, trunks: WatchTrunks): string | null {
  return context?.trunk ?? /^trunk:([^:]+)/.exec(context?.agent ?? "")?.[1] ?? trunks.atWork() ?? null;
}

/** "90", "90m", "6 hours", "1d" all become a number of minutes. */
export function everyMinutes(value: number | string): number {
  if (typeof value === "number") return value;
  const match = /^(\d+)\s*([a-z]*)$/i.exec(value.trim());
  if (!match) throw new Error("Say how often as minutes, or like \"30m\", \"6h\" or \"1d\"");
  const amount = Number(match[1]), unit = (match[2] ?? "").toLowerCase();
  const minutes = unit.startsWith("d") ? amount * 1440 : unit.startsWith("h") ? amount * 60 : amount;
  if (minutes < 5) throw new Error("A watch can run at most once every five minutes");
  return Math.min(minutes, 43200);
}

export class Monitors {
  private readonly db: DatabaseSync;
  /** Watches being looked at right now: a beat that overlaps the last one must not look again. */
  private readonly inFlight = new Set<string>();
  constructor(private readonly store: Store, private readonly web: WebAccess, private readonly deliver?: DeliveryHandler,
    private readonly trunks: WatchTrunks = noWatchTrunks) {
    this.db = store.sqlite;
    this.db.exec(`CREATE TABLE IF NOT EXISTS monitors(id TEXT PRIMARY KEY, owner TEXT NOT NULL, kind TEXT NOT NULL,
      target TEXT NOT NULL, label TEXT NOT NULL DEFAULT '', every_minutes INTEGER NOT NULL, notify TEXT NOT NULL,
      hash TEXT, snapshot TEXT, checked_at TEXT, next_at TEXT NOT NULL, changes INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL); CREATE INDEX IF NOT EXISTS monitors_owner ON monitors(owner);`);
    // Added later: the last few looks, for the health badge. Older databases gain the columns here.
    const columns = new Set(this.db.prepare("PRAGMA table_info(monitors)").all().map((row) => String(row.name)));
    if (!columns.has("recent")) this.db.exec("ALTER TABLE monitors ADD COLUMN recent TEXT NOT NULL DEFAULT '[]'");
    if (!columns.has("last_error")) this.db.exec("ALTER TABLE monitors ADD COLUMN last_error TEXT");
    // Q141: the Trunk that made the watch, if one did.
    if (!columns.has("made_by")) this.db.exec("ALTER TABLE monitors ADD COLUMN made_by TEXT");
    if (!columns.has("price_rule")) this.db.exec("ALTER TABLE monitors ADD COLUMN price_rule TEXT");
    if (!columns.has("prices")) this.db.exec("ALTER TABLE monitors ADD COLUMN prices TEXT NOT NULL DEFAULT '[]'");
  }
  /** Writes one look into the short record the health badge reads. */
  private remember(id: string, entry: HealthEntry, error: string | null): void {
    const row = this.db.prepare("SELECT recent FROM monitors WHERE id=?").get(id);
    const recent = [...parseRecent(row?.recent), entry].slice(-10);
    this.db.prepare("UPDATE monitors SET recent=?, last_error=? WHERE id=?").run(JSON.stringify(recent), error, id);
  }
  /** `context` is the tool call behind it, if any: a Trunk lists only the watches it made (A2). */
  list(owner: string, context?: ToolContext): MonitorRecord[] {
    // A Trunk's own are picked before the limit, so the owner's newer watches never push its older ones off (NAS e666bad).
    const asking = context ? watchMadeBy(context, this.trunks) : null;
    const rows = asking
      ? this.db.prepare("SELECT * FROM monitors WHERE owner=? AND made_by=? ORDER BY created_at DESC LIMIT 200").all(owner, asking)
      : this.db.prepare("SELECT * FROM monitors WHERE owner=? ORDER BY created_at DESC LIMIT 200").all(owner);
    return rows.map(toRecord);
  }
  remove(owner: string, id: string, context?: ToolContext): { removed: string } {
    const row = this.db.prepare("SELECT made_by FROM monitors WHERE owner=? AND id=?").get(owner, id);
    if (!row || !watchVisibleTo(context, this.trunks, row.made_by)) throw new Error("There is no watch with that number");
    this.db.prepare("DELETE FROM monitors WHERE owner=? AND id=?").run(owner, id);
    return { removed: id };
  }
  /**
   * Starts a watch and takes the first look right away, so the next change is a real change. `context` is the tool
   * call behind it; the app's own watch route has none.
   */
  async create(owner: string, input: unknown, signal?: AbortSignal, context?: ToolContext, beforeSave?: () => void): Promise<MonitorRecord> {
    const value = MonitorSchema.parse(input);
    if (value.price && !value.url) throw new Error("A price watch needs a page address, not search results");
    if (value.price) this.store.profiles.requireOwner("Creating a price watch");
    if (value.notifyVia !== "activity") requireMaySendToChats(this.store, context);
    const minutes = everyMinutes(value.every), id = randomUUID(), now = new Date();
    const kind = value.url ? "page" : "search", target = value.url ?? value.query!;
    const baseline = value.price ? await this.observe(kind, target, signal) : null;
    signal?.throwIfAborted();
    const prices = value.price ? observePrice(value.price, [], baseline!, new Date().toISOString()).history : [];
    if (value.price) this.store.profiles.requireOwner("Creating a price watch");
    if (value.price && value.notifyVia !== "activity") requireMaySendToChats(this.store, context);
    beforeSave?.();
    this.db.prepare(`INSERT INTO monitors(id, owner, kind, target, label, every_minutes, notify, hash, snapshot,
      checked_at, next_at, changes, created_at, made_by, price_rule, prices) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, owner, kind, target, value.label ?? target.slice(0, 120), minutes, JSON.stringify(value.notifyVia),
      null, null, null, new Date(now.getTime() + minutes * 60000).toISOString(), 0, now.toISOString(),
      watchMadeBy(context, this.trunks), value.price ? JSON.stringify(value.price) : null, JSON.stringify(prices));
    const text = baseline ?? await this.observe(kind, target, signal).catch((error) => `Could not be read: ${errorText(error)}`);
    this.db.prepare("UPDATE monitors SET hash=?, snapshot=?, checked_at=? WHERE id=?")
      .run(digest(text), text.slice(0, snapshotChars), now.toISOString(), id);
    return this.one(owner, id);
  }
  private one(owner: string, id: string): MonitorRecord {
    const row = this.db.prepare("SELECT * FROM monitors WHERE owner=? AND id=?").get(owner, id);
    if (!row) throw new Error("There is no watch with that number");
    return toRecord(row);
  }
  history(owner: string, id: string, context?: ToolContext): { currency: string; prices: PricePoint[] } {
    const row = this.db.prepare("SELECT * FROM monitors WHERE owner=? AND id=?").get(owner, id);
    if (!row || !watchVisibleTo(context, this.trunks, row.made_by)) throw new Error("There is no watch with that number");
    const rule = priceCondition(row.price_rule);
    if (!rule) throw new Error("This is not a price watch");
    return { currency: rule.currency, prices: priceHistory(row.prices) };
  }
  /** What the watch is looking at right now, as plain text. */
  private async observe(kind: string, target: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    // A search only ever yields titles and addresses, so only a page's own words need the owner's
    // injection policy applied: the same one `web.read` uses, before any of it is quoted at them.
    if (kind === "page") {
      const text = (await this.web.fetchPage(target, snapshotChars)).text;
      return applyContentPolicy(text, detectInjection(text), this.web.injectionPolicy).text;
    }
    return (await this.web.search(target, 8)).map((result) => `${result.title} — ${result.url}`).join("\n");
  }

  /** Looks again, describes anything that changed, and sends it on. */
  async check(owner: string, id: string, now = new Date(), signal?: AbortSignal, context?: ToolContext): Promise<MonitorCheck> {
    const row = this.db.prepare("SELECT * FROM monitors WHERE owner=? AND id=?").get(owner, id);
    if (!row || !watchVisibleTo(context, this.trunks, row.made_by)) throw new Error("There is no watch with that number"); // A2
    const record = toRecord(row);
    if (this.inFlight.has(id)) throw new Error("That watch is already being checked");
    const next = new Date(now.getTime() + record.everyMinutes * 60000).toISOString();
    this.inFlight.add(id);
    try {
      const started = new Date().toISOString();
      const text = await this.observe(record.kind, record.target, signal);
      signal?.throwIfAborted();
      if (!this.db.prepare("SELECT 1 FROM monitors WHERE owner=? AND id=?").get(owner, id)) throw new Error("That watch was stopped while being checked");
      const before = String(row.snapshot ?? "");
      // A different fingerprint with the same lines (spacing, order) is not news: it is kept, not sent.
      const price = record.price ? observePrice(record.price, priceHistory(row.prices), text, now.toISOString()) : null;
      const changed = price ? price.changed : digest(text) !== String(row.hash ?? "") && linesDiffer(before, text);
      const summary = changed ? price && record.price ? priceSummary(record.price, price.amount, price.previous, record.target, now.toISOString())
        : describeChange(record, before, text) : `No ${price ? "qualifying " : ""}change at ${record.label}.`;
      // Q141: a watch a Trunk made sends to its chat only while that Trunk may still send to chats.
      const madeBy = row.made_by ? String(row.made_by) : null;
      const held = changed && record.notifyVia !== "activity" && madeBy && !this.trunks.maySend(madeBy)
        ? (this.trunks.offReason() ?? trunkMayNotSend) : null;
      // The news goes out before the new copy is kept: a delivery that fails leaves the old copy in
      // place, so the same change is noticed again next time instead of being lost silently.
      const delivered = changed ? await this.announce(owner, record, summary, held, price ? `${row.checked_at}:${price.amount}` : undefined) : null;
      this.db.prepare("UPDATE monitors SET hash=?, snapshot=?, checked_at=?, next_at=?, changes=?, prices=? WHERE id=?")
        .run(digest(text), text.slice(0, snapshotChars), now.toISOString(), next, record.changes + (changed ? 1 : 0),
          price ? JSON.stringify(price.history) : String(row.prices ?? "[]"), id);
      this.remember(id, { status: "completed", startedAt: started, finishedAt: new Date().toISOString() }, null);
      return { id, changed, summary, delivered, ...(held ? { held } : {}) };
    } finally { this.inFlight.delete(id); }
  }
  /** Every watch that is due; each one's own failure is recorded and does not stop the others. */
  async tick(owner: string, now = new Date(), signal?: AbortSignal): Promise<MonitorCheck[]> {
    const due = this.db.prepare("SELECT id FROM monitors WHERE owner=? AND next_at<=? LIMIT 20").all(owner, now.toISOString());
    const results: MonitorCheck[] = [];
    for (const row of due) {
      const id = String(row.id);
      // A watch whose last look has not come back yet is left alone: a beat every few seconds
      // must not fetch the same page over and over, nor announce one change several times.
      if (this.inFlight.has(id)) continue;
      try { results.push(await this.check(owner, id, now, signal)); }
      catch (error) {
        this.db.prepare("UPDATE monitors SET next_at=? WHERE id=?").run(new Date(now.getTime() + 3600000).toISOString(), id);
        const at = new Date().toISOString();
        this.remember(id, { status: "failed", startedAt: at, finishedAt: at }, errorText(error).slice(0, 300));
        results.push({ id, changed: false, summary: `That watch could not be checked: ${errorText(error)}`, delivered: null });
      }
    }
    return results;
  }
  /**
   * Sends the summary to the chosen chat, or puts it in the activity list when none was chosen, or when it is
   * `held` from its chat: then the activity list says why, and the hold is recorded.
   */
  private async announce(owner: string, record: MonitorRecord, summary: string, held: string | null = null, priceKey?: string): Promise<string | null> {
    if (record.notifyVia === "activity" || !this.deliver || held) {
      const run = this.store.createRun(owner, `Watch: ${record.label}`);
      this.store.message(run.sessionId, { role: "assistant", content: held ? `${summary}\n\n${held}` : summary });
      this.store.event(run.id, "monitor.changed", { monitorId: record.id, target: record.target });
      if (held && record.notifyVia !== "activity") this.store.event(run.id, "delivery.held", { ...record.notifyVia, reason: held });
      this.store.finish(run.id, "completed", summary);
      return "activity";
    }
    const { channel, chatId } = record.notifyVia;
    await this.deliver(channel, chatId, summary, `monitor:${record.id}:${priceKey ?? Date.now()}`);
    return `${channel}:${chatId}`;
  }
}
const digest = (text: string): string => createHash("sha256").update(text).digest("hex");
function parseRecent(value: unknown): HealthEntry[] {
  try { const parsed: unknown = JSON.parse(String(value ?? "[]")); return Array.isArray(parsed) ? parsed as HealthEntry[] : []; }
  catch { return []; }
}
/** Whether any line came or went; spacing and order alone do not count. */
function linesDiffer(before: string, after: string): boolean {
  const lines = (text: string) => new Set(text.split("\n").map((line) => line.trim()).filter(Boolean));
  const old = lines(before), now = lines(after);
  return old.size !== now.size || [...now].some((line) => !old.has(line));
}
function toRecord(row: Record<string, unknown>): MonitorRecord {
  const recent = parseRecent(row.recent);
  return {
    id: String(row.id), kind: String(row.kind) as MonitorRecord["kind"], target: String(row.target),
    label: String(row.label ?? ""), everyMinutes: Number(row.every_minutes),
    notifyVia: JSON.parse(String(row.notify)) as MonitorRecord["notifyVia"],
    lastCheckedAt: row.checked_at === null ? null : String(row.checked_at),
    nextAt: String(row.next_at), changes: Number(row.changes ?? 0),
    health: automationHealth(recent), lastError: row.last_error ? String(row.last_error) : null,
    price: priceCondition(row.price_rule), lastPrice: priceHistory(row.prices).at(-1) ?? null,
  };
}
/** What changed, in sentences: how many lines came and went, with a few of each. */
export function describeChange(record: MonitorRecord, before: string, after: string): string {
  const oldLines = new Set(before.split("\n").map((line) => line.trim()).filter(Boolean));
  const newLines = new Set(after.split("\n").map((line) => line.trim()).filter(Boolean));
  const added = [...newLines].filter((line) => !oldLines.has(line));
  const removed = [...oldLines].filter((line) => !newLines.has(line));
  const what = record.kind === "page" ? `the page at ${record.target}` : `the search for “${record.target}”`;
  const parts = [`Something changed on ${what}.`];
  if (added.length) parts.push(`${added.length} new line${added.length === 1 ? "" : "s"}:`, ...added.slice(0, 5).map((line) => `- ${line.slice(0, 200)}`));
  if (removed.length) parts.push(`${removed.length} line${removed.length === 1 ? "" : "s"} gone:`, ...removed.slice(0, 5).map((line) => `- ${line.slice(0, 200)}`));
  if (!added.length && !removed.length) parts.push("The wording is the same but something small moved.");
  return parts.join("\n");
}

export function registerMonitors(registry: ToolRegistry, monitors: Monitors): void {
  registry.register({
    name: "monitor.create", reach: "outbound", permission: "monitors.manage",
    description: "Watch a web page or search and say what changed. Optional price rule watches one unique literal label followed by its currency marker and amount; alerts only on a lower price below the threshold. Give the exact item, currency and number format. The first price must be readable before scheduling. History keeps 100 valid observations.",
    parameters: MonitorSchema,
    execute: async (input, context) => monitors.create(context.owner, input, context.signal, context),
  });
  registry.register({
    name: "monitor.list", permission: "monitors.read",
    description: "List the watches that are running, what each is looking at, when it was last checked and how often it has changed.",
    parameters: z.object({}).strict(),
    execute: async (_input, context) => ({ monitors: monitors.list(context.owner, context) }),
  });
  registry.register({
    name: "monitor.check", reach: "outbound", permission: "monitors.manage",
    description: "Look at one watch right now instead of waiting for its next turn, and report what changed.",
    parameters: z.object({ id: z.string().uuid() }).strict(),
    execute: async ({ id }, context) => monitors.check(context.owner, id, new Date(), context.signal, context),
  });
  registry.register({
    name: "monitor.prices", permission: "monitors.read",
    description: "Read up to 100 retained valid price observations for a price watch; includes their timestamps and currency.",
    parameters: z.object({ id: z.string().uuid() }).strict(),
    execute: async ({ id }, context) => monitors.history(context.owner, id, context),
  });
  registry.register({
    name: "monitor.remove", permission: "monitors.manage",
    description: "Stop a watch and forget what it had seen.",
    parameters: z.object({ id: z.string().uuid() }).strict(),
    execute: async ({ id }, context) => monitors.remove(context.owner, id, context),
  });
}
