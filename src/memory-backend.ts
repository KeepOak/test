import type { MemoryRecord } from "./memory.js";
import type { Store } from "./store.js";
import { z } from "zod";

/** Where an accepted fact was written; names a credential, never contains its value. */
export const MemoryDestinationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("built-in") }).strict(),
  z.object({ kind: z.literal("outside"), url: z.url().max(500), header: z.string().max(64).regex(/^[A-Za-z0-9-]*$/), secret: z.string().max(200).regex(/^([A-Z][A-Z0-9_]*)?$/) }).strict(),
]);
export type MemoryDestination = z.infer<typeof MemoryDestinationSchema>;
export interface MemoryWriteReceipt { destination: MemoryDestination; record: MemoryRecord }

/**
 * Where saved facts are kept. There are two places now — the app's own SQLite database, and
 * whatever outside memory service the owner has pointed Branch at instead (src/memory-provider.ts)
 * — and this describes what a place has to do, so a second one has something to be built against
 * rather than a guess. It is deliberately small: six things, all of which the existing store
 * already does.
 *
 * The contract, in full:
 *
 * - `read` gives back the fact with that identifier, or nothing. It never throws for a fact that is
 *   not there; "not there" is an answer.
 * - `list` gives back every fact for that owner, newest change first. A backend may cap how many it
 *   returns, but it must say so in its own documentation rather than silently truncating a count.
 * - `write` saves a fact under an identifier the caller chose, replacing what was there. It must
 *   keep `createdAt` from the earlier version and move `revision` on by one, so an edit can be
 *   told from a new fact. Every field of the data is stored as given, including `kind`, `layer`,
 *   `project` and the timestamps that say when a fact was true.
 * - `search` matches on the fact's words at the least. A backend that can also compare by meaning
 *   may, but it must never return a fact the reader is not allowed to see.
 * - `forget` removes one fact and says whether there was one to remove.
 * - `count` says how many facts an owner has, which is what the capacity limit is checked against.
 *
 * Every method is async: a backend that lives on this computer answers at once, and one that is an
 * outside service answers over the network, and a caller must not have to know which. Two rules
 * hold for every backend regardless. Owners never see each other's facts: every call takes an owner
 * and must scope to it. And nothing is written anywhere but this computer unless the owner has
 * asked for that plainly, by switching a memory provider on in Settings — src/memory-provider.ts is
 * exactly that: a drop-in that replaces this one rather than only sitting beside it.
 */
export interface MemoryBackend {
  /** A name for the diagnostics folder and the Memory screen, such as "this computer's database". */
  readonly name: string;
  read(owner: string, id: string): Promise<MemoryRecord | undefined>;
  list(owner: string): Promise<MemoryRecord[]>;
  write(owner: string, id: string, data: Record<string, unknown>): Promise<MemoryRecord>;
  search(owner: string, query: string, agent?: string): Promise<MemoryRecord[]>;
  forget(owner: string, id: string): Promise<boolean>;
  count(owner: string): Promise<number>;
}

/**
 * The backend Branch ships with: the app's own database, which is the same file everything else in
 * Branch uses. It is a thin wrapper, on purpose — the point of the interface is to say what the
 * store promises, not to add a layer between callers and it. Every call is synchronous underneath;
 * wrapping it as `async` costs nothing and lets it stand next to a real network-backed adapter.
 */
export class SqliteMemoryBackend implements MemoryBackend {
  readonly name = "this computer's database";
  constructor(private readonly store: Store) {}
  async read(owner: string, id: string): Promise<MemoryRecord | undefined> {
    return this.store.get("memory", owner, id) as MemoryRecord | undefined;
  }
  async list(owner: string): Promise<MemoryRecord[]> { return this.store.list("memory", owner) as MemoryRecord[]; }
  async write(owner: string, id: string, data: Record<string, unknown>): Promise<MemoryRecord> {
    return this.store.save("memory", owner, id, data) as MemoryRecord;
  }
  async search(owner: string, query: string, agent?: string): Promise<MemoryRecord[]> {
    return this.store.searchMemory(owner, query, agent) as MemoryRecord[];
  }
  async forget(owner: string, id: string): Promise<boolean> { return this.store.delete("memory", owner, id); }
  async count(owner: string): Promise<number> { return this.store.memoryCapacity(owner).count; }
}
