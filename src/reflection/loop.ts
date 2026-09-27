import type { Message, Run } from "../contracts.js";
import type { Store } from "../store.js";
import type { Runtime } from "../runtime.js";
import type { ToolRegistry } from "../registry.js";
import type { Proposal } from "../memory-review.js";
import { learningTask, learningTaskPrefix } from "../skill-authoring.js";
import { asLines, ownersTask, turnsOf } from "./evidence.js";
import { LearningJobs } from "./jobs.js";
import { NewSkillDrafts, type NewSkillDraft } from "./new-skills.js";
import { batchRecords, lookBack, turnsDue, type Ask, type Batch, type LookTrigger } from "./pass.js";
import { offerRetirements } from "./retire.js";
import { reflectionSettings, saveReflectionSettings, type ReflectionSettings } from "./settings.js";
import { SkillNotes } from "./skill-notes.js";
import { syncLearnTool } from "./tool.js";

/**
 * Memory and skills that keep themselves in shape: the one object the rest of Branch talks to.
 * It owns the two switches, the look-back batches, the new-skill drafts and the background jobs.
 */
export interface BatchView extends Batch { proposals: Proposal[] }
const learnCommand = /^\/learn\b\s*/i;
/** A conversation without its "/learn" requests and the replies to them: those are asks, not evidence. */
function withoutLearnTurns(messages: Message[]): Message[] {
  let skipping = false;
  return messages.filter((message) => {
    if (message.role === "user") skipping = learnCommand.test(message.content.trim());
    return !skipping;
  });
}

export class LearningLoop {
  readonly jobs: LearningJobs;
  readonly drafts: NewSkillDrafts;
  readonly notes: SkillNotes;
  private readonly looking = new Set<string>();
  constructor(private readonly store: Store, private readonly runtime: Runtime, private readonly registry: ToolRegistry, readonly owner: string) {
    this.jobs = new LearningJobs(store, owner);
    this.drafts = new NewSkillDrafts(store, owner, runtime);
    this.notes = new SkillNotes(store, runtime, this.drafts, this.jobs);
    syncLearnTool(registry, this);
  }
  settings(): ReflectionSettings { return reflectionSettings(this.store, this.owner); }
  configure(input: unknown): ReflectionSettings {
    const saved = saveReflectionSettings(this.store, this.owner, input);
    syncLearnTool(this.registry, this);
    return saved;
  }
  idle(): Promise<void> { return this.jobs.idle(); }

  batches(): BatchView[] {
    const all = new Map(this.store.review.proposals(this.owner, "all").map((proposal) => [proposal.id, proposal]));
    return batchRecords(this.store, this.owner).map((batch) => ({
      ...batch, proposals: batch.proposalIds.map((id) => all.get(id)).filter((p): p is Proposal => !!p),
    }));
  }
  /** Says yes or no to every suggestion in a batch that is still waiting; one that fails is reported, not fatal. */
  async decideBatch(batchId: string, accept: boolean): Promise<{ decided: number; problems: string[] }> {
    const batch = this.batches().find((entry) => entry.id === batchId);
    if (!batch) throw new Error("There is no such look back");
    const problems: string[] = [];
    let decided = 0;
    for (const proposal of batch.proposals.filter((p) => p.status === "pending")) {
      try { await this.store.review.decide(this.owner, proposal.id, accept); decided++; }
      catch (error) { problems.push(`${proposal.text.slice(0, 80) || proposal.kind}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    return { decided, problems };
  }

  /** A look back the owner asked for, at one conversation or the most recent one with new turns. */
  async lookBackNow(sessionId?: string): Promise<Batch | null> {
    if (this.settings().reflection === "off") throw new Error("Looking back is switched off. Turn it on first.");
    const target = sessionId ?? this.latestSession();
    if (!target) return null;
    if (!this.store.ownsSession(this.owner, target)) throw new Error("Conversation not found");
    const { parent, context } = learningTask(this.store, this.owner, "Look back over a conversation", this.runtime);
    const ask: Ask = async (instructions, question) => {
      const child = await this.runtime.delegate(question, context, [], instructions, { timeoutMs: 120000 });
      if (child.status !== "completed") throw new Error(`The look back did not finish (${child.status})`);
      return child.output;
    };
    try {
      const batch = await this.look(target, parent.id, "asked", ask);
      this.store.finish(parent.id, "completed", batch ? `${batch.proposalIds.length} suggestion(s)` : "Nothing new to read");
      return batch;
    } catch (error) {
      this.store.finish(parent.id, "failed", error instanceof Error ? error.message : String(error));
      throw error;
    }
  }
  private latestSession(): string | undefined {
    return this.store.runs(this.owner).find((run) => ownersTask(this.store, run) && !this.store.sessionTemporary(run.sessionId))?.sessionId;
  }
  private async look(sessionId: string, runId: string, trigger: LookTrigger, ask: Ask): Promise<Batch | null> {
    if (this.looking.has(sessionId)) throw new Error("That conversation is already being looked back over");
    this.looking.add(sessionId);
    try { return await lookBack(this.store, { owner: this.owner, sessionId, runId, trigger, ask }); }
    finally { this.looking.delete(sessionId); }
  }

  /** "Make this into a skill": drafts from a conversation, in the background. */
  learn(input: { sessionId: string; notes?: string; runId?: string }): { drafting: true } {
    this.drafts.allowed("asked");
    if (!this.store.ownsSession(this.owner, input.sessionId)) throw new Error("Conversation not found");
    const evidence = asLines(withoutLearnTurns(turnsOf(this.store, input.sessionId)), 10000);
    if (!evidence.trim()) throw new Error("That conversation has nothing in it to learn from yet.");
    const source = this.store.runs(this.owner).find((run) => run.sessionId === input.sessionId && ownersTask(this.store, run) && !learnCommand.test(run.prompt));
    if (input.runId) this.store.event(input.runId, "skill.learn_started", { sessionId: input.sessionId });
    this.jobs.start("Make a conversation into a skill", async () => {
      const draft = await this.drafts.draft({ evidence, notes: input.notes ?? "", fromRunId: source?.id ?? "",
        sessionId: input.sessionId, sourcePrompt: source?.prompt ?? "", origin: "asked" });
      return draft ? `Drafted ${draft.name}.` : "Nothing in that conversation was worth a skill.";
    });
    return { drafting: true };
  }
  sessionOf(runId: string): string | undefined {
    const run = this.store.run(runId);
    return run && run.owner === this.owner ? run.sessionId : undefined;
  }
  offerRetirements(now = new Date()) { return offerRetirements(this.store, this.owner, now); }
  newSkills(): NewSkillDraft[] { return this.drafts.list(); }

  /** Called by the runtime once a task of the owner's has settled (src/reflection/hook.ts). */
  async afterTask(run: Run, ask: Ask, fromChat = false): Promise<void> {
    if (run.prompt.startsWith(learningTaskPrefix) || this.store.sessionTemporary(run.sessionId)) return;
    const settings = this.settings();
    // "/learn" is the owner's word; a chat message cannot prove who is typing, so from a chat it is ordinary text.
    const asked = fromChat ? null : learnCommand.exec(run.prompt.trim());
    if (asked && settings.newSkills !== "off" && !this.store.events(run.id).some((event) => event.kind === "skill.learn_started")) {
      try { this.learn({ sessionId: run.sessionId, notes: run.prompt.trim().slice(asked[0].length), runId: run.id }); }
      catch (error) { this.jobs.start("Make a conversation into a skill", () => Promise.reject(error)); }
    }
    // Seasons: no skill is drafted after a task just because it used several tools. A skill has to earn its place
    // through one of the owner's four triggers, and the Gardener drafts and proves it overnight (src/seasons/).
    if (settings.reflection === "off" || this.looking.has(run.sessionId)) return;
    const compacted = this.store.events(run.id).some((event) => event.kind === "context.compacted");
    const trigger: LookTrigger | null = compacted ? "compaction"
      : settings.reflection === "on" && turnsDue(this.store, this.owner, run.sessionId) ? "turns" : null;
    if (!trigger) return;
    this.jobs.start("Look back over a conversation", async () => {
      const batch = await this.look(run.sessionId, run.id, trigger, ask);
      return batch ? `${batch.proposalIds.length} suggestion(s) to review.` : "Nothing new to read.";
    });
  }
}
