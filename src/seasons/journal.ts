import type { Store } from "../store.js";
import { missedGates, scoreOf, signalsOf, type Candidate, type Night, type RingsBook } from "./rings-store.js";
import { seasonsSettings } from "./settings.js";
import type { MemoryWriteReceipt } from "../memory-backend.js";
import { archiveBuiltIn, restoreBuiltIn } from "../memory-journal.js";

/**
 * The Rings journal: what each night read, kept and left waiting, which the person whose night it was can read,
 * undo and veto. Local facts move to the archive. Outside facts retain a private restorable copy, then their
 * original service must confirm removal. Keep verifies restoration to that same service before reporting success.
 */
export interface CandidateView extends Candidate { score: number; missed: string[]; mentions: number; conversations: number }
const actions = new WeakMap<Store, Map<string, Promise<unknown>>>();
/** Orders opposite journal decisions for one fact while unrelated facts remain free to proceed. */
async function oneAction<T>(store: Store, scope: string, id: string, decide: () => Promise<T>): Promise<T> {
  let pending = actions.get(store);
  if (!pending) actions.set(store, pending = new Map());
  const key = `${scope}:${id}`, previous = pending.get(key);
  const work = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(decide);
  pending.set(key, work);
  try { return await work; }
  finally { if (pending.get(key) === work) pending.delete(key); }
}

/** Acceptance in Library retains the exact fact id, so a later night undo can set that fact aside. */
function resolvedCandidate(store: Store, entry: Candidate): Candidate {
  if (entry.status !== "staged" || !entry.proposalId) return entry;
  const proposal = store.review.proposal(entry.scope, entry.proposalId);
  if (proposal?.status === "accepted" && proposal.appliedId) return { ...entry, status: "promoted", memoryId: proposal.appliedId };
  if (proposal?.status === "rejected") return { ...entry, status: "vetoed" };
  return entry;
}

export function viewCandidate(store: Store, owner: string, entry: Candidate, now = new Date()): CandidateView {
  entry = resolvedCandidate(store, entry);
  const signals = signalsOf(entry, now);
  return { ...entry, score: scoreOf(signals), missed: missedGates(signals, seasonsSettings(store, owner)),
    mentions: signals.mentions, conversations: signals.conversations };
}

/** Sets a kept fact aside in its original backend, or turns down its waiting suggestion. */
async function takeBack(store: Store, scope: string, entry: Candidate, note: string): Promise<void> {
  if (entry.status === "promoted" && entry.memoryId) {
    const receipt = receiptFor(store, scope, entry);
    if (receipt.destination.kind === "outside") {
      if (!store.review.provider?.setAsideAt) throw new Error("The original outside memory service cannot archive this fact in this engine");
      await store.review.provider.setAsideAt(scope, entry.memoryId, receipt, note);
    } else archiveBuiltIn(store, scope, entry.memoryId, receipt, note);
  }
  const proposal = entry.proposalId ? store.review.proposal(scope, entry.proposalId) : undefined;
  if (entry.status === "staged" && proposal?.status === "accepted") throw new Error("Acceptance is still finishing; wait for its receipt before undoing this fact");
  if (entry.status === "staged" && entry.proposalId
    && proposal?.status === "pending")
    await store.review.decide(scope, entry.proposalId, false);
}
function receiptFor(store: Store, scope: string, entry: Candidate): MemoryWriteReceipt {
  const receipt = entry.proposalId ? store.review.proposal(scope, entry.proposalId)?.appliedReceipt : null;
  if (receipt) return receipt;
  if (entry.proposalId) throw new Error("Acceptance has no receipt naming its original memory service, so nothing was changed");
  const local = entry.memoryId ? store.get("memory", scope, entry.memoryId) : undefined;
  if (local) return { destination: { kind: "built-in" }, record: local as MemoryWriteReceipt["record"] };
  const archived = entry.memoryId ? store.sqlite.prepare("SELECT * FROM memory_archive WHERE owner=? AND id=?").get(scope, entry.memoryId) : undefined;
  if (archived) return { destination: { kind: "built-in" }, record: { id: String(archived.id), owner: scope,
    data: JSON.parse(String(archived.data)), createdAt: String(archived.created_at), updatedAt: String(archived.updated_at), revision: Number(archived.revision) } };
  throw new Error("This older fact has no receipt naming its original memory service, so nothing was changed or reported undone");
}

/** Vetoes one candidate: what it kept is set aside, and it is never kept again however often it comes back. */
export async function veto(store: Store, book: RingsBook, scope: string, id: string): Promise<Candidate> {
  return oneAction(store, scope, id, async () => {
    const entry = book.candidate(scope, id);
    if (!entry) throw new Error("There is no such candidate");
    const resolved = resolvedCandidate(store, entry);
    await takeBack(store, scope, resolved, "Vetoed in the Rings journal");
    return book.saveCandidate({ ...resolved, status: "vetoed" });
  });
}

/** Keeps a vetoed or undone candidate after all: its fact comes back from the archive. */
export async function keep(store: Store, book: RingsBook, scope: string, id: string): Promise<Candidate> {
  return oneAction(store, scope, id, async () => {
    const entry = book.candidate(scope, id);
    if (!entry) throw new Error("There is no such candidate");
    if (entry.status === "promoted") return entry;
    if (entry.status !== "vetoed" && entry.status !== "undone") throw new Error("Only a vetoed or undone candidate can be kept again");
    if (!entry.memoryId) return book.saveCandidate({ ...entry, status: "pending" });
    const receipt = receiptFor(store, scope, entry);
    if (receipt.destination.kind === "outside") {
      if (!store.review.provider?.restoreAt) throw new Error("The original outside memory service cannot restore this fact in this engine");
      await store.review.provider.restoreAt(scope, entry.memoryId, receipt);
    } else restoreBuiltIn(store, scope, entry.memoryId, receipt);
    return book.saveCandidate({ ...entry, status: "promoted" });
  });
}

/** Undoes a whole night: every fact it kept is set aside and every suggestion it left waiting is turned down. */
export async function undoNight(store: Store, book: RingsBook, scope: string, night: string): Promise<Night> {
  const entry = book.night(scope, night);
  if (!entry) throw new Error("There is no such night");
  if (entry.status === "undone") return entry;
  for (const candidate of book.candidatesForNight(scope, night).filter((c) => c.status === "promoted" || c.status === "staged")) {
    await oneAction(store, scope, candidate.id, async () => {
      const current = book.candidate(scope, candidate.id);
      if (!current || (current.status !== "promoted" && current.status !== "staged")) return;
      const resolved = resolvedCandidate(store, current);
      await takeBack(store, scope, resolved, `Rings night of ${night} undone`);
      book.saveCandidate({ ...resolved, status: "undone" });
    });
  }
  return book.saveNight({ ...entry, status: "undone" });
}

/**
 * The morning line: the newest finished night, with what it kept, until the person has seen it. Only the facts'
 * own words and counts; the window writes the sentence around them in the person's language.
 */
export function morning(book: RingsBook, scope: string, store?: Store): { night: string; kept: { id: string; text: string }[]; waiting: number; staged: number } | null {
  const last = book.nights(scope, 5).find((entry) => entry.status === "done");
  if (!last || last.seenAt) return null;
  const candidates = book.candidatesForNight(scope, last.night).map((c) => store ? resolvedCandidate(store, c) : c);
  const kept = candidates.filter((c) => c.status === "promoted").map((c) => ({ id: c.id, text: c.text }));
  const staged = candidates.filter((c) => c.status === "staged").length;
  if (!kept.length && !staged) return null;
  return { night: last.night, kept, waiting: last.data.deep.waiting, staged };
}
export function seenMorning(book: RingsBook, scope: string, night: string): Night {
  const entry = book.night(scope, night);
  if (!entry) throw new Error("There is no such night");
  return book.saveNight({ ...entry, seenAt: new Date().toISOString() });
}
