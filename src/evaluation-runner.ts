import { randomUUID } from "node:crypto";
import { rm, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import type { Store } from "./store.js";
import type { Runtime } from "./runtime.js";
import type { Run } from "./contracts.js";
import { isReadOnlyPermission } from "./policy.js";
import { estimateCost, pricingSettings, type CostConfidence, type TokenCounts } from "./pricing.js";
import { findSuite, type EvaluationTask, type SuiteEntry } from "./evaluation-suites.js";
import { gradeTask, type GradeMethod } from "./evaluation-grading.js";
import { applyGates, EvaluationGateSchema, readTrajectory, runtimeJudge, scoreTrajectory, type GateVerdict } from "./evaluation-run.js";
import {
  combinedBasis, comparisonRefusal, conditionsVersion, costNote, ledgerTokens, machineIdentity, scorerDigest,
  type CostBasis, type RunConditions,
} from "./evaluation-honesty.js";
import { datasetVersionOf } from "./study-journal.js";

/** One task's result: did it pass, how long it took, how many tokens and how much money. */
export interface TaskOutcome {
  id: string; runId: string | null; status: string; passed: boolean; skipped: boolean;
  score: number; method: GradeMethod | "skipped" | "scorers"; problem: string | null; reason: string | null;
  ms: number; tokens: number; dollars: number | null; tags: string[];
  /** Whether the tokens behind `dollars` were the provider's own count or Branch's own guess. */
  costBasis?: "reported" | "estimated";
  /** Wave 7: each scorer's own verdict, when the task declares scorers. */
  scores?: { kind: string; score: number; pass: boolean }[];
  /** Wave 7: every reason a scorer gave for failing, in plain words. */
  reasons?: string[];
}
export interface SuiteRun {
  id: string; suiteId: string; suiteName: string; preset: string; model: string; version: string;
  startedAt: string; finishedAt: string; tasks: TaskOutcome[];
  summary: {
    accuracy: number; passed: number; total: number; skipped: number;
    latencyMs: { mean: number; max: number }; tokens: number;
    dollars: number | null; costConfidence: CostConfidence; energy: "unavailable";
  };
  /** Tasks that passed in each of the three runs before this one and have just failed. */
  regressions: { taskId: string; problem: string | null }[];
  /** Wave 7: whether this run cleared the bar it was given, or null when it was given none. */
  gate?: GateVerdict | null;
  /**
   * mac7/eval-honesty: what this run was measured under. A run without it is never used as the
   * "before" of a regression, because there is no way to tell whether it measured the same thing.
   */
  conditions?: RunConditions;
  /** Why no regression could honestly be worked out, when none could. Null when one could. */
  regressionNote?: string | null;
  /** Where the money figure came from; never printed as a bill. */
  costBasis?: CostBasis;
}
/** One model choice's line in a side-by-side comparison. */
export interface CompareRow {
  preset: string; model: string; accuracy: number; passed: number; total: number;
  meanMs: number; tokens: number; dollars: number | null; costConfidence: CostConfidence; runId: string;
}
export const RunSuiteSchema = z.object({
  suite: z.string().min(1).max(64),
  /** The model choice to use; the one in use otherwise. */
  preset: z.string().min(1).max(64).optional(),
  /** Only let the tasks use tools that change nothing. Always on when comparing models. */
  readOnly: z.boolean().optional(),
  maxSteps: z.number().int().min(1).max(200).default(30),
  maxTokens: z.number().int().min(1000).max(1_000_000).default(120_000),
  /** Wave 7: the bar this run has to clear, for a release script that stops when it does not. */
  gates: EvaluationGateSchema.optional(),
}).strict();
export const CompareSchema = z.object({
  suite: z.string().min(1).max(64),
  presets: z.array(z.string().min(1).max(64)).min(2).max(4),
  /** Let the tasks change things. Off by default: a comparison repeats the same work several times. */
  allowChanges: z.boolean().default(false),
  maxSteps: z.number().int().min(1).max(200).default(30),
  maxTokens: z.number().int().min(1000).max(1_000_000).default(120_000),
}).strict();
const historyLimit = 50;
const recordId = (id: string): string => `evaluation-run:${id}`;

/**
 * Runs suites, keeps every result, and says when something that used to work has stopped working.
 * Everything a run records comes from the run itself: real answers, real time taken, real tokens,
 * and money worked out from the price table. Energy is reported unavailable: nothing here can
 * measure it honestly.
 */
export class SuiteRunner {
  /** Rubric answers already paid for, so one study never asks the same question twice. */
  private readonly judgeCache = new Map<string, { score: number; reason: string }>();
  constructor(private readonly store: Store, private readonly runtime: Runtime, private readonly version: string) {}
  private get owner(): string { return this.runtime.owner; }

  async run(input: unknown, onStarted?: (run: Run) => void): Promise<SuiteRun> {
    const request = RunSuiteSchema.parse(input);
    const suite = findSuite(this.store, this.owner, request.suite);
    const readOnly = request.readOnly ?? suite.readOnly;
    // A grader's answer is only reused within one run; two runs may be grading different work.
    this.judgeCache.clear();
    const choice = this.runtime.models.plan(this.owner, "evaluation", request.preset ? { preset: request.preset } : {}).choice;
    const startedAt = new Date().toISOString();
    const tasks: TaskOutcome[] = [];
    for (const task of suite.tasks) tasks.push(await this.runTask(task, request, readOnly, choice.model, onStarted));
    const result = this.assemble(suite, choice.presetId, choice.model, startedAt, tasks, request, readOnly);
    if (request.gates) result.gate = applyGates(result, request.gates);
    this.store.save("governance", this.owner, recordId(result.id), { ...result });
    return result;
  }

  private async runTask(task: EvaluationTask, request: z.infer<typeof RunSuiteSchema>, readOnly: boolean, model: string, onStarted?: (run: Run) => void): Promise<TaskOutcome> {
    const missing = task.requires.filter((tool) => !this.runtime.registry.names().includes(tool));
    if (missing.length)
      return { id: task.id, runId: null, status: "skipped", passed: false, skipped: true, score: 0, method: "skipped", problem: `Skipped: ${missing.join(", ")} is not installed`, reason: null, ms: 0, tokens: 0, dollars: null, tags: task.tags };
    const began = Date.now();
    const named = await this.namedFiles(task);
    const run = await this.execute(task, request, readOnly, onStarted);
    const graded = run.status === "completed"
      ? await gradeTask(this.runtime, task, run.output, onStarted)
      : { score: 0, passed: false, method: "checks" as const, problem: run.output.slice(0, 200), reason: null };
    const grade = await this.attributed(named, graded);
    const tokens = this.tokensFor(run.id);
    const outcome: TaskOutcome = {
      id: task.id, runId: run.id, status: run.status, passed: grade.passed, skipped: false,
      score: grade.score, method: grade.method, problem: grade.problem, reason: grade.reason,
      ms: Date.now() - began, tokens: tokens.input + tokens.output,
      dollars: this.costOf(model, tokens).amount, tags: task.tags, costBasis: tokens.basis,
    };
    const scored = task.scorers?.length ? await this.applyScorers(task, outcome, run.output, onStarted) : outcome;
    await this.tidy(named);
    return scored;
  }

  /**
   * The files a task's checks name, as they were before it ran (null when absent). A file already there proves nothing,
   * so it has to be written by this run to count; and what the run created is taken away again afterwards, so an
   * evaluation leaves the workspace as it found it and the next run cannot pass on this one's leftovers.
   */
  private async namedFiles(task: EvaluationTask): Promise<Map<string, { mtimeMs: number; size: number } | null>> {
    const found = new Map<string, { mtimeMs: number; size: number } | null>();
    const workspace = resolve(this.runtime.workspace);
    for (const file of (task.checks as { files?: string[] } | undefined)?.files ?? []) {
      const full = resolve(workspace, file), inside = relative(workspace, full);
      if (!inside || inside.startsWith("..") || isAbsolute(inside)) continue;
      const info = await stat(full).catch(() => null);
      found.set(full, info ? { mtimeMs: info.mtimeMs, size: info.size } : null);
    }
    return found;
  }
  private async attributed<T extends { passed: boolean; score: number; problem: string | null }>(named: Map<string, { mtimeMs: number; size: number } | null>, grade: T): Promise<T> {
    let stale: string | null = null;
    for (const [full, before] of named) {
      const now = await stat(full).catch(() => null);
      if (before && now && now.mtimeMs === before.mtimeMs && now.size === before.size) stale ??= relative(this.runtime.workspace, full);
    }
    if (!stale || !grade.passed) return grade;
    return { ...grade, passed: false, score: 0,
      problem: `${stale} was already in the workspace before this task and it did not write it, so it proves nothing` };
  }
  /** Takes away the named files this evaluation created, once everything that reads them has. */
  private async tidy(named: Map<string, { mtimeMs: number; size: number } | null>): Promise<void> {
    for (const [full, before] of named) if (!before) await rm(full, { force: true }).catch(() => undefined);
  }
  /** Wave 7: the task's own scorers, run over its record. Every one has to pass for the task to. */
  private async applyScorers(task: EvaluationTask, outcome: TaskOutcome, answer: string, onStarted?: (run: Run) => void): Promise<TaskOutcome> {
    const trajectory = readTrajectory(this.store, outcome.runId, { ms: outcome.ms, tokens: outcome.tokens, dollars: outcome.dollars });
    const scored = await scoreTrajectory(task.scorers, { workspace: this.runtime.workspace, judge: runtimeJudge(this.runtime, undefined, onStarted), judgeCache: this.judgeCache },
      { id: task.id, prompt: task.prompt, expected: task.expected }, trajectory, answer);
    if (!scored) return outcome;
    const passed = outcome.passed && scored.pass;
    // A task that already failed its checks keeps "checks" as how it was decided, so the report
    // never blames a scorer for something the checks caught first.
    return {
      ...outcome, passed, method: outcome.passed ? "scorers" : outcome.method,
      score: Math.round(((outcome.score + scored.score) / 2) * 1000) / 1000,
      problem: outcome.problem ?? (scored.pass ? null : scored.reasons[0] ?? "A scorer failed"),
      scores: scored.parts, reasons: scored.reasons,
    };
  }

  /** Runs one task, cutting it short after its first step and continuing it when the task asks for that. */
  private async execute(task: EvaluationTask, request: z.infer<typeof RunSuiteSchema>, readOnly: boolean, onStarted?: (run: Run) => void): Promise<Run> {
    const permissions = readOnly ? this.runtime.registry.permissions().filter(isReadOnlyPermission) : undefined;
    const options = {
      prompt: task.prompt, signal: AbortSignal.timeout(task.timeoutMs),
      ...(onStarted ? { onStarted } : {}),
      // Wave 7: every evaluation task is a trace of its own, labelled so an export can be filtered
      // down to one suite or one task months later.
      traceAttributes: { "branch.evaluation.suite": request.suite, "branch.evaluation.task": task.id },
      ...(permissions ? { permissions } : {}),
      ...(request.preset ? { model: request.preset } : {}),
      ...(task.checks ? { checks: { ...task.checks, maxRetries: 0 as const } } : {}),
    };
    if (task.mode !== "interrupt-resume")
      return this.runtime.run({ ...options, budget: { maxSteps: request.maxSteps, maxTokens: request.maxTokens } });
    // The stop is staged, not real: one round with the model and the one tool call it asks for are
    // allowed, then the saved task is marked interrupted exactly as a power cut would leave it, and
    // the ordinary continue path takes over from there.
    const first = await this.runtime.run({ ...options, budget: { maxSteps: 2, maxTokens: request.maxTokens } });
    if (first.status === "completed") return first;
    this.store.finish(first.id, "interrupted", "Stopped on purpose by the evaluation, part way through");
    return this.runtime.resume(first.id);
  }

  /**
   * mac7/eval-honesty: the provider's own count when it gave one, Branch's estimate otherwise, and
   * which of the two it was — so a figure worked out from a guess is never printed as a bill.
   */
  private tokensFor(runId: string): TokenCounts & { basis: "reported" | "estimated" } {
    return ledgerTokens(this.store.usage(runId));
  }

  private costOf(model: string, tokens: TokenCounts) {
    return estimateCost(model, tokens, pricingSettings(this.store, this.owner).overrides);
  }

  /** What this run was measured under, so a later run can tell whether it measured the same thing. */
  private conditionsFor(suite: SuiteEntry, preset: string, model: string, request: z.infer<typeof RunSuiteSchema>, readOnly: boolean, bases: CostBasis[]): RunConditions {
    const judged = suite.tasks.some((task) => task.judge) || suite.tasks.some((task) => task.scorers?.some((scorer) => (scorer as { kind?: unknown }).kind === "rubric"));
    return {
      version: conditionsVersion,
      presets: [preset], models: [model], judgeModel: judged ? model : null,
      settings: { maxSteps: request.maxSteps, maxTokens: request.maxTokens, readOnly, suite: suite.id, source: suite.source },
      appVersion: this.version,
      machine: machineIdentity(),
      taskSetHash: datasetVersionOf(suite.tasks.map(({ id, prompt, expected, checks, deny, scorers, judge }) => ({ id, prompt, expected, checks, deny, scorers, judge }))),
      scorerDigest: scorerDigest({ scorers: suite.tasks.flatMap((task) => task.scorers ?? []), judgeModel: judged ? model : null }),
      costBasis: combinedBasis(bases),
    };
  }

  private assemble(suite: SuiteEntry, preset: string, model: string, startedAt: string, tasks: TaskOutcome[], request: z.infer<typeof RunSuiteSchema>, readOnly: boolean): SuiteRun {
    const scored = tasks.filter((task) => !task.skipped);
    const passed = scored.filter((task) => task.passed).length;
    const latencies = scored.map((task) => task.ms);
    const priced = scored.filter((task) => task.dollars !== null);
    const confidence = this.costOf(model, { input: 0, output: 0 }).confidence;
    const id = randomUUID();
    const basis = combinedBasis(scored.flatMap((task) => (task.costBasis ? [task.costBasis] : [])));
    const conditions = this.conditionsFor(suite, preset, model, request, readOnly, scored.flatMap((task) => (task.costBasis ? [task.costBasis] : [])));
    const looked = this.regressionsFor(suite.id, tasks, conditions);
    return {
      conditions, costBasis: basis, regressionNote: looked.note,
      id, suiteId: suite.id, suiteName: suite.name, preset, model, version: this.version,
      startedAt, finishedAt: new Date().toISOString(), tasks,
      summary: {
        accuracy: scored.length ? Math.round((passed / scored.length) * 1000) / 1000 : 0,
        passed, total: scored.length, skipped: tasks.length - scored.length,
        latencyMs: { mean: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0, max: latencies.length ? Math.max(...latencies) : 0 },
        tokens: scored.reduce((total, task) => total + task.tokens, 0),
        dollars: priced.length ? Math.round(priced.reduce((total, task) => total + (task.dollars ?? 0), 0) * 1e6) / 1e6 : null,
        costConfidence: confidence, energy: "unavailable",
      },
      regressions: looked.regressions,
    };
  }

  /**
   * A task that passed in each of the three runs before this one and has just failed.
   *
   * mac7/eval-honesty: "the three runs before this one" used to mean any three runs of the same
   * suite, whatever model choice, version or computer they were made on. A run on a cheaper model
   * after three on a stronger one therefore announced that something which used to work had
   * stopped — and `runScheduled` sent that out as a regression notice. Only runs measured the same
   * way count now, and when there are not three of those, the run says so rather than reporting
   * nothing as if it had looked.
   */
  private regressionsFor(suiteId: string, tasks: TaskOutcome[], conditions: RunConditions): { regressions: { taskId: string; problem: string | null }[]; note: string | null } {
    const comparable = this.history(suiteId).filter((run) => !comparisonRefusal(run.conditions, conditions));
    const previous = comparable.slice(0, 3);
    if (previous.length < 3) {
      const all = this.history(suiteId).length;
      return { regressions: [], note: all < 3
        ? `Nothing is called a regression yet: this suite has ${all} earlier run(s), and three measured the same way are needed.`
        : `Nothing is called a regression here: of the ${all} earlier run(s) of this suite, only ${previous.length} were measured the same way `
          + `(same model choice, version, computer, tasks and scorers), and three are needed. Run this suite three times under these conditions first.` };
    }
    return {
      note: null,
      regressions: tasks
        .filter((task) => !task.skipped && !task.passed)
        .filter((task) => previous.every((run) => run.tasks.some((old) => old.id === task.id && old.passed)))
        .map((task) => ({ taskId: task.id, problem: task.problem })),
    };
  }

  /** Every stored run, newest first, for one suite or for all of them. */
  history(suiteId?: string): SuiteRun[] {
    return this.store.list("governance", this.owner)
      .filter((record) => record.id.startsWith("evaluation-run:"))
      .map((record) => record.data as unknown as SuiteRun)
      .filter((run) => !suiteId || run.suiteId === suiteId)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, historyLimit);
  }

  /** The history as a trend: one point per run, oldest first, plus how each task has been doing. */
  trend(suiteId?: string) {
    const runs = this.history(suiteId).slice().reverse();
    const taskIds = [...new Set(runs.flatMap((run) => run.tasks.map((task) => task.id)))];
    return {
      // mac7/eval-honesty: a trend line drawn through runs measured differently is a picture of the
      // settings changing, not of the assistant changing. Each point says whether it can honestly
      // be read against the newest one, and why not when it cannot.
      runs: runs.map((run) => {
        const against = runs.at(-1)?.conditions;
        const refusal = comparisonRefusal(run.conditions, against, { before: "this run", after: "the newest run" });
        return { id: run.id, at: run.startedAt, preset: run.preset, version: run.version, accuracy: run.summary.accuracy,
          meanMs: run.summary.latencyMs.mean, tokens: run.summary.tokens, dollars: run.summary.dollars,
          regressions: run.regressions.length, comparable: !refusal, whyNot: refusal };
      }),
      tasks: taskIds.map((id) => ({ id, results: runs.map((run) => run.tasks.find((task) => task.id === id)?.passed ?? null) })),
      latestRegressions: runs.at(-1)?.regressions ?? [],
    };
  }

  /**
   * Runs a suite on a schedule. The result is recorded as an ordinary finished task so it shows up
   * in Activity like anything else, and a regression is announced to whatever is listening.
   */
  async runScheduled(suiteId: string, preset?: string, onStarted?: (run: Run) => void): Promise<{ run: Run; result: SuiteRun | null }> {
    const run = this.store.createRun(this.owner, `Nightly evaluation: ${suiteId}`);
    try {
      onStarted?.(run);
      // Engine-only ancestry for evaluated tasks and both judge paths, written before a model round.
      // This callback is separate from the parsed suite definition and never supplied by a tool.
      const memberStarted = onStarted ? (member: Run): void => {
        if (member.owner !== run.owner) throw new Error("Evaluation task owner changed");
        this.store.event(member.id, "routine.parent", { runId: run.id });
      } : undefined;
      const result = await this.run({ suite: suiteId, ...(preset ? { preset } : {}) }, memberStarted);
      const text = summaryLine(result);
      this.store.message(run.sessionId, { role: "assistant", content: text });
      this.store.event(run.id, "evaluation.finished", { suite: result.suiteId, evaluationRunId: result.id, accuracy: result.summary.accuracy, regressions: result.regressions.length });
      if (result.regressions.length)
        this.runtime.notifyEvent("evaluation.regression", { suite: result.suiteId, evaluationRunId: result.id, runId: run.id, preset: result.preset, version: result.version, accuracy: result.summary.accuracy, tasks: result.regressions });
      return { run: this.store.finish(run.id, "completed", text), result };
    } catch (error) {
      const text = `The evaluation could not run: ${error instanceof Error ? error.message : String(error)}`;
      this.store.message(run.sessionId, { role: "assistant", content: text });
      return { run: this.store.finish(run.id, "failed", text), result: null };
    }
  }

  /** The same suite against several model choices, side by side. */
  async compare(input: unknown) {
    const request = CompareSchema.parse(input);
    const rows: CompareRow[] = [];
    for (const preset of request.presets) {
      const run = await this.run({ suite: request.suite, preset, readOnly: !request.allowChanges, maxSteps: request.maxSteps, maxTokens: request.maxTokens });
      rows.push({ preset: run.preset, model: run.model, accuracy: run.summary.accuracy, passed: run.summary.passed, total: run.summary.total, meanMs: run.summary.latencyMs.mean, tokens: run.summary.tokens, dollars: run.summary.dollars, costConfidence: run.summary.costConfidence, runId: run.id });
    }
    // Most right answers first; then the cheaper one, counting "no price on file" as dearest so a
    // known cheap model is never passed over for one nobody can price; then the quicker one.
    const cost = (row: CompareRow) => row.dollars ?? Number.POSITIVE_INFINITY;
    const best = rows.slice().sort((a, b) =>
      b.accuracy - a.accuracy || (cost(a) === cost(b) ? 0 : cost(a) - cost(b)) || a.meanMs - b.meanMs)[0];
    return { suite: request.suite, readOnly: !request.allowChanges, rows, best: best?.preset ?? null };
  }
}

/** One line a person can read at a glance, for Activity and for a message sent to a chat. */
export function summaryLine(result: SuiteRun): string {
  const money = result.summary.dollars === null ? "no price on file" : `$${result.summary.dollars.toFixed(4)}`;
  const regressions = result.regressions.length
    ? ` Something that used to work has stopped: ${result.regressions.map((entry) => entry.taskId).join(", ")}.`
    : "";
  // A skipped task is never quietly dropped from the denominator; it is said out loud.
  const skipped = result.summary.skipped ? `, ${result.summary.skipped} skipped` : "";
  // Wave 7: when a bar was set, say whether it was cleared — that is the line a build log needs.
  const gate = !result.gate ? "" : result.gate.passed ? " It cleared the bar that was set." : ` It did not clear the bar: ${result.gate.failures.join("; ")}.`;
  // mac7/eval-honesty: say where the money figure came from, and say when nothing could honestly be
  // called a regression — "no regressions" and "we did not look" must never read the same.
  const basis = ` (${costNote(result.costBasis ?? "unknown", result.summary.dollars !== null)})`;
  const looked = result.regressionNote ? ` ${result.regressionNote}` : "";
  return `${result.suiteName}: ${result.summary.passed} of ${result.summary.total} right using ${result.preset}${skipped}, ${result.summary.latencyMs.mean} ms each on average, ${money}${basis}.${regressions}${looked}${gate}`;
}
