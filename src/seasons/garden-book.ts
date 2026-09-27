import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/**
 * What the Gardener keeps, in tables of its own that no backup carries (a restored file cannot plant an adopted
 * skill or a proof). Seeds are skill candidates, each made by one of the owner's four triggers; the ledger is every
 * change the Gardener made to a skill, with what it was before, so each one can be undone.
 */
export type Trigger = "recurring" | "lesson" | "asked" | "budding";
export type SeedStatus = "waiting" | "adopted" | "discarded" | "rolled-back" | "archived";
export interface ProofTask { prompt: string; runId: string }
export interface ProofSide { scores: number[]; mean: number; errors: number; tokens: number }
export interface Proof {
  tasks: number; without: ProofSide; with: ProofSide;
  /** How much better the tasks went with the skill, from -1 to 1 (the difference of the two means). */
  gain: number;
  /** Why this replay cannot be read as a comparison, or null when it can. */
  unreadable: string | null;
  model: string; ranAt: string;
}
export interface Seed {
  id: string; trigger: Trigger; status: SeedStatus;
  /** What happened, in words, for the draft: the requests, the failure and the fix, or the conversation. */
  evidence: string;
  /** The tasks the skill is proved on: replayed with it and without it. */
  tasks: ProofTask[];
  /** The owner's tasks this seed came from, so the same ones never make a second seed. */
  sourceRunIds: string[];
  skillId: string | null; name: string | null;
  /** The drafted file, kept here for good, so a discarded draft can always be looked at or put back. */
  document: string | null;
  proofs: Proof[]; reason: string | null; createdAt: string; decidedAt: string | null; checkedAt: string | null;
  pinned: boolean;
}
export type LedgerAction = "adopted" | "discarded" | "grafted" | "pruned" | "re-rooted" | "rolled-back";
export interface SkillState { skillId: string; activeVersion: number | null }
export interface LedgerEntry {
  id: string; at: string; action: LedgerAction; seedId: string | null; name: string;
  /** Every skill the change touched, as it was before and after, which is exactly what undo puts back. */
  before: SkillState[]; after: SkillState[];
  reason: string; proof: Proof | null; undoneAt: string | null;
}

export class GardenBook {
  constructor(private readonly db: DatabaseSync, private readonly owner: string) {
    db.exec(`CREATE TABLE IF NOT EXISTS seasons_seeds(id TEXT PRIMARY KEY, owner TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS seasons_ledger(id TEXT PRIMARY KEY, owner TEXT NOT NULL, data TEXT NOT NULL, at TEXT NOT NULL);`);
  }
  seeds(): Seed[] {
    return this.db.prepare("SELECT data FROM seasons_seeds WHERE owner=? ORDER BY updated_at DESC LIMIT 300").all(this.owner)
      .map((row) => JSON.parse(String(row.data)) as Seed);
  }
  seed(id: string): Seed | undefined { return this.seeds().find((entry) => entry.id === id); }
  saveSeed(entry: Seed): Seed {
    this.db.prepare("INSERT INTO seasons_seeds VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at")
      .run(entry.id, this.owner, JSON.stringify(entry), new Date().toISOString());
    return entry;
  }
  plant(input: Pick<Seed, "trigger" | "evidence" | "tasks" | "sourceRunIds">): Seed {
    return this.saveSeed({ ...input, id: randomUUID(), status: "waiting", skillId: null, name: null, document: null, proofs: [],
      reason: null, createdAt: new Date().toISOString(), decidedAt: null, checkedAt: null, pinned: false });
  }
  ledger(limit = 200): LedgerEntry[] {
    return this.db.prepare("SELECT data FROM seasons_ledger WHERE owner=? ORDER BY at DESC LIMIT ?").all(this.owner, limit)
      .map((row) => JSON.parse(String(row.data)) as LedgerEntry);
  }
  entry(id: string): LedgerEntry | undefined { return this.ledger(1000).find((entry) => entry.id === id); }
  write(input: Omit<LedgerEntry, "id" | "at" | "undoneAt">): LedgerEntry {
    const entry: LedgerEntry = { ...input, id: randomUUID(), at: new Date().toISOString(), undoneAt: null };
    return this.saveEntry(entry);
  }
  saveEntry(entry: LedgerEntry): LedgerEntry {
    this.db.prepare("INSERT INTO seasons_ledger VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data")
      .run(entry.id, this.owner, JSON.stringify(entry), entry.at);
    return entry;
  }
}
