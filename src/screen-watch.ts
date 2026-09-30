import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { ToolContext } from "./contracts.js";
import type { Store } from "./store.js";
import type { ToolRegistry } from "./registry.js";
import type { DeliveryHandler } from "./scheduler.js";
import { noWatchTrunks, requireMaySendToChats, trunkMayNotSend, watchMadeBy, watchVisibleTo, type WatchTrunks } from "./monitors.js";
import { textDifference, type ReadScreenText } from "./screen-watch-ocr.js";

/**
 * Watching a corner of the screen for a change. A long job in a program that has no other way of
 * telling anybody it has finished; a number on a dashboard that only ever appears on screen. Every
 * so often Branch takes a picture of one rectangle, compares it with the last one, and says when it
 * is different.
 *
 * This is the most intrusive thing in the app, so it is fenced in three ways: it is off until the
 * owner switches it on, it refuses to run at all unless using the screen is already switched on,
 * and it keeps a fingerprint of the picture rather than the picture — nothing that was on the
 * screen is written to disk.
 *
 * The picture-taking itself is handed in rather than reached for, so the tests can watch a made-up
 * screen and no test ever opens a window.
 */
export const ScreenWatchSettingsSchema = z.object({
  /** Off until the owner asks for it, on top of the screen-control switch it also needs. */
  enabled: z.boolean().default(false),
}).strict();
const settingsKey = "screen-watch";
export function screenWatchSettings(store: Store, owner: string): { enabled: boolean } {
  const saved = ScreenWatchSettingsSchema.safeParse(store.get("settings", owner, settingsKey)?.data ?? {});
  return saved.success ? saved.data : { enabled: false };
}
export function saveScreenWatchSettings(store: Store, owner: string, input: unknown): { enabled: boolean } {
  const value = ScreenWatchSettingsSchema.parse(input ?? {});
  store.save("settings", owner, settingsKey, value);
  return value;
}

export const ScreenWatchSchema = z.object({
  label: z.string().trim().min(1).max(120),
  /** The rectangle to watch, in screen pixels. */
  region: z.object({
    x: z.number().int().min(0).max(20000), y: z.number().int().min(0).max(20000),
    width: z.number().int().min(8).max(20000), height: z.number().int().min(8).max(20000),
  }).strict(),
  everyMinutes: z.number().int().min(1).max(1440).default(5),
  /** Opt in to local OCR; recognized differences may be included in the selected notification. */
  readText: z.boolean().default(false),
  /** Where the news goes: the activity list, or a chat already connected. */
  notifyVia: z.union([z.literal("activity"),
    z.object({ channel: z.string().min(1).max(64), chatId: z.string().min(1).max(64) }).strict()]).default("activity"),
}).strict();
export type ScreenWatchInput = z.infer<typeof ScreenWatchSchema>;
export interface ScreenWatchRecord {
  id: string; label: string; region: { x: number; y: number; width: number; height: number };
  everyMinutes: number; notifyVia: "activity" | { channel: string; chatId: string };
  lastCheckedAt: string | null; changes: number; readText: boolean;
}
/** What a picture of the region is reduced to. The picture itself is never kept. */
export type CaptureRegion = (region: { x: number; y: number; width: number; height: number }) => Promise<Uint8Array>;

const fingerprint = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const row = (record: Record<string, unknown>): ScreenWatchRecord => ({
  id: String(record.id), label: String(record.label), region: JSON.parse(String(record.region)),
  everyMinutes: Number(record.every_minutes), notifyVia: JSON.parse(String(record.notify)),
  lastCheckedAt: (record.checked_at as string | null) ?? null, changes: Number(record.changes ?? 0),
  readText: Number(record.read_text ?? 0) === 1,
});

export class ScreenWatches {
  private readonly db: DatabaseSync;
  private readonly text = new Map<string, string>();
  private readonly checking = new Set<string>();
  constructor(
    private readonly store: Store,
    private readonly capture: CaptureRegion,
    /** True only while the owner has using the screen switched on. Checked at every look. */
    private readonly screenControlOn: () => boolean,
    private readonly deliver?: DeliveryHandler,
    /** Q141: whose work a call is, and whether a Trunk may send to chats now (src/monitors.ts). */
    private readonly trunks: WatchTrunks = noWatchTrunks,
    private readonly recognize?: ReadScreenText,
  ) {
    this.db = store.sqlite;
    this.db.exec(`CREATE TABLE IF NOT EXISTS screen_watches(id TEXT PRIMARY KEY, owner TEXT NOT NULL,
      label TEXT NOT NULL, region TEXT NOT NULL, every_minutes INTEGER NOT NULL, notify TEXT NOT NULL,
      fingerprint TEXT, checked_at TEXT, changes INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS screen_watches_owner ON screen_watches(owner);`);
    // Q141, added later: the Trunk that made the watch, if one did. Older databases gain the column here.
    const columns = new Set(this.db.prepare("PRAGMA table_info(screen_watches)").all().map((column) => String(column.name)));
    if (!columns.has("made_by")) this.db.exec("ALTER TABLE screen_watches ADD COLUMN made_by TEXT");
    if (!columns.has("read_text")) this.db.exec("ALTER TABLE screen_watches ADD COLUMN read_text INTEGER NOT NULL DEFAULT 0");
  }
  private allowed(owner: string): void {
    if (!screenWatchSettings(this.store, owner).enabled)
      throw new Error("Watching a corner of the screen is switched off. The owner turns it on in Settings.");
    if (!this.screenControlOn())
      throw new Error("This needs using your screen to be switched on as well, and it is not.");
  }
  list(owner: string): ScreenWatchRecord[] {
    return this.db.prepare("SELECT * FROM screen_watches WHERE owner=? ORDER BY created_at DESC LIMIT 100").all(owner).map(row);
  }
  remove(owner: string, id: string): { removed: string } {
    if (!this.db.prepare("DELETE FROM screen_watches WHERE owner=? AND id=?").run(owner, id).changes)
      throw new Error("There is no screen watch with that number");
    this.text.delete(JSON.stringify([owner, id]));
    return { removed: id };
  }
  /**
   * Starts a watch and takes the first picture at once, so the next change is a real change. `context` is the tool
   * call behind it. Who may point a watch at a chat is asked before the switches are.
   */
  async create(owner: string, input: unknown, context?: ToolContext): Promise<ScreenWatchRecord> {
    const value = ScreenWatchSchema.parse(input);
    if (value.notifyVia !== "activity") requireMaySendToChats(this.store, context);
    this.allowed(owner);
    const id = randomUUID(), now = new Date().toISOString();
    const picture = await this.capture(value.region);
    const text = value.readText ? await this.readText(picture) : undefined;
    this.allowed(owner);
    if (value.notifyVia !== "activity") requireMaySendToChats(this.store, context);
    const first = fingerprint(picture);
    this.db.prepare("INSERT INTO screen_watches(id,owner,label,region,every_minutes,notify,fingerprint,checked_at,changes,created_at,made_by,read_text) VALUES(?,?,?,?,?,?,?,?,0,?,?,?)")
      .run(id, owner, value.label, JSON.stringify(value.region), value.everyMinutes,
        JSON.stringify(value.notifyVia), first, now, now, watchMadeBy(context, this.trunks), value.readText ? 1 : 0);
    if (text !== undefined) this.rememberText(owner, id, text);
    return this.list(owner).find((one) => one.id === id)!;
  }
  /**
   * Looks once. A different picture is a change; the same picture is nothing at all, and neither
   * picture is kept — only the fingerprint that told them apart.
   */
  async check(owner: string, id: string, context?: ToolContext): Promise<{ id: string; changed: boolean; summary: string; delivered: string | null; held?: string }> {
    const key = JSON.stringify([owner, id]);
    if (this.checking.has(key)) throw new Error("This screen watch is already being checked");
    this.checking.add(key);
    try { return await this.checkOnce(owner, id, context); }
    finally { this.checking.delete(key); }
  }
  private async checkOnce(owner: string, id: string, context?: ToolContext): Promise<{ id: string; changed: boolean; summary: string; delivered: string | null; held?: string }> {
    this.allowed(owner);
    const found = this.db.prepare("SELECT * FROM screen_watches WHERE owner=? AND id=?").get(owner, id) as Record<string, unknown> | undefined;
    if (!found || !watchVisibleTo(context, this.trunks, found.made_by)) throw new Error("There is no screen watch with that number"); // A2
    const watch = row(found);
    const picture = await this.capture(watch.region);
    const now = fingerprint(picture);
    const changed = now !== String(found.fingerprint ?? "");
    const key = JSON.stringify([owner, id]);
    const text = watch.readText && (changed || !this.text.has(key)) ? await this.readText(picture) : undefined;
    const difference = text === undefined ? "" : textDifference(this.text.get(key), text);
    this.allowed(owner);
    if (!this.db.prepare("SELECT id FROM screen_watches WHERE owner=? AND id=?").get(owner, id))
      throw new Error("The screen watch was removed while checking");
    if (text !== undefined) this.rememberText(owner, id, text);
    this.db.prepare("UPDATE screen_watches SET fingerprint=?, checked_at=?, changes=changes+? WHERE owner=? AND id=?")
      .run(now, new Date().toISOString(), changed ? 1 : 0, owner, id);
    const summary = changed
      ? `"${watch.label}" looks different from the last time Branch looked.${difference ? `\n${difference}` : ""}`
      : `"${watch.label}" looks the same as last time.`;
    // Q141: a watch a Trunk made sends to its chat only while that Trunk may still send to chats.
    const madeBy = found.made_by ? String(found.made_by) : null;
    const held = changed && watch.notifyVia !== "activity" && madeBy && !this.trunks.maySend(madeBy)
      ? (this.trunks.offReason() ?? trunkMayNotSend) : null;
    const delivered = changed ? await this.tell(owner, watch, summary, held) : null;
    return { id, changed, summary, delivered, ...(held ? { held } : {}) };
  }
  private async readText(picture: Uint8Array): Promise<string> {
    if (!this.recognize) throw new Error("Local screen OCR is not available on this copy");
    return (await this.recognize(picture)).slice(0, 4096);
  }
  private rememberText(owner: string, id: string, text: string): void {
    const key = JSON.stringify([owner, id]);
    this.text.delete(key);
    if (this.text.size >= 100) this.text.delete(this.text.keys().next().value!);
    this.text.set(key, text);
  }
  /**
   * Sends the news where the owner asked, through the channel they already connected. News `held` from its chat
   * is kept in the activity list instead, saying why, and the hold is recorded.
   */
  private async tell(owner: string, watch: ScreenWatchRecord, summary: string, held: string | null): Promise<string | null> {
    if (watch.notifyVia === "activity" || !this.deliver) return null;
    if (held) {
      const run = this.store.createRun(owner, `Screen watch: ${watch.label}`);
      this.store.message(run.sessionId, { role: "assistant", content: `${summary}\n\n${held}` });
      this.store.event(run.id, "delivery.held", { ...watch.notifyVia, reason: held });
      this.store.finish(run.id, "completed", summary);
      return "activity";
    }
    const sent = await this.deliver(watch.notifyVia.channel, watch.notifyVia.chatId, summary, `screen-watch:${watch.id}`);
    return sent.messageId ?? "queued";
  }
}

export function registerScreenWatches(registry: ToolRegistry, watches: ScreenWatches): void {
  registry.register({
    name: "monitors.screen.create", permission: "monitors.manage",
    description: "Watch one rectangle of the screen and say when it changes. Needs using your screen switched on. Optional readText uses local OCR; recognized text differences are included in notifications.",
    parameters: ScreenWatchSchema,
    execute: async (input, context) => watches.create(context.owner, input, context),
  });
  registry.register({
    name: "monitors.screen.check", permission: "monitors.manage",
    description: "Look at one screen watch now rather than waiting, and say whether it changed.",
    parameters: z.object({ id: z.string().uuid() }).strict(),
    execute: async ({ id }, context) => watches.check(context.owner, id, context),
  });
}
