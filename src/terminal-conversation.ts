import type { Event, ImagePart, Run } from "./contracts.js";
import type { Runtime } from "./runtime.js";
import { carryable, carryOn } from "./carry-on.js"; // QA R1 follow-up
import type { Store } from "./store.js";
import type { PendingApproval } from "./approvals.js";
import type { ReasoningEffort } from "./models.js";
import { estimateCost, formatCost, pricingTableInUse } from "./pricing.js";
import { readPolicy, policyPresets } from "./policy.js";
import {
  activeModel, answerLine, attachedText, runTotals, sessionTotals, type Attachment,
} from "./terminal-commands.js";
import type { TranscriptLine } from "./terminal-screen.js";
import type { Row } from "./terminal-place-data.js";
import type { Words } from "./terminal-words.js";

/**
 * One conversation in the terminal: what was said, the steps each task took, the question a task
 * stopped on, and the settings that only hold for this conversation. It knows nothing about how the
 * view is drawn; it adds lines to its transcript and says when something changed.
 */
export interface Step { label: string; tool: string; status: "working" | "done" | "failed"; detail: string }
interface ActiveRun { controller: AbortController; run?: Run; eventId: number; steps: Step[] }
const safe = (text: string): string => text.replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");

export class Conversation {
  sessionId: string | undefined;
  model: string | undefined;
  reasoning: ReasoningEffort | null | undefined;
  plan = false;
  verify = false;
  dryRun = false;
  /** A temporary conversation keeps nothing in memory; it applies when the conversation starts. */
  temporary = false;
  details = false;
  attachments: Attachment[] = [];
  awaiting: PendingApproval | undefined;
  readonly transcript: TranscriptLine[] = [];
  steps: Step[] = [];
  private active: ActiveRun | undefined;
  private awaitingPrompt = "";
  private queue: string[] = [];
  private busy = false;
  private stream = "";
  closing = false;
  /** phase2/everywhere: the name each answer is headed with, the assistant's own as in the window (#18). */
  assistant = "Assistant";

  constructor(
    private readonly runtime: Runtime,
    private readonly changed: (kind: "line" | "work") => void,
    private readonly pollIntervalMs = 75,
  ) {}

  get working(): boolean { return !!this.active; }
  /** Adds a line to the transcript; long text keeps its own line breaks. */
  say(kind: TranscriptLine["kind"], text: string): void {
    for (const line of safe(text).split("\n")) this.transcript.push({ kind, text: line });
    if (this.transcript.length > 5000) this.transcript.splice(0, this.transcript.length - 5000);
    this.changed("line");
  }
  /** Starts a fresh conversation; the next message creates it. */
  reset(sessionId?: string): void {
    this.sessionId = sessionId;
    this.transcript.length = 0;
    this.steps = [];
    if (sessionId) for (const turn of this.runtime.store.messages(sessionId))
      if ((turn.role === "user" || turn.role === "assistant") && turn.from !== "branch") this.say(turn.role === "user" ? "you" : "assistant", turn.content);
    this.changed("line");
  }
  /** Words of context used and money spent in this conversation, as the window's meter says it. */
  status(words?: Words): string {
    const totals = sessionTotals(this.runtime, this.sessionId, activeModel(this.runtime, this.model));
    const short = (count: number): string => (count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count));
    const flags = [this.verify && "verify"].filter(Boolean).join(" ");
    const cost = words && totals.cost === "no price on file" ? words.t("dashboard.spend.noPrice", totals.cost) : totals.cost;
    return `${short(totals.input)} in / ${short(totals.output)} out · ${cost}${flags ? ` · ${flags}` : ""}`;
  }
  /** The model chip and the other things the next message will carry, as the composer shows them. */
  chips(words?: Words): string[] {
    const say = (key: string, english: string): string => words?.t(key, english) ?? english;
    const summary = this.runtime.models.summary(this.runtime.owner);
    const id = this.model ?? summary.activePreset ?? summary.defaultPreset;
    const preset = this.runtime.models.find(id);
    const policy = readPolicy(this.runtime.store, this.runtime.owner).preset;
    // The approval mode in the language in force, by the same words the window's settings use.
    const english = policyPresets().find((entry) => entry.id === policy)?.label ?? policy;
    const label = say(`settings-kit.value.policy.preset.${policy}`, english);
    return [preset?.name ?? id, label, ...this.attachments.map((file) => `+ ${file.name}`),
      ...(this.temporary ? [say("composer.temporary", "Temporary")] : []),
      ...(this.dryRun ? [say("terminal.chip.dry-run", "Dry run")] : []), ...(this.plan ? [say("terminal.chip.plan", "Plan first")] : [])];
  }
  modelName(): string { return this.chips()[0] ?? ""; }
  /** phase2/everywhere: the conversation's title, as the window names it: its first message. */
  title(): string | undefined {
    const first = this.transcript.find((line) => line.kind === "you")?.text.replace(/\s+/g, " ").trim();
    return first ? (first.length > 48 ? `${first.slice(0, 47)}…` : first) : undefined;
  }

  /** Ctrl+C: stops the task in hand. Says so when nothing is working. */
  interrupt(): void {
    this.queue = [];
    if (!this.active || this.active.controller.signal.aborted) {
      this.say("note", "[nothing is working right now; press Ctrl+D to leave]");
      return;
    }
    this.active.controller.abort(new Error("Cancelled by user"));
    this.say("note", "[stopping; waiting for the task to tidy up]");
  }
  stop(): void {
    this.closing = true;
    this.queue = [];
    this.active?.controller.abort(new Error("Cancelled by user"));
  }
  /** A message to send, or the answer to the question a task stopped on. */
  async send(text: string): Promise<void> {
    if (this.awaiting) return this.answerApproval(text);
    this.say("you", text);
    this.queue.push(text);
    await this.drain();
  }
  private async drain(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.queue.length && !this.closing) await this.execute(this.queue.shift()!);
    } finally {
      this.busy = false;
      this.changed("work");
    }
  }

  private async execute(prompt: string): Promise<void> {
    const images = this.attachments.map((file) => file.image).filter((image): image is ImagePart => !!image);
    const text = prompt + attachedText(this.attachments);
    this.attachments = [];
    await this.perform(prompt, (active) => this.runtime.run({
      prompt: text, signal: active.controller.signal,
      ...(this.sessionId ? { sessionId: this.sessionId } : {}), ...(this.model ? { model: this.model } : {}),
      ...(this.reasoning !== undefined ? { reasoning: this.reasoning } : {}), ...(images.length ? { images } : {}),
      ...(this.plan ? { plan: true } : {}), ...(this.verify ? { verify: true } : {}), ...(this.dryRun ? { dryRun: true } : {}),
      ...(this.temporary && !this.sessionId ? { temporary: true } : {}),
      onStarted: (started) => { active.run = started; this.progress(active); },
      onTextDelta: (delta) => { this.progress(active); this.streamDelta(delta); },
    }));
  }
  /** One task shown here: its steps while it works, then its answer or its question. */
  private async perform(prompt: string, start: (active: ActiveRun) => Promise<Run>): Promise<void> {
    const active: ActiveRun = { controller: new AbortController(), eventId: 0, steps: [] };
    this.active = active;
    this.steps = active.steps;
    this.changed("work");
    const poll = setInterval(() => this.progress(active), this.pollIntervalMs);
    try {
      const run = await start(active);
      this.sessionId = run.sessionId;
      this.progress(active);
      this.report(run, prompt);
    } catch {
      this.say("bad", "[the task could not start or finish; run `branch logs` on it for details]");
    } finally {
      clearInterval(poll);
      this.active = undefined;
      this.flushStream();
    }
  }
  /** Model text as it arrives: whole lines join the transcript, the unfinished one waits. */
  private streamDelta(text: string): void {
    this.stream += safe(text);
    const parts = this.stream.split("\n");
    this.stream = parts.pop() ?? "";
    for (const part of parts) this.say("assistant", part);
    if (this.stream) this.changed("line");
  }
  /** The line still arriving, for the view to show under the transcript. */
  get partial(): string { return this.stream; }
  private flushStream(): void {
    if (!this.stream) return;
    const text = this.stream;
    this.stream = "";
    this.say("assistant", text);
  }
  private report(run: Run, prompt: string): void {
    if (run.status === "completed") {
      this.stream = "";
      this.dropStreamed();
      this.say("ok", `${this.assistant}:`);
      this.say("assistant", run.output);
      const line = answerLine(runTotals(this.runtime, run.id, activeModel(this.runtime, this.model)));
      if (line) this.say("note", line);
      return;
    }
    const waiting = this.runtime.approvals.waiting(run.sessionId).at(-1);
    this.flushStream();
    if (run.status === "needs_input" && waiting) return this.askApproval(waiting, prompt);
    if (run.status === "needs_input") { this.say("warn", run.output); return; }
    this.say("warn", `[task ${run.status}] ${safe(run.output).slice(0, 500)}`);
  }
  /** The streamed words are replaced by the finished answer, which is the one that counts. */
  private dropStreamed(): void {
    while (this.transcript.at(-1)?.kind === "assistant") this.transcript.pop();
  }
  private askApproval(waiting: PendingApproval, prompt: string): void {
    this.awaiting = waiting;
    this.awaitingPrompt = prompt;
    // phase2/everywhere: drawn as one card with a warning edge, like the window's "needs you" card.
    this.say("ask", "Branch needs your yes before it goes on");
    this.say("askline", `What: ${waiting.label}`);
    this.say("askline", `Tool: ${waiting.tool}`);
    if (waiting.target) this.say("askline", `Exactly: ${waiting.target}`);
    this.say("askline", "Answer y (yes), n (no) or s (yes, for this conversation) with one key, or a (yes, always) then Enter.");
  }
  /** y / n / a / s, answered through the same policy route the app's settings screen uses. */
  private async answerApproval(text: string): Promise<void> {
    const waiting = this.awaiting!, choice = text.trim().toLowerCase()[0];
    if (!choice || !"ynas".includes(choice)) { this.say("note", "Please answer y, n, a or s."); return; }
    this.awaiting = undefined;
    const decision = choice === "n" ? "deny" : "allow";
    const remember = choice === "a" ? "always" : choice === "s" ? "session" : choice === "n" ? "session" : waiting.remember;
    try {
      // Bound to the exact request the person was shown, the same as the app's own card.
      const answered = this.runtime.approve(waiting.sessionId, decision, remember, waiting.fingerprint);
      this.say("note", `[noted: ${answered.decision === "allow" ? "go ahead" : "do not do that"} for ${answered.tool}${answered.target ? " on " + answered.target : ""}]`);
    } catch (error) {
      this.say("bad", `[${error instanceof Error ? error.message : String(error)}]`);
      return;
    }
    // QA R1 follow-up: the task that asked carries on as itself, and after a yes the engine runs the approved call.
    const waitingRun = carryable(this.runtime, waiting.runId, "owner");
    if (waitingRun && !this.busy) return this.carry(waitingRun, { decision, fingerprint: waiting.fingerprint });
    this.queue.push(this.awaitingPrompt);
    await this.drain();
  }
  /** QA R1 follow-up: carries the answered task on, shown here as a task of its own is (progress, then its answer). */
  private async carry(run: Run, answer: { decision: "allow" | "deny"; fingerprint: string }): Promise<void> {
    this.busy = true;
    try {
      await this.perform(this.awaitingPrompt, (active) => carryOn(this.runtime, run, answer, {
        signal: active.controller.signal,
        onStarted: (started) => { active.run = started; this.progress(active); },
        onTextDelta: (delta) => { this.progress(active); this.streamDelta(delta); },
      }));
      while (this.queue.length && !this.closing) await this.execute(this.queue.shift()!);
    } finally {
      this.busy = false;
      this.changed("work");
    }
  }
  /** New events since last time, as one short row each; Ctrl+E shows what is behind them. */
  private progress(active: ActiveRun): void {
    if (!active.run) return;
    for (const event of this.runtime.store.events(active.run.id)) {
      if (event.id <= active.eventId) continue;
      active.eventId = event.id;
      const row = stepRow(event, active.steps);
      if (row) this.say("step", this.details ? `${row} — ${String(event.kind)}` : row);
    }
  }

  /** The side pane's four tabs, from this conversation alone. */
  paneRows(tab: string, words: Words): Row[] {
    if (tab === "activity") return this.activityRows(words);
    if (tab === "plan") return this.steps.map((step) => ({ title: step.label, detail: step.status, tone: step.status === "failed" ? "bad" as const : step.status === "done" ? "ok" as const : "warn" as const }));
    if (tab === "files") return this.steps.filter((step) => step.detail).map((step) => ({ title: step.detail, detail: step.tool }));
    if (tab === "memory") return this.memoryRows();
    return [];
  }
  private activityRows(words: Words): Row[] {
    const policy = readPolicy(this.runtime.store, this.runtime.owner).preset;
    const working = this.steps.filter((step) => step.status === "working");
    // phase2/everywhere: a question waiting for the owner is said at the top of Activity, as in the window.
    const waiting = this.awaiting ? [{ title: words.t("terminal.pane.waiting", "Waiting for your yes"), detail: this.awaiting.label, tone: "warn" as const }] : [];
    return [
      { title: this.modelName(), detail: this.active ? words.t("terminal.pane.working", "working on it") : words.t("terminal.pane.ready", "ready"), tone: this.active ? "warn" as const : "ok" as const },
      ...waiting,
      ...working.map((step) => ({ title: step.label, detail: step.tool })),
      { title: policyPresets().find((entry) => entry.id === policy)?.label ?? policy, detail: words.t("terminal.pane.policy", "when it checks with you") },
    ];
  }
  private memoryRows(): Row[] {
    if (!this.sessionId) return [];
    const used = new Set<string>();
    for (const run of this.runtime.store.runs(this.runtime.owner).filter((entry) => entry.sessionId === this.sessionId))
      for (const event of this.runtime.store.events(run.id))
        if (/^memory\./.test(event.kind) && typeof event.data.text === "string") used.add(event.data.text.slice(0, 120));
    return [...used].map((text) => ({ title: text }));
  }
}

const cleanName = (value: unknown): string => String(value ?? "").replace(/[^a-zA-Z0-9_.:-]/g, "?").slice(0, 100);
/**
 * One compact row per step, and nothing at all for events that are only interesting inside. Tool
 * results and error bodies never reach here: only the name of the tool and what it was asked to
 * touch, both of which the person already chose.
 */
export function stepRow(event: Event, steps: Step[]): string | undefined {
  const label = typeof event.data.label === "string" ? event.data.label.slice(0, 120) : "";
  const tool = cleanName(event.data.name);
  if (event.kind === "tool.started") {
    steps.push({ label: label || tool, tool, status: "working", detail: String(event.data.target ?? "") });
    return `  · ${label || tool}`;
  }
  if (event.kind === "tool.completed" || event.kind === "tool.failed") {
    const step = steps.findLast((entry) => entry.tool === tool && entry.status === "working");
    if (step) step.status = event.kind === "tool.failed" ? "failed" : "done";
    return `  ${event.kind === "tool.failed" ? "x" : "ok"} ${label || step?.label || tool}`;
  }
  if (event.kind === "policy.ask") return `  ? ${label || tool} is waiting for your yes`;
  if (event.kind === "tool.simulated") return `  ~ ${label || tool} (dry run: shown, not done)`;
  if (event.kind === "model.retry_scheduled") return "  · the model is busy; trying again";
  if (event.kind === "run.steered") return "  · your note was added to the task";
  if (event.kind === "plan.created") return "  · a plan was written";
  return undefined;
}

/**
 * Wave 8: what a task used, in one line, for the terminal. Reported figures are what the service
 * itself counted; where it counted nothing, the estimate is named as an estimate rather than
 * passed off as the real number. Nothing at all is said when neither is known.
 */
export function usageLine(store: Store, run: Run): string | null {
  const used = store.usage(run.id);
  const at = (name: string): number => used[name] ?? 0;
  const reported = at("reportedInput") + at("reportedOutput");
  const estimated = at("estimatedInput") + at("estimatedOutput");
  if (!reported && !estimated) return null;
  const words = reported
    ? `${at("reportedInput")} in, ${at("reportedOutput")} out (counted by the service)`
    : `about ${at("estimatedInput")} in, about ${at("estimatedOutput")} out (an estimate)`;
  const cost = runCost(store, run, used);
  return `[tokens: ${words}${cost ? ` · ${cost}` : ""}]`;
}
/**
 * What one task cost, priced with whatever model actually answered. Where no price is on file for
 * that model, nothing is said at all rather than a figure nobody can stand behind.
 */
export function runCost(store: Store, run: Run, used: Record<string, number>): string | null {
  const model = store.events(run.id)
    .filter((event) => event.kind === "model.completed" && typeof event.data.model === "string")
    .map((event) => String(event.data.model)).at(-1);
  if (!model) return null;
  const { overrides } = pricingTableInUse(store, run.owner);
  const estimate = estimateCost(model, {
    input: used.reportedInput ?? used.estimatedInput ?? 0,
    output: used.reportedOutput ?? used.estimatedOutput ?? 0,
    // Cache reads and writes, parts of the reported input, are priced at their own rates.
    cached: used.reportedCachedInput ?? 0, cacheWrite: used.reportedCacheWrite ?? 0, cacheWrite1h: used.reportedCacheWrite1h ?? 0,
  }, overrides);
  return estimate.amount === null ? null : `${model} · ${formatCost(estimate)}`;
}
