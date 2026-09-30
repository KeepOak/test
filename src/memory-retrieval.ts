import type { DatabaseSync } from "node:sqlite";
import { binnedRuns, learnedInBin } from "./conversation-actions.js";
import { z } from "zod";
import { errorText } from "./contracts.js";
import { EmbeddingClient, cosine, defaultEmbeddingModel, fuseRanks, packVector, unpackVector, type Embedder } from "./document-embeddings.js";
import { embeddingFetch } from "./embeddings.js";
import { localEmbedder } from "./local-models.js";
import { visibleTo, type MemoryRecord } from "./memory.js";
import type { ModelRouter } from "./models.js";
import { providerEmbeddings } from "./providers.js";
import type { Store } from "./store.js";

/**
 * Finding the right saved fact. Facts are indexed for word search with ranking and, when the
 * connected provider offers embeddings and the owner has not turned that off, also compared by
 * meaning; the two orders are combined the way document search combines them. How useful a fact
 * has been (how recent it is, how often it has been drawn on, whether the owner confirmed it)
 * then decides the order the assistant sees.
 */
export const MemoryRetrievalSettingsSchema = z.object({
  /** Compare facts by meaning as well as by their words. Off means word search only. */
  useEmbeddings: z.boolean().default(true),
  embeddingModel: z.string().trim().min(1).max(120).default(defaultEmbeddingModel),
}).strict();
export type MemoryRetrievalSettings = z.infer<typeof MemoryRetrievalSettingsSchema>;
export interface MemoryHit {
  record: MemoryRecord;
  /** Combined rank from the searches that found it, weighted by how useful the fact has been. */
  score: number;
  importance: number;
  matched: "words" | "meaning" | "both";
}
const candidates = 40;
/** A search answer never exceeds this, the same ceiling literal fact search has always kept to. */
export const maximumSearchBytes = 48000;
/** As many of the best hits as fit, so one long fact can never make an answer the caller cannot hold. */
function bounded(hits: MemoryHit[], limit: number): MemoryHit[] {
  const kept: MemoryHit[] = [];
  let bytes = 2;
  for (const hit of hits) {
    const size = Buffer.byteLength(JSON.stringify(hit)) + 1;
    if (kept.length >= limit || bytes + size > maximumSearchBytes) break;
    kept.push(hit); bytes += size;
  }
  return kept;
}

/** Recency, how often it has been used, and whether the owner stood behind it. */
export function importanceOf(record: MemoryRecord, uses: number, now: number = Date.now()): number {
  const ageDays = Math.max(0, (now - Date.parse(record.updatedAt)) / 86_400_000);
  const recency = 0.2 + Math.exp(-ageDays / 30);
  const ownerConfirmed = record.revision > 1 || !record.data.sourceRunId;
  return Number((recency * (1 + Math.log1p(Math.max(0, uses))) * (ownerConfirmed ? 1.5 : 1)).toFixed(6));
}

export class MemoryRetrieval {
  private readonly db: DatabaseSync;
  /** False only where this build of SQLite has no full-text search; word search then matches plainly. */
  readonly ranked: boolean;
  /**
   * The app's guarded fetch, set once at start-up. A fact sent to a provider off this computer goes
   * through the owner's network rules first; a reader on this computer is reached directly.
   */
  embeddingFetch: typeof fetch = globalThis.fetch;
  constructor(private readonly store: Store, private readonly models?: ModelRouter) {
    this.db = store.sqlite;
    this.db.exec(`CREATE TABLE IF NOT EXISTS memory_terms(row_id INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL,
        memory_id TEXT NOT NULL, revision INTEGER NOT NULL, UNIQUE(owner,memory_id));
      CREATE TABLE IF NOT EXISTS memory_vectors(owner TEXT NOT NULL, memory_id TEXT NOT NULL, revision INTEGER NOT NULL,
        model TEXT NOT NULL, vector BLOB NOT NULL, PRIMARY KEY(owner,memory_id));
      CREATE TABLE IF NOT EXISTS memory_uses(owner TEXT NOT NULL, memory_id TEXT NOT NULL, uses INTEGER NOT NULL DEFAULT 0,
        last_used_at TEXT NOT NULL, PRIMARY KEY(owner,memory_id));`);
    this.ranked = this.createIndex();
  }
  private createIndex(): boolean {
    const available = this.db.prepare("PRAGMA compile_options").all()
      .some((row) => String(row.compile_options).toUpperCase() === "ENABLE_FTS5");
    if (!available) return false;
    try {
      this.db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS memory_search USING fts5(fact_text, tokenize='unicode61 remove_diacritics 2')");
      return true;
    } catch (error) {
      console.warn(`Branch Agent: memory ranking is unavailable (${errorText(error)}); facts match plain words instead.`);
      return false;
    }
  }
  settings(owner: string): MemoryRetrievalSettings {
    const saved = MemoryRetrievalSettingsSchema.safeParse(this.store.get("settings", owner, "memory-retrieval")?.data ?? {});
    return saved.success ? saved.data : MemoryRetrievalSettingsSchema.parse({});
  }
  configure(owner: string, input: unknown): MemoryRetrievalSettings {
    const value = MemoryRetrievalSettingsSchema.parse({ ...this.settings(owner), ...(input as object) });
    this.store.save("settings", owner, "memory-retrieval", value);
    return value;
  }
  /**
   * Set at start-up: puts the shared store of passages already read in front of whichever reader
   * the provider offers, so a fact that has not changed is never sent anywhere twice.
   */
  wrapEmbedder: ((embedder: Embedder) => Embedder) | undefined;
  /** The provider's embeddings route, or nothing when there is no key or the owner turned it off. */
  private client(owner: string): Embedder | null {
    const base = this.baseClient(owner);
    return base && this.wrapEmbedder ? this.wrapEmbedder(base) : base;
  }
  private baseClient(owner: string): Embedder | null {
    const settings = this.settings(owner);
    if (!settings.useEmbeddings) return null;
    const route = this.models ? providerEmbeddings(this.models.plan(owner, "").candidates[0]!.provider) : null;
    if (!route) return null;
    // A model on this computer reads facts through Ollama's own route, not the OpenAI one.
    const here = localEmbedder(route, settings.embeddingModel);
    if (here) return here;
    try { return new EmbeddingClient(route.endpoint, route.apiKey, settings.embeddingModel, embeddingFetch(route.endpoint, this.embeddingFetch)); }
    catch { return null; }
  }
  meaningSearchReady(owner: string): boolean { return this.client(owner) !== null; }
  view(owner: string) {
    return { settings: this.settings(owner), meaningSearch: this.meaningSearchReady(owner), ranked: this.ranked };
  }
  private facts(owner: string): MemoryRecord[] { return this.store.list("memory", owner) as MemoryRecord[]; }

  /** Brings the word index in line with the saved facts: new and edited ones in, removed ones out. */
  syncIndex(owner: string): { indexed: number; removed: number } {
    const records = this.facts(owner), live = new Set(records.map((r) => r.id));
    const known = new Map(this.db.prepare("SELECT row_id, memory_id, revision FROM memory_terms WHERE owner=?").all(owner)
      .map((row) => [String(row.memory_id), { rowId: Number(row.row_id), revision: Number(row.revision) }]));
    let indexed = 0, removed = 0;
    for (const [id, entry] of known) {
      if (live.has(id) && entry.revision === records.find((r) => r.id === id)!.revision) continue;
      this.dropRow(owner, id, entry.rowId); known.delete(id); removed++;
    }
    for (const record of records) {
      if (known.has(record.id)) continue;
      const row = this.db.prepare("INSERT INTO memory_terms(owner,memory_id,revision) VALUES(?,?,?) RETURNING row_id")
        .get(owner, record.id, record.revision);
      if (this.ranked) this.db.prepare("INSERT INTO memory_search(rowid,fact_text) VALUES(?,?)").run(Number(row?.row_id), indexText(record));
      indexed++;
    }
    return { indexed, removed };
  }
  private dropRow(owner: string, memoryId: string, rowId: number): void {
    if (this.ranked) this.db.prepare("DELETE FROM memory_search WHERE rowid=?").run(rowId);
    this.db.prepare("DELETE FROM memory_terms WHERE owner=? AND memory_id=?").run(owner, memoryId);
    this.db.prepare("DELETE FROM memory_vectors WHERE owner=? AND memory_id=?").run(owner, memoryId);
  }
  /** Gives every fact that has no current vector one, in the same batches the document library uses. */
  async index(owner: string, signal = AbortSignal.timeout(60000)): Promise<{ embedded: number; reason: string }> {
    this.syncIndex(owner);
    const client = this.client(owner);
    if (!client) return { embedded: 0, reason: "meaning search is not available" };
    const current = new Map(this.db.prepare("SELECT memory_id, revision, model FROM memory_vectors WHERE owner=?").all(owner)
      .map((row) => [String(row.memory_id), `${row.revision}:${row.model}`]));
    const pending = this.facts(owner).filter((r) => current.get(r.id) !== `${r.revision}:${client.model}`);
    if (!pending.length) return { embedded: 0, reason: "every fact is already compared by meaning" };
    try {
      const vectors = await client.embed(pending.map(indexText), signal);
      for (const [at, record] of pending.entries()) {
        const vector = vectors[at];
        if (vector) this.db.prepare("INSERT OR REPLACE INTO memory_vectors VALUES(?,?,?,?,?)")
          .run(owner, record.id, record.revision, client.model, packVector(vector));
      }
      return { embedded: pending.length, reason: "" };
    } catch (error) { return { embedded: 0, reason: errorText(error).slice(0, 200) }; }
  }

  /** Best facts for a question: ranked word matches, meaning matches where available, combined. */
  async search(owner: string, query: string, agent?: string, limit = 20, signal = AbortSignal.timeout(20000)): Promise<MemoryHit[]> {
    this.syncIndex(owner);
    const binned = binnedRuns(this.store.sqlite); // not a fact a conversation in Recently Deleted taught
    const visible = this.facts(owner).filter((record) => visibleTo(record, agent) && !learnedInBin(binned, record.data));
    const byId = new Map(visible.map((record) => [record.id, record]));
    const words = this.wordMatches(owner, query).filter((id) => byId.has(id));
    const meaning = (await this.meaningMatches(owner, query, signal)).filter((id) => byId.has(id));
    if (!words.length && !meaning.length) return [];
    const fused = fuseRanks([words, meaning].filter((list) => list.length));
    const uses = this.useCounts(owner);
    const ordered = [...fused.entries()].map(([id, rank]) => {
      const record = byId.get(id)!, importance = importanceOf(record, uses.get(id) ?? 0);
      const matched = words.includes(id) && meaning.includes(id) ? "both" : meaning.includes(id) ? "meaning" : "words";
      return { record, importance, score: Number((rank * importance).toFixed(6)), matched } as MemoryHit;
    }).sort((a, b) => b.score - a.score);
    const hits = bounded(ordered, limit);
    this.noteUse(owner, hits.map((hit) => hit.record.id));
    return hits;
  }
  private wordMatches(owner: string, query: string): string[] {
    const words = query.match(/[\p{L}\p{N}]+/gu)?.slice(0, 32) ?? [];
    if (!words.length) return [];
    if (!this.ranked) return this.plainMatches(owner, words);
    const expression = words.map((word) => `"${word.replace(/"/g, "")}"`).join(" OR ");
    return this.db.prepare(`SELECT t.memory_id FROM memory_search JOIN memory_terms t ON t.row_id=memory_search.rowid
      WHERE memory_search MATCH ? AND t.owner=? ORDER BY bm25(memory_search) LIMIT ?`)
      .all(expression, owner, candidates).map((row) => String(row.memory_id));
  }
  private plainMatches(owner: string, words: string[]): string[] {
    const wanted = words.map((word) => word.toLowerCase());
    return this.facts(owner)
      .filter((record) => wanted.some((word) => indexText(record).toLowerCase().includes(word)))
      .slice(0, candidates).map((record) => record.id);
  }
  private async meaningMatches(owner: string, query: string, signal: AbortSignal): Promise<string[]> {
    const client = this.client(owner);
    if (!client) return [];
    const rows = this.db.prepare("SELECT memory_id, vector FROM memory_vectors WHERE owner=? LIMIT 1000").all(owner);
    if (!rows.length) return [];
    const asked = await client.embed([query], signal).catch(() => null);
    if (!asked?.[0]) return [];
    return rows.map((row) => ({ id: String(row.memory_id), score: cosine(asked[0]!, unpackVector(row.vector as Uint8Array)) }))
      .filter((entry) => entry.score > 0.15).sort((a, b) => b.score - a.score).slice(0, candidates).map((entry) => entry.id);
  }
  /** The meaning vectors held for this owner's facts, for comparing facts with each other. */
  vectors(owner: string): Map<string, Float32Array> {
    return new Map(this.db.prepare("SELECT memory_id, vector FROM memory_vectors WHERE owner=? LIMIT 1000").all(owner)
      .map((row) => [String(row.memory_id), unpackVector(row.vector as Uint8Array)]));
  }
  useCounts(owner: string): Map<string, number> {
    return new Map(this.db.prepare("SELECT memory_id, uses FROM memory_uses WHERE owner=?").all(owner)
      .map((row) => [String(row.memory_id), Number(row.uses)]));
  }
  /** When each fact was last drawn on, for setting unused ones aside (src/memory-auto-archive.ts). */
  lastUses(owner: string): Map<string, string> {
    return new Map(this.db.prepare("SELECT memory_id, last_used_at FROM memory_uses WHERE owner=?").all(owner)
      .map((row) => [String(row.memory_id), String(row.last_used_at)]));
  }
  /** Records that a fact was drawn on, which makes it count as more useful next time. */
  noteUse(owner: string, ids: string[]): void {
    const now = new Date().toISOString();
    for (const id of ids.slice(0, 50))
      this.db.prepare(`INSERT INTO memory_uses VALUES(?,?,1,?) ON CONFLICT(owner,memory_id)
        DO UPDATE SET uses=memory_uses.uses+1, last_used_at=excluded.last_used_at`).run(owner, id, now);
  }
  /** Every fact in the order the assistant should prefer it, most useful first. */
  ranking(owner: string, agent?: string): { record: MemoryRecord; importance: number; uses: number }[] {
    const uses = this.useCounts(owner);
    return this.facts(owner).filter((record) => visibleTo(record, agent))
      .map((record) => ({ record, uses: uses.get(record.id) ?? 0, importance: importanceOf(record, uses.get(record.id) ?? 0) }))
      .sort((a, b) => b.importance - a.importance);
  }
}
/** What gets indexed for a fact: its words plus who and what it is about. */
export function indexText(record: MemoryRecord): string {
  const data = record.data as { text?: string; entity?: string; attribute?: string };
  return [data.entity, data.attribute, data.text].filter(Boolean).join(" ").slice(0, 4000);
}
