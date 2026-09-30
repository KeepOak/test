import { z } from "zod";
import { queryTables, tableFrom, type Cell, type DataColumn } from "./data-table.js";
import { nameFor, type DataTables } from "./data-tools.js";
import type { DocumentMetadata } from "./documents.js";

/**
 * p17 "Ask a spreadsheet" (Library › Documents): one read-only question over one spreadsheet in the owner's document
 * library, opened from its file in the workspace and answered in the same call. The model tools (data.load, then
 * data.query) keep a table open for one task; the window has no task, so this opens, asks and lets go at once.
 *
 * Read only, like data.query: only one SELECT or WITH question runs, over an in-memory copy, and the file is never
 * written. The file is read through the workspace's own checks (WorkspaceFiles.checked), so a folder rule that keeps a
 * path from Trunks keeps it from here too. A document that was pasted or uploaded has no file to open, and says so.
 */
export const DataAskSchema = z.object({
  document: z.string().uuid(),
  sql: z.string().trim().min(1).max(4000),
  limit: z.number().int().min(1).max(40).default(20),
}).strict();

/** The spreadsheet kinds the data readers open (src/data-table.ts `tableFrom`). */
export const askableFile = /\.(csv|tsv|json|xlsx)$/i;

export interface DataAnswer {
  document: string; table: string; columns: string[]; types: DataColumn[]; rows: Cell[][]; truncated: boolean;
}

export async function askSpreadsheet(
  deps: { documents: DocumentMetadata[]; tables: Pick<DataTables, "fromWorkspace">;
    uploadedBytes?: (id: string) => Buffer | null }, input: unknown,
): Promise<DataAnswer> {
  const wanted = DataAskSchema.parse(input);
  const doc = deps.documents.find((one) => one.id === wanted.document);
  if (!doc) throw new Error("There is no document with that id in your library.");
  const bytes = !doc.filePath ? deps.uploadedBytes?.(doc.id) : null;
  if (!doc.filePath && !bytes) throw new Error(`"${doc.name}" has no original file to open. Import the spreadsheet to ask it questions.`);
  const source = doc.filePath ?? doc.name;
  if (!askableFile.test(source)) throw new Error(`"${doc.name}" is not a spreadsheet. CSV, TSV, JSON and Excel files can be asked questions.`);
  const table = bytes ? tableFrom(nameFor(source), source, bytes) : await deps.tables.fromWorkspace(source, nameFor(source));
  const answer = queryTables([table], wanted.sql, wanted.limit);
  return { document: doc.id, table: table.name, types: table.columns, ...answer };
}
