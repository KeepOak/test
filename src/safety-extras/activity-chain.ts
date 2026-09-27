import { createHash } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type { AuditEntry } from "../audit.js";
import { safetyMode } from "./settings.js";
import type { Store } from "../store.js";

/**
 * mac7/r17-g (R17-066): a tamper-evident chain over what happened. Every entry carries the hash of
 * the one before it, so changing, removing or slipping in an entry anywhere breaks every hash after
 * it, and `verify` says where. Two database rules refuse edits and removals as well. Someone who can
 * rewrite the whole file can rebuild the chain, so the card shows the latest hash: written down
 * somewhere else, it proves the record up to that moment.
 *
 * Integration review: the hashes alone cannot show entries cut off the end, nor a database rebuilt
 * from the start. So the latest entry's number and hash are also written to a small note outside the
 * database (`activity-chain.anchor` in the data folder), and `verify` holds the chain to it: the note's
 * entry must still be there with the same hash. A chain with entries and no note is reported too.
 * Someone who can rewrite both files still needs the hash written down elsewhere.
 *
 * What goes in (never arguments or file contents, only names, a short label and a hash of the rest):
 *   when-needed  the record of what the assistant was allowed to do, refusals and questions
 *   on           the same, and every tool that started, finished or failed
 *
 * The shape follows OpenFang's `audit.rs` (MIT or Apache-2.0); the code is written here.
 */
export const genesisHash = "0".repeat(64);
const refusals = new Set(["policy.denied", "policy.ask", "approval.needed", "loop.blocked", "loop.stopped", "progress.stopped"]);
const toolKinds = new Set(["tool.started", "tool.completed", "tool.failed", "tool.simulated", "code.ran", "script.called"]);

export interface ChainEntry {
  seq: number; at: string; kind: string; runId: string; detail: string; outcome: string; prev: string; hash: string;
}
export interface ChainCheck { ok: boolean; entries: number; tip: string; brokenAt: number | null; reason: string }

export function entryHash(owner: string, entry: Omit<ChainEntry, "hash">): string {
  const fields = [entry.seq, entry.at, owner, entry.kind, entry.runId, entry.detail, entry.outcome, entry.prev];
  return createHash("sha256").update(fields.map((field) => String(field)).join("\u001f"), "utf8").digest("hex");
}

type Anchors = Record<string, { seq: number; hash: string }>;

export class ActivityChain {
  constructor(private readonly db: DatabaseSync, private readonly anchorPath: string | null = null) {
    db.exec(`CREATE TABLE IF NOT EXISTS activity_chain(owner TEXT NOT NULL, seq INTEGER NOT NULL, at TEXT NOT NULL,
        kind TEXT NOT NULL, run_id TEXT NOT NULL, detail TEXT NOT NULL, outcome TEXT NOT NULL, prev TEXT NOT NULL,
        hash TEXT NOT NULL, PRIMARY KEY(owner, seq));
      CREATE TRIGGER IF NOT EXISTS activity_chain_no_update BEFORE UPDATE ON activity_chain
        BEGIN SELECT RAISE(ABORT, 'The activity chain cannot be changed'); END;
      CREATE TRIGGER IF NOT EXISTS activity_chain_no_delete BEFORE DELETE ON activity_chain
        BEGIN SELECT RAISE(ABORT, 'The activity chain cannot be removed'); END;`);
  }
  /** Read from the database every time, so another writer (the command line) never leaves this one behind. */
  private tip(owner: string): { seq: number; hash: string } {
    const row = this.db.prepare("SELECT seq, hash FROM activity_chain WHERE owner=? ORDER BY seq DESC LIMIT 1").get(owner);
    return row ? { seq: Number(row.seq), hash: String(row.hash) } : { seq: -1, hash: genesisHash };
  }
  append(owner: string, input: { kind: string; runId?: string; detail: string; outcome: string }): ChainEntry {
    const tip = this.tip(owner);
    const base = { seq: tip.seq + 1, at: new Date().toISOString(), kind: input.kind.slice(0, 60), runId: (input.runId ?? "").slice(0, 64),
      detail: input.detail.slice(0, 600), outcome: input.outcome.slice(0, 60), prev: tip.hash };
    const entry = { ...base, hash: entryHash(owner, base) };
    this.db.prepare("INSERT INTO activity_chain VALUES(?,?,?,?,?,?,?,?,?)")
      .run(owner, entry.seq, entry.at, entry.kind, entry.runId, entry.detail, entry.outcome, entry.prev, entry.hash);
    this.writeAnchor(owner, entry);
    return entry;
  }
  private readAnchors(): Anchors | null {
    if (!this.anchorPath) return null;
    try { return JSON.parse(readFileSync(this.anchorPath, "utf8")) as Anchors; } catch { return {}; }
  }
  /** The note only moves forward: a slower writer never pulls it back. */
  private writeAnchor(owner: string, entry: ChainEntry): void {
    const anchors = this.readAnchors();
    if (!anchors || (anchors[owner]?.seq ?? -1) >= entry.seq) return;
    anchors[owner] = { seq: entry.seq, hash: entry.hash };
    const temp = `${this.anchorPath}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(anchors), { mode: 0o600 });
    renameSync(temp, this.anchorPath!);
  }
  /** How long the chain is and its latest hash, without walking it. */
  summary(owner: string): { entries: number; tip: string } {
    const tip = this.tip(owner);
    return { entries: tip.seq + 1, tip: tip.hash };
  }
  list(owner: string, limit = 100): ChainEntry[] {
    return this.db.prepare("SELECT * FROM activity_chain WHERE owner=? ORDER BY seq DESC LIMIT ?").all(owner, Math.min(Math.max(limit, 1), 1000))
      .map(toEntry);
  }
  /** Pass 17 (Timeline): one task's entries, oldest first, so each of its steps can show its own link. */
  forRun(owner: string, runId: string): ChainEntry[] {
    return this.db.prepare("SELECT * FROM activity_chain WHERE owner=? AND run_id=? ORDER BY seq LIMIT 1000").all(owner, runId)
      .map((row) => toEntry(row as Record<string, unknown>));
  }
  /** Walks the whole chain and says whether it is unbroken, and where it first is not. */
  verify(owner: string, expectedTip?: string): ChainCheck {
    let prev = genesisHash, count = 0;
    const seen = new Map<number, string>();
    for (const row of this.db.prepare("SELECT * FROM activity_chain WHERE owner=? ORDER BY seq").iterate(owner)) {
      const entry = toEntry(row as Record<string, unknown>);
      const broken = (reason: string): ChainCheck => ({ ok: false, entries: count, tip: prev, brokenAt: entry.seq, reason });
      if (entry.seq !== count) return broken(`entry ${count} is missing`);
      if (entry.prev !== prev) return broken(`entry ${entry.seq} does not follow the one before it`);
      const { hash, ...rest } = entry;
      if (entryHash(owner, rest) !== hash) return broken(`entry ${entry.seq} was changed after it was written`);
      prev = hash; count++;
      seen.set(entry.seq, hash);
    }
    const outside = this.anchorProblem(owner, count, seen);
    if (outside) return { ok: false, entries: count, tip: prev, brokenAt: null, reason: outside };
    if (expectedTip && !this.includes(owner, expectedTip))
      return { ok: false, entries: count, tip: prev, brokenAt: null, reason: "the hash you wrote down is not in the chain any more" };
    return { ok: true, entries: count, tip: prev, brokenAt: null, reason: count ? "Every entry follows the one before it." : "The chain is empty." };
  }
  /** What the note kept outside the database says is wrong, or null. */
  private anchorProblem(owner: string, count: number, seen: ReadonlyMap<number, string>): string | null {
    const anchors = this.readAnchors();
    if (!anchors) return null;
    const note = anchors[owner];
    if (!note) return count ? "the note of the latest entry, kept beside the database, is missing" : null;
    if (note.seq >= count) return `entries from ${count} to ${note.seq} were removed from the end`;
    if (seen.get(note.seq) !== note.hash) return `entry ${note.seq} does not match the note kept beside the database, so the record was rewritten`;
    return null;
  }
  private includes(owner: string, hash: string): boolean {
    return !!this.db.prepare("SELECT 1 AS found FROM activity_chain WHERE owner=? AND hash=?").get(owner, hash.toLowerCase());
  }
}

function toEntry(row: Record<string, unknown>): ChainEntry {
  return { seq: Number(row.seq), at: String(row.at), kind: String(row.kind), runId: String(row.run_id),
    detail: String(row.detail), outcome: String(row.outcome), prev: String(row.prev), hash: String(row.hash) };
}

const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value) ?? "", "utf8").digest("hex").slice(0, 16);

/** What one stored event puts in the chain, or null when this setting leaves it out. */
export function chainEventFor(kind: string, data: Record<string, unknown>, full: boolean): { detail: string; outcome: string } | null {
  if (!refusals.has(kind) && !(full && toolKinds.has(kind))) return null;
  const name = String(data.name ?? data.tool ?? data.language ?? "").slice(0, 80);
  const label = String(data.label ?? data.reason ?? "").slice(0, 200);
  return { detail: `${name}${label ? ` — ${label}` : ""} [${digest(data)}]`, outcome: kind.split(".")[1] ?? kind };
}

/** Starts writing the chain for one app. Returns a function that stops it. */
export function followActivity(store: Store, owner: string, chain: ActivityChain): () => void {
  const quiet = (write: () => void) => { try { write(); } catch { /* the chain is a witness, never a gate */ } };
  const stopEvents = store.onEvent((runId, kind, data) => quiet(() => {
    const mode = safetyMode(store, owner, "activity-chain");
    if (mode === "off") return;
    const entry = chainEventFor(kind, data, mode === "on");
    if (entry) chain.append(owner, { kind, runId, ...entry });
  }));
  const stopAudit = store.audit.onRecord((entry: AuditEntry) => quiet(() => {
    if (safetyMode(store, owner, "activity-chain") === "off") return;
    chain.append(entry.owner, { kind: entry.action, runId: entry.runId ?? "",
      detail: `${entry.subject} — ${entry.reason}`.slice(0, 600), outcome: entry.outcome });
  }));
  return () => { stopEvents(); stopAudit(); };
}
