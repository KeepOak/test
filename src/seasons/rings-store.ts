import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { jaccard, wordsOf } from "../learning-more/curator.js";
import type { SeasonsSettings } from "./settings.js";

/**
 * What Rings keeps between nights, in tables of its own that no backup carries (a restored file cannot plant a
 * candidate, a promotion or a night). Every row belongs to one memory scope: the owner's, or one household
 * person's (`profile:<id>`). Nothing here ever reads or writes across scopes; every query names the scope.
 */
export interface Evidence { runId: string; sessionId: string; quote: string; at: string; night: string; confidence: number }
export type CandidateStatus = "pending" | "promoted" | "staged" | "known" | "vetoed" | "undone";
export interface Candidate {
  id: string; scope: string; text: string; kind: string; status: CandidateStatus;
  evidence: Evidence[]; memoryId: string | null; proposalId: string | null; promotedNight: string | null;
  firstAt: string; lastAt: string;
}
export type NightStatus = "running" | "done" | "paused" | "skipped" | "undone";
export interface Night {
  id: string; scope: string; night: string; status: NightStatus; startedAt: string; finishedAt: string | null;
  model: string | null; modelKind: string | null; data: NightData; seenAt: string | null;
}
export interface NightData {
  read: number; reason?: string;
  light: { embedded: number; merges: number };
  rem: { found: number; grounded: number; ungrounded: number; refused: number };
  deep: { promoted: string[]; staged: string[]; known: number; waiting: number };
  /** The owner's night only: what the Gardener did, and how many code-level problems were filed for the owner. */
  garden?: { planted: number; adopted: number; discarded: number; rolledBack: number; pruned: number; grafted: number; problems: number };
}
export const emptyNight = (): NightData => ({ read: 0, light: { embedded: 0, merges: 0 },
  rem: { found: 0, grounded: 0, ungrounded: 0, refused: 0 }, deep: { promoted: [], staged: [], known: 0, waiting: 0 } });

/** Two wordings are one candidate when they share this much of their words. */
export const sameThought = 0.5;

export class RingsBook {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS seasons_candidates(id TEXT PRIMARY KEY, scope TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS seasons_nights(id TEXT PRIMARY KEY, scope TEXT NOT NULL, night TEXT NOT NULL, data TEXT NOT NULL,
        started_at TEXT NOT NULL, UNIQUE(scope, night));
      CREATE TABLE IF NOT EXISTS seasons_cursor(scope TEXT PRIMARY KEY, through TEXT NOT NULL, through_id TEXT NOT NULL DEFAULT '');`);
    if (!db.prepare("PRAGMA table_info(seasons_cursor)").all().some((column) => column.name === "through_id")) {
      db.exec("ALTER TABLE seasons_cursor ADD COLUMN through_id TEXT NOT NULL DEFAULT ''");
    }
  }
  candidates(scope: string): Candidate[] {
    return this.db.prepare("SELECT data FROM seasons_candidates WHERE scope=? ORDER BY updated_at DESC LIMIT 500").all(scope)
      .map((row) => JSON.parse(String(row.data)) as Candidate).filter((entry) => entry.scope === scope);
  }
  candidate(scope: string, id: string): Candidate | undefined {
    const row = this.db.prepare("SELECT data FROM seasons_candidates WHERE scope=? AND id=?").get(scope, id);
    if (!row) return undefined;
    const entry = JSON.parse(String(row.data)) as Candidate;
    return entry.scope === scope ? entry : undefined;
  }
  /** A night action must reach every fact from that night, including facts outside the recent list. */
  candidatesForNight(scope: string, night: string): Candidate[] {
    return this.db.prepare("SELECT data FROM seasons_candidates WHERE scope=? AND json_extract(data,'$.promotedNight')=?").all(scope, night)
      .map((row) => JSON.parse(String(row.data)) as Candidate).filter((entry) => entry.scope === scope && entry.promotedNight === night);
  }
  saveCandidate(entry: Candidate): Candidate {
    this.db.prepare("INSERT INTO seasons_candidates VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at")
      .run(entry.id, entry.scope, JSON.stringify(entry), new Date().toISOString());
    return entry;
  }
  /**
   * Adds one grounded mention. It joins the candidate in the same scope that says the same thing (whatever its
   * status, so a vetoed thought stays vetoed however often it comes back), or starts a new one. A task already
   * counted is not counted twice, so a night that is paused and run again never inflates a count.
   */
  addMention(scope: string, text: string, kind: string, evidence: Evidence): Candidate {
    const words = wordsOf(text);
    const match = this.matchingCandidate(scope, words);
    if (match) {
      if (!match.evidence.some((seen) => seen.runId === evidence.runId)) match.evidence.push(evidence);
      match.lastAt = evidence.at > match.lastAt ? evidence.at : match.lastAt;
      return this.saveCandidate(match);
    }
    return this.saveCandidate({ id: randomUUID(), scope, text, kind, status: "pending", evidence: [evidence],
      memoryId: null, proposalId: null, promotedNight: null, firstAt: evidence.at, lastAt: evidence.at });
  }
  private matchingCandidate(scope: string, words: Set<string>): Candidate | undefined {
    // Stream older thoughts too: a veto must not expire just because it left the Library's recent list.
    for (const row of this.db.prepare("SELECT data FROM seasons_candidates WHERE scope=? ORDER BY updated_at DESC").iterate(scope)) {
      const entry = JSON.parse(String(row.data)) as Candidate;
      if (entry.scope === scope && jaccard(wordsOf(entry.text), words) >= sameThought) return entry;
    }
    return undefined;
  }
  cursor(scope: string): string {
    return this.cursorPosition(scope).at;
  }
  cursorPosition(scope: string): { at: string; id: string } {
    const row = this.db.prepare("SELECT through,through_id FROM seasons_cursor WHERE scope=?").get(scope);
    return { at: String(row?.through ?? "1970-01-01T00:00:00.000Z"), id: String(row?.through_id ?? "") };
  }
  moveCursor(scope: string, through: string, id = ""): void {
    this.db.prepare("INSERT INTO seasons_cursor(scope,through,through_id) VALUES(?,?,?) ON CONFLICT(scope) DO UPDATE SET through=excluded.through,through_id=excluded.through_id")
      .run(scope, through, id);
  }
  nights(scope: string, limit = 60): Night[] {
    return this.db.prepare("SELECT data FROM seasons_nights WHERE scope=? ORDER BY night DESC LIMIT ?").all(scope, limit)
      .map((row) => JSON.parse(String(row.data)) as Night);
  }
  night(scope: string, night: string): Night | undefined {
    const row = this.db.prepare("SELECT data FROM seasons_nights WHERE scope=? AND night=?").get(scope, night);
    return row ? JSON.parse(String(row.data)) as Night : undefined;
  }
  saveNight(entry: Night): Night {
    this.db.prepare("INSERT INTO seasons_nights VALUES(?,?,?,?,?) ON CONFLICT(scope, night) DO UPDATE SET data=excluded.data")
      .run(entry.id, entry.scope, entry.night, JSON.stringify(entry), entry.startedAt);
    return entry;
  }
}

/**
 * The deep phase's weighted score, from 0 to 1. The six signals and their weights are OpenClaw's deep ranking
 * (relevance 0.30, frequency 0.24, query diversity 0.15, recency 0.15, consolidation 0.10, conceptual richness
 * 0.06); docs/seasons.md says what each one counts here.
 */
export const weights = { relevance: 0.3, frequency: 0.24, diversity: 0.15, recency: 0.15, consolidation: 0.1, richness: 0.06 } as const;
export const recencyHalfLifeDays = 14;
export interface Signals { mentions: number; conversations: number; nights: number; relevance: number; recency: number; richness: number }
export function signalsOf(entry: Candidate, now: Date): Signals {
  const ageDays = Math.max(0, (now.getTime() - Date.parse(entry.lastAt)) / 86_400_000);
  const relevance = entry.evidence.reduce((sum, seen) => sum + seen.confidence, 0) / Math.max(1, entry.evidence.length);
  return { mentions: entry.evidence.length, conversations: new Set(entry.evidence.map((seen) => seen.sessionId)).size,
    nights: new Set(entry.evidence.map((seen) => seen.night)).size, relevance: Math.min(1, Math.max(0, relevance)),
    recency: Math.pow(0.5, ageDays / recencyHalfLifeDays), richness: Math.min(1, wordsOf(entry.text).size / 8) };
}
export function scoreOf(signals: Signals): number {
  const score = weights.relevance * signals.relevance + weights.frequency * Math.min(1, signals.mentions / 5)
    + weights.diversity * Math.min(1, signals.conversations / 3) + weights.recency * signals.recency
    + weights.consolidation * Math.min(1, signals.nights / 3) + weights.richness * signals.richness;
  return Math.round(score * 1000) / 1000;
}
export type Gate = "minScore" | "minRecallCount" | "minUniqueQueries";
/** The gates a candidate misses; empty means every one passed. */
export function missedGates(signals: Signals, settings: Pick<SeasonsSettings, Gate>): Gate[] {
  const missed: Gate[] = [];
  if (scoreOf(signals) < settings.minScore) missed.push("minScore");
  if (signals.mentions < settings.minRecallCount) missed.push("minRecallCount");
  if (signals.conversations < settings.minUniqueQueries) missed.push("minUniqueQueries");
  return missed;
}
