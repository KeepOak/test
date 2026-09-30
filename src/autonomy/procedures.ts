import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { Store } from "../store.js";
import { fingerprintOf, type Ledger, type LedgerEntry } from "./ledger.js";
import { permissionWords } from "./orders.js";
import { narrowed, type Runner } from "./runner.js";
import { quoteLine } from "./settings.js";
import { nextDue, StartSchema, startsAfter, startWords } from "./timing.js";
import { fanItems, kindOf, maxFanItems, parseWait, parseWhen, maxUnattendedTurns, needsUnattendedYes, says, StepSchema, stepTurns, subProblem, unattendedKinds, type Step } from "./step-kinds.js";

/**
 * R17-019: procedures that start themselves, each with its own autonomy level and success rate.
 *
 *   ask-each-step  every step waits for the owner's yes
 *   ask-to-start   the owner says yes once before it starts; then its steps run (the default)
 *   auto           it starts and runs by itself, within the owner's approval rules
 *
 * A step marked `confirm` always waits, whatever the level. A procedure already running is not
 * started again (a second start is dropped), and at most one start waits for an answer at a time.
 * Its success rate is finished-and-completed over everything that finished; an "auto" procedure that
 * falls under half after four runs goes back to asking before it starts, and the card says why.
 *
 * The levels, the per-step confirmation that overrides "auto", the coalescing of starts and the
 * completion rate follow ZeroClaw's SOP engine (`crates/zeroclaw-runtime/src/sop/`, MIT/Apache-2.0);
 * this is an independent, smaller implementation.
 */
export const levels = ["ask-each-step", "ask-to-start", "auto"] as const;
export type Level = (typeof levels)[number];

export const ProcedureSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).default(""),
  start: StartSchema,
  // A step's kind (src/autonomy/step-kinds.ts); a step with none asks a Trunk, as every step saved before kinds did.
  steps: z.array(StepSchema).min(1).max(12),
  level: z.enum(levels).default("ask-to-start"),
  permissions: z.array(z.string().max(100)).max(50).optional(),
  perDay: z.number().int().min(1).max(24).default(4),
}).strict();
export type Procedure = z.infer<typeof ProcedureSchema>;
/** A change the owner proposes to a kept procedure: its steps, and its start if that changes too. */
export const ProcedureChangeSchema = z.object({ steps: ProcedureSchema.shape.steps, start: StartSchema.optional() }).strict();
/** A change a Trunk (or Branch's own assistant) suggests: the same, with why it would help. */
export const ProcedureSuggestionSchema = ProcedureChangeSchema.extend({
  procedureId: z.string().uuid(),
  why: z.string().trim().min(1).max(300),
}).strict();
/** What a change is made against and what it makes, as kept in the waiting question; a suggestion also keeps why, and
    the Trunk it came from (none for Branch's own assistant). */
const ChangePayloadSchema = z.object({
  procedureId: z.string().uuid(),
  base: z.object({ steps: ProcedureSchema.shape.steps, start: StartSchema }).strict(),
  change: z.object({ steps: ProcedureSchema.shape.steps, start: StartSchema }).strict(),
  why: z.string().max(300).optional(),
  trunk: z.string().max(100).optional(),
}).strict();

type Outcome = "completed" | "failed" | "cancelled";
export interface ProcedureState {
  id: string;
  procedure: Procedure;
  status: "active" | "paused";
  nextDueAt: string | null;
  running: Running | null;
  stats: Record<Outcome, number>;
  recent: { at: string; outcome: Outcome; note: string }[];
  levelNote: string;
  createdAt: string;
  /** Which version of its steps is in use (1 until a change is approved), and since when. */
  version?: number;
  /** Invalidates an unanswered start or step when the owner changes its level or pauses it. */
  questionRevision?: number;
  changedAt?: string;
  /** The versions before it, oldest first, each with the steps and start it had and when it came into use. */
  history?: { version: number; steps: Procedure["steps"]; start: Procedure["start"]; from: string }[];
  /** The owner's own yes to what its Repeat, Split and gather and Run a flow steps could do unattended, by fingerprint. */
  unattended?: { fingerprint: string; at: string };
}
/**
 * Where a run is: the step, its conversation, what the step before said (for "If it says" and "Split and gather"), how many
 * requests it has made (never past `maxUnattendedTurns`), and what a "When" or "Wait" step is waiting for.
 */
interface Running {
  /** Each run has its own identity, even when two starts share a clock tick. */
  id?: string;
  step: number; sessionId: string | null; startedAt: string;
  last?: string; turns?: number; waitUntil?: string | null; waitFor?: string | null;
}
const keptVersions = 20;
/** A run held by a "When" or "Wait" step, until its moment or a task finishing carries it on. */
const waiting = (running: Running): boolean => !!running.waitUntil || typeof running.waitFor === "string";

const prefix = "autonomy-procedure:";
export const maxProcedures = 20;
const demoteAfter = 4;

export function successRate(stats: Record<Outcome, number>): number | null {
  const finished = stats.completed + stats.failed + stats.cancelled;
  return finished ? stats.completed / finished : null;
}

export interface ProceduresDeps {
  store: Store; owner: string; runner: Runner; ledger: Ledger; held: () => string[]; now?: () => Date;
  /** The owner's time zone, for a "When" step written as a time of day. */
  timezone?: () => string;
}

export class SelfStarting {
  private readonly work = new Set<Promise<unknown>>();
  constructor(private readonly deps: ProceduresDeps) {}
  private get now(): Date { return (this.deps.now ?? (() => new Date()))(); }

  /** Resolves once every step started so far has settled (for closing, and for tests). */
  async idle(): Promise<void> { while (this.work.size) await Promise.allSettled([...this.work]); }
  private track(promise: Promise<unknown>): void {
    const tracked = promise.catch(() => undefined).finally(() => this.work.delete(tracked));
    this.work.add(tracked);
  }

  list(): (ProcedureState & { successRate: number | null; starts: string })[] {
    return this.deps.store.list("settings", this.deps.owner).filter((r) => r.id.startsWith(prefix))
      .map((r) => r.data as unknown as ProcedureState)
      .map((s) => ({ ...s, successRate: successRate(s.stats), starts: startWords(s.procedure.start) }));
  }
  get(id: string): ProcedureState {
    const found = this.deps.store.get("settings", this.deps.owner, prefix + id)?.data as ProcedureState | undefined;
    if (!found) throw new Error("There is no procedure with that id.");
    return found;
  }
  private save(state: ProcedureState): ProcedureState {
    this.deps.store.save("settings", this.deps.owner, prefix + state.id, { ...state });
    return state;
  }

  /** The owner's own yes: the procedure is kept and starts on its trigger. */
  create(input: unknown): ProcedureState {
    const id = randomUUID(), procedure = this.settled(ProcedureSchema.parse(this.words(input)), id);
    if (this.list().length >= maxProcedures) throw new Error(`At most ${maxProcedures} procedures that start themselves.`);
    // Its Repeat, Split and gather and Run a flow steps are asked about on their own: this yes does not cover them.
    return this.deps.store.atomically(() => this.askIfUnattended(this.save({ id, procedure, status: "active", nextDueAt: nextDue(procedure.start, this.now), running: null,
      stats: { completed: 0, failed: 0, cancelled: 0 }, recent: [], levelNote: "", createdAt: this.now.toISOString() })));
  }

  propose(input: unknown): { waiting: boolean; id?: string } {
    const procedure = this.settled(ProcedureSchema.parse(this.words(input)));
    const entry = this.deps.ledger.ask({ kind: "procedure", from: "assistant",
      fingerprint: fingerprintOf("procedure", { ...procedure, name: procedure.name.toLowerCase() }),
      title: `Procedure: ${quoteLine(procedure.name, 80)}`,
      detail: [
        `${procedure.steps.length} step${procedure.steps.length === 1 ? "" : "s"}, starting ${startWords(procedure.start)}, level ${procedure.level}, at most ${procedure.perDay} times a day.`,
        ...procedure.steps.map((step, i) => stepLine(step, i)),
        permissionWords(procedure.permissions),
      ].join("\n"),
      payload: { procedure } });
    return entry ? { waiting: true, id: entry.id } : { waiting: false };
  }

  /**
   * The owner proposes changed steps (and start) for a kept procedure. It waits in the same list, for
   * the same yes, as a new procedure does; nothing changes until then. The question is fingerprinted
   * by what it changes from and to, so the same change asked again from the same steps is not asked twice,
   * and a no to it blocks only that.
   */
  proposeChange(id: string, input: unknown): { waiting: boolean; id?: string; said: string } {
    const asked = ProcedureChangeSchema.parse(this.words(input));
    const current = this.get(id).procedure;
    const base = { steps: current.steps, start: current.start };
    const change = { steps: this.settled(ProcedureSchema.parse({ ...current, steps: asked.steps }), id).steps, start: asked.start ?? current.start };
    if (isDeepStrictEqual(base, change)) throw new Error("Nothing changed: the steps and the start are the same as now.");
    const fingerprint = fingerprintOf("procedure-change", id, base, change);
    const entry = this.deps.ledger.ask({ kind: "procedure", from: "owner", fingerprint,
      title: `Change the procedure ${quoteLine(current.name, 80)}`,
      detail: [
        `From now on: ${change.steps.length} step${change.steps.length === 1 ? "" : "s"}, starting ${startWords(change.start)}. Its level, its runs and its record stay as they are.`,
        ...change.steps.map((step, i) => stepLine(step, i)),
      ].join("\n"),
      payload: { procedureId: id, base, change } });
    if (entry) return { waiting: true, id: entry.id, said: "Nothing about the procedure changes until you say yes to this change." };
    const already = this.deps.ledger.list("pending").find((e) => e.fingerprint === fingerprint);
    if (already) return { waiting: true, id: already.id, said: "This exact change already waits for your answer." };
    return { waiting: false, said: this.deps.ledger.refused(fingerprint) ? "You already said no to this exact change." : "This exact change was already answered." };
  }

  /**
   * A Trunk suggests a change to a kept procedure, with why. It waits for the owner's yes like the owner's own change,
   * and the flow editor shows it as that Trunk's suggestion. A no is kept against what it would change to, so the same
   * suggestion is never made again, even after other edits.
   */
  suggestChange(input: unknown, trunk?: string): { waiting: boolean; id?: string; said: string } {
    const { procedureId, why, ...asked } = ProcedureSuggestionSchema.parse(this.words(input));
    const current = this.get(procedureId).procedure;
    const base = { steps: current.steps, start: current.start };
    const change = { steps: this.settled(ProcedureSchema.parse({ ...current, steps: asked.steps }), procedureId).steps, start: asked.start ?? current.start };
    if (isDeepStrictEqual(base, change)) throw new Error("Nothing changed: the steps and the start are the same as now.");
    const fingerprint = fingerprintOf("procedure-suggestion", procedureId, change);
    const entry = this.deps.ledger.ask({ kind: "procedure", from: "assistant", fingerprint,
      title: `A change to the procedure ${quoteLine(current.name, 80)}`,
      detail: [
        `Why: ${quoteLine(why, 300)}`,
        `From now on: ${change.steps.length} step${change.steps.length === 1 ? "" : "s"}, starting ${startWords(change.start)}. Its level, its runs and its record stay as they are.`,
        ...change.steps.map((step, i) => stepLine(step, i)),
      ].join("\n"),
      payload: { procedureId, base, change, why, ...(trunk ? { trunk } : {}) } });
    if (entry) return { waiting: true, id: entry.id, said: "The owner sees this change in the procedure and in Inbox, Needs you. Nothing changes until they say yes." };
    return { waiting: false, said: this.deps.ledger.refused(fingerprint) ? "The owner already said no to this change; do not suggest it again." : "This change was already suggested." };
  }

  /**
   * The owner's yes to a proposed change: the same procedure, under the same id, with its record, runs
   * and level kept, and only its steps and start replaced. A change asked from steps that have changed
   * since, or while it runs, is refused, and the question keeps waiting with the reason.
   */
  applyChange(payload: unknown): ProcedureState {
    const { procedureId, base, change } = ChangePayloadSchema.parse(payload);
    const state = this.get(procedureId);
    if (state.running) throw new Error("It is running now, so the change waits. Answer again once it has finished.");
    if (!isDeepStrictEqual({ steps: state.procedure.steps, start: state.procedure.start }, base))
      throw new Error("Its steps or start changed after this was asked, so this change no longer fits. Say no to it and propose it again.");
    const procedure = this.settled(ProcedureSchema.parse({ ...state.procedure, steps: change.steps, start: change.start }), procedureId);
    const moved = !isDeepStrictEqual(state.procedure.start, procedure.start) && state.status === "active";
    // The steps it had are kept as the version before, so the owner can see them and go back to them.
    const version = state.version ?? 1, at = this.now.toISOString();
    const history = [...(state.history ?? []), { version, steps: state.procedure.steps, start: state.procedure.start, from: state.changedAt ?? state.createdAt }].slice(-keptVersions);
    return this.deps.store.atomically(() => this.askIfUnattended(this.save({ ...state, procedure, version: version + 1, changedAt: at, history, ...(moved ? { nextDueAt: nextDue(procedure.start, this.now) } : {}) })));
  }

  /** The owner changes the level or pauses it. Raising to "auto" clears the note about going back. */
  update(id: string, input: unknown): ProcedureState {
    const change = z.object({ level: z.enum(levels).optional(), paused: z.boolean().optional() }).strict().parse(input);
    const state = this.get(id);
    const stopPaused = change.paused === true || (change.paused === false && state.status === "paused");
    state.questionRevision = (state.questionRevision ?? 0) + 1;
    if (change.level) Object.assign(state, { procedure: { ...state.procedure, level: change.level }, levelNote: "" });
    if (change.paused !== undefined) Object.assign(state, { status: change.paused ? "paused" : "active",
      nextDueAt: change.paused ? state.nextDueAt : nextDue(state.procedure.start, this.now) });
    this.save(state);
    if (stopPaused) this.stopPaused(state, "You paused this flow.");
    return this.get(id);
  }

  private stopPaused(state: ProcedureState, reason: string): void {
    this.deps.runner.cancel((key) => key === `procedure:${state.id}`);
    this.deps.ledger.withdraw((entry) => entry.payload.procedureId === state.id && (entry.kind === "start" || entry.kind === "step"));
    if (state.running) this.finish(state.id, "cancelled", reason);
  }

  remove(id: string): { removed: boolean } {
    this.get(id);
    this.deps.runner.cancel((key) => key === `procedure:${id}`);
    this.deps.store.delete("settings", this.deps.owner, prefix + id);
    this.deps.ledger.withdraw((entry) => entry.payload.procedureId === id);
    return { removed: true };
  }

  /**
   * After a restart: a procedure marked running that is not waiting for the owner's answer, nor for a "When" or "Wait"
   * step's moment, was cut off, so it is finished as cancelled rather than left "running" and never started again.
   */
  recover(): void {
    for (const state of this.list()) {
      if (state.status === "paused") { this.stopPaused(state, "This flow was paused before Branch reopened."); continue; }
      if (!state.running || waiting(state.running)) continue;
      const asked = this.deps.ledger.pendingCount((e) => e.kind === "step" && e.payload.procedureId === state.id);
      if (!asked) this.finish(state.id, "cancelled", "Branch was closed while it was running.");
    }
  }

  async tick(): Promise<void> {
    const now = this.now.toISOString();
    for (const state of this.list()) {
      if (state.status !== "active") continue;
      // A "When" or "Wait" step whose moment has come carries on from the step after it.
      if (state.running?.waitUntil && state.running.waitUntil <= now) { this.resume(state.id); continue; }
      if (state.status !== "active" || !state.nextDueAt || state.nextDueAt > now) continue;
      this.save({ ...this.get(state.id), nextDueAt: nextDue(state.procedure.start, this.now) });
      this.trigger(state.id, "its clock came round");
    }
  }
  afterTask(prompt: string): void {
    for (const state of this.list()) {
      if (state.status !== "active") continue;
      const waitFor = state.running?.waitFor;
      if (typeof waitFor === "string" && (!waitFor || says(prompt, waitFor))) { this.resume(state.id); continue; }
      if (state.status === "active" && startsAfter(state.procedure.start, prompt)) this.trigger(state.id, "a task of yours finished");
    }
  }
  /** A "When" or "Wait" step's moment came: the run carries on from the step after it. */
  private resume(id: string): void {
    const state = this.get(id);
    if (state.status !== "active" || !state.running || !waiting(state.running)) return;
    this.save({ ...state, running: { ...state.running, step: state.running.step + 1, waitUntil: null, waitFor: null } });
    this.track(this.continueFrom(id, this.runId(state.running)));
  }

  /** A start: dropped while running, a question below "auto", and a run at "auto". */
  trigger(id: string, why: string): { started: boolean; reason: string } {
    const state = this.get(id);
    if (state.status !== "active") return { started: false, reason: "This flow is paused." };
    if (state.running) return { started: false, reason: "It is already running, so this start was dropped." };
    const held = this.unattendedBlock(state);
    if (held) return { started: false, reason: held };
    if (state.procedure.level === "auto") {
      this.track(this.begin(id));
      return { started: true, reason: "" };
    }
    if (this.deps.ledger.pendingCount((e) => e.kind === "start" && e.payload.procedureId === id))
      return { started: false, reason: "A start already waits for your answer." };
    this.deps.ledger.ask({ kind: "start", from: "procedure", fingerprint: fingerprintOf("start", id, randomUUID()),
      title: `Start "${quoteLine(state.procedure.name, 80)}"?`, detail: `It wants to start because ${why}.`, payload: { procedureId: id, scope: this.questionScope(state, false) } });
    return { started: false, reason: "It asked you first (Inbox, Needs you)." };
  }

  /** The owner's answer to a start or a step. */
  answered(entry: LedgerEntry, yes: boolean): void {
    const id = String(entry.payload.procedureId ?? "");
    const state = this.deps.store.get("settings", this.deps.owner, prefix + id)?.data as ProcedureState | undefined;
    if (!state) return;
    if (entry.kind === "start") { if (yes && !state.running) this.track(this.begin(id)); return; }
    const scope = entry.payload.scope as { running?: { startedAt?: string; id?: string } } | undefined;
    if (!state.running || state.running.step !== Number(entry.payload.step)
      || (scope && (scope.running?.startedAt !== state.running.startedAt || scope.running?.id !== this.runId(state.running)))) return;
    if (yes) this.track(this.runStep(id, true, this.runId(state.running)));
    else this.finish(id, "cancelled", `You said no to step ${state.running.step + 1}.`);
  }

  private questionScope(state: ProcedureState, step: boolean): unknown {
    return { version: state.version ?? 1, revision: state.questionRevision ?? 0, procedure: state.procedure,
      running: step && state.running ? { id: this.runId(state.running), startedAt: state.running.startedAt, step: state.running.step } : null };
  }

  /** An answer covers the exact version and run shown, never changed or resumed work. */
  requireQuestion(entry: LedgerEntry): void {
    const state = this.get(String(entry.payload.procedureId ?? ""));
    if (state.status !== "active" || !isDeepStrictEqual(entry.payload.scope, this.questionScope(state, entry.kind === "step"))
      || (entry.kind === "start" ? Boolean(state.running) : !state.running))
      throw new Error("This question no longer matches the active flow. Say no to it and start the flow again.");
  }

  /** Switching procedures off withdraws their questions and stops runs waiting for an answer. */
  revokeQuestions(): void {
    this.deps.ledger.withdraw((entry) => entry.kind === "start" || entry.kind === "step");
    for (const state of this.list()) if (state.running) this.finish(state.id, "cancelled", "Procedures were switched off.");
  }

  private async begin(id: string): Promise<void> {
    const state = this.get(id);
    // A yes to start never covers repeating or running flows the owner has not said yes to (their steps may have changed).
    if (state.status !== "active" || this.unattendedBlock(state)) return;
    const runId = randomUUID();
    this.save({ ...state, running: { id: runId, step: 0, sessionId: null, startedAt: this.now.toISOString(), turns: 0, last: "" } });
    // The owner's yes to the start covers the first step; at "auto" a step marked `confirm` still asks.
    await this.runStep(id, state.procedure.level === "ask-to-start" && !state.procedure.steps[0]?.confirm, runId);
  }

  private runId(running: Running): string { return running.id ?? running.startedAt; }
  private currentRun(id: string, runId: string): (ProcedureState & { running: Running }) | undefined {
    const state = this.find(id);
    return state?.running && this.runId(state.running) === runId ? state as ProcedureState & { running: Running } : undefined;
  }

  /** The step after one that finished: done when there is none, otherwise its own question or work. */
  private async continueFrom(id: string, runId: string): Promise<void> {
    const state = this.currentRun(id, runId);
    if (!state || state.status !== "active") return;
    if (state.running.step >= state.procedure.steps.length) return this.finish(id, "completed", "Every step finished.", runId);
    await this.runStep(id, false, runId);
  }

  /** One step: a question first when its level or the step asks for one, then the step's own kind of work. */
  private async runStep(id: string, cleared: boolean, runId: string): Promise<void> {
    const state = this.currentRun(id, runId);
    if (!state || state.status !== "active") return;
    const index = state.running.step, step = state.procedure.steps[index]!;
    const asks = state.procedure.level === "ask-each-step" || step.confirm;
    if (asks && !cleared) {
      this.deps.ledger.ask({ kind: "step", from: "procedure", fingerprint: fingerprintOf("step", id, runId, index),
        title: `"${quoteLine(state.procedure.name, 80)}", step ${index + 1}: ${quoteLine(step.title, 120)}`,
        detail: quoteLine(step.prompt || step.title, 300), payload: { procedureId: id, step: index, scope: this.questionScope(state, true) } });
      return;
    }
    const kind = kindOf(step);
    if (kind === "when" || kind === "wait") return this.waitAt(id, step, runId);
    // Checked again at the step itself: a procedure it runs may have changed since the run began.
    if (unattendedKinds.has(kind) && this.unattendedBlock(state)) return this.finish(id, "failed", `Step ${index + 1} may not repeat or run a flow without your yes to it.`, runId);
    let said: string;
    try { said = await this.stepWork(id, step, state.procedure.steps.length, index, runId); }
    catch (error) { return this.finish(id, "failed", String((error as Error)?.message ?? error), runId); }
    const now = this.currentRun(id, runId);
    if (!now || now.status !== "active") return;
    this.save({ ...now, running: { ...now.running, step: index + 1, last: said.slice(0, 8000) } });
    await this.continueFrom(id, runId);
  }

  /** A "When" or "Wait" step: the run waits, and tick() (a moment) or afterTask() (a task finishing) carries it on. */
  private waitAt(id: string, step: Step, runId: string): void {
    const state = this.currentRun(id, runId);
    if (!state || state.status !== "active") return;
    const running = state.running, at = step.at;
    const waitUntil = step.minutes ? new Date(this.now.getTime() + step.minutes * 60_000).toISOString() : at ? nextDue(at, this.now) : null;
    const waitFor = at?.kind === "after-task" ? at.words : null;
    this.save({ ...state, running: { ...running, waitUntil, waitFor } });
  }

  /** The work of a step that asks a Trunk: once, by what the step before said, repeatedly, per line, or another procedure's steps. */
  private async stepWork(id: string, step: Step, count: number, index: number, runId: string, permissions?: readonly string[]): Promise<string> {
    const kind = kindOf(step), last = this.currentRun(id, runId)?.running.last ?? "";
    const ask = (prompt: string, note = ""): Promise<string> => this.ask(id, `step ${index + 1} of ${count}: ${step.title}${note}\n${prompt}`, runId, permissions);
    if (kind === "if") {
      const way = says(last, step.contains ?? "") ? step.yes : step.no;
      return way ? ask(way) : last;
    }
    if (kind === "loop") {
      let said = "";
      for (let time = 1; time <= (step.times ?? 1); time++) {
        said = await ask(step.prompt, ` (time ${time} of at most ${step.times})`);
        if (step.until && says(said, step.until)) break;
      }
      return said;
    }
    if (kind === "fan") {
      const answers: string[] = [];
      for (const item of fanItems(last))
        answers.push(`${item}: ${await ask(step.prompt.includes("{item}") ? step.prompt.replaceAll("{item}", item) : `${step.prompt}\nThis one: ${item}`)}`);
      return answers.join("\n");
    }
    if (kind === "sub") return this.runInner(id, step, runId);
    return ask(step.prompt);
  }

  /** "Run a flow": the steps of the procedure it names, as it was when the owner said yes to running it from here. */
  private async runInner(id: string, step: Step, runId: string): Promise<string> {
    const target = this.find(step.flowId ?? "");
    if (!target) throw new Error(`The procedure the step "${step.title}" runs is no longer kept.`);
    if ((target.version ?? 1) !== step.version) throw new Error(`"${target.procedure.name}" changed after you said yes to running it from here.`);
    const problem = subProblem(target.procedure.name, target.procedure.steps);
    if (problem) throw new Error(problem);
    let said = this.currentRun(id, runId)?.running.last ?? "";
    for (const [i, inner] of target.procedure.steps.entries()) {
      said = await this.stepWork(id, inner, target.procedure.steps.length, i, runId, bothAllow(this.get(id).procedure.permissions, target.procedure.permissions));
      const now = this.currentRun(id, runId);
      if (!now || now.status !== "active") throw new Error("This flow run has stopped.");
      this.save({ ...now, running: { ...now.running, last: said.slice(0, 8000) } });
    }
    return said;
  }

  /** One request to a Trunk, counted against the run's hard cap before it is made. */
  /** `permissions`: what a flow run from this one may use (both flows' own), in place of this flow's alone. */
  private async ask(id: string, words: string, runId: string, permissions?: readonly string[]): Promise<string> {
    const state = this.currentRun(id, runId);
    if (!state || state.status !== "active") throw new Error("This flow run has stopped.");
    const running = state.running;
    if ((running.turns ?? 0) >= maxUnattendedTurns) throw new Error(`It stopped at ${maxUnattendedTurns} requests to a Trunk, the most one run may make.`);
    this.save({ ...state, running: { ...running, turns: (running.turns ?? 0) + 1 } });
    const outcome = await this.deps.runner.turn({ key: `procedure:${id}`, prompt: `Procedure "${quoteLine(state.procedure.name, 80)}", ${words}`,
      permissions: narrowed(permissions ?? state.procedure.permissions, this.deps.held()), perDay: state.procedure.perDay * Math.max(1, this.worstTurns(state.procedure.steps)),
      gapMs: 0, ...(running.sessionId ? { sessionId: running.sessionId } : {}) });
    const now = this.currentRun(id, runId);
    if (!now || now.status !== "active") throw new Error("This flow run has stopped.");
    if (!outcome.ran) throw new Error(outcome.reason);
    if (outcome.run.status !== "completed") throw new Error(`A request did not finish (${outcome.run.status}).`);
    this.save({ ...now, running: { ...now.running, sessionId: outcome.run.sessionId } });
    return outcome.run.output;
  }

  /* ---------- the owner's own yes to what could run unattended ---------- */

  /**
   * A "When" step's moment and a "Wait" step's length may be written as the owner says them ("5:00 PM", "every 2 hours",
   * "after the invoice task"; "30 minutes"): they are read into the engine's own form here, before anything is checked.
   */
  private words(input: unknown): unknown {
    const steps = (input as { steps?: unknown } | null)?.steps;
    if (!Array.isArray(steps)) return input;
    const zone = this.deps.timezone?.() ?? "UTC";
    return { ...(input as object), steps: steps.map((step: unknown) => {
      if (!step || typeof step !== "object") return step;
      const { at, minutes } = step as { at?: unknown; minutes?: unknown };
      return { ...step, ...(typeof at === "string" ? { at: parseWhen(at, zone) } : {}), ...(typeof minutes === "string" ? { minutes: parseWait(minutes) } : {}) };
    }) };
  }

  private find(id: string): ProcedureState | undefined {
    return this.deps.store.get("settings", this.deps.owner, prefix + id)?.data as ProcedureState | undefined;
  }
  private readonly subSteps = (flowId: string): readonly Step[] | null => this.find(flowId)?.procedure.steps ?? null;
  /** The most requests to a Trunk one run of these steps could make. */
  worstTurns(steps: readonly Step[]): number { return steps.reduce((sum, step) => sum + stepTurns(step, this.subSteps), 0); }

  /** Pins each "Run a flow" step to the version of the procedure it runs now, and refuses what could never be allowed. */
  private settled(procedure: Procedure, selfId?: string): Procedure {
    const steps = procedure.steps.map((step) => {
      if (kindOf(step) !== "sub") return step;
      if (step.flowId === selfId) throw new Error(`The step "${step.title}" would run the procedure it is part of.`);
      const target = this.find(step.flowId ?? "");
      if (!target) throw new Error(`The step "${step.title}" runs a procedure that is not kept here.`);
      const problem = subProblem(target.procedure.name, target.procedure.steps);
      if (problem) throw new Error(problem);
      return { ...step, version: target.version ?? 1 };
    });
    const total = this.worstTurns(steps);
    if (total > maxUnattendedTurns) throw new Error(`One run could make up to ${total} requests to a Trunk; the most a procedure may make is ${maxUnattendedTurns}.`);
    return { ...procedure, steps };
  }

  /**
   * Exactly what its Repeat, Split and gather and Run a flow steps could do without the owner watching, how many times,
   * and the cap; null when it has none. The fingerprint covers the steps, the versions of the procedures it runs and the cap.
   */
  unattendedPlan(state: ProcedureState): { lines: string[]; total: number; pins: Record<number, number>; fingerprint: string } | null {
    const steps = state.procedure.steps;
    if (!needsUnattendedYes(steps)) return null;
    const pins: Record<number, number> = {};
    const lines = steps.flatMap((step, i) => {
      const kind = kindOf(step), at = `Step ${i + 1}, ${quoteLine(step.title, 120)}`;
      if (kind === "loop") return [`${at}: asks a Trunk the same request up to ${step.times} times${step.until ? `, stopping once the answer says "${quoteLine(step.until, 200)}"` : ""}: ${quoteLine(step.prompt, 300)}`];
      if (kind === "fan") return [`${at}: asks a Trunk once for each line the step before gave, up to ${maxFanItems} times: ${quoteLine(step.prompt, 300)}`];
      if (kind !== "sub") return [];
      const target = this.find(step.flowId ?? "");
      pins[i] = target ? target.version ?? 1 : 0; // 0: no longer kept, never asked about
      return [`${at}: runs the procedure "${quoteLine(target?.procedure.name ?? "(no longer kept)", 80)}" (version ${pins[i]}), up to ${stepTurns(step, this.subSteps)} requests to a Trunk.`];
    });
    const total = this.worstTurns(steps);
    lines.push(`In all, one run makes at most ${total} requests to a Trunk without asking you each time (no procedure may make more than ${maxUnattendedTurns}), and it runs at most ${state.procedure.perDay} times a day.`);
    const shape = steps.map(({ version: _pinned, ...step }) => step);
    return { lines, total, pins, fingerprint: fingerprintOf("unattended", state.id, state.version ?? 1, shape, pins, state.procedure.perDay, maxUnattendedTurns) };
  }

  /** Why it may not run its unattended steps now (asking the owner if nothing is asked yet), or null. */
  private unattendedBlock(state: ProcedureState): string | null {
    const plan = this.unattendedPlan(state);
    if (!plan || state.unattended?.fingerprint === plan.fingerprint) return null;
    if (Object.values(plan.pins).includes(0)) return "A procedure it runs is no longer kept, so it does not run. Change its steps.";
    const nested = this.nestedProblem(state);
    if (nested) return nested;
    if (this.deps.ledger.refused(plan.fingerprint))
      return "You said no to what it would repeat or run by itself, so it does not run. Change its steps to be asked again.";
    this.askUnattended(state, plan);
    return "It waits for your yes to what it would repeat or run by itself: open the procedure to answer.";
  }
  private askUnattended(state: ProcedureState, plan: NonNullable<ReturnType<SelfStarting["unattendedPlan"]>>): void {
    if (this.deps.ledger.pendingCount((e) => e.kind === "unattended" && e.fingerprint === plan.fingerprint)) return;
    this.deps.ledger.ask({ kind: "unattended", from: "procedure", fingerprint: plan.fingerprint,
      title: `Let "${quoteLine(state.procedure.name, 80)}" repeat and run steps without asking each time?`,
      detail: plan.lines.join("\n"), payload: { procedureId: state.id, fingerprint: plan.fingerprint } });
  }
  /** Asks at once when a procedure that holds such steps is made or changed; its own yes is not this one. */
  private askIfUnattended(state: ProcedureState): ProcedureState {
    const plan = this.unattendedPlan(state);
    if (plan && state.unattended?.fingerprint !== plan.fingerprint && !this.deps.ledger.refused(plan.fingerprint) && !Object.values(plan.pins).includes(0) && !this.nestedProblem(state))
      this.askUnattended(state, plan);
    return state;
  }
  /** A procedure it runs that has since been changed to wait, ask or run a procedure itself: never run from here, never asked about. */
  private nestedProblem(state: ProcedureState): string | null {
    for (const step of state.procedure.steps) {
      if (kindOf(step) !== "sub") continue;
      const target = this.find(step.flowId ?? "");
      const problem = target ? subProblem(target.procedure.name, target.procedure.steps) : null;
      if (problem) return `${problem} Change the steps of "${quoteLine(state.procedure.name, 80)}".`;
    }
    return null;
  }
  /** The owner's yes to exactly that plan: the versions it named are the ones run from here from now on. */
  allowUnattended(payload: unknown): ProcedureState {
    const { procedureId, fingerprint } = z.object({ procedureId: z.string().uuid(), fingerprint: z.string().min(1).max(64) }).strict().parse(payload);
    const state = this.get(procedureId), plan = this.unattendedPlan(state);
    const nested = this.nestedProblem(state);
    if (nested) throw new Error(nested);
    if (!plan || plan.fingerprint !== fingerprint)
      throw new Error("It changed after this was asked, so this yes no longer fits. Say no to this one; it asks again about what it is now.");
    const steps = state.procedure.steps.map((step, i) => (i in plan.pins ? { ...step, version: plan.pins[i]! } : step));
    return this.save({ ...state, procedure: { ...state.procedure, steps }, unattended: { fingerprint, at: this.now.toISOString() } });
  }

  private finish(id: string, outcome: Outcome, note: string, runId?: string): void {
    const state = runId ? this.currentRun(id, runId) : this.find(id);
    if (!state) return;
    if (!state.running) return; // An off switch may have already stopped it while its model turn settled.
    const stats = { ...state.stats, [outcome]: state.stats[outcome] + 1 };
    const next: ProcedureState = { ...state, running: null, stats,
      recent: [...state.recent, { at: this.now.toISOString(), outcome, note: quoteLine(note, 200) }].slice(-20) };
    const rate = successRate(stats);
    const finished = stats.completed + stats.failed + stats.cancelled;
    if (state.procedure.level === "auto" && finished >= demoteAfter && rate !== null && rate < 0.5) {
      next.procedure = { ...state.procedure, level: "ask-to-start" };
      next.levelNote = `It went back to asking before it starts: only ${Math.round(rate * 100)}% of its runs worked.`;
    }
    this.save(next);
  }
}

/**
 * What a flow run from another may use: only what both allow. The owner said yes to each flow's requests under its own
 * permissions, so running one from another never widens them. Neither naming any means the owner's rules as they are.
 */
function bothAllow(outer: readonly string[] | undefined, inner: readonly string[] | undefined): string[] | undefined {
  if (!outer) return inner ? [...inner] : undefined;
  return inner ? outer.filter((p) => inner.includes(p)) : [...outer];
}

/** One step, as the owner reads it in a question: its kind's own words, and the request it sends. */
function stepLine(step: Step, i: number): string {
  const kind = kindOf(step), head = `Step ${i + 1}${step.confirm ? " (asks you first)" : ""}, ${quoteLine(step.title, 120)}`;
  if (kind === "when") return `${head}: waits until ${startWords(step.at!)}.`;
  if (kind === "wait") return `${head}: waits ${step.minutes} minutes.`;
  if (kind === "if") return `${head}: if the step before says "${quoteLine(step.contains ?? "", 200)}", asks ${step.yes ? quoteLine(step.yes, 600) : "nothing"}; otherwise ${step.no ? quoteLine(step.no, 600) : "nothing"}.`;
  if (kind === "loop") return `${head}: up to ${step.times} times${step.until ? ` (until the answer says "${quoteLine(step.until, 200)}")` : ""}: ${quoteLine(step.prompt, 2000)}`;
  if (kind === "fan") return `${head}: for each line the step before gave (up to ${maxFanItems}): ${quoteLine(step.prompt, 2000)}`;
  if (kind === "sub") return `${head}: runs another procedure.`;
  return `${head}: ${quoteLine(step.prompt, 2000)}`;
}
