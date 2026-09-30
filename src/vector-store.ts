import type { DatabaseSync } from "node:sqlite";
import { cosine, packVector, unpackVector } from "./document-embeddings.js";

/**
 * Where the lists of numbers live. Today they sit in the same SQLite file as everything else and
 * the comparison is done here, in plain TypeScript: for a personal library — up to roughly fifty
 * thousand passages in one collection — that is fast enough and needs nothing installed. The
 * interface below is deliberately small so a future adapter that talks to a vector database over
 * HTTP can take its place without anything above it changing; see docs/configuration.md.
 */
export interface VectorRecord {
  collection: string;
  docId: string;
  chunkId: string;
  model: string;
  vector: Float32Array;
  /** Fingerprint of the passage this came from, so an unchanged passage is never read again. */
  textHash: string;
}
export interface VectorMatch { docId: string; chunkId: string; score: number }
/** The size beyond which comparing here stops being the right answer; said plainly in the docs. */
export const comfortableChunkCount = 50_000;

export interface VectorBackend {
  /** A short name for the panel and the docs, such as "this computer". */
  readonly name: string;
  upsert(owner: string, records: VectorRecord[]): Promise<number>;
  /** Everything indexed for one document in one collection. */
  removeDocument(owner: string, collection: string, docId: string): Promise<number>;
  removeCollection(owner: string, collection: string): Promise<number>;
  /**
   * The closest passages to a question, best first. `scanAtMost` is how many stored passages one
   * comparison may look at, so the work never grows without a ceiling; a backend that does the
   * comparison itself may ignore it. When `model` is supplied, it is a route/model/version identity;
   * an adapter must restrict results to that identity and the query's dimensions.
   */
  search(owner: string, collection: string, query: Float32Array, limit: number, scanAtMost?: number, model?: string): Promise<VectorMatch[]>;
  count(owner: string, collection?: string): Promise<number>;
  /** Which passages of a collection are already read, by fingerprint, so re-reading is free. */
  fingerprints(owner: string, collection: string, model: string): Promise<Map<string, string>>;
  /**
   * The same count as `count`, answered without waiting, for the panel that draws its cards in one
   * pass. A backend that cannot answer without waiting leaves this out and the card simply says
   * nothing about how many passages are compared by meaning, rather than showing a wrong zero.
   */
  countNow?(owner: string, collection: string): number | null;
  /**
   * Lets go of whatever the backend was holding — a file handle, a connection. Only a backend that
   * opened something of its own has one; the shipped one shares Branch's database and must not
   * close it, so it does nothing unless it was given a file of its own to look after.
   */
  close?(): void;
}

/** The backend that ships: one table in the database Branch already keeps, compared here. */
export class SqliteVectors implements VectorBackend {
  constructor(
    private readonly db: DatabaseSync, readonly name = "this computer",
    /** True only when this object opened the file itself and is the one that must close it. */
    private readonly ownsDatabase = false,
  ) {
    this.db.exec(`CREATE TABLE IF NOT EXISTS vectors(owner TEXT NOT NULL, collection TEXT NOT NULL,
      doc_id TEXT NOT NULL, chunk_id TEXT NOT NULL, model TEXT NOT NULL, dims INTEGER NOT NULL,
      blob BLOB NOT NULL, text_hash TEXT NOT NULL, PRIMARY KEY(owner,collection,chunk_id));
      CREATE INDEX IF NOT EXISTS vectors_collection ON vectors(owner,collection);
      CREATE INDEX IF NOT EXISTS vectors_document ON vectors(owner,collection,doc_id);`);
  }
  async upsert(owner: string, records: VectorRecord[]): Promise<number> {
    const statement = this.db.prepare("INSERT OR REPLACE INTO vectors VALUES(?,?,?,?,?,?,?,?)");
    let written = 0;
    for (const record of records) {
      if (!record.vector.length) continue;
      statement.run(owner, record.collection, record.docId, record.chunkId, record.model,
        record.vector.length, packVector(record.vector), record.textHash);
      written++;
    }
    return written;
  }
  async removeDocument(owner: string, collection: string, docId: string): Promise<number> {
    return Number(this.db.prepare("DELETE FROM vectors WHERE owner=? AND collection=? AND doc_id=?")
      .run(owner, collection, docId).changes ?? 0);
  }
  async removeCollection(owner: string, collection: string): Promise<number> {
    return Number(this.db.prepare("DELETE FROM vectors WHERE owner=? AND collection=?").run(owner, collection).changes ?? 0);
  }
  /**
   * The passages of the collection compared with the question, best first, never more than
   * `scanAtMost` of them so one search can never grow without a ceiling. Lists of different
   * lengths — a collection read by two different models — score zero rather than throwing.
   */
  async search(
    owner: string, collection: string, query: Float32Array, limit: number, scanAtMost = comfortableChunkCount, model?: string,
  ): Promise<VectorMatch[]> {
    if (!query.length) return [];
    const ceiling = Math.max(1, Math.min(scanAtMost, comfortableChunkCount));
    const rows = model
      ? this.db.prepare("SELECT doc_id, chunk_id, blob FROM vectors WHERE owner=? AND collection=? AND model=? AND dims=? LIMIT ?")
        .all(owner, collection, model, query.length, ceiling)
      : this.db.prepare("SELECT doc_id, chunk_id, blob FROM vectors WHERE owner=? AND collection=? AND dims=? LIMIT ?")
        .all(owner, collection, query.length, ceiling);
    return rows
      .map((row) => ({
        docId: String(row.doc_id), chunkId: String(row.chunk_id),
        score: Number(cosine(query, unpackVector(row.blob as Uint8Array)).toFixed(6)),
      }))
      .filter((match) => match.score > 0)
      .sort((a, b) => b.score - a.score || a.chunkId.localeCompare(b.chunkId))
      .slice(0, Math.max(1, limit));
  }
  async count(owner: string, collection?: string): Promise<number> {
    const row = collection
      ? this.db.prepare("SELECT COUNT(*) AS n FROM vectors WHERE owner=? AND collection=?").get(owner, collection)
      : this.db.prepare("SELECT COUNT(*) AS n FROM vectors WHERE owner=?").get(owner);
    return Number(row?.n ?? 0);
  }
  close(): void { if (this.ownsDatabase) try { this.db.close(); } catch { /* already closed */ } }
  countNow(owner: string, collection: string): number {
    return Number(this.db.prepare("SELECT COUNT(*) AS n FROM vectors WHERE owner=? AND collection=?")
      .get(owner, collection)?.n ?? 0);
  }
  async fingerprints(owner: string, collection: string, model: string): Promise<Map<string, string>> {
    return new Map(this.db.prepare("SELECT chunk_id, text_hash FROM vectors WHERE owner=? AND collection=? AND model=?")
      .all(owner, collection, model).map((row) => [String(row.chunk_id), String(row.text_hash)]));
  }
}

/**
 * The best passages for one question, worked out here rather than by a database. Kept separate
 * from the backend so the same hand-checkable comparison can be used on any list of vectors.
 */
export function topK(query: Float32Array, entries: { id: string; vector: Float32Array }[], limit: number): { id: string; score: number }[] {
  return entries
    .map((entry) => ({ id: entry.id, score: Number(cosine(query, entry.vector).toFixed(6)) }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, Math.max(0, limit));
}
