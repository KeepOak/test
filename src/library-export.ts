import type { DatabaseSync } from "node:sqlite";
import { joinPassages } from "./documents.js";
import { zipName, type ZipEntry } from "./zip-write.js";

/** A person's Library, including directly imported originals that never belonged to a conversation. */
export function libraryExport(db: DatabaseSync, owner: string, byteLimit: number): ZipEntry[] {
  const entries: ZipEntry[] = [], documents = [];
  let bytes = 0;
  const add = (name: string, data: Buffer): void => {
    bytes += data.length;
    if (bytes > byteLimit) throw new Error("Your Library is larger than one export can hold. Nothing was saved.");
    entries.push({ name, data });
  };
  const rows = db.prepare(`SELECT d.*, u.bytes FROM documents d LEFT JOIN document_uploads u
    ON u.document_id=d.id AND u.owner=d.owner WHERE d.owner=? ORDER BY d.created_at,d.id`).iterate(owner);
  for (const row of rows) {
    const { bytes: original, ...metadata } = row;
    const id = String(row.id), name = originalName(String(row.name));
    const source = original === null ? null : zipName(`library/${id}/original/${name}`);
    documents.push({ ...metadata, original: source });
    if (original !== null) add(source!, Buffer.from(original as Uint8Array));
    const passages = db.prepare("SELECT chunk_text FROM document_chunks WHERE document_id=? AND owner=? ORDER BY chunk_index")
      .all(id, owner).map((passage) => String(passage.chunk_text));
    if (passages.length) add(`library/${id}/text.txt`, Buffer.from(joinPassages(passages), "utf8"));
  }
  add("library/documents.json", Buffer.from(JSON.stringify(documents, null, 2), "utf8"));
  return entries;
}
function originalName(name: string): string {
  const last = name.split(/[\\/]/).at(-1) ?? "";
  return !last || last === "." || last === ".." ? "original" : last;
}
