import { z } from "zod";
import type { Run, ToolContext } from "./contracts.js";
import { declareShape, type AnswerShape, type ShapedAnswer } from "./answer-shape.js";
import { CompletionCheckSchema, evaluateChecks, type CompletionCheck } from "./reliability.js";
import type { RunOptions } from "./runtime.js";
import type { Store } from "./store.js";
import { markChosen, savedFields, shippedUnlessChosen } from "./ship-on.js";
import { goalWithSubgoals } from "./autonomy/subgoals.js"; // r17-b: /subgoal
import { byCard, recordedWrite } from "./settings-kit/recorded-write.js"; // Q48
import { ownerChatMark } from "./key-context.js"; // owner-dm-full

/**
 * Wave mac2: goal mode. `/goal <objective> [--max n]` keeps one conversation working in rounds until
 * a judge says the goal is met, the work is blocked, or the round limit is reached. A reply along the
 * way does not end it: after each round the judge looks at what was said, and unless it is done the
 * next round is asked to carry on with what is still missing.
 *
 * The judge is the existing completion checks (src/reliability.ts), when the goal declares any, plus a
 * model grader asked for a score in a fixed shape with no tools. Rounds are ordinary tasks, one after
 * another, so every round keeps the runtime's own limits, approvals and two-minute ceiling.
 */
export const goalLimits = { defaultRounds: 6, maxRounds: 20 };
/** The grader's score at which a goal counts as met (when no declared check is failing). */
export const goalDoneScore = 0.8;
/** Rounds in a row without a better score before the goal is called stuck rather than burning the rest. */
export const goalStuckRounds = 2;

/**
 * The owner's switches for this area. Every feature is off, on, or "when needed", and ships off.
 * Goal mode: off refuses to start one; on shows the Goal button and takes /goal; when needed takes
 * /goal but shows no button. Snapshots for going back (src/rewind.ts): off takes none; on records
 * the workspace as each task starts; when needed records it just before a task first changes something.
 */
export const featureModes = ["off", "on", "when-needed"] as const;
export type FeatureMode = (typeof featureModes)[number];
export const GoalUndoSettingsSchema = z.object({
  goal: z.enum(featureModes).default("off"),
  snapshots: z.enum(featureModes).default("off"),
}).strict();
export type GoalUndoSettings = z.infer<typeof GoalUndoSettingsSchema>;
const settingsKey = "goal-undo";
/**
 * The owner's rule (ships on, 2026-09-26): a goal starts only when the owner sets one, and its rounds are bounded; none of (a)–(f).
 * Snapshots stay off: each records the whole workspace, up to 2 GB (e).
 */
export const goalUndoShipsOn: Partial<GoalUndoSettings> = { goal: "on" };

export function goalUndoSettings(store: Store, owner: string): GoalUndoSettings {
  const saved = GoalUndoSettingsSchema.safeParse(store.get("settings", owner, settingsKey)?.data ?? {});
  return saved.success ? shippedUnlessChosen(store, owner, settingsKey, saved.data, goalUndoShipsOn) : GoalUndoSettingsSchema.parse({});
}
export function saveGoalUndoSettings(store: Store, owner: string, input: unknown): GoalUndoSettings {
  // Only the switches that were sent change; the others keep their saved value (no defaults here).
  const sent = z.object({ goal: z.enum(featureModes).optional(), snapshots: z.enum(featureModes).optional() }).strict().parse(input);
  const before = store.get("settings", owner, settingsKey)?.data;
  const next = GoalUndoSettingsSchema.parse({ ...goalUndoSettings(store, owner), ...sent });
  store.save("settings", owner, settingsKey, { ...next });
  markChosen(store, owner, settingsKey, savedFields(before, GoalUndoSettingsSchema.safeParse(before ?? {}).success, sent, goalUndoShipsOn));
  return next;
}
const offNote = "Goal mode is off. Switch it on in Settings, under \"Working until done, and going back\".";

export const GoalStartSchema = z.object({
  objective: z.string().trim().min(1).max(4000),
  maxRounds: z.number().int().min(1).max(goalLimits.maxRounds).default(goalLimits.defaultRounds),
  sessionId: z.string().uuid().optional(),
  checks: CompletionCheckSchema.optional(),
}).strict();
export type GoalStart = z.input<typeof GoalStartSchema>;

/** Reads `/goal <objective> [--max n]`; null when the line is not a goal command. */
export function parseGoalCommand(line: string): { objective: string; maxRounds: number } | null {
  const match = /^\/goal(?:\s+([\s\S]*))?$/i.exec(line.trim());
  if (!match) return null;
  let text = (match[1] ?? "").trim(), maxRounds: number = goalLimits.defaultRounds;
  const limit = /(?:^|\s)--max(?:=|\s+)(\S+)\s*$/.exec(text);
  if (limit) {
    maxRounds = z.coerce.number().int().min(1).max(goalLimits.maxRounds).parse(limit[1]);
    text = text.slice(0, limit.index).trim();
  }
  if (!text) throw new Error("Say what the goal is: /goal <what should be true when it is done> [--max rounds]");
  return { objective: GoalStartSchema.shape.objective.parse(text), maxRounds };
}

export type GoalStatus = "working" | "paused" | "done" | "blocked" | "stopped" | "limit";
export interface GoalState {
  sessionId: string;
  objective: string;
  status: GoalStatus;
  round: number;
  maxRounds: number;
  /** The grader's latest score, 0 to 1; null before the first round is judged. */
  score: number | null;
  best: number;
  flatRounds: number;
  /** What the judge says is still missing. */
  missing: string[];
  /** Why it stopped, in plain words, once it has. */
  reason: string;
  checks: CompletionCheck | null;
  startedAt: string;
  /** Time spent working, not counting pauses. */
  elapsedMs: number;
  activeSince: number | null;
  lastRunId: string | null;
  /** Every round's task, in order, so undoing the goal (src/goal-undo.ts) knows exactly what it did. Absent on older goals. */
  runIds?: string[];
  /** CHAT-185: a goal set from a chat runs every round as that chat's task. Never taken from a request body. */
  origin?: GoalOrigin;
}
/**
 * CHAT-185: where a goal set from a chat came from. owner-dm-full: from the owner's own verified direct chat with full
 * access it is the owner's ("owner"), and each round carries that chat's mark so it is checked again at every step.
 */
export interface GoalOrigin { source: "channel" | "owner"; permissions: string[]; chat?: { channel: string; senderId: string } }
export interface Verdict { score: number; missing: string[]; done: boolean; blocked: string | null }

/** The part of the runtime goal mode uses; tests hand in a fake. */
export interface GoalRuntime {
  readonly owner: string;
  readonly workspace: string;
  run(options: RunOptions): Promise<Run>;
  cancel(id: string): boolean;
  context(options: { runId?: string; signal?: AbortSignal; permissions?: string[] }): ToolContext;
  shaped(run: Run, context: ToolContext, question: string, shape: AnswerShape): Promise<ShapedAnswer>;
}

const GradeSchema = z.object({
  score: z.number().min(0).max(1),
  missing: z.array(z.string().max(300)).max(8),
  blocked: z.boolean(),
});
const gradeShape = declareShape("goal_grade", GradeSchema);
const busyError = /already has an active run/;
const waitMs = 500;

export class GoalMode {
  private readonly live = new Map<string, { controller: AbortController; runId: string | null; ended: Promise<void> }>();
  /** How long to wait between tries when the owner's own message is still being answered. */
  busyWaitMs = waitMs;

  constructor(private readonly runtime: GoalRuntime, private readonly store: Store, private readonly now: () => number = Date.now) {}

  /** Starts a goal; resolves once its first round has begun, so a new conversation has its id. */
  /** This area's switches, as saved. */
  settings(): GoalUndoSettings { return goalUndoSettings(this.store, this.runtime.owner); }
  /** Q48: the card's save is written down as a change record. */
  saveSettings(input: unknown): GoalUndoSettings {
    return recordedWrite(this.store, this.runtime.owner, byCard("goal-undo"), ["goal-undo"], () => saveGoalUndoSettings(this.store, this.runtime.owner, input));
  }

  async start(input: GoalStart, origin?: GoalOrigin): Promise<GoalState> {
    const wanted = GoalStartSchema.parse(input);
    if (this.settings().goal === "off") throw new Error(offNote);
    if (wanted.sessionId && this.live.has(wanted.sessionId)) throw new Error("This conversation is already working on a goal.");
    const state: GoalState = {
      sessionId: wanted.sessionId ?? "", objective: wanted.objective, status: "working", round: 0, maxRounds: wanted.maxRounds,
      score: null, best: 0, flatRounds: 0, missing: [], reason: "", checks: wanted.checks ?? null,
      startedAt: new Date(this.now()).toISOString(), elapsedMs: 0, activeSince: this.now(), lastRunId: null, runIds: [],
      ...(origin ? { origin: { source: origin.chat ? origin.source : "channel", permissions: [...origin.permissions],
        ...(origin.chat ? { chat: { channel: origin.chat.channel, senderId: origin.chat.senderId } } : {}) } } : {}),
    };
    const started = new Promise<void>((resolve, reject) => {
      void this.drive(state, resolve).then(() => resolve(), (error: unknown) => reject(error));
    });
    await started;
    return this.view(state);
  }

  /** The goal in this conversation as it stands, or null when there is none. */
  status(sessionId: string): GoalState | null {
    const saved = this.store.get("settings", this.runtime.owner, key(sessionId))?.data as GoalState | undefined;
    if (!saved) return null;
    // A goal still marked as working that nothing is driving was cut off by Branch closing: it can be resumed.
    if (saved.status === "working" && !this.live.has(sessionId))
      return this.view({ ...saved, status: "paused", reason: "Branch was closed while this was working. Resume to carry on.", activeSince: null });
    return this.view(saved);
  }

  /** Lets the round that is working finish, then waits. */
  pause(sessionId: string): GoalState {
    const state = this.require(sessionId);
    if (state.status !== "working") throw new Error("This goal is not working right now.");
    return this.settle(state, "paused", "Paused. Resume to carry on.");
  }

  /** Carries on a paused goal (or one Branch was closed on) from the next round. */
  async resume(sessionId: string): Promise<GoalState> {
    const state = this.status(sessionId);
    if (!state) throw new Error("There is no goal in this conversation.");
    if (this.live.has(sessionId)) {
      const stored = this.require(sessionId);
      if (stored.status === "paused") { stored.status = "working"; stored.activeSince = this.now(); stored.reason = ""; this.save(stored); }
      return this.view(stored);
    }
    if (state.status !== "paused") throw new Error("Only a paused goal can be resumed.");
    if (this.settings().goal === "off") throw new Error(offNote);
    const next: GoalState = { ...state, status: "working", reason: "", activeSince: this.now() };
    if (next.round >= next.maxRounds) next.maxRounds = Math.min(goalLimits.maxRounds, next.round + 1);
    this.save(next);
    void this.drive(next, () => undefined).catch(() => undefined);
    return this.view(next);
  }

  /** Stops at once: the round that is working is cancelled. */
  stop(sessionId: string): GoalState {
    const state = this.status(sessionId);
    if (!state) throw new Error("There is no goal in this conversation.");
    if (state.status !== "working" && state.status !== "paused") throw new Error("This goal has already finished.");
    const driving = this.live.get(sessionId);
    if (driving) {
      driving.controller.abort();
      if (driving.runId) this.runtime.cancel(driving.runId);
    }
    return this.settle(this.store.get("settings", this.runtime.owner, key(sessionId))!.data as unknown as GoalState, "stopped", "Stopped by you.");
  }

  /** Resolves once nothing drives this conversation's goal any more (at once when nothing does). */
  async settled(sessionId: string): Promise<void> { await this.live.get(sessionId)?.ended; }

  /** Takes the goal off this conversation (undoing it): its strip goes; its rounds stay in the history. */
  forget(sessionId: string): void {
    if (this.live.has(sessionId)) throw new Error("This goal is still working. Stop it first.");
    this.store.delete("settings", this.runtime.owner, key(sessionId));
  }

  /** Runs rounds until the goal is met, blocked, stopped, paused or out of rounds. */
  private async drive(state: GoalState, onStarted: () => void): Promise<void> {
    const controller = new AbortController();
    let end!: () => void;
    const ended = new Promise<void>((resolve) => { end = resolve; });
    if (state.sessionId) this.live.set(state.sessionId, { controller, runId: null, ended });
    try {
      while (this.current(state).status === "working") {
        if (state.round >= state.maxRounds) { this.settle(state, "limit", `Stopped after ${state.round} rounds without being judged done.`); break; }
        state.round += 1;
        const run = await this.round(state, controller, onStarted, ended);
        Object.assign(state, this.current(state));
        if (controller.signal.aborted) break;
        this.apply(state, await this.judge(run, state));
      }
    } catch (error) {
      if (this.current(state).status === "working") this.settle(state, "blocked", `The goal could not carry on: ${String((error as Error)?.message ?? error).slice(0, 300)}`);
      throw error;
    } finally {
      if (state.sessionId) this.live.delete(state.sessionId);
      end();
    }
  }

  /** One round: the goal itself the first time, a request to carry on afterwards. */
  private async round(state: GoalState, controller: AbortController, onStarted: () => void, ended: Promise<void>): Promise<Run> {
    // r17-b: the sub-goals added with /subgoal are part of the goal each round is shown.
    const goal = { ...state, objective: goalWithSubgoals(this.store, this.runtime.owner, state) };
    const prompt = state.round === 1 && !state.lastRunId ? firstPrompt(goal.objective) : nextPrompt(goal);
    for (;;) {
      try {
        return await this.runtime.run({
          prompt, signal: controller.signal, onTextDelta: () => undefined,
          ...(state.sessionId ? { sessionId: state.sessionId } : {}),
          ...(state.origin ? { source: state.origin.source, permissions: state.origin.permissions } : {}),
          onStarted: (run) => {
            if (state.origin?.chat) this.store.event(run.id, ownerChatMark, { ...state.origin.chat, chatKind: "direct" }); // owner-dm-full
            if (!state.sessionId) { state.sessionId = run.sessionId; this.live.set(run.sessionId, { controller, runId: null, ended }); }
            this.live.get(state.sessionId)!.runId = run.id;
            state.lastRunId = run.id;
            state.runIds = [...(this.current(state).runIds ?? state.runIds ?? []), run.id];
            this.save(state);
            onStarted();
          },
        });
      } catch (error) {
        // The owner's own message is still being answered: wait for it rather than giving up.
        if (!busyError.test(String((error as Error)?.message)) || controller.signal.aborted) throw error;
        await new Promise((done) => setTimeout(done, this.busyWaitMs));
      }
    }
  }

  /** The existing completion checks plus the grader, turned into one verdict. */
  async judge(run: Run, state: GoalState): Promise<Verdict> {
    const held = { score: state.score ?? 0, missing: state.missing, done: false };
    if (run.status === "needs_input") return { ...held, blocked: "It is waiting for your answer to its question." };
    if (run.status !== "completed") return { ...held, blocked: `The round did not finish: ${run.output.slice(0, 300)}` };
    const said = /^\s*BLOCKED:\s*([\s\S]*)/i.exec(run.output);
    if (said) return { ...held, blocked: said[1]!.trim().slice(0, 300) || "It said it cannot go on." };
    const problem = state.checks ? await evaluateChecks(run.output, state.checks, this.runtime.workspace) : null;
    const graded = await this.grade(run, state);
    const score = problem ? Math.min(graded.score, 0.5) : graded.score;
    const missing = [...(problem ? [problem] : []), ...graded.missing].slice(0, 8);
    return { score, missing, done: !problem && score >= goalDoneScore, blocked: graded.blocked ? missing[0] ?? "The grader says it cannot go on." : null };
  }

  private async grade(run: Run, state: GoalState): Promise<{ score: number; missing: string[]; blocked: boolean }> {
    const context = this.runtime.context({ runId: run.id, signal: AbortSignal.timeout(60_000), permissions: [] });
    try {
      const answer = await this.runtime.shaped(run, context, gradeQuestion({ ...state, objective: goalWithSubgoals(this.store, this.runtime.owner, state) }, this.recent(state.sessionId)) /* r17-b */, gradeShape);
      if (answer.status === "resolved") return GradeSchema.parse(answer.value);
    } catch { /* an unanswered grade is judged as no progress, below */ }
    return { score: state.score ?? 0, missing: ["The judge could not give a score for this round."], blocked: false };
  }

  private apply(state: GoalState, verdict: Verdict): void {
    // The owner may have paused or stopped it while the judge was reading; their choice wins.
    const { status, reason, elapsedMs, activeSince } = this.current(state);
    Object.assign(state, { status, reason, elapsedMs, activeSince });
    state.score = verdict.score;
    state.missing = verdict.missing;
    if (verdict.score > state.best) { state.best = verdict.score; state.flatRounds = 0; } else state.flatRounds += 1;
    if (state.status !== "working") { this.save(state); return; }
    if (verdict.done) this.settle(state, "done", "The goal was judged done.");
    else if (verdict.blocked) this.settle(state, "blocked", verdict.blocked);
    else if (state.flatRounds >= goalStuckRounds) this.settle(state, "blocked", `No progress in the last ${goalStuckRounds} rounds.`);
    else this.save(state);
  }

  /** The last few things the assistant said, for the grader to read. */
  private recent(sessionId: string): string {
    const said = this.store.messages(sessionId).filter((m) => m.role === "assistant" && m.content.trim()).slice(-4);
    return said.map((m) => m.content.trim()).join("\n---\n").slice(-6000);
  }
  private current(state: GoalState): GoalState {
    const saved = state.sessionId ? this.store.get("settings", this.runtime.owner, key(state.sessionId))?.data as GoalState | undefined : undefined;
    return saved ?? state;
  }
  private require(sessionId: string): GoalState {
    const saved = this.store.get("settings", this.runtime.owner, key(sessionId))?.data as GoalState | undefined;
    if (!saved) throw new Error("There is no goal in this conversation.");
    return saved;
  }
  private settle(state: GoalState, status: GoalStatus, reason: string): GoalState {
    if (state.activeSince !== null) state.elapsedMs += Math.max(0, this.now() - state.activeSince);
    Object.assign(state, { status, reason, activeSince: null });
    this.save(state);
    return this.view(state);
  }
  private save(state: GoalState): void {
    if (state.sessionId) this.store.save("settings", this.runtime.owner, key(state.sessionId), { ...state });
  }
  /** Elapsed time includes the stretch that is running now. */
  private view(state: GoalState): GoalState {
    const running = state.activeSince === null ? 0 : Math.max(0, this.now() - state.activeSince);
    return { ...state, elapsedMs: state.elapsedMs + running };
  }
}

function key(sessionId: string): string { return `goal:${sessionId}`; }

export function firstPrompt(objective: string): string {
  return `Goal: ${objective}\n\nKeep working on this until it is done. A reply along the way is only a progress note, and you will be asked to carry on. ` +
    `If you cannot go on without me, start your reply with "BLOCKED:" and say what you need.`;
}
export function nextPrompt(state: Pick<GoalState, "objective" | "round" | "maxRounds" | "missing">): string {
  const missing = state.missing.length ? state.missing.map((item) => `- ${item}`).join("\n") : "- (not judged yet)";
  return `Carry on with the goal: ${state.objective}\nRound ${state.round} of ${state.maxRounds}. Still missing:\n${missing}\n` +
    `Do the next concrete step now. If you cannot go on without me, start your reply with "BLOCKED:".`;
}
function gradeQuestion(state: GoalState, recent: string): string {
  return `You are judging whether a goal has been met. Judge only from the work described; do not do the work.\n\n` +
    `Goal: ${state.objective}\n\nWhat the assistant said most recently:\n${recent || "(nothing yet)"}\n\n` +
    `Give a score from 0 (nothing done) to 1 (fully done and checked), list what is still missing (empty when done), ` +
    `and set blocked to true only if it cannot go on without the owner.`;
}

/** The HTTP side: `/api/goal-undo/settings` holds the switches; `POST /api/goals` starts one; `/api/sessions/<id>/goal` reads it and pauses, resumes or stops it. */
export async function goalApi(goals: GoalMode, owns: (sessionId: string) => boolean, method: string, path: string, body: () => Promise<unknown>): Promise<unknown> {
  if (path === "/api/goal-undo/settings") {
    if (method === "GET") return goals.settings();
    if (method === "POST") return goals.saveSettings(await body());
    return undefined;
  }
  if (path === "/api/goals" && method === "POST") {
    const wanted = GoalStartSchema.parse(await body());
    if (wanted.sessionId && !owns(wanted.sessionId)) throw new Error("Conversation not found");
    return goals.start(wanted);
  }
  const match = /^\/api\/sessions\/([a-f0-9-]{36})\/goal$/.exec(path);
  if (!match) return undefined;
  const id = match[1]!;
  if (!owns(id)) throw new Error("Conversation not found");
  if (method === "GET") return { goal: goals.status(id) };
  if (method !== "POST") return undefined;
  const { action } = z.object({ action: z.enum(["pause", "resume", "stop"]) }).strict().parse(await body());
  if (action === "pause") return { goal: goals.pause(id) };
  if (action === "resume") return { goal: await goals.resume(id) };
  return { goal: goals.stop(id) };
}
