import { z } from "zod";
import type { Message } from "./contracts.js";
import { MemoryDataSchema, type MemoryRecord } from "./memory.js";
import { normaliseFact } from "./memory-hygiene.js";
import type { Store } from "./store.js";

/**
 * Taking memory and conversations out of the app, and putting facts back in. Facts travel as JSON
 * Lines — one fact per line — because that is what other assistants read and write, and because a
 * half-written file still gives back every complete line. Bringing facts back in never makes a
 * second copy of something already saved.
 */
export const maximumImportBytes = 16 * 1024 * 1024;
const LineSchema = z.object({
  id: z.string().min(1).max(200),
  data: MemoryDataSchema,
  createdAt: z.iso.datetime().optional(),
  updatedAt: z.iso.datetime().optional(),
  revision: z.number().int().positive().optional(),
}).strict();
export interface ImportReport { imported: number; duplicates: number; unchanged: number; skipped: { line: number; reason: string }[] }

/** One fact per line, newest first, exactly as the Memory view lists them. */
export function memoryJsonl(records: MemoryRecord[]): string {
  return records.map((record) => JSON.stringify({
    id: record.id, data: record.data, createdAt: record.createdAt, updatedAt: record.updatedAt, revision: record.revision,
  })).join("\n") + (records.length ? "\n" : "");
}
/** Reads the lines that are whole and well-formed, and says which ones were not. */
export function parseMemoryJsonl(text: string): { records: z.infer<typeof LineSchema>[]; skipped: { line: number; reason: string }[] } {
  if (Buffer.byteLength(text) > maximumImportBytes) throw new Error("That file is larger than 16 MB");
  const records: z.infer<typeof LineSchema>[] = [], skipped: { line: number; reason: string }[] = [];
  for (const [at, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line) continue;
    if (records.length + skipped.length >= 2000) { skipped.push({ line: at + 1, reason: "Only 2000 lines are read at a time" }); break; }
    try { records.push(LineSchema.parse(JSON.parse(line) as unknown)); }
    catch { skipped.push({ line: at + 1, reason: "This line is not a saved fact" }); }
  }
  return { records, skipped };
}
/**
 * rw4: the desktop app's Save dialog writes an export only when every line is a saved fact, and writes the facts as
 * read back, one per line. Unlike an import it is all or nothing and has no line cap: it is the owner's whole memory.
 */
export function exportedMemoryLines(text: string): string {
  if (Buffer.byteLength(text, "utf8") > maximumImportBytes) throw new Error("That file is larger than 16 MB");
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  const records = lines.map((line, at) => {
    try { return LineSchema.parse(JSON.parse(line) as unknown); }
    catch { throw new Error(`Line ${at + 1} is not a saved fact`); }
  });
  return records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : "");
}
/** The wording, subject and detail together: two facts that agree on all three are the same fact. */
export function factFingerprint(data: { text?: unknown; entity?: unknown; attribute?: unknown }): string {
  return [data.entity, data.attribute, data.text].map((part) => normaliseFact(String(part ?? ""))).join("|");
}

export class MemoryTransfer {
  constructor(private readonly store: Store) {}
  export(owner: string): string {
    return memoryJsonl(this.store.list("memory", owner) as MemoryRecord[]);
  }
  /** Adds the facts that are new. A fact already saved under any identifier is counted, not copied. */
  import(owner: string, text: string): ImportReport {
    const { records, skipped } = parseMemoryJsonl(text);
    const existing = this.store.list("memory", owner) as MemoryRecord[];
    const seen = new Map(existing.map((record) => [factFingerprint(record.data), record.id]));
    const ids = new Set(existing.map((record) => record.id));
    let imported = 0, duplicates = 0, unchanged = 0;
    for (const record of records) {
      const fingerprint = factFingerprint(record.data);
      if (ids.has(record.id)) { unchanged++; continue; }
      if (seen.has(fingerprint)) { duplicates++; continue; }
      this.store.save("memory", owner, record.id, record.data);
      ids.add(record.id); seen.set(fingerprint, record.id); imported++;
    }
    return { imported, duplicates, unchanged, skipped };
  }
}

/** One conversation written out as Markdown, ready to paste anywhere or keep as a file. */
export function conversationMarkdown(meta: { sessionId: string; createdAt?: string; title?: string }, messages: Message[]): string {
  const speaker: Record<string, string> = { user: "You", assistant: "Assistant", system: "Setup", tool: "Tool result" };
  const lines = [`# ${meta.title || "Conversation"}`, "", `Conversation ${meta.sessionId}`];
  if (meta.createdAt) lines.push(`Started ${meta.createdAt}`);
  for (const message of messages.slice(0, 2000)) {
    if (message.role === "system") continue;
    lines.push("", `## ${speaker[message.role] ?? message.role}`, "", message.content.slice(0, 20000) || "_(no words)_");
    for (const call of message.toolCalls ?? []) lines.push("", `_used ${call.name}_`);
  }
  return lines.join("\n") + "\n";
}
