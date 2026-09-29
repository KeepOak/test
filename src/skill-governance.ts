import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Store } from "./store.js";
import type { Runtime } from "./runtime.js";
import type { SkillCatalogEntry } from "./skills.js";
import { evaluateChecks, CompletionCheckSchema } from "./reliability.js";

/**
 * Skill governance: remembers how skills fail, keeps a skill with an active failure pattern out of
 * new tasks (with one recovery trial after a cool-off), demotes a skill whose failures pile up,
 * benchmarks two versions of a skill on the same tasks, and drafts a new version from a task that
 * went well. Every decision is recorded on the run it affected.
 */
export const GovernanceSettingsSchema = z.object({
  /** Failures with the same pattern inside the window before a skill is set aside. */
  excludeAfterFailures: z.number().int().min(1).max(10).default(2),
  windowMinutes: z.number().int().min(5).max(43200).default(1440),
  /** After this long a set-aside skill gets one trial; success clears the pattern. */
  recoveryAfterMinutes: z.number().int().min(1).max(10080).default(60),
  /** Total failures in the window before the skill's active version is disabled (0 = never). */
  demoteAfterFailures: z.number().int().min(0).max(20).default(4),
}).strict();
export type GovernanceSettings = z.infer<typeof GovernanceSettingsSchema>;
interface Failure { skillId: string; signature: string; runId: string; at: string }
interface Exclusion { skillId: string; signature: string; since: string; until: string; trialRunId: string | null; trials: number }
export const BenchmarkInputSchema = z.object({
  skillId: z.string().uuid(),
  baselineVersion: z.number().int().min(1).max(20),
  candidateVersion: z.number().int().min(1).max(20),
  tasks: z.array(z.object({ prompt: z.string().trim().min(1).max(4000), checks: CompletionCheckSchema.optional() }).strict()).min(1).max(8),
  seed: z.string().max(64).default("default"),
}).strict();
/** A stable, short form of a failure reason so repeats can be recognised. */
export function failureSignature(reason: string): string {
  return reason.toLowerCase().replace(/[0-9a-f]{8,}/g, "#").replace(/\d+/g, "#").replace(/\s+/g, " ").trim().slice(0, 80);
}

export class SkillGovernance {
  constructor(private readonly store: Store, private readonly owner: string, public now: () => Date = () => new Date()) {}
  settings(): GovernanceSettings {
    const saved = this.store.get("settings", this.owner, "governance")?.data;
    const parsed = GovernanceSettingsSchema.safeParse(saved ?? {});
    return parsed.success ? parsed.data : GovernanceSettingsSchema.parse({});
  }
  configure(input: unknown): GovernanceSettings {
    const value = GovernanceSettingsSchema.parse(input);
    this.store.save("settings", this.owner, "governance", value);
    return value;
  }
  /** Skills a run read or had pinned, from its events. */
  skillsUsed(runId: string): string[] {
    const ids = new Set<string>();
    for (const event of this.store.events(runId)) {
      if (event.kind === "skills.pinned") ids.add(String(event.data.id));
      if (event.kind === "tool.completed" && event.data.name === "skills.read") { const id = (event.data.result as { id?: string } | undefined)?.id; if (id) ids.add(id); }
    }
    return [...ids];
  }
  private failures(skillId: string): Failure[] {
    const cutoff = new Date(this.now().getTime() - this.settings().windowMinutes * 60000).toISOString();
    return this.store.list("governance", this.owner).filter((r) => r.id.startsWith(`failure:${skillId}:`)).map((r) => r.data as unknown as Failure).filter((f) => f.at >= cutoff);
  }
  exclusion(skillId: string): Exclusion | undefined {
    return this.store.get("governance", this.owner, `exclusion:${skillId}`)?.data as unknown as Exclusion | undefined;
  }
  exclusions(): Exclusion[] {
    return this.store.list("governance", this.owner).filter((r) => r.id.startsWith("exclusion:")).map((r) => r.data as unknown as Exclusion);
  }
  /** Records how a finished run went for every skill it used; may set a skill aside or demote it. */
  recordOutcome(runId: string, status: string, reason: string): void {
    const used = this.skillsUsed(runId);
    if (!used.length) return;
    for (const skillId of used) {
      const active = this.exclusion(skillId);
      if (status === "completed") { if (active?.trialRunId === runId) this.clear(skillId, runId); continue; }
      const failure: Failure = { skillId, signature: failureSignature(reason || status), runId, at: this.now().toISOString() };
      this.store.save("governance", this.owner, `failure:${skillId}:${randomUUID()}`, { ...failure });
      this.judge(skillId, failure, runId);
    }
  }
  private judge(skillId: string, failure: Failure, runId: string): void {
    const settings = this.settings(), all = this.failures(skillId), same = all.filter((f) => f.signature === failure.signature);
    if (same.length >= settings.excludeAfterFailures) {
      const until = new Date(this.now().getTime() + settings.recoveryAfterMinutes * 60000).toISOString();
      const previous = this.exclusion(skillId);
      const exclusion: Exclusion = { skillId, signature: failure.signature, since: previous?.since ?? this.now().toISOString(), until, trialRunId: null, trials: previous?.trials ?? 0 };
      this.store.save("governance", this.owner, `exclusion:${skillId}`, { ...exclusion });
      this.store.event(runId, "skill.set_aside", { skillId, signature: failure.signature, failures: same.length, until });
    }
    if (settings.demoteAfterFailures && all.length >= settings.demoteAfterFailures) this.demote(skillId, runId, all.length);
  }
  private demote(skillId: string, runId: string, failures: number): void {
    try {
      const view = this.store.skills.view(this.owner, skillId);
      if (view.activeVersion === null) return;
      this.store.skills.disable(this.owner, skillId, { expectedRevision: view.revision });
      this.store.event(runId, "skill.demoted", { skillId, name: view.name, failures, version: view.activeVersion });
    } catch { /* the skill may already be gone or changing; demotion is best effort */ }
  }
  private clear(skillId: string, runId: string): void {
    this.store.delete("governance", this.owner, `exclusion:${skillId}`);
    for (const record of this.store.list("governance", this.owner)) if (record.id.startsWith(`failure:${skillId}:`)) this.store.delete("governance", this.owner, record.id);
    this.store.event(runId, "skill.recovered", { skillId });
  }
  /** Removes set-aside skills from a run's catalog, granting one recovery trial once the cool-off has passed. */
  filterCatalog(entries: SkillCatalogEntry[], runId: string): SkillCatalogEntry[] {
    const now = this.now().toISOString();
    return entries.filter((entry) => {
      const exclusion = this.exclusion(entry.id);
      if (!exclusion) return true;
      if (exclusion.until <= now && !exclusion.trialRunId) {
        this.store.save("governance", this.owner, `exclusion:${entry.id}`, { ...exclusion, trialRunId: runId, trials: exclusion.trials + 1 });
        if (runId) this.store.event(runId, "skill.recovery_trial", { skillId: entry.id, trial: exclusion.trials + 1, signature: exclusion.signature });
        return true;
      }
      if (runId) this.store.event(runId, "skill.excluded", { skillId: entry.id, reason: `set aside after repeated failures (${exclusion.signature}) until ${exclusion.until}` });
      return false;
    });
  }
  /** Lets a set-aside skill back in right away. */
  restore(skillId: string): void { this.store.delete("governance", this.owner, `exclusion:${skillId}`); }
  /** Runs the same tasks under two versions of a skill and keeps every outcome and cost. */
  async benchmark(runtime: Runtime, input: unknown) {
    const spec = BenchmarkInputSchema.parse(input);
    const documents = { baseline: this.store.skills.read(this.owner, spec.skillId, { version: spec.baselineVersion }).document, candidate: this.store.skills.read(this.owner, spec.skillId, { version: spec.candidateVersion }).document };
    const parent = await runtime.run({ prompt: `Benchmark skill ${spec.skillId}: v${spec.baselineVersion} against v${spec.candidateVersion} on ${spec.tasks.length} task(s)` });
    const context = runtime.context({ runId: parent.id });
    const results: { task: number; side: "baseline" | "candidate"; runId: string; status: string; passed: boolean; problem: string | null; ms: number; tokens: number }[] = [];
    for (const [index, task] of spec.tasks.entries()) for (const side of ["baseline", "candidate"] as const) {
      const started = Date.now();
      const run = await runtime.delegate(task.prompt, context, [...context.permissions].filter((p) => !["shell.execute", "remote.execute", "git.remote", "github.manage", "gitlab.manage"].includes(p)), `Skill under test (${side}, seed ${spec.seed}):\n${documents[side]}`, { timeoutMs: 120000 });
      const usage = this.store.usage(run.id) as { estimatedInput?: number; estimatedOutput?: number };
      const problem = task.checks && run.status === "completed" ? await evaluateChecks(run.output, task.checks, runtime.workspace) : null;
      results.push({ task: index, side, runId: run.id, status: run.status, passed: run.status === "completed" && !problem, problem, ms: Date.now() - started, tokens: (usage.estimatedInput ?? 0) + (usage.estimatedOutput ?? 0) });
    }
    const summary = (side: "baseline" | "candidate") => { const rows = results.filter((r) => r.side === side); return { passed: rows.filter((r) => r.passed).length, ms: rows.reduce((a, r) => a + r.ms, 0), tokens: rows.reduce((a, r) => a + r.tokens, 0) }; };
    const record = { id: randomUUID(), skillId: spec.skillId, baselineVersion: spec.baselineVersion, candidateVersion: spec.candidateVersion, seed: spec.seed, preset: runtime.models.plan(this.owner, parent.sessionId).choice.presetId, parentRunId: parent.id, tasks: results, summary: { baseline: summary("baseline"), candidate: summary("candidate") }, createdAt: this.now().toISOString() };
    this.store.save("governance", this.owner, `benchmark:${record.id}`, record);
    this.store.event(parent.id, "skill.benchmarked", { id: record.id, summary: record.summary });
    return record;
  }
  benchmarks() {
    return this.store.list("governance", this.owner).filter((r) => r.id.startsWith("benchmark:")).map((r) => r.data);
  }
  /** Drafts a new, inactive version of a skill from a task that went well; the original version stays. */
  async proposeFromRun(runtime: Runtime, skillId: string, runId: string) {
    const skill = this.store.skills.view(this.owner, skillId), source = this.store.run(runId);
    if (!source || source.owner !== this.owner) throw new Error("Run not found");
    const transcript = this.store.messages(source.sessionId).filter((m) => m.role !== "system").map((m) => `${m.role}: ${m.content.slice(0, 1200)}`).join("\n").slice(0, 9000);
    const parent = await runtime.run({ prompt: `Draft an improved version of skill "${skill.name}" from task ${runId}` });
    const child = await runtime.delegate(`Current SKILL.md:\n${skill.document}\n\nA task where this skill was used and things went well:\n${transcript}\n\nWrite the improved SKILL.md. Keep the same name line. Reply with the full document only, starting with ---.`,
      runtime.context({ runId: parent.id }), [], "You improve skill documents from real task traces. Output only the document.", { timeoutMs: 120000 });
    if (child.status !== "completed") throw new Error(`The draft could not be produced (${child.status})`);
    const document = child.output.replace(/^```[a-z]*\n?|```$/g, "").trim();
    const updated = this.store.skills.update(this.owner, skillId, { document, expectedRevision: skill.revision });
    this.store.save("settings", this.owner, `skill-candidate:${skillId}:${updated.headVersion}`, { fromRunId: runId, draftRunId: child.id, createdAt: this.now().toISOString() });
    this.store.event(parent.id, "skill.candidate_drafted", { skillId, version: updated.headVersion, fromRunId: runId, activeVersion: updated.activeVersion });
    return { skill: updated, candidateVersion: updated.headVersion, originalVersion: skill.headVersion, fromRunId: runId };
  }
}
