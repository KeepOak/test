import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { isCurrentFact, MemoryDataSchema, reworded, takeBackFact, visibleTo, type MemoryFacts, type MemoryRecord, type OutsideMemoryProvider } from "./memory.js";
import { FactKindSchema } from "./memory-layers.js";
import { binnedRuns, learnedInBin } from "./conversation-actions.js";
import { detectInjection } from "./content-guard.js";
import { MemoryDestinationSchema, type MemoryWriteReceipt } from "./memory-backend.js";

/**
 * Governance for what the assistant learns: exact versions of every memory, whole-memory
 * checkpoints, staged changes that wait for the owner's acceptance, and a per-conversation
 * memory snapshot that stays stable until the next conversation starts.
 */
export const LearningSettingsSchema = z.object({
  /** After each finished task, ask the model whether anything is worth remembering; suggestions wait for acceptance. */
  review: z.boolean().default(false),
  /** Memory changes the model makes on its own are staged for the owner instead of applied. */
  requireApproval: z.boolean().default(false),
}).strict();
export type LearningSettings = z.infer<typeof LearningSettingsSchema>;
const ProposedFactSchema = MemoryDataSchema.pick({ scope: true, entity: true, attribute: true, validFrom: true, kind: true, layer: true, project: true }).strict();
export const ProposalSchema = z.object({
  /**
   * merge keeps one fact and sets the rest aside; archive and forget set facts aside with a note;
   * knowledge-card adds a written-up card to one of the owner's knowledge bases.
   */
  kind: z.enum(["put", "update", "delete", "skill-note", "merge", "archive", "forget", "knowledge-card"]),
  /** For a knowledge-card suggestion: what it says, which collection it would go in, how sure it is. */
  card: z.object({
    title: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(4000),
    collection: z.string().trim().min(1).max(120),
    /** The turn of the conversation the card was taken from, so the owner can go and look. */
    sourceTurn: z.string().max(2000).default(""),
    confidence: z.number().min(0).max(1).default(0.5),
  }).strict().nullable().default(null),
  /**
   * Set when the assistant noticed this for itself from what actually happened rather than being
   * told it. It carries what it was learned from, so the owner can see why it is being offered,
   * and a fingerprint of the noticing, so turning it down stops it being offered again.
   */
  learned: z.object({
    /** "learning-core": a pattern of steps the learning core (src/fly-core) saw keep working. */
    signal: z.enum(["file-revisited", "name-recurs", "correction", "learning-core"]),
    text: z.string().max(4000).default(""),
    source: z.string().max(500).default(""),
    kind: z.string().max(40).default("fact-about-world"),
    evidence: z.array(z.string().max(300)).max(8).default([]),
    fingerprint: z.string().max(80).default(""),
  }).strict().nullable().default(null),
  memoryId: z.string().max(200).nullable().default(null),
  /**
   * For a put: whose the fact is and what it is about, as memory.put would have saved it, so accepting a
   * Trunk's suggestion saves the Trunk's own fact rather than one of the owner's. Null for older suggestions.
   */
  fact: ProposedFactSchema.nullable().default(null),
  /** The other facts a tidying suggestion touches; every one of them is set aside, never deleted. */
  memoryIds: z.array(z.string().max(200)).max(50).default([]),
  skillId: z.string().max(200).nullable().default(null),
  text: z.string().trim().max(4000).default(""),
  source: z.string().trim().max(500).default("Suggested after a task"),
  runId: z.string().max(200).default(""),
  note: z.string().max(500).default(""),
}).strict();
export interface Proposal extends z.infer<typeof ProposalSchema> { id: string; status: "pending" | "accepted" | "rejected"; createdAt: string; decidedAt: string | null; appliedId?: string | null; appliedReceipt?: MemoryWriteReceipt | null }
function readProposal(row: Record<string, unknown>): Proposal {
  return { ...ProposalSchema.parse(JSON.parse(String(row.data))), id: String(row.id), status: String(row.status) as Proposal["status"],
    createdAt: String(row.created_at), decidedAt: row.decided_at === null ? null : String(row.decided_at), appliedId: row.applied_id ? String(row.applied_id) : null,
    appliedReceipt: row.applied_receipt ? JSON.parse(String(row.applied_receipt)) as MemoryWriteReceipt : null };
}
export interface MemoryVersion { memoryId: string; revision: number; data: Record<string, unknown>; reason: string; createdAt: string }
export interface Checkpoint { id: string; label: string; memories: number; skills: number; createdAt: string }
export const memorySnapshotLimits = { facts: 20, chars: 2000 };
/** Suggestions that tidy the store: they set facts aside in the archive and never delete anything. */
/**
 * What a model writes as a suggestion's source when it changes facts: the look back, and tidying by the
 * owner's instructions. Such a change may only land on the owner's own private facts, which are all
 * either is shown. It is checked again when the owner says yes, because a row staged before that rule
 * (or with a fact moved since) would otherwise put a model's words on another person's fact (NAS d2ca9b8).
 */
export const lookBackSource = "Looked back over messages";
export const tidyByInstructionsSource = "Tidying by your instructions:";
/** Seasons: what Rings writes as the source of a fact it keeps overnight (src/seasons/rings.ts). */
export const ringsSource = "Rings, night of";
const modelWritten = (source: string): boolean => [lookBackSource, tidyByInstructionsSource, ringsSource].some((start) => source.startsWith(start));
/** Whose a fact is: missing means the owner's own. */
const whose = (data: Record<string, unknown>): string => String(data.scope ?? "private");
const notTheOwners = "A suggestion a model wrote can only change the owner's own facts, and this one names someone else's, so it is not made. Decline it, then tidy again.";
export const tidyingKinds: Proposal["kind"][] = ["merge", "archive", "forget"];

export class MemoryReview {
  /**
   * Set when hybrid retrieval is available: the snapshot then takes the most useful facts first.
   * The conversation is passed so the learning core can put what helped in similar tasks first.
   */
  orderFacts?: (owner: string, agent?: string, sessionId?: string) => MemoryRecord[];
  /** R17-S13: the owner's memory budget; `createBranch` connects it, and without it the fixed figures apply. */
  snapshotLimits?: (owner: string) => { facts: number; chars: number };
  /**
   * Set at start-up: what accepting a skill idea from the learning core does. It returns a skill
   * draft for the existing skill editor to open, pre-filled from the steps; nothing is installed.
   */
  acceptSkillIdea?: (owner: string, proposal: Proposal) => unknown;
  /**
   * Set at start-up when knowledge bases are available: what accepting a card suggestion does. It
   * is handed in rather than reached for, so this module never has to know about collections.
   */
  acceptCard?: (owner: string, card: NonNullable<Proposal["card"]>) => unknown;
  /**
   * mac3/reflection-skills: what accepting a skill note does (src/reflection/skill-notes.ts), handed
   * in at start-up like `acceptCard`. Without it a skill note is only noted.
   */
  applySkillNote?: (owner: string, proposal: Proposal) => unknown;
  /**
   * FQ-memory.providers: set at start-up once `src/memory-provider.ts` exists. When the owner has an
   * outside memory service switched on, an accepted put/update/delete suggestion is written there
   * instead of this computer's database, exactly as `memory.put`/`memory.update`/`memory.delete`
   * already do — so a staged change does not land somewhere the owner switched away from. Every
   * other kind of suggestion (tidying, knowledge cards, skill notes) stays on this computer's
   * database either way: it is Branch's own bookkeeping on top of a fact, not a remembered fact
   * itself, the same boundary `src/memory.ts` draws for `memory.keep`/`memory.at`/`memory.timeline`.
   */
  provider?: OutsideMemoryProvider;
  constructor(private readonly db: DatabaseSync, private readonly memories: MemoryFacts) {
    db.exec(`CREATE TABLE IF NOT EXISTS memory_proposals(id TEXT PRIMARY KEY, owner TEXT NOT NULL, data TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, decided_at TEXT);
      CREATE TABLE IF NOT EXISTS memory_checkpoints(id TEXT PRIMARY KEY, owner TEXT NOT NULL, label TEXT NOT NULL, memories TEXT NOT NULL, skills TEXT NOT NULL, created_at TEXT NOT NULL);`);
    if (!db.prepare("PRAGMA table_info(memory_proposals)").all().some((row) => row.name === "applied_id"))
      db.exec("ALTER TABLE memory_proposals ADD COLUMN applied_id TEXT");
    // A backup may carry suggestions, but cannot plant a destination receipt for a Rings action.
    db.exec("CREATE TABLE IF NOT EXISTS memory_proposal_receipts(owner TEXT NOT NULL,proposal_id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(owner,proposal_id))");
  }
  settings(owner: string): LearningSettings {
    const row = this.db.prepare("SELECT data FROM settings WHERE owner=? AND id='learning'").get(owner);
    // Seasons: the old daily look (`consolidateDaily`) is Rings now. A record saved with it still holds the owner's
    // other two switches, so that field is dropped before reading rather than the whole record read as unset.
    const { consolidateDaily: _replaced, ...saved } = row ? JSON.parse(String(row.data)) as Record<string, unknown> : {};
    const parsed = LearningSettingsSchema.safeParse(saved);
    return parsed.success ? parsed.data : LearningSettingsSchema.parse({});
  }
  configure(owner: string, input: unknown): LearningSettings {
    const value = LearningSettingsSchema.parse(input);
    const now = new Date().toISOString();
    this.db.prepare("INSERT INTO settings VALUES('learning',?,?,?,?) ON CONFLICT(id,owner) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at")
      .run(owner, JSON.stringify(value), now, now);
    return value;
  }
  /**
   * Stages a change for the owner to accept or reject. Whose a suggested fact is comes only from `fact`, which
   * memory.put passes, never from the suggestion itself, so nothing else can choose a Trunk's memory for it.
   */
  propose(owner: string, input: unknown, fact: unknown = null): Proposal {
    const data = { ...ProposalSchema.parse(input), fact: fact === null ? null : ProposedFactSchema.parse(fact) };
    if ((data.kind === "put" || data.kind === "update") && !data.text) throw new Error("A memory suggestion needs text");
    if (tidyingKinds.includes(data.kind) && !data.memoryIds.length) throw new Error("A tidying suggestion needs the facts it applies to");
    // QA retest 2026-09-28 (m12): the same fact suggested again while the first is still waiting is that suggestion,
    // not a second row the owner has to accept or reject twice.
    const waiting = data.kind === "put" ? this.samePut(owner, data) : undefined;
    if (waiting) return waiting;
    const proposal: Proposal = { ...data, id: randomUUID(), status: "pending", createdAt: new Date().toISOString(), decidedAt: null };
    this.db.prepare("INSERT INTO memory_proposals(id,owner,data,status,created_at,decided_at) VALUES(?,?,?,?,?,NULL)").run(proposal.id, owner, JSON.stringify(data), "pending", proposal.createdAt);
    return proposal;
  }
  /** A waiting suggestion to remember the same words with the same details (spacing and case aside), if there is one. */
  private samePut(owner: string, data: { text?: string | undefined; fact: unknown; skillId?: string | null | undefined }): Proposal | undefined {
    const words = (text: string | undefined) => String(text ?? "").trim().replace(/\s+/g, " ").toLowerCase();
    const key = JSON.stringify([words(data.text), data.fact ?? null, data.skillId ?? null]);
    return this.proposals(owner, "pending").find((one) => one.kind === "put" && JSON.stringify([words(one.text), one.fact ?? null, one.skillId ?? null]) === key);
  }
  proposals(owner: string, status: Proposal["status"] | "all" = "pending"): Proposal[] {
    const rows = status === "all"
      ? this.db.prepare("SELECT p.*,r.data AS applied_receipt FROM memory_proposals p LEFT JOIN memory_proposal_receipts r ON r.owner=p.owner AND r.proposal_id=p.id WHERE p.owner=? ORDER BY p.created_at DESC LIMIT 200").all(owner)
      : this.db.prepare("SELECT p.*,r.data AS applied_receipt FROM memory_proposals p LEFT JOIN memory_proposal_receipts r ON r.owner=p.owner AND r.proposal_id=p.id WHERE p.owner=? AND p.status=? ORDER BY p.created_at DESC LIMIT 200").all(owner, status);
    return rows.map(readProposal);
  }
  /** Exact provenance lookup stays available after the proposal leaves the recent list. */
  proposal(owner: string, id: string): Proposal | undefined {
    const row = this.db.prepare("SELECT p.*,r.data AS applied_receipt FROM memory_proposals p LEFT JOIN memory_proposal_receipts r ON r.owner=p.owner AND r.proposal_id=p.id WHERE p.owner=? AND p.id=?").get(owner, id);
    return row ? readProposal(row) : undefined;
  }
  /** Accepting applies the change exactly as staged; rejecting only records the decision. */
  async decide(owner: string, id: string, accept: boolean): Promise<{ proposal: Proposal; applied: unknown }> {
    const proposal = this.proposal(owner, id);
    if (!proposal) throw new Error("No such suggestion");
    if (proposal.status !== "pending") throw new Error("That suggestion was already decided");
    // Marked decided before it is applied, with nothing awaited between the check above and here, so a second
    // Accept while an outside service is still answering the first finds it decided instead of applying it again.
    // If applying fails it is pending again, as before.
    const decidedAt = new Date().toISOString();
    this.db.prepare("UPDATE memory_proposals SET status=?, decided_at=? WHERE id=? AND owner=?").run(accept ? "accepted" : "rejected", decidedAt, id, owner);
    let applied: unknown = null;
    const destination = this.provider?.destinationFor?.(owner) ?? (this.provider?.isOutside(owner) ? null : { kind: "built-in" as const });
    if (accept) {
      try { applied = await this.apply(owner, proposal); }
      catch (error) {
        this.db.prepare("UPDATE memory_proposals SET status='pending', decided_at=NULL WHERE id=? AND owner=?").run(id, owner);
        throw error;
      }
    }
    const appliedId = applied && typeof applied === "object" && "id" in applied && typeof applied.id === "string" ? applied.id : null;
    if (appliedId) this.db.prepare("UPDATE memory_proposals SET applied_id=? WHERE id=? AND owner=?").run(appliedId, id, owner);
    const appliedReceipt = appliedId && destination && (proposal.kind === "put" || proposal.kind === "update")
      ? { destination: MemoryDestinationSchema.parse(destination), record: applied as MemoryRecord } : null;
    if (appliedReceipt) this.db.prepare("INSERT INTO memory_proposal_receipts VALUES(?,?,?) ON CONFLICT(owner,proposal_id) DO UPDATE SET data=excluded.data").run(owner, id, JSON.stringify(appliedReceipt));
    return { proposal: { ...proposal, status: accept ? "accepted" : "rejected", decidedAt, appliedId, appliedReceipt }, applied };
  }
  private async apply(owner: string, proposal: Proposal): Promise<unknown> {
    // FQ-memory.providers: put/update/delete are exactly the three methods `memory.put`/`.update`/
    // `.delete` already send to the outside service when one is switched on, so an accepted
    // suggestion of the same kind goes the same way rather than always landing in SQLite.
    const outside = this.provider?.isOutside(owner) ? this.provider : undefined;
    if (proposal.kind === "put") {
      // A suggestion the assistant noticed for itself says what sort of fact it is; anything else
      // is saved exactly as it always was, as a fact about the world.
      const kind = FactKindSchema.safeParse(proposal.learned?.kind).data;
      const data = { text: proposal.text, source: proposal.source, sourceRunId: proposal.runId, ...(kind ? { kind } : {}), ...proposal.fact };
      if (!outside) return this.memories.save(owner, randomUUID(), data);
      // As memory.put: a save reported as failed is never read back, even if the service applies it late.
      const id = randomUUID();
      const service = outside.serviceFor?.(owner);
      return outside.write(owner, id, data).catch(async (error: unknown) => {
        await takeBackFact(outside, owner, id, service);
        throw error;
      });
    }
    if (proposal.kind === "update") {
      const apply = async () => {
        const current = proposal.memoryId ? await (outside ? outside.read(owner, proposal.memoryId) : this.memories.get(owner, proposal.memoryId)) : undefined;
        if (!current) throw new Error("The memory this suggestion changes no longer exists");
        if (modelWritten(proposal.source) && whose(current.data) !== "private") throw new Error(notTheOwners);
        // Only the words change: an accepted change keeps whose fact it is, as memory.update does.
        const data = reworded(current.data, { text: proposal.text, source: proposal.source, sourceRunId: proposal.runId });
        return outside ? outside.write(owner, current.id, data) : this.memories.save(owner, current.id, data);
      };
      // Read and written under the same lock as memory.update, so neither overwrites the other unseen.
      return outside?.withFactLock && proposal.memoryId ? outside.withFactLock(owner, proposal.memoryId, apply) : apply();
    }
    if (proposal.kind === "delete") {
      if (!proposal.memoryId) return { removed: false };
      return { removed: outside ? await outside.forget(owner, proposal.memoryId) : this.memories.delete(owner, proposal.memoryId, `accepted suggestion ${proposal.id}`) };
    }
    if (tidyingKinds.includes(proposal.kind)) return this.tidy(owner, proposal);
    if (proposal.kind === "knowledge-card") {
      if (!proposal.card) throw new Error("That card suggestion has nothing in it");
      if (!this.acceptCard) throw new Error("Knowledge bases are not available in this launch");
      // A card is written up from a conversation, which may itself repeat what a document said. One
      // that reads like an order to the assistant is refused here, whatever put it in the queue,
      // because accepting it would make that order part of what the assistant knows for good.
      if (detectInjection([proposal.card.title, proposal.card.body, proposal.card.sourceTurn].join("\n")).length)
        throw new Error("That card reads like instructions to the assistant rather than something to remember, so it was not added.");
      return this.acceptCard(owner, proposal.card);
    }
    if (proposal.kind === "skill-note" && proposal.learned?.signal === "learning-core" && this.acceptSkillIdea)
      return this.acceptSkillIdea(owner, proposal);
    if (proposal.kind === "skill-note" && this.applySkillNote) return this.applySkillNote(owner, proposal);
    return { noted: true };
  }
  /**
   * A tidying suggestion the owner accepted. Every fact it names is moved to the archive with the
   * reason attached, so it stays in the Memory view and can be brought back; a merge first writes
   * the agreed wording onto the fact that is kept.
   */
  private tidy(owner: string, proposal: Proposal): { kept: string | null; setAside: string[]; note: string } {
    const note = (proposal.note || `Accepted suggestion ${proposal.id}`).slice(0, 500);
    if (proposal.kind === "merge" && proposal.memoryId && proposal.text) {
      const current = this.memories.get(owner, proposal.memoryId);
      if (!current) throw new Error("The fact this suggestion would keep no longer exists");
      // The kept fact takes the merged words, so every fact merged into it must be the same person's. Checked here, when
      // the owner says yes, because a suggestion may have been made before tidying knew that, or by the look back,
      // which groups what the model saw (Mac mini 5c2e4f6, NAS ea14643).
      // A fact named in the merge that is gone by now (deleted, forgotten, expired) still has its words in the merged
      // text, and whose they were can no longer be told, so the merge is refused (NAS ec65398).
      const others = proposal.memoryIds.filter((id) => id !== current.id).map((id) => this.memories.get(owner, id));
      if (others.some((record) => record === undefined))
        throw new Error("A fact this merge names is gone, so it is not merged. Decline it, then tidy again.");
      if (others.some((record) => whose(record!.data) !== whose(current.data)))
        throw new Error("These facts belong to different people, so they are not merged. Each stays as it is.");
      if (modelWritten(proposal.source) && whose(current.data) !== "private") throw new Error(notTheOwners);
      this.memories.save(owner, current.id, { ...current.data, text: proposal.text, source: proposal.source || String(current.data.source) });
    }
    const setAside: string[] = [];
    for (const id of proposal.memoryIds) {
      if (id === proposal.memoryId) continue;
      if (!this.memories.get(owner, id)) continue;
      this.memories.setAside(owner, id, note);
      setAside.push(id);
    }
    return { kept: proposal.kind === "merge" ? proposal.memoryId : null, setAside, note };
  }
  versions(owner: string, memoryId: string): MemoryVersion[] {
    return this.memories.versions(owner, memoryId);
  }
  /** Writes an earlier version's exact text and source back as a new revision. */
  restoreVersion(owner: string, memoryId: string, revision: number): MemoryRecord {
    const version = this.versions(owner, memoryId).find((v) => v.revision === revision);
    if (!version) throw new Error("That earlier version is not kept");
    const data = version.data as { text: string; source: string; sourceRunId?: string; originRunId?: string };
    const words = { text: data.text, source: data.source, sourceRunId: data.sourceRunId ?? "" };
    // Only the words go back: the fact stays whose it is now, as with any other change. A fact that is gone is whose
    // it was when it went (the last version kept of it, never the revision chosen, which could be wider than that).
    const now = this.memories.get(owner, memoryId)?.data ?? this.memories.lastKept(owner, memoryId);
    return this.memories.save(owner, memoryId, now && MemoryDataSchema.safeParse(now).success ? reworded(now, words) : words);
  }
  /** Freezes every memory record and every skill's active version so both can be put back exactly. */
  checkpoint(owner: string, input: unknown): Checkpoint {
    const { label } = z.object({ label: z.string().trim().min(1).max(120).default("Checkpoint") }).strict().parse(input ?? {});
    const records = this.memories.list(owner).map((r) => ({ id: r.id, data: r.data, createdAt: r.createdAt, updatedAt: r.updatedAt, revision: r.revision }));
    const skills = this.db.prepare("SELECT id, active_version FROM installed_skills WHERE owner=?").all(owner).map((row) => ({ id: String(row.id), activeVersion: row.active_version === null ? null : Number(row.active_version) }));
    const checkpoint: Checkpoint = { id: randomUUID(), label, memories: records.length, skills: skills.length, createdAt: new Date().toISOString() };
    this.db.prepare("INSERT INTO memory_checkpoints VALUES(?,?,?,?,?,?)").run(checkpoint.id, owner, label, JSON.stringify(records), JSON.stringify(skills), checkpoint.createdAt);
    return checkpoint;
  }
  checkpoints(owner: string): Checkpoint[] {
    return this.db.prepare("SELECT id,label,memories,skills,created_at FROM memory_checkpoints WHERE owner=? ORDER BY created_at DESC LIMIT 50").all(owner)
      .map((row) => ({ id: String(row.id), label: String(row.label), memories: JSON.parse(String(row.memories)).length, skills: JSON.parse(String(row.skills)).length, createdAt: String(row.created_at) }));
  }
  /** Replaces the current memory set with the checkpoint's exact records and re-selects the skill versions it recorded. */
  restoreCheckpoint(owner: string, id: string): { id: string; memories: number; skills: number } {
    const row = this.db.prepare("SELECT * FROM memory_checkpoints WHERE owner=? AND id=?").get(owner, id);
    if (!row) throw new Error("That checkpoint is not kept");
    const records = JSON.parse(String(row.memories)) as { id: string; data: Record<string, unknown>; createdAt: string; updatedAt: string; revision: number }[];
    const skills = JSON.parse(String(row.skills)) as { id: string; activeVersion: number | null }[];
    this.db.exec("BEGIN");
    try {
      for (const current of this.memories.list(owner)) this.memories.delete(owner, current.id, `before restoring checkpoint ${id}`);
      for (const r of records) this.memories.restoreExact(owner, r);
      let restoredSkills = 0;
      for (const s of skills) restoredSkills += Number(this.db.prepare("UPDATE installed_skills SET active_version=? WHERE owner=? AND id=?").run(s.activeVersion, owner, s.id).changes);
      this.db.exec("COMMIT");
      return { id, memories: records.length, skills: restoredSkills };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  /** The memory snapshot a conversation started with; the same one is returned for the rest of that conversation. */
  sessionSnapshot(owner: string, sessionId: string, agent?: string): { text: string; count: number; reused: boolean; takenAt: string } {
    // FQ-routing.isolated-agents: one per conversation and per whoever answers in it, so a conversation the owner
    // re-chose for another Trunk never hands it the facts the first one was shown (the owner's own key is unchanged).
    const key = `memory-snapshot:${sessionId}${agent ? `:${agent}` : ""}`;
    const saved = this.db.prepare("SELECT data FROM settings WHERE owner=? AND id=?").get(owner, key);
    if (saved) return { ...(JSON.parse(String(saved.data)) as { text: string; count: number; takenAt: string }), reused: true };
    const lines: string[] = []; let chars = 0;
    const binned = binnedRuns(this.db); // a fact a conversation in Recently Deleted taught is not handed to a new one
    const ordered = (this.orderFacts?.(owner, agent, sessionId) ?? this.memories.list(owner).filter((r) => visibleTo(r, agent)))
      .filter((r) => !learnedInBin(binned, r.data) && isCurrentFact(r)); // SELF-202: a fact a newer one ended is not current
    const limits = this.snapshotLimits?.(owner) ?? memorySnapshotLimits; // R17-S13
    for (const record of ordered.slice(0, limits.facts)) {
      const line = `- ${String(record.data.text).replace(/\s+/g, " ").trim()}`;
      if (chars + line.length > limits.chars) break;
      lines.push(line); chars += line.length + 1;
    }
    const snapshot = { text: lines.join("\n"), count: lines.length, takenAt: new Date().toISOString() };
    this.db.prepare("INSERT INTO settings VALUES(?,?,?,?,?) ON CONFLICT(id,owner) DO UPDATE SET data=excluded.data").run(key, owner, JSON.stringify(snapshot), snapshot.takenAt, snapshot.takenAt);
    return { ...snapshot, reused: false };
  }
}
