import { Curator } from "../learning-more/curator.js";
import type { ModelPreset } from "../models.js";
import type { Runtime } from "../runtime.js";
import { draftFromNote, draftNewSkill } from "../skill-authoring.js";
import type { Store } from "../store.js";
import { typedBy } from "./evidence.js";
import { GardenBook, type LedgerEntry, type Proof, type Seed, type SkillState } from "./garden-book.js";
import { prove, type ProofParts } from "./proof.js";
import { seasonsSettings, type SeasonsSettings } from "./settings.js";
import { asked, lessons, recurring, type Planting, type TaskFacts } from "./triggers.js";

/**
 * The Gardener: skills that earn their place. Compared with Hermes Agent's curator in docs/seasons.md.
 *
 * - Seeds come only from the owner's four triggers (src/seasons/triggers.ts); a task that merely used several tools
 *   makes none.
 * - Each night it drafts at most `perNight` seeds on the night's free model, and proves each: the seed's own tasks are
 *   replayed with the draft and without it (src/seasons/proof.ts). It is adopted only when the proof shows a
 *   measurable gain; otherwise it is discarded with the reason. Every adopted skill is short and loads only when
 *   needed (its one-line index entry, #471), and the cap is on what those lines cost, not on how many there are.
 * - Later nights re-prove one adopted skill each; one that has regressed is rolled back by itself.
 * - Grafting (merging two it adopted), pruning (setting aside what nothing uses) and re-rooting (bringing one back)
 *   are written in the ledger with what they changed, and each can be undone. Nothing is ever deleted: a skill is
 *   switched off, and a discarded draft's file is kept in its seed.
 *
 * Skills are the owner's, so the Gardener reads only the owner's own typed requests, never a household person's.
 */
export interface GardenReport { planted: number; adopted: number; discarded: number; rolledBack: number; pruned: number; grafted: number }
export interface GardenStep { preset: ModelPreset; stillQuiet: () => boolean; now: Date }
/** How many seeds are drafted and proved in one night, so a night stays small. */
export const perNight = 2;
const dayMs = 86_400_000;

export class Gardener {
  readonly book: GardenBook;
  /** Replaced in tests; the real replay and grading otherwise. */
  proofParts?: (preset: ModelPreset) => ProofParts;
  constructor(private readonly store: Store, private readonly runtime: Runtime) {
    this.book = new GardenBook(store.sqlite, runtime.owner);
  }
  private get owner(): string { return this.runtime.owner; }
  settings(): SeasonsSettings { return seasonsSettings(this.store, this.owner); }

  /** The owner's own finished or failed tasks, newest first, each with the tools it used. */
  private tasks(): TaskFacts[] {
    return this.store.runs(this.owner).filter((run) => (run.status === "completed" || run.status === "failed") && typedBy(this.store, run, null))
      .map((run) => ({ run, tools: [...new Set(this.store.events(run.id).filter((event) => event.kind === "tool.completed")
        .map((event) => String(event.data.name)))] }));
  }
  /** Plants a seed for each trigger that fired since the last night. Nothing is drafted here and no model is asked. */
  plantFromTriggers(): Seed[] {
    const tasks = this.tasks(), seeds = this.book.seeds(), governance = this.store.governanceFor(this.owner);
    const found: Planting[] = [...asked(tasks, seeds), ...lessons(tasks, seeds), ...recurring(tasks, seeds, (id) => governance.skillsUsed(id).length > 0)];
    return found.map((planting) => this.book.plant(planting));
  }
  /** Trigger 4: Budding built a capability and asks for it to be kept as a skill (src/seasons/budding.ts). */
  plantBud(planting: Omit<Planting, "trigger">): Seed { return this.book.plant({ ...planting, trigger: "budding" }); }

  /** The night's garden work, after Rings has read the day. Stops between steps once the owner is back. */
  async night(step: GardenStep): Promise<GardenReport> {
    const report: GardenReport = { planted: 0, adopted: 0, discarded: 0, rolledBack: 0, pruned: 0, grafted: 0 };
    if (this.settings().gardener === "off") return report;
    report.planted = this.plantFromTriggers().length;
    for (const seed of this.book.seeds().filter((entry) => entry.status === "waiting").slice(0, perNight)) {
      if (!step.stillQuiet()) return report;
      const grown = await this.grow(seed, step.preset, step.now);
      report[grown.status === "adopted" ? "adopted" : "discarded"]++;
    }
    if (step.stillQuiet() && await this.recheck(step)) report.rolledBack++;
    if (step.stillQuiet() && await this.graft(step.preset)) report.grafted++;
    if (step.stillQuiet()) report.pruned = this.prune(step.now);
    return report;
  }

  /**
   * Drafts one seed, keeps it short and within the index budget, proves it, and adopts or discards it. The decision is
   * dated on the night's own clock (`now`), the clock `recheck` and `prune` read it on: dated on the computer's clock
   * instead, a night whose clock ran ahead found the skill it had just adopted due for a re-proof that same night.
   */
  async grow(seed: Seed, preset: ModelPreset, now: Date = new Date()): Promise<Seed> {
    const settings = this.settings();
    let drafted: Awaited<ReturnType<typeof draftNewSkill>>;
    try {
      drafted = await draftNewSkill(this.store, this.owner, this.runtime,
        { evidence: seed.evidence.slice(0, 12000), notes: "Keep it short: at most 25 lines.", fromRunId: seed.sourceRunIds[0] ?? "" }, { model: preset.id });
    } catch (error) { return this.discard(seed, `not-drafted: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300), null, now); }
    if (!drafted) return this.discard(seed, "nothing-worth-a-skill", null, now);
    const withDraft = this.book.saveSeed({ ...seed, skillId: drafted.skillId, name: drafted.name, document: drafted.document });
    if (drafted.document.length > settings.maxSkillChars) return this.discard(withDraft, "too-long", null, now);
    if (this.indexCost() + lineCost(drafted.name, drafted.description) > settings.indexBudget) return this.discard(withDraft, "over-budget", null, now);
    const proof = await prove(this.store, this.runtime, preset, { tasks: seed.tasks, withDocument: drafted.document, baseline: null, label: drafted.name }, this.parts(preset));
    const proved = this.book.saveSeed({ ...withDraft, proofs: [proof] });
    if (proof.unreadable) return this.discard(proved, `unreadable: ${proof.unreadable}`, proof, now);
    if (proof.gain < settings.minGain) return this.discard(proved, "no-gain", proof, now);
    return this.adopt(proved, proof, now);
  }
  private parts(preset: ModelPreset): ProofParts | undefined { return this.proofParts?.(preset); }

  private adopt(seed: Seed, proof: Proof, now: Date): Seed {
    const skill = this.store.skills.view(this.owner, seed.skillId!);
    // Never with `acknowledge`: a draft with a scan finding is refused when it is written, and never waved through here.
    this.store.skills.activate(this.owner, skill.id, { version: skill.headVersion, expectedRevision: skill.revision });
    this.book.write({ action: "adopted", seedId: seed.id, name: skill.name, reason: `gain ${proof.gain}`, proof,
      before: [{ skillId: skill.id, activeVersion: null }], after: [{ skillId: skill.id, activeVersion: skill.headVersion }] });
    return this.book.saveSeed({ ...seed, status: "adopted", reason: null, decidedAt: now.toISOString(), checkedAt: now.toISOString() });
  }
  /**
   * A draft that did not earn its place. Its switched-off install, which nothing ever used, is taken out of the
   * skills list, and its whole file stays in the seed, so undoing the discard puts it back exactly.
   */
  private discard(seed: Seed, reason: string, proof: Proof | null, now: Date): Seed {
    if (seed.skillId) {
      try {
        const skill = this.store.skills.view(this.owner, seed.skillId);
        if (skill.activeVersion === null) this.store.skills.remove(this.owner, skill.id, { expectedRevision: skill.revision });
      } catch { /* not installed: the seed still records the draft */ }
    }
    this.book.write({ action: "discarded", seedId: seed.id, name: seed.name ?? seed.trigger, reason, proof, before: [], after: [] });
    return this.book.saveSeed({ ...seed, status: "discarded", reason, decidedAt: now.toISOString() });
  }

  /** What the one-line index entries of the skills the Gardener adopted cost, in tokens. */
  indexCost(): number {
    return this.adoptedSkills().reduce((sum, skill) => sum + lineCost(skill.name, skill.description), 0);
  }
  private adoptedSkills() {
    const ids = new Set(this.book.seeds().filter((seed) => seed.status === "adopted" && seed.skillId).map((seed) => seed.skillId!));
    return this.store.skills.list(this.owner).filter((skill) => ids.has(skill.id) && skill.activeVersion !== null);
  }

  /** Re-proves the adopted skill checked longest ago; one that regressed is switched off by itself. True when rolled back. */
  async recheck(step: GardenStep): Promise<boolean> {
    const settings = this.settings();
    const due = this.book.seeds().filter((seed) => seed.status === "adopted" && seed.skillId && seed.tasks.length && !seed.pinned
      && step.now.getTime() - Date.parse(seed.checkedAt ?? seed.decidedAt ?? seed.createdAt) >= dayMs / 2)
      .sort((a, b) => (a.checkedAt ?? "").localeCompare(b.checkedAt ?? ""))[0];
    if (!due) return false;
    const skill = this.store.skills.view(this.owner, due.skillId!);
    if (skill.activeVersion === null) return false;
    const document = this.store.skills.read(this.owner, skill.id, { version: skill.activeVersion }).document;
    const proof = await prove(this.store, this.runtime, step.preset, { tasks: due.tasks, withDocument: document, baseline: null, label: skill.name }, this.parts(step.preset));
    const adoptedWith = due.proofs[0]?.with.mean ?? 0;
    const checked = this.book.saveSeed({ ...due, proofs: [...due.proofs, proof].slice(-20), checkedAt: step.now.toISOString() });
    if (proof.unreadable || (proof.gain >= 0 && proof.with.mean >= adoptedWith - settings.minGain)) return false;
    this.setActive([{ skillId: skill.id, activeVersion: null }]);
    this.book.write({ action: "rolled-back", seedId: due.id, name: skill.name, proof, reason: `gain ${proof.gain}`,
      before: [{ skillId: skill.id, activeVersion: skill.activeVersion }], after: [{ skillId: skill.id, activeVersion: null }] });
    this.book.saveSeed({ ...checked, status: "rolled-back", reason: "regressed" });
    return true;
  }

  /**
   * Grafting: two skills the Gardener adopted that say much the same thing become one. The kept skill gets a merged
   * version, proved against the two it replaces on both skills' tasks; only when it does no worse is it switched on
   * and the other switched off. True when a graft was made.
   */
  async graft(preset: ModelPreset): Promise<boolean> {
    const adopted = new Map(this.book.seeds().filter((seed) => seed.status === "adopted" && seed.skillId).map((seed) => [seed.skillId!, seed]));
    const overlap = new Curator(this.store).overlaps(this.owner).find((pair) => adopted.has(pair.a.id) && adopted.has(pair.b.id)
      && !adopted.get(pair.a.id)!.pinned && !adopted.get(pair.b.id)!.pinned);
    if (!overlap) return false;
    const keep = this.store.skills.view(this.owner, overlap.a.id), fold = this.store.skills.view(this.owner, overlap.b.id);
    if (keep.activeVersion === null || fold.activeVersion === null) return false;
    const plan = new Curator(this.store).dryRun(this.owner, { keepId: keep.id, foldId: fold.id });
    const drafted = await draftFromNote(this.store, this.owner, this.runtime, { skillId: keep.id, note: plan.note }, { model: preset.id });
    const merged = this.store.skills.read(this.owner, keep.id, { version: drafted.candidateVersion }).document;
    const tasks = [...adopted.get(keep.id)!.tasks.slice(0, 2), ...adopted.get(fold.id)!.tasks.slice(0, 2)];
    const baseline = `${this.store.skills.read(this.owner, keep.id, { version: keep.activeVersion }).document}\n\n${this.store.skills.read(this.owner, fold.id, { version: fold.activeVersion }).document}`;
    const proof = await prove(this.store, this.runtime, preset, { tasks, withDocument: merged, baseline, label: `${keep.name} + ${fold.name}` }, this.parts(preset));
    if (proof.unreadable || proof.gain < 0) return false;
    const before: SkillState[] = [{ skillId: keep.id, activeVersion: keep.activeVersion }, { skillId: fold.id, activeVersion: fold.activeVersion }];
    const after: SkillState[] = [{ skillId: keep.id, activeVersion: drafted.candidateVersion }, { skillId: fold.id, activeVersion: null }];
    this.setActive(after);
    this.book.write({ action: "grafted", seedId: adopted.get(keep.id)!.id, name: `${keep.name} + ${fold.name}`, reason: `gain ${proof.gain}`, proof, before, after });
    this.book.saveSeed({ ...adopted.get(fold.id)!, status: "archived", reason: `grafted into ${keep.name}` });
    return true;
  }

  /** Pruning: an adopted skill nothing has used for `archiveAfterDays` is switched off (never removed). */
  prune(now: Date): number {
    const settings = this.settings();
    let pruned = 0;
    for (const skill of this.adoptedSkills()) {
      const seed = this.book.seeds().find((entry) => entry.skillId === skill.id && entry.status === "adopted")!;
      if (seed.pinned || now.getTime() - this.lastUsed(skill.id, seed) < settings.archiveAfterDays * dayMs) continue;
      this.setActive([{ skillId: skill.id, activeVersion: null }]);
      this.book.write({ action: "pruned", seedId: seed.id, name: skill.name, proof: null, reason: "unused",
        before: [{ skillId: skill.id, activeVersion: skill.activeVersion }], after: [{ skillId: skill.id, activeVersion: null }] });
      this.book.saveSeed({ ...seed, status: "archived", reason: "unused" });
      pruned++;
    }
    return pruned;
  }
  /** When a skill was last drawn on by a task (or adopted, if it never was). */
  lastUsed(skillId: string, seed: Seed): number {
    const governance = this.store.governanceFor(this.owner);
    const used = this.store.runs(this.owner).find((run) => governance.skillsUsed(run.id).includes(skillId));
    return Math.max(Date.parse(used?.createdAt ?? "1970-01-01"), Date.parse(seed.decidedAt ?? seed.createdAt));
  }
  /** Active, stale or archived, as Hermes' curator names them. */
  stateOf(seed: Seed, now = new Date()): "active" | "stale" | "archived" | null {
    if (seed.status === "archived" || seed.status === "rolled-back") return "archived";
    if (seed.status !== "adopted" || !seed.skillId) return null;
    return now.getTime() - this.lastUsed(seed.skillId, seed) >= this.settings().staleAfterDays * dayMs ? "stale" : "active";
  }

  /** Puts each skill at the version named (null switches it off). A skill that is gone is left alone. */
  private setActive(states: SkillState[]): void {
    for (const state of states) {
      let skill: ReturnType<Store["skills"]["view"]>;
      try { skill = this.store.skills.view(this.owner, state.skillId); } catch { continue; }
      if (skill.activeVersion === state.activeVersion) continue;
      if (state.activeVersion === null) this.store.skills.disable(this.owner, skill.id, { expectedRevision: skill.revision });
      else this.store.skills.activate(this.owner, skill.id, { version: state.activeVersion, expectedRevision: skill.revision });
    }
  }
  /**
   * Undoes one ledger entry: every skill it touched goes back to the version it had before. Undoing a discard puts
   * the draft back from its seed, switched off and waiting to be proved again.
   */
  undo(id: string): LedgerEntry {
    const entry = this.book.entry(id);
    if (!entry) throw new Error("There is no such change");
    if (entry.undoneAt) throw new Error("That change is already undone");
    if (entry.action === "discarded") this.replant(entry);
    else this.setActive(entry.before);
    this.afterUndo(entry);
    return this.book.saveEntry({ ...entry, undoneAt: new Date().toISOString() });
  }
  /** What undoing an entry means for the seeds it touched. An undone rollback is pinned, so it is not rolled back again. */
  private afterUndo(entry: LedgerEntry): void {
    const seed = entry.seedId ? this.book.seed(entry.seedId) : undefined;
    if (seed && (entry.action === "adopted" || entry.action === "re-rooted")) this.book.saveSeed({ ...seed, status: "archived", reason: "undone" });
    if (seed && (entry.action === "pruned" || entry.action === "rolled-back"))
      this.book.saveSeed({ ...seed, status: "adopted", reason: null, pinned: entry.action === "rolled-back" || seed.pinned });
    if (entry.action === "grafted") {
      const folded = entry.before[1]?.skillId;
      const other = this.book.seeds().find((candidate) => candidate.skillId === folded && candidate.status === "archived");
      if (other) this.book.saveSeed({ ...other, status: "adopted", reason: null });
    }
  }
  private replant(entry: LedgerEntry): void {
    const seed = entry.seedId ? this.book.seed(entry.seedId) : undefined;
    if (!seed) throw new Error("That draft is no longer kept");
    const installed = seed.document ? this.store.skills.install(this.owner, { document: seed.document }) : null;
    const off = installed && installed.activeVersion !== null ? this.store.skills.disable(this.owner, installed.id, { expectedRevision: installed.revision }) : installed;
    this.book.saveSeed({ ...seed, status: "waiting", skillId: off?.id ?? null, reason: null, decidedAt: null });
  }
  /** Re-rooting: brings back an adopted skill that was set aside, at the version it had. */
  reroot(seedId: string): LedgerEntry {
    const seed = this.book.seed(seedId);
    if (!seed?.skillId || (seed.status !== "archived" && seed.status !== "rolled-back")) throw new Error("Only a skill that was set aside can be brought back");
    const last = this.book.ledger(1000).find((entry) => entry.after.some((state) => state.skillId === seed.skillId && state.activeVersion === null)
      && entry.before.some((state) => state.skillId === seed.skillId && state.activeVersion !== null));
    const version = last?.before.find((state) => state.skillId === seed.skillId)?.activeVersion ?? this.store.skills.view(this.owner, seed.skillId).headVersion;
    this.setActive([{ skillId: seed.skillId, activeVersion: version }]);
    this.book.saveSeed({ ...seed, status: "adopted", reason: null, pinned: true });
    return this.book.write({ action: "re-rooted", seedId: seed.id, name: seed.name ?? "", proof: null, reason: "owner",
      before: [{ skillId: seed.skillId, activeVersion: null }], after: [{ skillId: seed.skillId, activeVersion: version }] });
  }
  /** Pruning by the owner's hand: the skill is switched off now, whatever its use. */
  pruneSeed(seedId: string): LedgerEntry {
    const seed = this.book.seed(seedId);
    if (!seed?.skillId || seed.status !== "adopted") throw new Error("Only a skill the Gardener adopted can be set aside here");
    const skill = this.store.skills.view(this.owner, seed.skillId);
    this.setActive([{ skillId: skill.id, activeVersion: null }]);
    this.book.saveSeed({ ...seed, status: "archived", reason: "owner" });
    return this.book.write({ action: "pruned", seedId: seed.id, name: skill.name, proof: null, reason: "owner",
      before: [{ skillId: skill.id, activeVersion: skill.activeVersion }], after: [{ skillId: skill.id, activeVersion: null }] });
  }
  /** A pinned skill is never pruned, grafted or rolled back by itself. */
  pin(seedId: string, pinned: boolean): Seed {
    const seed = this.book.seed(seedId);
    if (!seed) throw new Error("There is no such seed");
    return this.book.saveSeed({ ...seed, pinned });
  }
}

/** Roughly what a skill's one-line index entry costs: its name and the first eight words of its description. */
export function lineCost(name: string, description: string): number {
  return Math.ceil((name.length + description.split(/\s+/).slice(0, 8).join(" ").length + 4) / 4);
}
