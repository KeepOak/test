import type { Store } from "../store.js";
import { missedGates, scoreOf, signalsOf, type Candidate, type Night, type RingsBook } from "./rings-store.js";
import { seasonsSettings } from "./settings.js";

/**
 * The Rings journal: what each night read, kept and left waiting, which the person whose night it was can read,
 * undo and veto. Nothing here deletes: undoing or vetoing a kept fact sets it aside in the memory archive, where
 * the Memory screen can bring it back, and keeping it again brings it back from there.
 */
export interface CandidateView extends Candidate { score: number; missed: string[]; mentions: number; conversations: number }

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

/** Sets a kept fact aside, or turns down its suggestion while it still waits. Never a delete. */
async function takeBack(store: Store, scope: string, entry: Candidate, note: string): Promise<void> {
  if (entry.status === "promoted" && entry.memoryId && store.get("memory", scope, entry.memoryId)) store.setAsideMemory(scope, entry.memoryId, note);
  if (entry.status === "staged" && entry.proposalId
    && store.review.proposals(scope, "pending").some((proposal) => proposal.id === entry.proposalId))
    await store.review.decide(scope, entry.proposalId, false);
}

/** Vetoes one candidate: what it kept is set aside, and it is never kept again however often it comes back. */
export async function veto(store: Store, book: RingsBook, scope: string, id: string): Promise<Candidate> {
  const entry = book.candidate(scope, id);
  if (!entry) throw new Error("There is no such candidate");
  const resolved = resolvedCandidate(store, entry);
  await takeBack(store, scope, resolved, "Vetoed in the Rings journal");
  return book.saveCandidate({ ...resolved, status: "vetoed" });
}

/** Keeps a vetoed or undone candidate after all: its fact comes back from the archive. */
export function keep(store: Store, book: RingsBook, scope: string, id: string): Candidate {
  const entry = book.candidate(scope, id);
  if (!entry) throw new Error("There is no such candidate");
  if (entry.status !== "vetoed" && entry.status !== "undone") throw new Error("Only a vetoed or undone candidate can be kept again");
  if (!entry.memoryId || !store.archivedMemory(scope).some((fact) => fact.id === entry.memoryId))
    return book.saveCandidate({ ...entry, status: "pending" });
  store.restoreMemory(scope, entry.memoryId);
  return book.saveCandidate({ ...entry, status: "promoted" });
}

/** Undoes a whole night: every fact it kept is set aside and every suggestion it left waiting is turned down. */
export async function undoNight(store: Store, book: RingsBook, scope: string, night: string): Promise<Night> {
  const entry = book.night(scope, night);
  if (!entry) throw new Error("There is no such night");
  if (entry.status === "undone") throw new Error("That night is already undone");
  for (const candidate of book.candidates(scope).filter((c) => c.promotedNight === night && (c.status === "promoted" || c.status === "staged"))) {
    const resolved = resolvedCandidate(store, candidate);
    await takeBack(store, scope, resolved, `Rings night of ${night} undone`);
    book.saveCandidate({ ...resolved, status: "undone" });
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
  const candidates = book.candidates(scope).filter((c) => c.promotedNight === last.night).map((c) => store ? resolvedCandidate(store, c) : c);
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
