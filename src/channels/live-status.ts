import type { ChannelAdapter } from "./router.js";
import { chunkText } from "./deliveries.js";

/**
 * What a chat shows while a task is working: "typing…" kept on where the app has it, a reaction on
 * the person's message that says where the task is (waiting, thinking, using a tool, done, went
 * wrong), and one progress message that lists the steps and then fills in the reply as it is
 * written, edited in place. Every part is optional per app; an app with none of them simply gets
 * the finished reply, as before.
 *
 * Nothing here can fail a task: every call to the app is caught, and a part that keeps failing is
 * switched off for the rest of the task. Every word that goes out passes the same last look
 * (`guard`) as an ordinary reply.
 *
 * The approach follows OpenClaw's typing, status-reaction and draft-stream helpers (MIT); the code
 * is written for Branch.
 */
export type LiveState = "queued" | "thinking" | "tool" | "done" | "error";
/** Chosen from the short list Telegram accepts, so the same set works on every app. */
export const statusEmoji: Record<LiveState, string> = {
  queued: "👀", thinking: "🤔", tool: "\u{1F468}\u200D\u{1F4BB}", done: "👍", error: "😢",
};
export interface LiveTiming {
  /** A task that answers sooner than this never gets a progress message at all. */
  progressAfterMs: number;
  /** The fewest milliseconds between two edits of the progress message. */
  editEveryMs: number;
  /** How often "typing…" is asked for again; apps drop it after about five seconds. */
  typingEveryMs: number;
  /** Quick changes of reaction are held this long so the chat does not flicker. */
  reactEveryMs: number;
}
export const defaultLiveTiming: LiveTiming = { progressAfterMs: 4000, editEveryMs: 1500, typingEveryMs: 4000, reactEveryMs: 700 };
export type OutboundGuard = (text: string) => Promise<{ text: string; blocked: boolean }>;
export interface LiveTarget {
  adapter: ChannelAdapter;
  chatId: string;
  /** The person's message: reactions go on it and the progress message replies to it. */
  messageId: string;
  reactTo?: string | undefined;
  /** Checked before every call to the app, so Lockdown or quiet hours starting mid-task stop the status too. */
  allowed?: () => boolean;
}
interface Step { label: string; state: "working" | "done" | "failed" }
/** A part that failed this many times in a row is left alone for the rest of the task. */
const giveUpAfter = 2;
const stepMarks: Record<Step["state"], string> = { working: "…", done: "✓", failed: "✗" };

/** The progress message: the steps so far, or once the reply is being written, the reply itself. */
export function renderProgress(steps: readonly { label: string; state: Step["state"] }[], reply: string, limit: number): string {
  const done = steps.filter((step) => step.state !== "working").length;
  if (reply.trim()) {
    const head = steps.length ? `(${steps.length} ${steps.length === 1 ? "step" : "steps"})\n\n` : "";
    const room = Math.max(40, limit - head.length - 2);
    const body = reply.trim();
    return head + (body.length > room ? `${body.slice(0, room).trimEnd()} …` : body);
  }
  const shown = steps.slice(-8);
  const lines = shown.map((step) => `${stepMarks[step.state]} ${step.label}`);
  const earlier = steps.length - shown.length;
  return [`Working on it${steps.length ? ` (${done} of ${steps.length} steps done)` : ""}…`,
    ...(earlier > 0 ? [`(${earlier} earlier)`] : []), ...lines].join("\n").slice(0, limit);
}
/** A tool step in words: the label the app already shows for it, on one short line. */
function stepLabel(data: Record<string, unknown>): string {
  const label = typeof data.label === "string" && data.label.trim() ? data.label : String(data.name ?? "a step");
  return label.replace(/\s+/g, " ").trim().slice(0, 80);
}
const fitsOne = (text: string, limit: number): boolean => !!text.trim() && chunkText(text, limit).length === 1;

export class LiveStatus {
  private readonly steps: (Step & { id: string })[] = [];
  private reply = "";
  private streamBlocked = false;
  private progressId: string | null = null;
  private progressPlanned = false;
  private shown = "";
  private closed = false;
  private state: LiveState | null = null;
  private wanted: LiveState | null = null;
  private readonly failures = { typing: 0, react: 0, edit: 0 };
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private typingTimer: ReturnType<typeof setInterval> | undefined;
  private editTimer: ReturnType<typeof setTimeout> | null = null;
  private reactTimer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly limit: number;
  /** Shown so far; a patient status stays asleep until the task has worked for a while. */
  private awake: boolean;
  /**
   * `patient` is the "when needed" setting: nothing at all is shown for a quick answer, and typing,
   * the reaction and the progress message all start together once the task is still working after
   * `progressAfterMs`.
   */
  constructor(private readonly target: LiveTarget, private readonly guard: OutboundGuard,
    private readonly timing: LiveTiming = defaultLiveTiming, private readonly patient = false) {
    this.limit = Math.min(target.adapter.maxTextLength ?? 3500, 3500);
    this.awake = !patient;
  }
  /** The message has been taken on: show "seen" and start typing. */
  start(): void {
    this.setState("queued", true);
    if (this.awake) this.keepTyping();
  }
  private keepTyping(): void {
    this.typing();
    if (!this.target.adapter.sendTyping || this.typingTimer) return;
    this.typingTimer = setInterval(() => this.typing(), this.timing.typingEveryMs);
    this.typingTimer.unref();
  }
  /** The task has started and the model is reading. A task still working after a while gets a progress message. */
  thinking(): void {
    if (this.closed) return;
    this.setState("thinking");
    if (this.progressPlanned) return;
    this.progressPlanned = true;
    this.later(() => {
      if (this.closed) return;
      if (!this.awake) {
        this.awake = true;
        this.keepTyping();
        this.setState(this.wanted ?? "thinking", true);
      }
      if (this.target.adapter.edit) void this.openProgress();
    }, this.timing.progressAfterMs);
  }
  /** One stored event of the task. Tool steps go in the list; a new model round is thinking again. */
  event(kind: string, data: Record<string, unknown>): void {
    if (this.closed) return;
    // Opening a toolbox or looking a tool up is Branch finding its way, not a step of the work.
    if (kind.startsWith("tool.") && String(data.name ?? "").startsWith("tools.")) return;
    const id = String(data.id ?? data.name ?? "");
    if (kind === "tool.started") {
      this.steps.push({ id, label: stepLabel(data), state: "working" });
      this.setState("tool");
    } else if (kind === "tool.completed" || kind === "tool.failed" || kind === "tool.stalled") {
      const step = this.steps.find((s) => s.state === "working" && s.id === id) ?? this.steps.find((s) => s.state === "working");
      if (step) step.state = kind === "tool.completed" ? "done" : "failed";
    } else if (kind === "model.started") {
      // Words written before a tool call are not the reply; the next round writes that afresh.
      this.reply = "";
      this.setState("thinking");
    } else return;
    this.scheduleEdit();
  }
  /** A piece of the reply as the model writes it. */
  text(delta: string): void {
    if (this.closed || this.streamBlocked) return;
    if (this.reply.length <= this.limit) this.reply += delta;
    this.scheduleEdit();
  }
  /**
   * The task is over. When the finished reply fits the progress message, it is put there and the
   * words that went out are returned, so the caller writes them down instead of sending them
   * again. Null means "send the reply the ordinary way".
   */
  async finish(outcome: "done" | "error", reply?: string): Promise<{ messageId: string; text: string } | null> {
    if (this.closed) return null;
    this.closed = true;
    this.stopTimers();
    this.wanted = outcome;
    // A patient status that never woke has shown nothing, and ends the same way.
    if (!this.awake) return null;
    return this.enqueue(async () => {
      await this.applyReaction();
      if (!this.progressId) return null;
      if (outcome === "done" && reply !== undefined && fitsOne(reply, this.limit)) {
        const text = await this.checked(reply);
        if (text !== null && fitsOne(text, this.limit) && await this.editTo(text)) return { messageId: this.progressId, text };
      }
      const count = this.steps.length ? ` (${this.steps.length} ${this.steps.length === 1 ? "step" : "steps"})` : "";
      await this.editTo(outcome === "done" ? `Done${count}.` : `Stopped${count}.`);
      return null;
    });
  }
  /** Stops everything without a last reaction or edit, for a turn that never became a task. */
  cancel(): void {
    this.closed = true;
    this.stopTimers();
  }
  private render(): string {
    return renderProgress(this.steps, this.streamBlocked ? "" : this.reply, this.limit);
  }
  private typing(): void {
    const { adapter, chatId } = this.target;
    if (this.closed || !adapter.sendTyping || this.failures.typing >= giveUpAfter || !this.permitted()) return;
    adapter.sendTyping(chatId).then(() => { this.failures.typing = 0; }, () => { this.failures.typing++; });
  }
  /** Asks for a reaction; quick changes wait a moment so only the latest one is shown. */
  private setState(state: LiveState, now = false): void {
    if (this.closed || !this.target.adapter.react) return;
    this.wanted = state;
    if (!this.awake) return;
    if (now) { void this.enqueue(() => this.applyReaction()); return; }
    if (this.reactTimer) return;
    this.reactTimer = this.later(() => {
      this.reactTimer = null;
      void this.enqueue(() => this.applyReaction());
    }, this.timing.reactEveryMs);
  }
  private async applyReaction(): Promise<void> {
    const { adapter, chatId, messageId, reactTo } = this.target;
    const wanted = this.wanted;
    if (!adapter.react || !wanted || wanted === this.state || this.failures.react >= giveUpAfter || !this.permitted()) return;
    const previous = this.state ? statusEmoji[this.state] : undefined;
    try {
      await adapter.react(chatId, reactTo ?? messageId, statusEmoji[wanted], previous);
      this.state = wanted;
      this.failures.react = 0;
    } catch {
      this.failures.react++;
    }
  }
  /** Sends the progress message once the task has been working for a while. */
  private openProgress(): Promise<void> {
    return this.enqueue(async () => {
      if (this.closed || this.progressId || !this.permitted()) return;
      const rendered = this.render();
      const text = await this.checked(rendered);
      if (text === null) return;
      try {
        // An app that does not say which message it sent cannot have it edited; the reply still
        // comes the ordinary way, so nothing more is tried.
        this.progressId = (await this.target.adapter.send(this.target.chatId, text, this.target.messageId)) ?? null;
        this.shown = rendered;
      } catch {
        this.failures.edit++;
      }
    });
  }
  private scheduleEdit(): void {
    if (this.closed || !this.progressId || this.editTimer) return;
    this.editTimer = this.later(() => {
      this.editTimer = null;
      void this.enqueue(() => this.pushEdit());
    }, this.timing.editEveryMs);
  }
  private async pushEdit(): Promise<void> {
    if (this.closed) return;
    const rendered = this.render();
    if (rendered === this.shown) return;
    const text = await this.checked(rendered);
    if (text === null) {
      // The reply so far was held back: stop showing it while it is written, keep the steps.
      if (this.reply && !this.streamBlocked) { this.streamBlocked = true; this.scheduleEdit(); }
      return;
    }
    if (await this.editTo(text)) this.shown = rendered;
  }
  private async editTo(text: string): Promise<boolean> {
    const { adapter, chatId } = this.target;
    if (!adapter.edit || !this.progressId || this.failures.edit >= giveUpAfter || !this.permitted()) return false;
    try {
      await adapter.edit(chatId, this.progressId, text);
      this.failures.edit = 0;
      return true;
    } catch {
      this.failures.edit++;
      return false;
    }
  }
  private permitted(): boolean {
    try {
      return this.target.allowed?.() ?? true;
    } catch {
      return false;
    }
  }
  private async checked(text: string): Promise<string | null> {
    try {
      const result = await this.guard(text);
      return result.blocked ? null : result.text;
    } catch {
      return null;
    }
  }
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work);
    this.chain = next.catch(() => undefined);
    return next;
  }
  private later(work: () => void, ms: number): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => { this.timers.delete(timer); work(); }, ms);
    timer.unref();
    this.timers.add(timer);
    return timer;
  }
  private stopTimers(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.editTimer = this.reactTimer = null;
    if (this.typingTimer) clearInterval(this.typingTimer);
    this.typingTimer = undefined;
  }
}
