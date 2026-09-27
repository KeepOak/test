import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Store } from "../store.js";

/**
 * R17-B: the one list of things waiting for the owner's yes, and of everything the owner has
 * already said yes or no to.
 *
 * Nothing lasting is made by itself. A suggestion, a proposal from the assistant, a procedure that
 * wants to start, a step that asks first, and an escalation all wait here until the owner answers in
 * Inbox › Needs you. Each entry carries a fingerprint of what it is, so a "no" is remembered for good
 * and the same thing is never offered again (the idea of a dedup key that dismissals keep blocked is
 * from Hermes Agent's `cron/suggestions.py`, MIT; this is an independent implementation).
 */
export const entryKinds = ["schedule", "order", "procedure", "instruction", "start", "step", "escalation"] as const;
export type EntryKind = (typeof entryKinds)[number];
export type EntryStatus = "pending" | "accepted" | "dismissed";

export interface LedgerEntry {
  id: string;
  kind: EntryKind;
  fingerprint: string;
  title: string;
  /** What saying yes would do, in one plain sentence. */
  detail: string;
  payload: Record<string, unknown>;
  status: EntryStatus;
  /** Who asked: a suggestion, the assistant, a procedure, or the owner proposing a change to their own. */
  from: "suggestion" | "assistant" | "procedure" | "order" | "owner";
  createdAt: string;
  decidedAt: string | null;
}

const EntrySchema = z.object({
  id: z.string(), kind: z.enum(entryKinds), fingerprint: z.string(), title: z.string(), detail: z.string(),
  payload: z.record(z.string(), z.unknown()), status: z.enum(["pending", "accepted", "dismissed"]),
  from: z.enum(["suggestion", "assistant", "procedure", "order", "owner"]), createdAt: z.string(), decidedAt: z.string().nullable(),
}).strict();
const BookSchema = z.object({ entries: z.array(EntrySchema).default([]), refused: z.array(z.string()).default([]) }).strict();
type Book = z.infer<typeof BookSchema>;

const bookKey = "autonomy-ledger";
/** At most this many questions wait at once; a new one past it is not added (and says so). */
export const maxPending = 20;
const maxKept = 300;
const maxRefused = 2000;

/** A stable fingerprint of what something is, so the same idea regenerated later matches. */
export function fingerprintOf(...parts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 24);
}

export class Ledger {
  constructor(private readonly store: Store, private readonly owner: string, private readonly now: () => Date = () => new Date()) {}

  private read(): Book {
    const saved = BookSchema.safeParse(this.store.get("settings", this.owner, bookKey)?.data ?? {});
    return saved.success ? saved.data : { entries: [], refused: [] };
  }
  private write(book: Book): void {
    // Answered entries go first when the list is full; pending ones are never dropped.
    const answered = book.entries.filter((e) => e.status !== "pending");
    const over = Math.max(0, book.entries.length - maxKept);
    const drop = new Set(answered.slice(0, over).map((e) => e.id));
    this.store.save("settings", this.owner, bookKey, {
      entries: book.entries.filter((e) => !drop.has(e.id)), refused: book.refused.slice(-maxRefused),
    });
  }

  list(status: EntryStatus | "all" = "pending"): LedgerEntry[] {
    const entries = this.read().entries;
    return (status === "all" ? entries : entries.filter((e) => e.status === status)).slice().reverse();
  }

  get(id: string): LedgerEntry | undefined { return this.read().entries.find((e) => e.id === id); }

  /** True when the owner already answered this, or it is already waiting. */
  seen(fingerprint: string): boolean {
    const book = this.read();
    return book.refused.includes(fingerprint) || book.entries.some((e) => e.fingerprint === fingerprint);
  }

  /** True when the owner said no to this; that is never offered again. */
  refused(fingerprint: string): boolean { return this.read().refused.includes(fingerprint); }

  /** Adds a question for the owner. Null when it was already asked or answered. Throws when too many wait. */
  ask(input: Omit<LedgerEntry, "id" | "status" | "createdAt" | "decidedAt">): LedgerEntry | null {
    const book = this.read();
    if (book.refused.includes(input.fingerprint) || book.entries.some((e) => e.fingerprint === input.fingerprint)) return null;
    if (book.entries.filter((e) => e.status === "pending").length >= maxPending)
      throw new Error(`${maxPending} things already wait for the owner's answer; nothing more is asked until those are answered.`);
    const entry: LedgerEntry = { ...input, id: randomUUID(), status: "pending", createdAt: this.now().toISOString(), decidedAt: null };
    book.entries.push(entry);
    this.write(book);
    return entry;
  }

  /** Writes down the owner's own yes or no for something that never waited (a suggestion answered on the spot). */
  record(input: Omit<LedgerEntry, "id" | "status" | "createdAt" | "decidedAt">, yes: boolean): LedgerEntry {
    const book = this.read();
    const at = this.now().toISOString();
    const entry: LedgerEntry = { ...input, id: randomUUID(), status: yes ? "accepted" : "dismissed", createdAt: at, decidedAt: at };
    book.entries.push(entry);
    if (!yes) book.refused.push(input.fingerprint);
    this.write(book);
    return entry;
  }

  /** Settles a waiting entry. A "no" keeps its fingerprint blocked for good. */
  settle(id: string, yes: boolean): LedgerEntry {
    const book = this.read();
    const entry = book.entries.find((e) => e.id === id);
    if (!entry) throw new Error("Nothing waits under that id.");
    if (entry.status !== "pending") throw new Error("That was already answered.");
    entry.status = yes ? "accepted" : "dismissed";
    entry.decidedAt = this.now().toISOString();
    if (!yes && !["start", "step", "escalation"].includes(entry.kind)) book.refused.push(entry.fingerprint);
    this.write(book);
    return entry;
  }

  /** Withdraws waiting entries that no longer apply (a procedure that was removed). */
  withdraw(match: (entry: LedgerEntry) => boolean): number {
    const book = this.read();
    const before = book.entries.length;
    book.entries = book.entries.filter((e) => !(e.status === "pending" && match(e)));
    if (book.entries.length !== before) this.write(book);
    return before - book.entries.length;
  }

  pendingCount(match: (entry: LedgerEntry) => boolean = () => true): number {
    return this.read().entries.filter((e) => e.status === "pending" && match(e)).length;
  }
}
