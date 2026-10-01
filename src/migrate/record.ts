import { z } from "zod";
import type { Store } from "../store.js";
import { ChatProvenanceSchema, MoveInSourceSchema, itemKinds, type ItemKind, type MoveInSource } from "./types.js";

/**
 * The record of what has already moved in, so nothing is brought over twice. There is one saved
 * record per assistant, kept in the settings table so a backup carries it along with the chats and
 * memory it describes: restoring a backup cannot bring the chats back while forgetting they came.
 */
const EntrySchema = z.object({
  provenance: ChatProvenanceSchema.optional(),
  kind: z.enum(itemKinds), title: z.string().max(200), target: z.string().max(200), at: z.iso.datetime(),
}).strict();
const RecordSchema = z.object({ entries: z.record(z.string().regex(/^[0-9a-f]{32}$/), EntrySchema) }).strict();
export type RecordEntry = z.infer<typeof EntrySchema>;
export const maximumRecordEntries = 20_000;

const recordId = (source: MoveInSource): string => `move-in:${MoveInSourceSchema.parse(source)}`;

export function movedIn(store: Store, owner: string, source: MoveInSource): Record<string, RecordEntry> {
  const saved = RecordSchema.safeParse(store.get("settings", owner, recordId(source))?.data ?? { entries: {} });
  return saved.success ? saved.data.entries : {};
}

/** Adds what was just brought over. The record never forgets an entry, so it refuses to grow past its cap. */
export function rememberMoved(
  store: Store, owner: string, source: MoveInSource,
  added: { key: string; kind: ItemKind; title: string; target: string; provenance?: RecordEntry["provenance"] }[],
): void {
  if (!added.length) return;
  const entries = movedIn(store, owner, source), at = new Date().toISOString();
  for (const entry of added)
    entries[entry.key] = { kind: entry.kind, title: entry.title.slice(0, 200), target: entry.target.slice(0, 200), at,
      ...(entry.provenance ? { provenance: entry.provenance } : {}) };
  if (Object.keys(entries).length > maximumRecordEntries)
    throw new Error(`Branch keeps a record of at most ${maximumRecordEntries} things brought over from one assistant`);
  store.save("settings", owner, recordId(source), RecordSchema.parse({ entries }));
}

/** How many things each assistant has already brought over, for the list of sources. */
export function movedCounts(store: Store, owner: string, source: MoveInSource): Partial<Record<ItemKind, number>> {
  const counts: Partial<Record<ItemKind, number>> = {};
  for (const entry of Object.values(movedIn(store, owner, source))) counts[entry.kind] = (counts[entry.kind] ?? 0) + 1;
  return counts;
}
