import { randomUUID } from "node:crypto";
import { memoryAgent, readsSharedFacts, writesSharedFacts } from "./trunks/memory-scope.js"; // R17-A (Trunks)
import { isDeepStrictEqual } from "node:util";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { SavedRecord, Store } from "./store.js";
import type { ToolRegistry } from "./registry.js";
import { FactKindSchema, MemoryLayerSchema, layerForKind, layerOf } from "./memory-layers.js";
import type { MemoryBackend } from "./memory-backend.js"; // FQ-memory.providers

export const maximumMemoryArchiveBytes = 16 * 1024 * 1024;
export const MemoryDataSchema = z.object({
  text: z.string().min(1).max(4000),
  source: z.string().min(1).max(500).default("Saved by workspace owner"),
  sourceRunId: z.string().max(200).default(""),
  /** The run that first saved the fact; survives later edits so a conversation can be forgotten precisely. */
  originRunId: z.string().max(200).optional(),
  /** Who or what the fact is about, and which detail, so facts can change over time. */
  entity: z.string().trim().min(1).max(120).optional(),
  attribute: z.string().trim().min(1).max(80).optional(),
  /** When the fact became true and when it stopped being true (null or absent while current). */
  validFrom: z.iso.datetime().optional(),
  validTo: z.iso.datetime().nullable().optional(),
  /** private (owner only, default), shared (also visible to delegated specialists), or agent:<id>. */
  scope: z.string().regex(/^(private|shared|agent:[a-zA-Z0-9_.:-]{1,80})$/).optional(),
  /** What kind of thing this is; absent means a fact about the world. See src/memory-layers.ts. */
  kind: FactKindSchema.optional(),
  /** How long it is meant to last; absent means long-term, which is how every older fact behaved. */
  layer: MemoryLayerSchema.optional(),
  /** The project it belongs to, when it belongs to one rather than to the person in general. */
  project: z.string().trim().min(1).max(120).optional(),
  /** Set when the owner asked for a scribble to be kept, so ending the job no longer clears it. */
  promoted: z.boolean().optional(),
  // ── R17-058 (src/learning-more/expiry.ts): the owner's labels, and when a fact stops being kept. ──
  tags: z.array(z.string().trim().min(1).max(40)).max(12).optional(),
  expiresAt: z.iso.datetime().optional(),
  // ── end R17-058 ──
}).strict();
/**
 * A fact reworded: its words, where they came from and the run that changed them are new, and everything else
 * about it stays: whose it is (scope), how long it is meant to last (layer, expiry), what it is about (entity,
 * attribute, dates) and the owner's labels. Before this, only the outside path kept the scope, and a Trunk's
 * fact changed on this computer, or by an accepted suggestion, became the owner's and was lost to the Trunk.
 * What cannot be read as a fact is refused, not half-kept.
 */
export function reworded(previous: unknown, words: { text: string; source: string; sourceRunId: string }): z.infer<typeof MemoryDataSchema> {
  return { ...MemoryDataSchema.parse(previous), ...words };
}
/** Scopes a reader may see: everything for the owner, shared plus its own for a delegated specialist. */
export function visibleTo(record: { data: { scope?: string } }, agent?: string): boolean {
  if (!agent) return true;
  const scope = record.data.scope ?? "private";
  if (scope === "shared") return readsSharedFacts(agent); // R17-A: a Trunk may be set to keep to itself
  return scope === `agent:${agent}`;
}
/**
 * FQ-routing.isolated-agents: scopes `agent`'s memory.write may change by id (update, delete, keep).
 * Mirrors what memory.put is already allowed to save under (`writesSharedFacts`): its own agent scope
 * always, and `shared` only for whatever is not a Trunk (a Trunk never writes shared facts, R17-A). The
 * owner's own turn (no agent) may reach anything, exactly as before this existed. Read access
 * (`visibleTo`) is wider than write access on purpose: a Trunk may read a shared fact without being
 * able to edit or delete it, and never another Trunk's own fact either way.
 */
export function writableTo(record: { data: { scope?: string } } | undefined, agent?: string): boolean {
  if (!record || !agent) return true;
  const scope = record.data.scope ?? "private";
  return scope === `agent:${agent}` || (scope === "shared" && writesSharedFacts(agent));
}
const NewMemoryDataSchema = MemoryDataSchema.extend({
  text: z.string().trim().min(1).max(4000),
  source: z.string().trim().min(1).max(500).default("Saved by workspace owner"),
});
const MemoryIdSchema = z.string().min(1).max(200);
const RecordSchema = z.object({
  id: MemoryIdSchema, data: MemoryDataSchema,
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict();
const ArchiveSchema = z.object({
  format: z.literal("branch-agent-memory"), version: z.literal(1),
  exportedAt: z.iso.datetime(), records: z.array(RecordSchema).max(500),
}).strict();
const CapacitySchema = z.object({ maxFacts: z.number().int().min(1).max(500) }).strict();
export const UpdateMemorySchema = z.object({
  id: MemoryIdSchema, text: z.string().trim().min(1).max(4000),
  source: z.string().trim().min(1).max(500), expectedRevision: z.number().int().positive(),
}).strict();
export const PutMemorySchema = z.object({
  text: z.string().trim().min(1).max(4000),
  source: z.string().trim().min(1).max(500),
  entity: z.string().trim().min(1).max(120).optional(),
  attribute: z.string().trim().min(1).max(80).optional(),
  validFrom: z.iso.datetime().optional(),
  scope: z.enum(["private", "shared"]).optional(),
  /** What kind of thing this is. A task-scratch note is cleared when the job that made it ends. */
  kind: FactKindSchema.optional(),
  /** Which project it belongs to, when it belongs to one rather than to the person in general. */
  project: z.string().trim().min(1).max(120).optional(),
}).strict();
export const AtMemorySchema = z.object({ entity: z.string().trim().min(1).max(120), attribute: z.string().trim().min(1).max(80).optional(), at: z.iso.datetime().optional() }).strict();
export interface MemoryRecord extends SavedRecord { revision: number }
type MemoryData = z.infer<typeof MemoryDataSchema>;
type ArchiveRecord = z.infer<typeof RecordSchema>;

export function parseMemoryArchive(input: unknown) {
  const serialized = JSON.stringify(input);
  if (!serialized || Buffer.byteLength(serialized) > maximumMemoryArchiveBytes)
    throw new Error("Memory archive exceeds 16 MiB");
  const archive = ArchiveSchema.parse(input), ids = new Set<string>();
  for (const record of archive.records) {
    if (ids.has(record.id)) throw new Error("Memory archive contains repeated identifiers");
    if (Date.parse(record.updatedAt) < Date.parse(record.createdAt))
      throw new Error("Memory update time precedes its creation time");
    ids.add(record.id);
  }
  return archive;
}

export class MemoryFacts {
  constructor(private readonly db: DatabaseSync) {
    if (!db.prepare("PRAGMA table_info(memory)").all().some(row => row.name === "revision"))
      db.exec("ALTER TABLE memory ADD COLUMN revision INTEGER NOT NULL DEFAULT 1");
    db.exec("CREATE TABLE IF NOT EXISTS memory_limits(owner TEXT PRIMARY KEY,max_facts INTEGER NOT NULL)");
    db.exec(`CREATE TABLE IF NOT EXISTS memory_suppressions(owner TEXT NOT NULL, session_id TEXT NOT NULL,
      created_at TEXT NOT NULL, PRIMARY KEY(owner,session_id))`);
    db.exec(`CREATE TABLE IF NOT EXISTS memory_archive(id TEXT NOT NULL, owner TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, revision INTEGER NOT NULL, archived_at TEXT NOT NULL, PRIMARY KEY(id,owner))`);
    if (!db.prepare("PRAGMA table_info(memory_archive)").all().some(row => row.name === "note"))
      db.exec("ALTER TABLE memory_archive ADD COLUMN note TEXT NOT NULL DEFAULT ''");
    db.exec(`CREATE TABLE IF NOT EXISTS memory_versions(id INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL, memory_id TEXT NOT NULL,
      revision INTEGER NOT NULL, data TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL)`);
  }
  /** Every earlier content of a fact, newest first; kept before each edit and on deletion. */
  /**
   * The last thing kept of a fact, by when it was kept: after a delete, what the fact was when it went. Not the highest
   * revision: a fact brought back starts again at revision 1, so an earlier life can hold higher ones (NAS 640471a).
   */
  lastKept(owner: string, memoryId: string): Record<string, unknown> | undefined {
    const row = this.db.prepare("SELECT data FROM memory_versions WHERE owner=? AND memory_id=? ORDER BY id DESC LIMIT 1").get(owner, memoryId);
    return row ? JSON.parse(String(row.data)) as Record<string, unknown> : undefined;
  }
  versions(owner: string, memoryId: string) {
    return this.db.prepare("SELECT * FROM memory_versions WHERE owner=? AND memory_id=? ORDER BY revision DESC, id DESC LIMIT 100").all(owner, memoryId)
      .map((row) => ({ memoryId: String(row.memory_id), revision: Number(row.revision), data: JSON.parse(String(row.data)) as Record<string, unknown>, reason: String(row.reason), createdAt: String(row.created_at) }));
  }
  private keepVersion(owner: string, record: MemoryRecord, reason: string): void {
    this.db.prepare("INSERT INTO memory_versions(owner,memory_id,revision,data,reason,created_at) VALUES(?,?,?,?,?,?)")
      .run(owner, record.id, record.revision, JSON.stringify(record.data), reason, new Date().toISOString());
  }
  /** Removes a fact but keeps its last content as a version so it can be brought back. */
  delete(owner: string, id: string, reason = "deleted"): boolean {
    const previous = this.get(owner, id);
    if (!previous) return false;
    this.keepVersion(owner, previous, reason);
    return this.db.prepare("DELETE FROM memory WHERE owner=? AND id=?").run(owner, id).changes > 0;
  }
  /**
   * A scribble made while doing one job, kept for good instead. The owner asks for this from the
   * Memory screen, or a task asks for it before it finishes; either way the note stops being
   * cleared when the job ends and joins everything else the assistant knows.
   */
  promote(owner: string, id: string): MemoryRecord {
    const record = this.get(owner, id);
    if (!record) throw new Error("That note is no longer saved");
    if (layerOf(record) !== "task") throw new Error("Only a note made while doing a job can be kept this way");
    this.keepVersion(owner, record, "kept for good");
    const data = { ...record.data, layer: "long-term" as const, promoted: true };
    this.db.prepare("UPDATE memory SET data=?, updated_at=?, revision=revision+1 WHERE owner=? AND id=?")
      .run(JSON.stringify(data), new Date().toISOString(), owner, id);
    return this.get(owner, id)!;
  }
  /**
   * Clears the scribbles one job made, which is what "task scratch" means: they were only ever for
   * the length of that job. A note the owner asked to keep is left alone, and every note that does
   * go keeps its last wording as a version, so nothing is lost beyond recall.
   */
  clearTaskScratch(owner: string, runId: string): { cleared: string[] } {
    const cleared: string[] = [];
    for (const record of this.list(owner)) {
      const data = record.data as { sourceRunId?: string };
      // Keeping a note moves it out of this layer, which is exactly what spares it from here.
      if (layerOf(record) !== "task" || String(data.sourceRunId ?? "") !== runId) continue;
      this.delete(owner, record.id, "the job this note was for finished");
      cleared.push(record.id);
    }
    return { cleared };
  }
  /** Puts a record back exactly as a checkpoint kept it, id, times and revision included. */
  restoreExact(owner: string, record: { id: string; data: Record<string, unknown>; createdAt: string; updatedAt: string; revision: number }): void {
    this.db.prepare("INSERT OR REPLACE INTO memory(id,owner,data,created_at,updated_at,revision) VALUES(?,?,?,?,?,?)")
      .run(record.id, owner, JSON.stringify(record.data), record.createdAt, record.updatedAt, record.revision);
  }
  /**
   * Facts a conversation's runs saved by themselves, split into removable and kept (owner-edited) ones.
   * `outside` is what an outside memory service holds for this owner when one is switched on
   * (src/memory-provider.ts), so a conversation's facts are found wherever they were saved.
   */
  forgetPreview(owner: string, sessionId: string, outside: readonly MemoryRecord[] = []) {
    if (!this.db.prepare("SELECT id FROM sessions WHERE id=? AND owner=?").get(sessionId, owner))
      throw new Error("Conversation not found");
    const runIds = new Set(this.db.prepare("SELECT id FROM tasks WHERE session_id=?").all(sessionId).map(row => String(row.id)));
    const remove: { id: string; text: string; source: string; createdAt: string }[] = [];
    const excluded: { id: string; text: string; reason: string }[] = [];
    for (const record of [...this.list(owner), ...outside]) {
      if (!runIds.has(String(record.data.originRunId || record.data.sourceRunId))) continue;
      const text = String(record.data.text);
      if (record.revision > 1) excluded.push({ id: record.id, text, reason: `You edited this after it was saved (revision ${record.revision}), so it stays.` });
      else remove.push({ id: record.id, text, source: String(record.data.source), createdAt: record.createdAt });
    }
    return { sessionId, remove, excluded, suppressed: this.suppressed(owner, sessionId) };
  }
  /**
   * Removes the previewed facts (or a chosen subset) kept on this computer and stops the conversation
   * from saving memory again on its own. `ids` is every fact chosen, so the caller can remove the
   * ones an outside memory service holds as well.
   */
  forget(owner: string, input: unknown, outside: readonly MemoryRecord[] = []) {
    const { sessionId, ids } = z.object({ sessionId: z.string().uuid(), ids: z.array(MemoryIdSchema).max(500).optional() }).strict().parse(input);
    const preview = this.forgetPreview(owner, sessionId, outside);
    const removable = new Set(preview.remove.map(entry => entry.id));
    const chosen = ids ?? [...removable];
    if (chosen.some(id => !removable.has(id))) throw new Error("Only facts listed in the preview can be forgotten");
    this.db.exec("BEGIN");
    try {
      const remove = this.db.prepare("DELETE FROM memory WHERE owner=? AND id=?");
      for (const id of chosen) remove.run(owner, id);
      this.db.prepare("INSERT OR IGNORE INTO memory_suppressions VALUES(?,?,?)").run(owner, sessionId, new Date().toISOString());
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return { sessionId, removed: chosen.length, ids: chosen, excluded: preview.excluded, suppressed: true };
  }
  /** Retention: facts untouched for longer than the policy are archived (restorable) or purged, with a report. */
  hygiene(owner: string, input: unknown, now: number = Date.now()) {
    const { olderThanDays, action } = z.object({ olderThanDays: z.number().int().min(1).max(3650), action: z.enum(["preview", "archive", "purge"]) }).strict().parse(input);
    const cutoff = new Date(now - olderThanDays * 86_400_000).toISOString();
    const stale = this.list(owner).filter((record) => record.updatedAt < cutoff);
    if (action === "preview") return { action, cutoff, stale: stale.map(summary), archived: [], purged: [] };
    this.db.exec("BEGIN");
    try {
      for (const record of stale) {
        if (action === "archive")
          this.db.prepare("INSERT OR REPLACE INTO memory_archive(id,owner,data,created_at,updated_at,revision,archived_at) VALUES(?,?,?,?,?,?,?)")
            .run(record.id, owner, JSON.stringify(record.data), record.createdAt, record.updatedAt, record.revision, new Date().toISOString());
        this.db.prepare("DELETE FROM memory WHERE owner=? AND id=?").run(owner, record.id);
      }
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return { action, cutoff, stale: [], archived: action === "archive" ? stale.map(summary) : [], purged: action === "purge" ? stale.map(summary) : [] };
  }
  archived(owner: string) {
    return this.db.prepare("SELECT * FROM memory_archive WHERE owner=? ORDER BY archived_at DESC LIMIT 500").all(owner)
      .map((row) => ({ ...this.record(row), archivedAt: String(row.archived_at), note: String(row.note ?? "") }));
  }
  /**
   * Moves one fact out of the working set and into the archive with a note saying why. Nothing is
   * destroyed: the fact keeps its versions and can be put back from the Memory view.
   */
  setAside(owner: string, id: string, note: string): { id: string; note: string } {
    const record = this.get(owner, id);
    if (!record) throw new Error("That fact is no longer saved");
    this.keepVersion(owner, record, note.slice(0, 200) || "set aside");
    this.db.prepare("INSERT OR REPLACE INTO memory_archive(id,owner,data,created_at,updated_at,revision,archived_at,note) VALUES(?,?,?,?,?,?,?,?)")
      .run(id, owner, JSON.stringify(record.data), record.createdAt, record.updatedAt, record.revision, new Date().toISOString(), note.slice(0, 500));
    this.db.prepare("DELETE FROM memory WHERE owner=? AND id=?").run(owner, id);
    return { id, note };
  }
  restore(owner: string, id: string) {
    const row = this.db.prepare("SELECT * FROM memory_archive WHERE owner=? AND id=?").get(owner, id);
    if (!row) throw new Error("Archived memory not found");
    this.requireRoom(owner, 1);
    // R17-058 (integration review): the owner putting back a fact that expired keeps it for good,
    // rather than the next sweep setting it straight aside again.
    const data = JSON.parse(String(row.data)) as Record<string, unknown>;
    if (typeof data.expiresAt === "string" && Date.parse(data.expiresAt) <= Date.now()) delete data.expiresAt;
    this.db.exec("BEGIN");
    try {
      this.db.prepare("INSERT INTO memory(id,owner,data,created_at,updated_at,revision) VALUES(?,?,?,?,?,?)")
        .run(id, owner, JSON.stringify(data), String(row.created_at), new Date().toISOString(), Number(row.revision) + 1);
      this.db.prepare("DELETE FROM memory_archive WHERE owner=? AND id=?").run(owner, id);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.get(owner, id)!;
  }
  /** How many facts are archived, all of them (the list shows the newest 500). */
  archivedCount(owner: string): number {
    return Number(this.db.prepare("SELECT COUNT(*) AS count FROM memory_archive WHERE owner=?").get(owner)!.count);
  }
  /**
   * Removes every archived fact for good, with the earlier versions kept of it, so nothing puts it back.
   * The owner says how many they saw; when that is no longer how many there are (something was archived
   * or restored since), nothing is removed. A fact that is back in memory under the same id keeps its versions.
   */
  purgeArchive(owner: string, seen: number): { purged: number } {
    const ids = this.db.prepare("SELECT id FROM memory_archive WHERE owner=?").all(owner).map((row) => String(row.id));
    if (ids.length !== seen)
      throw new Error(`There are ${ids.length} archived facts now, not ${seen}, so nothing was purged. Look at the list again first.`);
    this.db.exec("BEGIN");
    try {
      for (const id of ids) {
        this.db.prepare("DELETE FROM memory_archive WHERE owner=? AND id=?").run(owner, id);
        if (!this.get(owner, id)) this.db.prepare("DELETE FROM memory_versions WHERE owner=? AND memory_id=?").run(owner, id);
      }
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return { purged: ids.length };
  }
  suppressed(owner: string, sessionId: string): boolean {
    return !!this.db.prepare("SELECT 1 AS found FROM memory_suppressions WHERE owner=? AND session_id=?").get(owner, sessionId);
  }
  capacity(owner: string) {
    return { count: Number(this.db.prepare("SELECT COUNT(*) AS count FROM memory WHERE owner=?").get(owner)!.count),
      maxFacts: Number(this.db.prepare("SELECT max_facts FROM memory_limits WHERE owner=?").get(owner)?.max_facts ?? 500) };
  }
  configure(owner: string, input: unknown) {
    const { maxFacts } = CapacitySchema.parse(input);
    if (this.capacity(owner).count > maxFacts) throw new Error("Remove memories before lowering capacity below the current count");
    this.db.prepare("INSERT INTO memory_limits VALUES(?,?) ON CONFLICT(owner) DO UPDATE SET max_facts=excluded.max_facts")
      .run(owner, maxFacts);
    return this.capacity(owner);
  }
  get(owner: string, id: string): MemoryRecord | undefined {
    const row = this.db.prepare("SELECT * FROM memory WHERE owner=? AND id=?").get(owner, id);
    return row ? this.record(row) : undefined;
  }
  list(owner: string): MemoryRecord[] {
    return this.db.prepare("SELECT * FROM memory WHERE owner=? ORDER BY updated_at DESC,id LIMIT 501")
      .all(owner).map(row => this.record(row));
  }
  /** `agent` is who is writing (a Trunk's or specialist's turn); unset for the owner's own write. */
  save(owner: string, id: string, input: unknown, agent?: string): MemoryRecord {
    MemoryIdSchema.parse(id);
    const parsed = NewMemoryDataSchema.parse(input), previous = this.get(owner, id);
    const origin = previous ? (previous.data.originRunId || previous.data.sourceRunId) : (parsed.originRunId || parsed.sourceRunId);
    const data = { ...parsed, ...(origin ? { originRunId: origin } : {}) };
    // FQ-routing.isolated-agents: a fact saved under an agent's own scope was written by that agent,
    // even when the caller did not say so, so it never ends a fact that agent may not write.
    const writer = agent ?? (data.scope?.startsWith("agent:") ? data.scope.slice("agent:".length) : undefined);
    if (!previous && data.entity && data.attribute) this.closeEarlier(owner, data.entity, data.attribute, data.validFrom ?? new Date().toISOString(), writer);
    if (!previous) this.requireRoom(owner, 1);
    if (previous?.revision === Number.MAX_SAFE_INTEGER) throw new Error("Memory revision limit reached");
    if (previous) this.keepVersion(owner, previous, "before edit");
    const now = new Date(Math.max(Date.now(), previous ? Date.parse(previous.updatedAt) + 1 : 0)).toISOString();
    this.db.prepare(`INSERT INTO memory(id,owner,data,created_at,updated_at,revision) VALUES(?,?,?,?,?,1)
      ON CONFLICT(id,owner) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at,revision=memory.revision+1`)
      .run(id, owner, JSON.stringify(data), now, now);
    return this.get(owner, id)!;
  }
  /**
   * A newer fact about the same entity and detail ends the earlier one at the moment the new one starts.
   * FQ-routing.isolated-agents: only facts the writer may change (`writableTo`, the rule memory.update
   * keeps) are ended, so one Trunk saving "launch / day" never ends another Trunk's own fact about it.
   * The owner's own write (no agent) ends any earlier one, exactly as before.
   */
  private closeEarlier(owner: string, entity: string, attribute: string, validFrom: string, agent?: string): void {
    for (const record of this.list(owner)) {
      if (!writableTo(record, agent)) continue;
      const d = record.data as MemoryData;
      if (d.entity !== entity || d.attribute !== attribute || (d.validTo ?? null) !== null) continue;
      if ((d.validFrom ?? record.createdAt) >= validFrom) continue;
      this.keepVersion(owner, record, "superseded");
      this.db.prepare("UPDATE memory SET data=?, updated_at=?, revision=revision+1 WHERE owner=? AND id=?")
        .run(JSON.stringify({ ...d, validTo: validFrom }), new Date().toISOString(), owner, record.id);
    }
  }
  /** Facts about an entity that were true at a moment: started on or before it and not ended by then. */
  at(owner: string, input: unknown, agent?: string) {
    const { entity, attribute, at } = AtMemorySchema.parse(input);
    const moment = at ?? new Date().toISOString();
    return this.list(owner).filter((record) => visibleTo(record, agent)).filter((record) => {
      const d = record.data as MemoryData;
      if (d.entity?.toLowerCase() !== entity.toLowerCase()) return false;
      if (attribute && d.attribute?.toLowerCase() !== attribute.toLowerCase()) return false;
      const from = d.validFrom ?? record.createdAt;
      return from <= moment && (!d.validTo || d.validTo > moment);
    }).map((record) => { const d = record.data as MemoryData; return { id: record.id, text: d.text, entity: d.entity, attribute: d.attribute, validFrom: d.validFrom ?? record.createdAt, validTo: d.validTo ?? null, scope: d.scope }; });
  }
  /** Every fact about an entity in the order it became true, ended ones included. */
  timeline(owner: string, entity: string, agent?: string) {
    return this.list(owner).filter((record) => visibleTo(record, agent) && (record.data as MemoryData).entity?.toLowerCase() === entity.toLowerCase())
      .map((record) => { const d = record.data as MemoryData; return { id: record.id, text: d.text, attribute: d.attribute, validFrom: d.validFrom ?? record.createdAt, validTo: d.validTo ?? null, scope: d.scope }; })
      .sort((a, b) => a.validFrom.localeCompare(b.validFrom));
  }
  /** Lets a conversation save memory again, or stops it from doing so on its own. */
  setSuppressed(owner: string, sessionId: string, suppressed: boolean): boolean {
    if (suppressed) this.db.prepare("INSERT OR IGNORE INTO memory_suppressions VALUES(?,?,?)").run(owner, sessionId, new Date().toISOString());
    else this.db.prepare("DELETE FROM memory_suppressions WHERE owner=? AND session_id=?").run(owner, sessionId);
    return this.suppressed(owner, sessionId);
  }
  update(owner: string, input: unknown, sourceRunId: string) {
    const value = UpdateMemorySchema.parse(input), previous = this.get(owner, value.id);
    if (!previous) throw new Error("Memory not found");
    if (previous.revision !== value.expectedRevision) throw new Error("Memory changed since you opened it. Reload it before saving.");
    return this.save(owner, value.id, reworded(previous.data, { text: value.text, source: value.source, sourceRunId }));
  }
  export(owner: string) {
    if (this.capacity(owner).count > 500) throw new Error("Memory archive exceeds 500 records; reduce legacy memory count before exporting");
    return parseMemoryArchive({ format: "branch-agent-memory", version: 1, exportedAt: new Date().toISOString(),
      records: this.list(owner).map(({ owner: _owner, ...record }) => record) });
  }
  import(owner: string, input: unknown) {
    const archive = parseMemoryArchive(input), additions: ArchiveRecord[] = [];
    for (const record of archive.records) {
      const previous = this.get(owner, record.id);
      if (!previous) additions.push(record);
      else {
        const { owner: _owner, ...saved } = previous;
        if (!isDeepStrictEqual(saved, record)) throw new Error("Memory archive conflicts with an existing identifier; nothing was imported");
      }
    }
    this.requireRoom(owner, additions.length);
    this.db.exec("BEGIN");
    try {
      const insert = this.db.prepare("INSERT INTO memory(id,owner,data,created_at,updated_at,revision) VALUES(?,?,?,?,?,?)");
      for (const record of additions)
        insert.run(record.id, owner, JSON.stringify(record.data), record.createdAt, record.updatedAt, record.revision);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return { imported: additions.length, unchanged: archive.records.length - additions.length };
  }
  search(owner: string, query: string, agent?: string) {
    const normalized = query.normalize("NFC").toLowerCase();
    const results: MemoryRecord[] = [];
    let bytes = 2;
    for (const record of this.list(owner)) {
      if (!visibleTo(record, agent)) continue;
      if (!String(record.data.text).normalize("NFC").toLowerCase().includes(normalized)) continue;
      const size = Buffer.byteLength(JSON.stringify(record)) + 1;
      if (bytes + size > 48000 || results.length === 20) break;
      results.push(record); bytes += size;
    }
    return results;
  }
  private requireRoom(owner: string, additions: number) {
    const { count, maxFacts } = this.capacity(owner);
    if (additions > 0 && count + additions > maxFacts)
      throw new Error(`Memory capacity reached (${count}/${maxFacts}). Edit or delete a fact, or increase the configured limit.`);
  }
  private record(row: Record<string, unknown>): MemoryRecord {
    return { id: String(row.id), owner: String(row.owner), data: MemoryDataSchema.parse(JSON.parse(String(row.data))),
      createdAt: String(row.created_at), updatedAt: String(row.updated_at), revision: Number(row.revision) };
  }
}

/** When the owner asked to approve memory changes, the model's change waits as a suggestion. */
function staged(store: Store, context: { owner: string; runId: string }, proposal: Record<string, unknown>, fact: unknown = null) {
  // A suggestion waits in the scope it was made in, so a profile's suggestion never turns up in
  // the owner's Memory view and the owner's never turns up in theirs.
  const owner = memoryScope(store, context);
  if (!store.review.settings(owner).requireApproval) return null;
  const saved = store.review.propose(owner, { ...proposal, runId: context.runId }, fact);
  return { staged: true, proposalId: saved.id, message: "Saved as a suggestion. The owner can accept it in the Memory view." };
}
/** Hybrid retrieval, when it is wired: the same shape src/memory-retrieval.ts provides. */
export interface FactSearch {
  search(owner: string, query: string, agent?: string, limit?: number, signal?: AbortSignal):
    Promise<{ record: MemoryRecord; score: number; importance: number; matched: string }[]>;
}
/**
 * Where facts are saved and read for whoever is using the app right now. With no household profile
 * switched on this is the owner and nothing changes. With one on, it is that profile: what the
 * assistant learns during their task is saved under their name, and the owner's own facts are not
 * there to be read — the same separation their conversations already have. Models, settings and
 * the secrets locker still belong to the owner; only what is remembered moves.
 */
export const memoryScope = (store: Store, context: { owner: string }): string =>
  context.owner === store.profiles.ownerName ? store.profiles.scope() : context.owner;

/**
 * FQ-memory.providers: when the owner has switched an outside memory service on, the assistant's
 * basic remember/recall/forget loop below goes to it instead of this computer's database —
 * `src/memory-provider.ts` is the one place that decides which, read fresh on every call. Facts
 * that depend on Branch's own revision history (`memory.keep`, `memory.at`, `memory.timeline`, and
 * the hygiene/versions screens) stay on this computer's database either way: they are Branch's own
 * bookkeeping on top of a fact, not part of what `MemoryBackend` promises a backend does.
 */
export interface OutsideMemoryProvider extends MemoryBackend {
  isOutside(owner: string): boolean;
  withFactLock?<T>(owner: string, id: string, fn: () => Promise<T>): Promise<T>;
  forgetSettled?(owner: string, sessionId: string): Promise<void>;
  serviceFor?(owner: string): MemoryBackend | undefined;
  takeBack?(owner: string, id: string, service: MemoryBackend): Promise<boolean>;
}
/**
 * Takes back a fact just written for `owner`: from the service it was written to when that is known
 * (NAS 4654193: the owner may have switched since), otherwise through the provider. True only when the
 * service said it deleted it; a fact it did not have yet may still arrive, and is hidden here either way.
 */
export function takeBackFact(provider: OutsideMemoryProvider, owner: string, id: string, service: MemoryBackend | undefined): Promise<boolean> {
  const taking = service && provider.takeBack ? provider.takeBack(owner, id, service) : provider.forget(owner, id);
  return taking.then((deleted) => deleted === true, () => false);
}

export function registerMemory(registry: ToolRegistry, store: Store, retrieval?: FactSearch, provider?: OutsideMemoryProvider): void {
  registry.register({ name: "memory.put", description: "Save one clear fact with its source. Give entity and attribute when it may change later, so a newer fact ends the earlier one.",
    permission: "memory.write", parameters: PutMemorySchema,
    execute: async (value, context) => {
      const owner = memoryScope(store, context);
      const sessionId = store.run(context.runId)?.sessionId;
      if (sessionId && store.memorySuppressed(owner, sessionId))
        throw new Error("Memory from this conversation was forgotten, so it is not saved again automatically. The owner can save it from the Memory view.");
      const agent = memoryAgent(context);
      const scope = agent ? (value.scope === "shared" && writesSharedFacts(agent) ? "shared" : `agent:${agent}`) : value.scope;
      const { scope: _requested, ...rest } = value; void _requested;
      // A kind decides how long the fact lasts unless it says otherwise: only a scribble is short-lived.
      const layer = layerForKind(value.kind ?? "fact-about-world");
      const data = { ...rest, ...(scope ? { scope } : {}), layer, sourceRunId: context.runId };
      // A suggestion carries whose the fact is and what it is about, so the owner's yes saves it as this would have.
      const { text: _text, source: _source, sourceRunId: _run, ...fact } = data; void _text; void _source; void _run;
      const proposal = staged(store, context, { kind: "put", text: value.text, source: value.source }, fact);
      if (proposal) return proposal;
      if (!provider?.isOutside(owner)) return store.save("memory", owner, randomUUID(), data, agent);
      const id = randomUUID();
      const service = provider.serviceFor?.(owner); // taken with the write, so a switch since cannot redirect the takeback
      const saved = await provider.write(owner, id, data).catch(async (error: unknown) => {
        // A save Branch reports as failed is never read back: the service may still apply one it was too slow
        // to answer, after a Forget has already looked. This id is new, so nothing of the owner's is hidden.
        await takeBackFact(provider, owner, id, service);
        throw error;
      });
      // "Forget this conversation" may have run while the service was still saving this fact, and it could not see
      // a fact the service did not have yet. Once any Forget of it now running has settled, what was saved is taken
      // back (and never read back) and refused the same way if the conversation was forgotten.
      if (sessionId) await provider.forgetSettled?.(owner, sessionId);
      if (sessionId && store.memorySuppressed(owner, sessionId)) {
        const deleted = await takeBackFact(provider, owner, id, service);
        throw new Error("Memory from this conversation was forgotten, so it is not saved again automatically. The owner can save it from the Memory view."
          + (deleted ? "" : " The outside memory service would not delete what it had just saved, so it may still keep it; Branch will not read it back."));
      }
      return saved;
    } });
  registry.register({ name: "memory.keep", description: "Keep a note from this job for good, so ending the job does not clear it.",
    permission: "memory.write", parameters: z.object({ id: MemoryIdSchema }).strict(),
    execute: async (value, context) => {
      const owner = memoryScope(store, context);
      // FQ-routing.isolated-agents: was context.owner, which skipped a household profile's own scope
      // entirely; now the same scope every other memory tool reads and writes.
      if (!writableTo(store.get("memory", owner, value.id) as MemoryRecord | undefined, memoryAgent(context)))
        throw new Error("That note is no longer saved");
      return store.promoteMemory(owner, value.id);
    } });
  registry.register({ name: "memory.at", description: "Facts about an entity that were true at a given moment, now by default.",
    permission: "memory.read", parameters: AtMemorySchema,
    execute: async (value, context) => store.memoryAt(memoryScope(store, context), value, memoryAgent(context)) });
  registry.register({ name: "memory.timeline", description: "Every saved fact about an entity in order, including ones that have ended.",
    permission: "memory.read", parameters: z.object({ entity: z.string().trim().min(1).max(120) }).strict(),
    execute: async (value, context) => store.memoryTimeline(memoryScope(store, context), value.entity, memoryAgent(context)) });
  registry.register({ name: "memory.update", description: "Correct an existing fact using its current revision. Stale edits are rejected.",
    permission: "memory.write", parameters: UpdateMemorySchema,
    execute: async (value, context) => {
      const owner = memoryScope(store, context);
      const agent = memoryAgent(context);
      const outside = !!provider?.isOutside(owner);
      // FQ-routing.isolated-agents: checked before staging, so an id outside this agent's own scope
      // never even reaches the review queue as a proposal (on an outside service as on this computer).
      // Only an agent's reach needs the fact read first; the owner may change any of theirs.
      const current = agent && outside ? await provider!.read(owner, value.id) : store.get("memory", owner, value.id) as MemoryRecord | undefined;
      // A fact an agent cannot find is not one it may change: nothing is staged or sent for it.
      if ((agent && !current) || !writableTo(current, agent)) throw new Error("Memory not found");
      const proposal = staged(store, context, { kind: "update", memoryId: value.id, text: value.text, source: value.source });
      if (proposal) return proposal;
      if (!outside) return store.updateMemory(owner, value, context.runId);
      if (!provider!.withFactLock) return Promise.reject(new Error("Provider does not support outside updates"));
      return provider!.withFactLock(owner, value.id, async () => {
        // The service is taken in the same step as the read, as a delete's is. A fact whose service changed while it was
        // read has changed under this edit, so the edit is refused as stale and no copy of it is saved anywhere else.
        const service = provider!.serviceFor?.(owner);
        const previous = await provider!.read(owner, value.id);
        if (!previous || !writableTo(previous, agent)) throw new Error("Memory not found");
        if (previous.revision !== value.expectedRevision || provider!.serviceFor?.(owner) !== service)
          throw new Error("Memory changed since you opened it. Reload it before saving.");
        // The fact keeps whose it is and how long it lasts: only its words change. The write takes its service in this
        // same step as the check above, so the words go to the service the fact was read from.
        return provider!.write(owner, value.id, reworded(previous.data, { text: value.text, source: value.source, sourceRunId: context.runId }));
      });
    } });
  registry.register({ name: "memory.search", description: "Search this owner's facts by words and, where the provider allows it, by meaning.",
    permission: "memory.read", parameters: z.object({ query: z.string().max(200) }).strict(),
    execute: async (value, context) => {
      const owner = memoryScope(store, context);
      if (provider?.isOutside(owner)) return provider.search(owner, value.query, memoryAgent(context));
      if (!retrieval) return store.searchMemory(owner, value.query, memoryAgent(context));
      const hits = await retrieval.search(owner, value.query, memoryAgent(context), 20, context.signal);
      return hits.map((hit) => ({ ...hit.record, score: hit.score, importance: hit.importance, matched: hit.matched }));
    } });
  registry.register({ name: "memory.delete", description: "Delete an owner-scoped memory.", permission: "memory.write",
    parameters: z.object({ id: MemoryIdSchema }).strict(),
    execute: async (value, context) => {
      const owner = memoryScope(store, context);
      const outside = !!provider?.isOutside(owner);
      // FQ-routing.isolated-agents: an id outside this agent's own scope is refused exactly as a
      // missing one is (returns false, nothing thrown) — an unauthorised Trunk learns nothing about
      // whether that id even exists.
      const agent = memoryAgent(context);
      // Only an agent's reach needs the fact read first; the owner may delete any of theirs. The service is taken before
      // the read, so the delete goes where the fact was found, whatever the owner has switched to since.
      const service = agent && outside ? provider!.serviceFor?.(owner) : undefined;
      const current = agent && outside ? await provider!.read(owner, value.id) : store.get("memory", owner, value.id) as MemoryRecord | undefined;
      if ((agent && !current) || !writableTo(current, agent)) return false;
      const proposal = staged(store, context, { kind: "delete", memoryId: value.id });
      if (proposal) return proposal;
      if (!outside) return store.delete("memory", owner, value.id);
      return agent ? takeBackFact(provider!, owner, value.id, service) : provider!.forget(owner, value.id);
    } });
}

function summary(record: MemoryRecord) {
  return { id: record.id, text: String(record.data.text), updatedAt: record.updatedAt };
}
