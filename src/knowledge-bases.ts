import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { Bm25 } from "./bm25.js";
import { chunkDocument, type Chunk } from "./chunking.js";
import { Citations, type Citation } from "./citations.js";
import { errorText, estimateTokens } from "./contracts.js";
import { documentType, knownExtension } from "./document-text.js";
import { readableTypes, tryReadDocument } from "./document-readers.js";
import { fuseRanks } from "./document-embeddings.js";
import { CachedEmbeddings, EmbeddingCache, EmbeddingSources, noEmbeddingsMessage,
  textFingerprint, type EmbeddingLedger } from "./embeddings.js";
import type { WorkspaceFiles } from "./files.js";
import { allowAll, passageVisible, WalkRules } from "./walk-rules.js"; // mac7/walk-rules
import type { ModelRouter } from "./models.js";
import { filterIsSet, filterSql, nothingMatchedNote, RetrievalFilterSchema,
  type RetrievalFilter } from "./retrieval-filters.js";
import type { Store } from "./store.js";
import { SqliteVectors, comfortableChunkCount, type VectorBackend } from "./vector-store.js";
import { chooseVectorStore, VectorStoreSettingsSchema, type VectorStoreSettings, type VectorServiceDependencies } from "./vector-store-file.js";
import type { RerankablePassage } from "./documents.js";

/**
 * A knowledge base is a name the owner gives to a set of folders and files they want the assistant
 * to be able to quote. Reading one means cutting every file into passages, keeping them for word
 * search, and — where a connected model can do it — also as lists of numbers so a question finds
 * the right passage even when it uses none of the same words. A search asks both ways at once and
 * merges the two orders, and every answer says which file, heading and page it came from.
 */
export const maximumSources = 20;
export const maximumFiles = 400;
export const maximumFileBytes = 5 * 1024 * 1024;
const passageChars = 900;
const candidates = 60;

export const SourceSchema = z.object({
  kind: z.enum(["folder", "file"]),
  path: z.string().trim().min(1).max(500),
}).strict();
export type CollectionSource = z.infer<typeof SourceSchema>;
export const CreateCollectionSchema = z.object({
  name: z.string().trim().min(1).max(120),
  sources: z.array(SourceSchema).max(maximumSources).default([]),
}).strict();
/**
 * The two limits the owner can move. `maxIndexTokens` is how much new reading one press of "Read it
 * again" may do; a reading that would go past it is refused in one sentence rather than run up a
 * bill, or an hour of work, that nobody asked for. Passages already read never count towards it, so
 * re-reading a folder nothing changed in is always allowed; zero means no limit.
 * `compareAtMost` is how many stored passages one search may compare, so the work has a ceiling.
 */
export const KnowledgeSettingsSchema = z.object({
  maxIndexTokens: z.number().int().min(0).max(20_000_000).default(400_000),
  compareAtMost: z.number().int().min(100).max(comfortableChunkCount).default(comfortableChunkCount),
}).strict();
export type KnowledgeSettings = z.infer<typeof KnowledgeSettingsSchema>;
export const KnowledgeSearchSchema = z.object({
  collection: z.string().trim().min(1).max(120).optional(),
  query: z.string().trim().min(1).max(500),
  limit: z.number().int().min(1).max(10).default(5),
  /** Narrow the search before anything is ranked; see src/retrieval-filters.ts. */
  filter: RetrievalFilterSchema.optional(),
}).strict();

export interface CollectionInfo {
  id: string; name: string; sources: CollectionSource[]; model: string; attached: boolean;
  documents: number; chunks: number; embedded: number; lastIndexedAt: string | null; note: string;
  /** The files in this collection that could not be read, each with the reason in plain language. */
  unread: { file: string; reason: string }[];
  /** Roughly how much new reading this knowledge base has been charged for, added up over every read. */
  indexTokens: number;
}
export interface IndexProgress {
  event: "knowledge.index.progress";
  collection: string; name: string;
  files: number; filesDone: number; chunks: number; embedded: number;
  /** Files whose contents had not changed since the last read, so they were left as they were. */
  unchanged: number;
  /** Roughly how much new reading this pass was charged for; zero when the reader is on this computer. */
  tokens: number;
  status: string; finished: boolean; error?: string;
}
export interface KnowledgeHit {
  collection: string; collectionName: string;
  documentId: string; documentName: string; heading: string; page: number | null;
  chunkId: string; text: string; score: number; matched: "words" | "meaning" | "both";
}

export class KnowledgeBases {
  private readonly db: DatabaseSync;
  /** Where the lists of numbers are kept. Swapped when the owner names a file of their own. */
  vectors: VectorBackend;
  /** The sentence to show when the file the owner chose could not be opened; empty when all is well. */
  backendNote = "";
  readonly cache: EmbeddingCache;
  readonly embeddingSources: EmbeddingSources;
  /** Set at startup; external vector services never acquire an unguarded network connection. */
  vectorServiceDependencies: VectorServiceDependencies | undefined;
  private readonly vectorWork = new Map<string, Promise<void>>();
  /** False only where this build of SQLite has no full-text search; every collection is then read whole. */
  readonly ranked: boolean;
  /** Set at start-up: puts the passages a search found into the best order. See src/retrieval.ts. */
  reranker: ((owner: string, query: string, passages: RerankablePassage[], signal?: AbortSignal) => Promise<RerankablePassage[]>) | undefined;
  private readonly latest = new Map<string, IndexProgress>();
  constructor(
    private readonly store: Store,
    private readonly files?: WorkspaceFiles,
    private readonly models?: ModelRouter,
    private readonly ledger?: EmbeddingLedger,
    backend?: VectorBackend,
    /**
     * The app's guarded fetch. Every passage sent to a provider off this computer is checked
     * against the owner's network rules first; a reader on this computer is reached directly.
     */
    readonly embeddingCall: typeof fetch = globalThis.fetch,
  ) {
    this.db = store.sqlite;
    this.embeddingSources = new EmbeddingSources(store, models);
    this.cache = new EmbeddingCache(this.db);
    this.vectors = backend ?? new SqliteVectors(this.db);
    this.createTables();
    this.ranked = this.createIndex();
  }
  private createTables(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS kb_collections(id TEXT NOT NULL, owner TEXT NOT NULL, name TEXT NOT NULL,
        sources TEXT NOT NULL, model TEXT NOT NULL DEFAULT '', attached INTEGER NOT NULL DEFAULT 0,
        note TEXT NOT NULL DEFAULT '', last_indexed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY(id,owner));
      CREATE TABLE IF NOT EXISTS kb_chunks(row_id INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL,
        collection TEXT NOT NULL, chunk_id TEXT NOT NULL, doc_id TEXT NOT NULL, doc_name TEXT NOT NULL,
        chunk_index INTEGER NOT NULL, heading TEXT NOT NULL DEFAULT '', page INTEGER, chunk_text TEXT NOT NULL,
        text_hash TEXT NOT NULL, UNIQUE(owner,collection,chunk_id));
      CREATE INDEX IF NOT EXISTS kb_chunks_collection ON kb_chunks(owner,collection);
      CREATE INDEX IF NOT EXISTS kb_chunks_document ON kb_chunks(owner,collection,doc_id);
      CREATE TABLE IF NOT EXISTS kb_documents(owner TEXT NOT NULL, collection TEXT NOT NULL, doc_id TEXT NOT NULL,
        file_hash TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL,
        PRIMARY KEY(owner,collection,doc_id));`);
    // Added after the first release of this table; an install that already has it simply keeps it.
    try { this.db.exec("ALTER TABLE kb_collections ADD COLUMN index_tokens INTEGER NOT NULL DEFAULT 0"); } catch { /* already there */ }
  }
  /** The owner's two limits: what one reading may cost, and how much one search may compare. */
  settings(owner: string): KnowledgeSettings {
    const saved = KnowledgeSettingsSchema.safeParse(this.store.get("settings", owner, "knowledge")?.data ?? {});
    return saved.success ? saved.data : KnowledgeSettingsSchema.parse({});
  }
  configure(owner: string, input: unknown): KnowledgeSettings {
    const value = KnowledgeSettingsSchema.parse({ ...this.settings(owner), ...(input as object) });
    this.store.save("settings", owner, "knowledge", value);
    return value;
  }
  /** Where the owner has asked for their vectors to live. */
  vectorStoreSettings(owner: string): VectorStoreSettings {
    const saved = VectorStoreSettingsSchema.safeParse(this.store.get("settings", owner, "vector-store")?.data ?? {});
    return saved.success ? saved.data : VectorStoreSettingsSchema.parse({});
  }
  /** Configuration only: deleting never opens a connection just to discover what is configured. */
  vectorDeletionChoice(owner: string): VectorStoreSettings | null {
    const settings = this.vectorStoreSettings(owner);
    return settings.vectorsIn === "qdrant" || settings.vectorsIn === "chroma" ? settings : null;
  }
  /** A pending delete cannot be undone by another index/search while the service is offline. */
  private vectorsWaiting(owner: string): boolean {
    const exists = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='your_data_deletes'").get();
    if (!exists) return false;
    const rows = this.db.prepare("SELECT data FROM your_data_deletes WHERE scope=? AND finished=0").all(owner);
    return rows.some((row) => {
      const journal = JSON.parse(String(row.data)) as { vectors?: unknown; done: string[] };
      return journal.vectors && !journal.done.includes("vectors");
    });
  }
  /** Replays only against the current matching destination; never resolves a removed service's key. */
  async clearSelectedVectors(scope: string, owner: string, input: VectorStoreSettings): Promise<number | null> {
    const saved = VectorStoreSettingsSchema.parse(input);
    if (JSON.stringify(saved) !== JSON.stringify(this.vectorStoreSettings(owner))) return null;
    if (!this.vectors.clearOwner) throw new Error("The selected external vector store is unavailable; its cleanup is still pending");
    return this.withVectors(scope, () => this.vectors.clearOwner!(scope), true);
  }
  private async withVectors<T>(owner: string, operation: () => Promise<T>, cleanup = false): Promise<T> {
    const previous = this.vectorWork.get(owner);
    let release!: () => void;
    const next = new Promise<void>((resolve) => { release = resolve; });
    this.vectorWork.set(owner, next);
    try {
      await previous;
      if (!cleanup && this.vectorsWaiting(owner)) throw new Error("External vector cleanup is pending; meaning indexing waits until it finishes");
      return await operation();
    } finally {
      release();
      if (this.vectorWork.get(owner) === next) this.vectorWork.delete(owner);
    }
  }
  /**
   * Moves where new vectors are written. The change takes at once, so the owner sees a refusal now
   * rather than after a long reading; nothing is deleted from the place they were in before, and
   * the new place fills up the next time the knowledge base is read.
   */
  chooseVectorStore(owner: string, input: unknown): { settings: VectorStoreSettings; backend: string; note: string } {
    this.store.profiles.requireOwner("Where document meaning vectors are kept");
    const settings = VectorStoreSettingsSchema.parse({ ...this.vectorStoreSettings(owner), ...(input as object) });
    const remote = this.vectorServiceDependencies ? { owner, dependencies: this.vectorServiceDependencies } : undefined;
    const chosen = chooseVectorStore(settings, new SqliteVectors(this.db), remote);
    this.store.save("settings", owner, "vector-store", settings);
    if (this.vectors !== chosen.backend) this.vectors.close?.();
    this.vectors = chosen.backend;
    this.backendNote = chosen.note;
    return { settings, backend: chosen.backend.name, note: chosen.note };
  }
  private createIndex(): boolean {
    const available = this.db.prepare("PRAGMA compile_options").all()
      .some((row) => String(row.compile_options).toUpperCase() === "ENABLE_FTS5");
    if (!available) return false;
    try {
      this.db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS kb_search USING fts5(chunk_text, tokenize='unicode61 remove_diacritics 2')");
      return true;
    } catch { return false; }
  }

  /** The reader for this owner's passages, or nothing when no connected model can read them. */
  embeddings(owner: string): CachedEmbeddings | null {
    const adapter = this.embeddingSources.reader(owner, this.embeddingCall);
    return adapter ? new CachedEmbeddings(adapter, this.cache, this.ledger) : null;
  }
  meaningSearchReady(owner: string): boolean { return this.embeddings(owner) !== null; }

  list(owner: string): CollectionInfo[] {
    return this.db.prepare("SELECT * FROM kb_collections WHERE owner=? ORDER BY name LIMIT 100").all(owner)
      .map((row) => this.describe(owner, row));
  }
  private describe(owner: string, row: Record<string, unknown>): CollectionInfo {
    const id = String(row.id);
    const counts = this.db.prepare(`SELECT COUNT(*) AS chunks, COUNT(DISTINCT doc_id) AS documents
      FROM kb_chunks WHERE owner=? AND collection=?`).get(owner, id);
    // Asked of whichever backend the vectors are actually in, so pointing them at another file
    // does not make every card read "0 matched by meaning" as though the reading had failed.
    let embedded = 0;
    try { embedded = this.vectors.countNow?.(owner, id) ?? 0; } catch { embedded = 0; }
    return {
      id, name: String(row.name), sources: JSON.parse(String(row.sources)) as CollectionSource[],
      model: String(row.model ?? ""), attached: Number(row.attached) === 1,
      documents: Number(counts?.documents ?? 0), chunks: Number(counts?.chunks ?? 0),
      embedded, note: String(row.note ?? ""), indexTokens: Number(row.index_tokens ?? 0),
      lastIndexedAt: row.last_indexed_at === null ? null : String(row.last_indexed_at),
      unread: this.unread(owner, id),
    };
  }
  one(owner: string, id: string): CollectionInfo {
    const row = this.db.prepare("SELECT * FROM kb_collections WHERE owner=? AND (id=? OR name=?)").get(owner, id, id);
    if (!row) throw new Error("There is no knowledge base by that name");
    return this.describe(owner, row);
  }
  view(owner: string) {
    const sources = this.embeddingSources;
    const connection = sources.connection(owner);
    return {
      collections: this.list(owner), meaningSearch: this.meaningSearchReady(owner),
      model: connection?.model ?? "",
      onThisComputer: connection?.local ?? false,
      ranked: this.ranked, backend: this.vectors.name, backendNote: this.backendNote,
      vectorStore: this.vectorStoreSettings(owner), limits: this.settings(owner),
      readingNow: [...this.latest.values()].filter((entry) => !entry.finished),
    };
  }
  /** How far the last read of a collection got, for the panel's progress line. */
  progress(id: string): IndexProgress | null { return this.latest.get(id) ?? null; }

  create(owner: string, input: unknown): CollectionInfo {
    const value = CreateCollectionSchema.parse(input);
    if (this.db.prepare("SELECT id FROM kb_collections WHERE owner=? AND name=?").get(owner, value.name))
      throw new Error("You already have a knowledge base with that name");
    const id = randomUUID(), now = new Date().toISOString();
    this.db.prepare("INSERT INTO kb_collections(id,owner,name,sources,model,attached,note,last_indexed_at,created_at,updated_at) VALUES(?,?,?,?,'',0,'',NULL,?,?)")
      .run(id, owner, value.name, JSON.stringify(value.sources), now, now);
    return this.one(owner, id);
  }
  /** Adds a folder or a file to a collection. It is read the next time the collection is read. */
  addSource(owner: string, id: string, input: unknown): CollectionInfo {
    const source = SourceSchema.parse(input), current = this.one(owner, id);
    if (current.sources.some((entry) => entry.kind === source.kind && entry.path === source.path)) return current;
    if (current.sources.length >= maximumSources) throw new Error(`A knowledge base holds up to ${maximumSources} folders or files`);
    return this.saveSources(owner, current.id, [...current.sources, source]);
  }
  async removeSource(owner: string, id: string, path: string): Promise<CollectionInfo> {
    const current = this.one(owner, id);
    const kept = current.sources.filter((entry) => entry.path !== path);
    const info = this.saveSources(owner, current.id, kept);
    await this.forgetDocument(owner, current.id, path);
    this.db.prepare("DELETE FROM kb_documents WHERE owner=? AND collection=? AND doc_id=?").run(owner, current.id, path);
    return info;
  }
  private saveSources(owner: string, id: string, sources: CollectionSource[]): CollectionInfo {
    this.db.prepare("UPDATE kb_collections SET sources=?, updated_at=? WHERE owner=? AND id=?")
      .run(JSON.stringify(sources), new Date().toISOString(), owner, id);
    return this.one(owner, id);
  }
  /** Puts a collection in front of every task, the way the document library already can be. */
  attach(owner: string, id: string, on: boolean): CollectionInfo {
    const current = this.one(owner, id);
    this.db.prepare("UPDATE kb_collections SET attached=?, updated_at=? WHERE owner=? AND id=?")
      .run(on ? 1 : 0, new Date().toISOString(), owner, current.id);
    return this.one(owner, current.id);
  }
  async remove(owner: string, id: string): Promise<{ removed: string }> {
    const current = this.one(owner, id);
    this.clearChunks(owner, current.id);
    await this.vectors.removeCollection(owner, current.id);
    this.db.prepare("DELETE FROM kb_documents WHERE owner=? AND collection=?").run(owner, current.id);
    this.db.prepare("DELETE FROM kb_collections WHERE owner=? AND id=?").run(owner, current.id);
    this.latest.delete(current.id);
    return { removed: current.id };
  }
  private clearChunks(owner: string, collection: string): void {
    if (this.ranked) this.db.prepare("DELETE FROM kb_search WHERE rowid IN (SELECT row_id FROM kb_chunks WHERE owner=? AND collection=?)")
      .run(owner, collection);
    this.db.prepare("DELETE FROM kb_chunks WHERE owner=? AND collection=?").run(owner, collection);
  }
  private async forgetDocument(owner: string, collection: string, docId: string): Promise<void> {
    this.forgetChunkRows(owner, collection, docId);
    await this.vectors.removeDocument(owner, collection, docId);
  }
  /** The passages of one document dropped from the database; the vectors are dealt with separately. */
  private forgetChunkRows(owner: string, collection: string, docId: string): void {
    if (this.ranked) this.db.prepare(`DELETE FROM kb_search WHERE rowid IN
      (SELECT row_id FROM kb_chunks WHERE owner=? AND collection=? AND doc_id=?)`).run(owner, collection, docId);
    this.db.prepare("DELETE FROM kb_chunks WHERE owner=? AND collection=? AND doc_id=?").run(owner, collection, docId);
  }

  /** Every file a collection's folders and files come to, as workspace-relative paths. */
  async filesIn(owner: string, id: string): Promise<string[]> {
    return (await this.sourceFiles(owner, id)).paths;
  }
  /**
   * mac7/walk-rules: the files a collection comes to under the owner's rules. Nothing is taken from a
   * folder or file the rules keep the assistant out of — whoever asks for the reading, since what is
   * read in is read back to the assistant — and `leftOut` says so.
   */
  private async sourceFiles(owner: string, id: string): Promise<{ paths: string[]; leftOut?: string }> {
    const current = this.one(owner, id);
    if (!this.files) return { paths: [] };
    const rules = this.readRules(), found: string[] = [];
    for (const source of current.sources) {
      const path = source.kind === "file" ? source.path.replace(/^\.\//, "") : source.path.replace(/\/$/, "");
      if (source.kind === "file") { if (rules.file(path)) found.push(path); continue; }
      if (path && path !== "." && !rules.folder(path)) continue;
      await this.walk(path === "." ? "" : path, found, 0, rules);
    }
    return rules.noted({ paths: [...new Set(found)].slice(0, maximumFiles) });
  }
  /** mac7/walk-rules: the rules for what may be read into, or back out of, a knowledge base right now. */
  readRules(): WalkRules {
    return new WalkRules(this.files?.walkRules({ source: "owner" }) ?? allowAll);
  }

  /**
   * Folders the assistant writes itself, which are never the owner's own material. Set once at
   * start-up; the mirror of what is remembered is the one that uses it. Reading those back in would
   * have a knowledge base quote the assistant's own notes as though they were a document of the
   * owner's, which is a circle worth refusing rather than explaining afterwards.
   */
  skip: (path: string) => boolean = () => false;
  private async walk(folder: string, found: string[], depth: number, rules: WalkRules): Promise<void> {
    if (depth > 4 || found.length >= maximumFiles || !this.files) return;
    const listing = await this.files.list(folder || ".", rules).catch(() => ({ entries: [] as { name: string; type: string }[] }));
    for (const entry of listing.entries) {
      const path = folder ? `${folder}/${entry.name}` : entry.name;
      if (this.skip(path)) continue;
      if (entry.type === "directory") await this.walk(path, found, depth + 1, rules);
      else if (readableFile(path) && rules.file(path)) found.push(path);
    }
  }

  /**
   * A fact card written into a collection and indexed exactly like a passage from a file, so a
   * search finds it the same way and an answer can cite it. The card's own title is what a citation
   * shows; `source` says where it came from, which for a card from a conversation is that turn.
   */
  addCard(
    owner: string, collection: string, card: { title: string; body: string; source?: string },
  ): { collection: string; docId: string; chunks: number } {
    const current = this.one(owner, collection);
    const docId = `card:${textFingerprint(`${card.title}\n${card.body}`, "card")}`;
    const text = `# ${card.title.trim()}\n\n${card.body.trim()}${card.source ? `\n\nNoted from: ${card.source.trim()}` : ""}`;
    this.forgetChunkRows(owner, current.id, docId);
    const chunks = chunkDocument({ key: docId, title: card.title.trim().slice(0, 200), text, markdown: true });
    this.writeChunks(owner, current.id, docId, chunks);
    this.noteDocument(owner, current.id, docId, textFingerprint(text, "file"), "");
    // The card is searchable by its words at once. Comparing it by meaning waits for the next
    // reading of the collection or the nightly pass, so accepting a suggestion never stalls.
    return { collection: current.id, docId, chunks: chunks.length };
  }

  /**
   * One document put into a collection from words already read elsewhere — a knowledge base brought
   * back from a saved copy, or a picture somebody described. It is cut and stored exactly as a file
   * from the workspace is, so a search finds it and cites it the same way.
   */
  putDocument(
    owner: string, collection: string, document: { docId: string; title: string; text: string },
  ): { collection: string; docId: string; chunks: number } {
    const current = this.one(owner, collection);
    this.forgetChunkRows(owner, current.id, document.docId);
    const chunks = chunkDocument({ key: document.docId, title: document.title.slice(0, 200), text: document.text, markdown: true });
    this.writeChunks(owner, current.id, document.docId, chunks);
    this.noteDocument(owner, current.id, document.docId, textFingerprint(document.text, "file"), "");
    return { collection: current.id, docId: document.docId, chunks: chunks.length };
  }

  /** The files of this collection that could not be read, with the reason for each. */
  unread(owner: string, collection: string): { file: string; reason: string }[] {
    return this.db.prepare("SELECT doc_id, reason FROM kb_documents WHERE owner=? AND collection=? AND reason<>'' ORDER BY doc_id LIMIT 200")
      .all(owner, collection).map((row) => ({ file: String(row.doc_id), reason: String(row.reason) }));
  }

  /**
   * Reads a collection again: every file cut into passages, then the passages a connected model has
   * not already read turned into lists of numbers. A file whose contents have not changed since the
   * last read keeps the passages it already has, so reading a large folder again is quick. Progress
   * is reported after each file, so a large folder shows movement rather than a frozen button.
   */
  async reindex(
    owner: string, id: string,
    onProgress: (progress: IndexProgress) => void = () => undefined,
    signal: AbortSignal = AbortSignal.timeout(600000), runId?: string,
  ): Promise<IndexProgress> {
    const current = this.one(owner, id);
    const { paths, leftOut } = await this.sourceFiles(owner, current.id); // mac7/walk-rules
    let progress: IndexProgress = { event: "knowledge.index.progress", collection: current.id, name: current.name,
      files: paths.length, filesDone: 0, chunks: 0, embedded: 0, unchanged: 0, tokens: 0, status: "Reading your files", finished: false };
    const report = (next: Partial<IndexProgress>) => { progress = { ...progress, ...next }; this.latest.set(current.id, progress); onProgress(progress); };
    report({});
    await this.forgetMissing(owner, current.id, paths);
    for (const path of paths) {
      signal.throwIfAborted();
      const read = await this.readOneFile(owner, current.id, path);
      report({ filesDone: progress.filesDone + 1, chunks: progress.chunks + read.chunks,
        unchanged: progress.unchanged + (read.unchanged ? 1 : 0) });
    }
    const meaning = await this.embedCollection(owner, current.id, signal, runId);
    // A file too large, or one no reader could turn into text, is named rather than passed over in
    // silence, so the owner can see why a folder came out smaller than they expected.
    const unread = this.unread(owner, current.id);
    const unreadNote = unread.length ? `${unread.length} file${unread.length === 1 ? "" : "s"} could not be read; open the knowledge base to see which.` : "";
    const note = [meaning.note, unreadNote, leftOut ?? ""].filter(Boolean).join(" ");
    report({ embedded: meaning.embedded, tokens: meaning.tokens, status: note || "Ready", finished: true,
      ...(meaning.error ? { error: meaning.error } : {}) });
    this.db.prepare(`UPDATE kb_collections SET last_indexed_at=?, model=?, note=?, updated_at=?,
        index_tokens=index_tokens+? WHERE owner=? AND id=?`)
      .run(new Date().toISOString(), meaning.model, note, new Date().toISOString(), meaning.tokens, owner, current.id);
    return progress;
  }
  /** Passages of files the collection no longer points at are dropped before anything is read. */
  private async forgetMissing(owner: string, collection: string, paths: string[]): Promise<void> {
    const wanted = new Set(paths);
    // Cards the owner accepted have no file behind them, so a reading of the folders leaves them be.
    const gone = this.db.prepare("SELECT doc_id FROM kb_documents WHERE owner=? AND collection=?").all(owner, collection)
      .map((row) => String(row.doc_id)).filter((docId) => !wanted.has(docId) && !docId.startsWith("card:"));
    for (const docId of gone) {
      await this.forgetDocument(owner, collection, docId);
      this.db.prepare("DELETE FROM kb_documents WHERE owner=? AND collection=? AND doc_id=?").run(owner, collection, docId);
    }
  }
  /** One file: left alone when its contents have not changed, otherwise read again from scratch. */
  private async readOneFile(owner: string, collection: string, path: string): Promise<{ chunks: number; unchanged: boolean }> {
    const opened = await this.fileBytes(path);
    if (!opened.bytes) {
      await this.forgetDocument(owner, collection, path);
      this.noteDocument(owner, collection, path, "", opened.reason);
      return { chunks: 0, unchanged: false };
    }
    const hash = textFingerprint(opened.bytes.toString("latin1"), "file");
    const before = this.db.prepare("SELECT file_hash, reason FROM kb_documents WHERE owner=? AND collection=? AND doc_id=?")
      .get(owner, collection, path);
    const held = Number(this.db.prepare("SELECT COUNT(*) AS n FROM kb_chunks WHERE owner=? AND collection=? AND doc_id=?")
      .get(owner, collection, path)?.n ?? 0);
    if (before && String(before.file_hash) === hash && !String(before.reason) && held) return { chunks: held, unchanged: true };
    const read = tryReadDocument(opened.bytes, path, { byteLimit: maximumFileBytes });
    await this.forgetDocument(owner, collection, path);
    if (!read.document || !read.document.text.trim()) {
      this.noteDocument(owner, collection, path, hash,
        read.reason || read.document?.limits[0] || "No readable text was found in this file.");
      return { chunks: 0, unchanged: false };
    }
    const title = path.split("/").pop() ?? path;
    // Reader output always carries its shape as Markdown headings and page markers, so it is cut at
    // those boundaries and every passage keeps the page, slide or sheet it came from.
    const chunks = chunkDocument({ key: path, title, text: read.document.text, markdown: true });
    this.writeChunks(owner, collection, path, chunks);
    this.noteDocument(owner, collection, path, hash, read.document.limits.join(" "));
    return { chunks: chunks.length, unchanged: false };
  }
  private noteDocument(owner: string, collection: string, docId: string, hash: string, reason: string): void {
    this.db.prepare(`INSERT OR REPLACE INTO kb_documents(owner,collection,doc_id,file_hash,reason,updated_at)
      VALUES(?,?,?,?,?,?)`).run(owner, collection, docId, hash, reason.slice(0, 300), new Date().toISOString());
  }
  /** The bytes of one workspace file, or the reason it could not be opened. */
  private async fileBytes(path: string): Promise<{ bytes: Buffer | null; reason: string }> {
    if (!this.files) return { bytes: null, reason: "Workspace files are not available in this launch." };
    try {
      const full = await this.files.checked(path);
      const info = await stat(full);
      if (!info.isFile()) return { bytes: null, reason: "That path is not a file." };
      if (info.size > maximumFileBytes)
        return { bytes: null, reason: `This file is larger than ${maximumFileBytes / 1048576} MB, so it was left out.` };
      return { bytes: await readFile(full), reason: "" };
    } catch (error) { return { bytes: null, reason: errorText(error).slice(0, 200) }; }
  }
  private writeChunks(owner: string, collection: string, docId: string, chunks: Chunk[]): void {
    for (const chunk of chunks) {
      const row = this.db.prepare(`INSERT OR REPLACE INTO kb_chunks(owner,collection,chunk_id,doc_id,doc_name,chunk_index,heading,page,chunk_text,text_hash)
        VALUES(?,?,?,?,?,?,?,?,?,?) RETURNING row_id`)
        .get(owner, collection, chunk.id, docId, chunk.title, chunk.index, chunk.headingPath.join(" › "),
          chunk.page, chunk.text, textFingerprint(chunk.text, "chunk"));
      if (this.ranked) this.db.prepare("INSERT INTO kb_search(rowid,chunk_text) VALUES(?,?)").run(Number(row?.row_id), chunk.text);
    }
  }
  /** Turns the passages that have no current list of numbers into one; the cache makes repeats free. */
  private async embedCollection(owner: string, collection: string, signal: AbortSignal, runId?: string) {
    if (this.vectorsWaiting(owner)) return { embedded: 0, model: "", tokens: 0, note: "External vector cleanup is pending. Word search works; meaning indexing waits until it finishes.", error: "cleanup-pending" };
    const reader = this.embeddings(owner);
    if (!reader) return { embedded: 0, model: "", tokens: 0, note: noEmbeddingsMessage, error: "" };
    try { await reader.prepare(signal); } catch (error) {
      return { embedded: 0, model: reader.model, tokens: 0, note: `Word search works. ${errorText(error).slice(0, 200)}`, error: "unavailable" };
    }
    const rows = this.db.prepare("SELECT chunk_id, doc_id, chunk_text, text_hash FROM kb_chunks WHERE owner=? AND collection=? LIMIT ?")
      .all(owner, collection, comfortableChunkCount);
    if (!rows.length) return { embedded: 0, model: reader.model, tokens: 0, note: "Nothing readable was found in those files", error: "" };
    const texts = rows.map((row) => String(row.chunk_text));
    const tooMuch = this.tooExpensive(owner, reader, texts);
    if (tooMuch) return { embedded: 0, model: reader.model, tokens: 0, note: tooMuch, error: "" };
    try {
      const vectors = await reader.embedFor(runId, texts, signal);
      const written = await this.withVectors(owner, () => this.vectors.upsert(owner, rows.map((row, at) => ({
        collection, docId: String(row.doc_id), chunkId: String(row.chunk_id), model: reader.vectorKey,
        vector: vectors[at] ?? new Float32Array(), textHash: String(row.text_hash),
      }))));
      return { embedded: written, model: reader.model, tokens: reader.stats.tokens, note: "", error: "" };
    } catch (error) {
      const message = errorText(error).slice(0, 200);
      return { embedded: 0, model: reader.model, tokens: reader.stats.tokens,
        note: `Word search works. Comparing by meaning failed: ${message}`, error: message };
    }
  }
  /**
   * What to say when one reading would go past the limit the owner set, or nothing when it may go
   * ahead. Only passages that have never been read count, so re-reading a folder nothing changed in
   * is always allowed however large it is. A limit of zero means no limit.
   */
  private tooExpensive(owner: string, reader: CachedEmbeddings, texts: string[]): string {
    const allowed = this.settings(owner).maxIndexTokens;
    if (allowed === 0) return "";
    const wanted = estimateTokens(reader.missing(texts));
    if (wanted <= allowed) return "";
    const where = reader.local
      ? `would ask ${reader.model} on this computer to read about ${wanted.toLocaleString("en-US")} units of text`
      : `would send about ${wanted.toLocaleString("en-US")} units of text to ${reader.model}`;
    return `Word search works. Comparing by meaning was not done: reading these files ${where}, and your `
      + `limit for one reading is ${allowed.toLocaleString("en-US")}. Point this knowledge base at fewer `
      + `files, or raise the limit.`;
  }

  /** Word ranking and meaning ranking merged, then the second pass, with a citation on every answer. */
  async search(owner: string, input: unknown, signal = AbortSignal.timeout(30000)): Promise<KnowledgeHit[]> {
    return (await this.searchWithNote(owner, input, signal)).hits;
  }
  /**
   * The same search, with the sentence a filter that matched nothing has to say. A plain list cannot
   * tell "nothing in those invoices" apart from "nothing anywhere", and the difference matters: the
   * first means the filter worked and the answer is honestly empty, and somebody has to be told that
   * rather than be handed passages from outside what they asked for.
   */
  async searchWithNote(
    owner: string, input: unknown, signal = AbortSignal.timeout(30000),
  ): Promise<{ hits: KnowledgeHit[]; note: string }> {
    const { collection, query, limit, filter } = KnowledgeSearchSchema.parse(input);
    const target = collection ? this.one(owner, collection) : null;
    const narrowing = filterIsSet(filter) ? filter : undefined;
    // mac7/walk-rules: a passage from a file the rules now keep the assistant out of is never handed back.
    const rules = this.readRules();
    const rows = this.candidateRows(owner, target?.id, query, narrowing)
      .filter((row) => passageVisible(rules, String(row.doc_id)));
    const leftOut = rules.note() ?? "";
    if (!rows.length)
      return { hits: [], note: narrowing ? nothingMatchedNote(narrowing, this.collectionWords(owner)) : leftOut };
    const hits = await this.rankRows(owner, rows, { collection, query, limit }, signal);
    // Passages survived the filter but nothing came through the ranking or the active project's own
    // list: still an honest nothing, and still not a reason to answer from outside the filter.
    if (!hits.length && narrowing) return { hits, note: nothingMatchedNote(narrowing, this.collectionWords(owner)) };
    return { hits, note: [leftOut, this.backendNote].filter(Boolean).join(" ") };
  }
  /** Every name and id a filter may have meant, so an unknown one can be named back to the owner. */
  private collectionWords(owner: string): string[] {
    return this.list(owner).flatMap((entry) => [entry.name, entry.id]);
  }
  /** Word ranking and meaning ranking merged over an already-narrowed set of passages. */
  private async rankRows(
    owner: string, rows: Record<string, unknown>[],
    asked: { collection?: string | undefined; query: string; limit: number }, signal: AbortSignal,
  ): Promise<KnowledgeHit[]> {
    const { collection, query, limit } = asked;
    const target = collection ? this.one(owner, collection) : null;
    // Wave 8: with no knowledge base named, the active project's own list narrows the search.
    const scope = collection ? null : this.projectScope(owner);
    const byId = new Map(rows.map((row) => [String(row.chunk_id), row]));
    const words = new Bm25(rows.map((row) => ({ id: String(row.chunk_id), text: String(row.chunk_text) })))
      .rank(query, candidates).map((entry) => entry.id);
    const meaning = (await this.meaningMatches(owner, target?.id, query, signal)).filter((id) => byId.has(id));
    if (!words.length && !meaning.length) return [];
    const fused = fuseRanks([words, meaning].filter((list) => list.length));
    const names = new Map(this.list(owner).map((entry) => [entry.id, entry.name]));
    const ordered = [...fused.entries()].sort((a, b) => b[1] - a[1]).slice(0, candidates)
      .map(([id, score]) => toHit(byId.get(id)!, names, score,
        words.includes(id) && meaning.includes(id) ? "both" : meaning.includes(id) ? "meaning" : "words"));
    const inScope = scope ? ordered.filter((hit) => scope.has(hit.collection) || scope.has(hit.collectionName)) : ordered;
    return this.bestFirst(owner, query, inScope, limit, signal);
  }
  /**
   * The knowledge bases the active project says to look in, by id and by name, or null when it
   * names none — then everything the person has is searched, as it always was.
   */
  private projectScope(owner: string): Set<string> | null {
    const wanted = this.store.projects.defaults(owner).knowledgeBases;
    return wanted.length ? new Set(wanted) : null;
  }
  /**
   * The passages worth ranking: narrowed by full-text search where the database offers it, and by
   * the owner's filter first. The filter goes into **both** ways of finding candidates. Putting it
   * on only the quick one would mean that whenever full-text search happened to find nothing the
   * search quietly fell back to every passage the owner has, which is the exact failure a filter
   * exists to prevent.
   */
  private candidateRows(
    owner: string, collection: string | undefined, query: string, filter?: RetrievalFilter,
  ): Record<string, unknown>[] {
    const narrow = filter
      ? filterSql(filter, this.resolveCollections(owner, filter.collections ?? []))
      : { clause: "", params: [] as string[], needsDocuments: false };
    const join = narrow.needsDocuments
      ? "LEFT JOIN kb_documents d ON d.owner=c.owner AND d.collection=c.collection AND d.doc_id=c.doc_id" : "";
    const where = collection ? "AND c.collection=?" : "";
    const scope = collection ? [owner, collection] : [owner];
    const words = query.match(/[\p{L}\p{N}]+/gu)?.slice(0, 32) ?? [];
    if (this.ranked && words.length) {
      const expression = words.map((word) => `"${word.replace(/"/g, "")}"`).join(" OR ");
      const hits = this.db.prepare(`SELECT c.* FROM kb_search JOIN kb_chunks c ON c.row_id=kb_search.rowid ${join}
        WHERE kb_search MATCH ? AND c.owner=? ${where}${narrow.clause} ORDER BY bm25(kb_search) LIMIT ?`)
        .all(expression, ...scope, ...narrow.params, candidates * 4);
      if (hits.length) return hits;
    }
    return this.db.prepare(`SELECT c.* FROM kb_chunks c ${join} WHERE c.owner=? ${where}${narrow.clause} LIMIT ?`)
      .all(...scope, ...narrow.params, 2000);
  }
  /** The ids behind the knowledge-base names a filter used; one nobody has simply resolves to none. */
  private resolveCollections(owner: string, wanted: string[]): string[] {
    const known = this.list(owner);
    return wanted.flatMap((name) => {
      const found = known.find((entry) => entry.id === name || entry.name.toLowerCase() === name.toLowerCase());
      return found ? [found.id] : [];
    });
  }
  private async meaningMatches(owner: string, collection: string | undefined, query: string, signal: AbortSignal): Promise<string[]> {
    if (this.vectorsWaiting(owner)) return [];
    const reader = this.embeddings(owner);
    if (!reader) return [];
    const asked = await reader.embed([query], signal).catch(() => null);
    if (!asked?.[0]?.length) return [];
    const collections = collection ? [collection] : this.list(owner).map((entry) => entry.id);
    const scanAtMost = this.settings(owner).compareAtMost;
    let found: Awaited<ReturnType<VectorBackend["search"]>>[];
    try { found = await Promise.all(collections.map((id) => this.vectors.search(owner, id, asked[0]!, candidates, scanAtMost, reader.vectorKey))); }
    catch (error) { this.backendNote = `Word search works. The chosen vector store could not compare by meaning: ${errorText(error).slice(0, 160)}`; return []; }
    if (this.vectors.clearOwner) this.backendNote = "";
    return found.flat().filter((match) => match.score > 0.15).sort((a, b) => b.score - a.score)
      .slice(0, candidates).map((match) => match.chunkId);
  }
  /** The second pass from wave 6, when one is set, then as many answers as the caller asked for. */
  private async bestFirst(owner: string, query: string, hits: KnowledgeHit[], limit: number, signal?: AbortSignal): Promise<KnowledgeHit[]> {
    if (!this.reranker || hits.length < 2) return hits.slice(0, limit);
    const keyed = new Map(hits.map((hit) => [`knowledge:${hit.collection}:${hit.chunkId}`, hit]));
    const ordered = await this.reranker(owner, query,
      [...keyed].map(([key, hit]) => ({ key, source: hit.documentName, text: hit.text, score: hit.score, from: "knowledge" })), signal)
      .catch(() => null);
    if (!ordered?.length) return hits.slice(0, limit);
    return ordered.flatMap((passage) => { const hit = keyed.get(passage.key); return hit ? [hit] : []; }).slice(0, limit);
  }

  /** The attached collections' best passages, numbered for citation, to put in front of a task. */
  async contextFor(owner: string, prompt: string, signal?: AbortSignal): Promise<{ text: string; sources: string[]; citations: Citation[] } | null> {
    const attached = this.list(owner).filter((entry) => entry.attached && entry.chunks > 0);
    if (!attached.length) return null;
    const query = prompt.slice(0, 500);
    const found: KnowledgeHit[] = [];
    for (const collection of attached)
      found.push(...await this.search(owner, { collection: collection.id, query, limit: 3 }, signal).catch(() => []));
    if (!found.length) return null;
    const chosen = found.sort((a, b) => b.score - a.score).slice(0, 3);
    const citations = new Citations();
    /* The knowledge base is named on every passage, not only the file inside it. A fact the owner
       accepted into a collection weeks ago has to be answerable with "this came from your
       knowledge base X", or the person cannot tell a remembered fact from a guess. */
    const blocks = chosen.map((hit) => {
      const citation = citations.add({ url: `document:${hit.collection}/${hit.documentId}`, title: namedSource(hit), quote: hit.text });
      return `[${citation.number}] From your knowledge base "${hit.collectionName}", ${citationTitle(hit)}:\n${hit.text}`;
    });
    return {
      text: `${blocks.join("\n\n")}\n\n${citations.markdown("Sources in your knowledge bases")}`,
      sources: [...new Set(chosen.map(namedSource))], citations: citations.list(),
    };
  }
}

/** The same line with the knowledge base in front of it, so the source names the collection. */
export const namedSource = (hit: KnowledgeHit): string => `${hit.collectionName} › ${citationTitle(hit)}`;
/** The one line that tells the person where a passage came from: file, heading and page. */
export function citationTitle(hit: KnowledgeHit): string {
  const parts = [hit.documentName, hit.heading, hit.page === null ? "" : `page ${hit.page}`].filter(Boolean);
  return parts.join(" › ");
}
function toHit(row: Record<string, unknown>, names: Map<string, string>, score: number, matched: KnowledgeHit["matched"]): KnowledgeHit {
  const collection = String(row.collection);
  return {
    collection, collectionName: names.get(collection) ?? collection,
    documentId: String(row.doc_id), documentName: String(row.doc_name), heading: String(row.heading ?? ""),
    page: row.page === null || row.page === undefined ? null : Number(row.page),
    chunkId: String(row.chunk_id), text: String(row.chunk_text).slice(0, passageChars),
    score: Number(score.toFixed(6)), matched,
  };
}
/** Whether this build has a reader for a file; anything else is never walked into a collection. */
export const readableFile = (path: string): boolean =>
  knownExtension(path) && readableTypes.includes(documentType(path));
