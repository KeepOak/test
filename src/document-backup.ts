import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { z } from "zod";
import { documentBytesLimit } from "./documents.js";

/** Originals and indexed passages travel together; the search index is rebuilt from those passages. */
export const documentBackupTables = ["documents", "document_chunks", "document_uploads"] as const;
const owner = z.string().min(1);
const document = z.object({ id: z.uuid(), owner, name: z.string().min(1), file_path: z.string().nullable(),
  file_type: z.string(), file_size: z.number().int().min(0).max(documentBytesLimit),
  status: z.enum(["indexed", "needs_helper", "failed"]), note: z.string(), created_at: z.iso.datetime(), updated_at: z.iso.datetime() }).strict();
const original = z.object({ document_id: z.uuid(), owner, bytes: z.string() }).strict();
const passage = z.object({ chunk_id: z.number().int().min(1), document_id: z.uuid(), owner,
  chunk_index: z.number().int().min(0), chunk_text: z.string(), embedding: z.string().nullable() }).strict();

/** Reject malformed, oversized or cross-owner originals before restore changes anything. */
export function validateDocumentBackup(tables: Record<string, unknown>): void {
  const documents = z.array(document).parse(tables.documents ?? []);
  const owners = new Map(documents.map((row) => [row.id, row]));
  if (owners.size !== documents.length) throw new Error("Backup repeats a document id");
  const uploaded = new Set<string>(), chunks = new Set<number>();
  for (const row of z.array(original).parse(tables.document_uploads ?? [])) {
    const head = owners.get(row.document_id);
    if (!head || head.owner !== row.owner) throw new Error("Backup original does not belong to its document owner");
    if (uploaded.has(row.document_id)) throw new Error("Backup repeats a document original");
    uploaded.add(row.document_id);
    decodeDocumentBytes(row.bytes); // file_size can describe separately pasted text; the original retains its own exact bytes
  }
  for (const row of z.array(passage).parse(tables.document_chunks ?? [])) {
    if (owners.get(row.document_id)?.owner !== row.owner) throw new Error("Backup passage does not belong to its document owner");
    if (chunks.has(row.chunk_id)) throw new Error("Backup repeats a passage id");
    chunks.add(row.chunk_id);
    if (row.embedding !== null && decodeDocumentBytes(row.embedding).length % 4 !== 0)
      throw new Error("Backup document embedding has an invalid size");
  }
}
function decodeDocumentBytes(value: string): Buffer {
  if (value.length > Math.ceil(documentBytesLimit / 3) * 4) throw new Error("Backup document original exceeds its byte limit");
  const bytes = Buffer.from(value, "base64");
  if (!bytes.length || bytes.length > documentBytesLimit || bytes.toString("base64") !== value)
    throw new Error("Backup document bytes must be canonical base64");
  return bytes;
}
export function encodeDocumentCell(table: string, field: string, value: unknown): string | number | null {
  if ((table === "document_uploads" && field === "bytes") || (table === "document_chunks" && field === "embedding"))
    return value === null ? null : Buffer.from(value as Uint8Array).toString("base64");
  return typeof value === "bigint" ? Number(value) : value as string | number | null;
}
export function restoredDocumentCell(table: string, field: string, value: string | number | null | undefined): SQLInputValue {
  if (value !== null && value !== undefined && ((table === "document_uploads" && field === "bytes") || (table === "document_chunks" && field === "embedding")))
    return decodeDocumentBytes(String(value));
  return value ?? null;
}
/** A Store restored before its Library is constructed still gets the same tables. */
export function ensureDocumentBackupTables(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL,
    file_path TEXT, file_type TEXT NOT NULL, file_size INTEGER NOT NULL, status TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS document_chunks(chunk_id INTEGER PRIMARY KEY, document_id TEXT NOT NULL,
    owner TEXT NOT NULL, chunk_index INTEGER NOT NULL, chunk_text TEXT NOT NULL, embedding BLOB);
    CREATE TABLE IF NOT EXISTS document_uploads(document_id TEXT PRIMARY KEY, owner TEXT NOT NULL, bytes BLOB NOT NULL);`);
}
export function rebuildDocumentSearch(db: DatabaseSync): void {
  if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='document_chunks'").get()) return;
  if (!db.prepare("PRAGMA compile_options").all().some((row) => String(row.compile_options).toUpperCase() === "ENABLE_FTS5")) return;
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS document_search USING fts5(chunk_text, tokenize='unicode61 remove_diacritics 2');
    DELETE FROM document_search;
    INSERT INTO document_search(rowid,chunk_text) SELECT chunk_id,chunk_text FROM document_chunks;`);
}
