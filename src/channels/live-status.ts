import type { ChannelAdapter, MessageFormat } from "./router.js";
import { chunkText } from "./deliveries.js";
import { kindLines, type RichText } from "./progress-render.js";

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
 * With a `StepsSource` (the owner's "Show steps in chats", in a direct chat), the progress message
 * is the task's steps as Hermes Agent shows them (src/channels/progress-render.ts): one line per
 * step, commands as code, sent quietly, and ended with a line saying how it went. The reply then
 * goes out as a message of its own, so it is the one that rings.
 *
 * An app that says "too many requests, wait N seconds" (Telegram's retry_after) is waited out: that
 * is not a failure, and the progress message carries on after the wait.
 *
 * The approach follows OpenClaw's typing, status-reaction and draft-stream helpers (MIT) and Hermes
 * Agent's progress bubble (MIT); the code is written for Branch.
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
/** The task's steps as the progress message shows them; `final` adds the line saying how it ended. */
export interface StepsSource {
  render(limit: number, final?: "done" | "error"): RichText;
  /**
   * The steps as one or more messages (src/channels/steps-display.ts `overflow` and `grouping`): a list too long for one
   * message carries on in a new one. Absent, the one message from `render` is edited in place.
   */
  pages?(limit: number, final?: "done" | "error"): RichText[];
  /** A message per step, sent and never edited (Hermes Agent's "separate"); works on an app that cannot edit too. */
  each?: boolean;
  /** How many steps the task has taken; a task with none is never shown a steps message. */
  count?(): number;
}
/** How long an app asked to be left alone (Telegram's `retry_after`, carried on the error), in ms; 0 for any other failure. */
export function retryAfterMs(error: unknown): number {
  const seconds = Number((error as { retryAfter?: unknown } | null)?.retryAfter);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 300) * 1000 : 0;
}
export interface LiveTarget {
  adapter: ChannelAdapter;
  chatId: string;
  /** The person's message: reactions go on it and, unless `quote` says otherwise, the progress message replies to it. */
  messageId: string;
  reactTo?: string | undefined;
  /**
   * Which message the progress message quotes, asked as it is sent (src/channels/reply-style.ts): the answer's quoting
   * rule decides, so the steps message and the reply below it never both quote. Absent means it quotes `messageId`.
   */
  quote?: () => string | undefined;
  /** False when the owner switched the reaction on the person's message off for this app. */
  react?: boolean;
  /**
   * A message of this answer already in the chat (the reply's first words, written before the task took a step) that
   * the steps message takes over, so the steps stay above the answer. Null when there is none.
   */
  adopt?: () => Promise<string | null>;
  /** Checked before every call to the app, so Lockdown or quiet hours starting mid-task stop the status too. */
  allowed?: () => boolean;
  /**
   * A group, where other people read along: the steps are shown as kinds and counts ("Reading 2 files"), never by
   * their labels, which name files, pages and commands.
   */
  kindsOnly?: boolean | undefined;
  /** False: no progress message at all, only typing and the reaction (the owner's "no steps in groups"). */
  progress?: boolean | undefined;
  /**
   * A picture of the task's browser now (a masked frame), or null when there is none to show. Set only for a direct
   * chat whose owner has pictures on and whose app can send a file; absent, no picture is ever sent.
   */
  picture?: (() => Promise<{ bytes: Uint8Array; caption: string } | null>) | undefined;
  /** The buttons under a picture kept in place (Take over, or Hand back): values the router reads back as a press. */
  pictureButtons?: (() => { label: string; value: string; webApp?: string }[]) | undefined;
}
/** Pictures of the browser: the first after the first browser step, then at most one every so often, and a cap per task. */
export const pictureTiming = { everyMs: 20_000, most: 6, inPlaceEveryMs: 4_000, inPlaceMost: 150 };
interface Step { label: string; name: string; state: "working" | "done" | "failed" }
/** A part that failed this many times in a row is left alone for the rest of the task. */
const giveUpAfter = 2;
const stepMarks: Record<Step["state"], string> = { working: "…", done: "✓", failed: "✗" };

/** The progress message: the steps so far, or once the reply is being written, the reply itself. */
export function renderProgress(steps: readonly { label: string; name?: string; state: Step["state"] }[], reply: string, limit: number, kindsOnly = false): string {
  const done = steps.filter((step) => step.state !== "working").length;
  if (reply.trim()) {
    const head = steps.length ? `(${steps.length} ${steps.length === 1 ? "step" : "steps"})\n\n` : "";
    const room = Math.max(40, limit - head.length - 2);
    const body = reply.trim();
    return head + (body.length > room ? `${body.slice(0, room).trimEnd()} …` : body);
  }
  const shown = kindsOnly ? [] : steps.slice(-8);
  const lines = kindsOnly ? kindLines(steps.map((step) => step.name ?? "")) : shown.map((step) => `${stepMarks[step.state]} ${step.label}`);
  const earlier = kindsOnly ? 0 : steps.length - shown.length;
  return [`Working on it${steps.length ? ` (${done} of ${steps.length} steps done)` : ""}…`,
    ...(earlier > 0 ? [`(${earlier} earlier)`] : []), ...lines].join("\n").slice(0, limit);
}
const thinkingWords = "is thinking…", workingWords = "is working…";
/** A step as a status line: "is Reading notes.md…", short enough for the app's status. */
const statusOf = (label: string): string => {
  const words = label.charAt(0).toLowerCase() + label.slice(1);
  return `is ${words.length > 60 ? `${words.slice(0, 59)}…` : words}${words.endsWith("…") ? "" : "…"}`;
};
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
  /** With pages (`StepsSource.pages`): every message the steps went out in, oldest first, and what each shows. */
  private readonly pageIds: string[] = [];
  private readonly pageShown: string[] = [];
  /** The steps' messages have been started (with `each`, the first step may not have come yet). */
  private pagesOpen = false;
  private progressPlanned = false;
  /** The task has worked long enough for a progress message; it opens with its first step. */
  private due = false;
  private shown = "";
  private closed = false;
  private state: LiveState | null = null;
  private wanted: LiveState | null = null;
  private readonly failures = { typing: 0, react: 0, edit: 0, status: 0 };
  /** The status line last asked for, so the same words are not sent again. */
  private statusShown = "";
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private pictures = 0;
  private pictureAt = 0;
  private pictureDue: ReturnType<typeof setTimeout> | null = null;
  private pictureCaption = "";
  /** The one picture message kept up to date in place, where the app can replace a picture (Telegram, Discord). */
  private pictureId: string | null = null;
  private lastPicture: { name: string; mediaType: string; bytes: Uint8Array; caption: string } | null = null;
  private get inPlace(): boolean { return !!this.target.adapter.sendPicture && !!this.target.adapter.editPicture; }
  private typingTimer: ReturnType<typeof setInterval> | undefined;
  private editTimer: ReturnType<typeof setTimeout> | null = null;
  private reactTimer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly limit: number;
  /** Nothing is sent to the app before this time (it asked to be left alone for a while). */
  private pausedUntil = 0;
  /** Shown so far; a patient status stays asleep until the task has worked for a while. */
  private awake: boolean;
  /**
   * `patient` is the "when needed" setting: nothing at all is shown for a quick answer, and typing,
   * the reaction and the progress message all start together once the task is still working after
   * `progressAfterMs`.
   */
  constructor(private readonly target: LiveTarget, private readonly guard: OutboundGuard,
    private readonly timing: LiveTiming = defaultLiveTiming, private readonly patient = false,
    private readonly stepsSource?: StepsSource, private readonly separateReply = false) {
    this.limit = Math.min(target.adapter.maxTextLength ?? 3500, 3500);
    this.awake = !patient;
  }
  /** The message has been taken on: show "seen" and start typing. */
  start(): void {
    this.setState("queued", true);
    if (this.awake) this.keepTyping();
  }
  private keepTyping(): void {
    this.status(thinkingWords);
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
      this.due = true;
      if (this.target.progress !== false && (this.target.adapter.edit || this.stepsSource?.each) && this.hasSteps()) void this.openProgress();
    }, this.timing.progressAfterMs);
  }
  /**
   * Hermes Agent sends its progress bubble only once a tool runs, and OpenClaw's quiet progress mode posts nothing for a
   * turn without one: a task that only thinks and answers shows typing and the reaction, and then its answer, with no
   * "Done · 0 steps" message of its own.
   */
  private hasSteps(): boolean {
    if (this.stepsSource?.count) {
      try { return this.stepsSource.count() > 0; } catch { return this.steps.length > 0; }
    }
    // A steps source that cannot count is shown as it always was.
    return this.stepsSource ? true : this.steps.length > 0;
  }
  /** One stored event of the task. Tool steps go in the list; a new model round is thinking again. */
  event(kind: string, data: Record<string, unknown>): void {
    if (this.closed) return;
    // Opening a toolbox or looking a tool up is Branch finding its way, not a step of the work.
    if (kind.startsWith("tool.") && String(data.name ?? "").startsWith("tools.")) return;
    const id = String(data.id ?? data.name ?? "");
    if (kind === "tool.started") {
      this.steps.push({ id, label: stepLabel(data), name: String(data.name ?? ""), state: "working" });
      this.setState("tool");
      // A group's status names no file or command (Hermes Agent's "verb" live status); a direct chat's says the step.
      this.status(this.target.kindsOnly ? workingWords : statusOf(stepLabel(data)));
      this.openIfDue();
    } else if (kind === "tool.completed" || kind === "tool.failed" || kind === "tool.stalled") {
      const step = this.steps.find((s) => s.state === "working" && s.id === id) ?? this.steps.find((s) => s.state === "working");
      if (step) step.state = kind === "tool.completed" ? "done" : "failed";
      if (kind === "tool.completed" && step && /^browser\./.test(step.name)) this.browserStep(step.label);
    } else if (kind === "model.started") {
      // Words written before a tool call are not the reply; the next round writes that afresh.
      this.reply = "";
      this.setState("thinking");
      this.status(thinkingWords);
    } else {
      // The steps come from the task's whole record, so anything it does may change them (an installed program's own
      // steps arrive as program.step.* events, and may be the first step of all).
      if (this.stepsSource) { this.openIfDue(); this.scheduleEdit(); }
      return;
    }
    this.scheduleEdit();
  }
  /** The task has worked long enough and now has a step to show: the progress message opens. */
  private openIfDue(): void {
    if (this.due && !this.progressId && this.target.progress !== false && (this.target.adapter.edit || this.stepsSource?.each) && this.hasSteps()) void this.openProgress();
  }
  /**
   * A browser step finished: a picture of the page goes out now if none has for a while, otherwise once the wait is
   * over (the newest step's words as its caption), and never more than `pictureTiming.most` for one task.
   */
  private browserStep(label: string): void {
    if (!this.target.picture || (!this.target.adapter.sendFile && !this.inPlace) || this.target.kindsOnly || this.pictures >= this.mostPictures) return;
    this.pictureCaption = label;
    if (this.pictureDue) return;
    const wait = Math.max(0, this.pictureAt + (this.inPlace ? pictureTiming.inPlaceEveryMs : pictureTiming.everyMs) - Date.now());
    // The page is pictured the moment it is due (a quick task's window closes when it ends); it is sent in turn.
    const take = () => { this.pictureDue = null; this.pictureWork = this.takePicture(); };
    if (!this.pictureAt || wait === 0) take(); else this.pictureDue = this.later(take, wait);
  }
  private get mostPictures(): number { return this.inPlace ? pictureTiming.inPlaceMost : pictureTiming.most; }
  /** The page changed hands (Take over, Hand back): the picture and its buttons are brought up to date at once. */
  refreshPicture(): void {
    if (this.closed || !this.target.picture || this.target.kindsOnly) return;
    if (this.pictureDue) { clearTimeout(this.pictureDue); this.timers.delete(this.pictureDue); this.pictureDue = null; }
    this.pictureWork = this.takePicture();
  }
  private quoteTarget(): string | undefined { return this.target.quote ? this.target.quote() : this.target.messageId; }
  private pictureWork: Promise<void> | null = null;
  private picturesClosed = false;
  private async takePicture(): Promise<void> {
    if (this.closed || this.picturesClosed || !this.permitted() || this.pictures >= this.mostPictures || Date.now() < this.pausedUntil) return;
    this.pictures++;
    this.pictureAt = Date.now();
    let shot: { bytes: Uint8Array; caption: string } | null = null;
    try { shot = await this.target.picture!(); } catch { shot = null; }
    if (!shot?.bytes.length) { this.pictures--; return; }
    // A capture can outlive finish's bounded wait; it must not enqueue another picture after cleanup.
    if (this.closed || this.picturesClosed) return;
    await this.enqueue(() => this.sendPicture(shot!));
  }
  private async sendPicture(shot: { bytes: Uint8Array; caption: string }): Promise<void> {
    const bytes = shot.bytes;
    if (this.closed || this.picturesClosed || !this.permitted()) return;
    // The page the picture shows, else what the step was; every word through the chat's outbound check.
    const caption = (shot!.caption ? await this.checked(shot!.caption) : null) ?? await this.checked(statusOf(this.pictureCaption));
    if (caption === null) return;
    if (this.target.adapter.maxFileBytes && bytes.length > this.target.adapter.maxFileBytes) return;
    const file = { name: "branch-browser.jpg", mediaType: "image/jpeg", bytes, caption };
    this.lastPicture = file;
    try {
      if (this.inPlace) {
        const buttons = this.closed ? [] : this.target.pictureButtons?.() ?? [];
        if (this.pictureId) await this.target.adapter.editPicture!(this.target.chatId, this.pictureId, file, buttons);
        // Pictures follow the chat's quoting rule like the steps message (#700), not a quote on every one.
        else this.pictureId = await this.target.adapter.sendPicture!(this.target.chatId, file, buttons, this.quoteTarget()) ?? null;
      } else await this.target.adapter.sendFile!(this.target.chatId, file, this.quoteTarget());
    } catch (error) {
      const wait = retryAfterMs(error);
      if (wait) this.pausedUntil = Date.now() + wait;
    }
  }
  /** A piece of the reply as the model writes it. */
  text(delta: string): void {
    // The steps message stays the steps; the reply goes out on its own at the end.
    if (this.closed || this.streamBlocked || this.stepsSource || this.separateReply) return;
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
    // A picture already taken goes out before the reply, never after it (bounded, so a slow app never holds the reply).
    if (this.pictureDue) { clearTimeout(this.pictureDue); this.timers.delete(this.pictureDue); this.pictureDue = null; }
    if (this.pictureWork) await Promise.race([this.pictureWork, new Promise((done) => { setTimeout(done, 5000).unref?.(); })]);
    this.pictureWork = null;
    // Close picture admission before queueing the final edit: delayed captures and queued sends stop here.
    this.picturesClosed = true;
    // The task is over: its last picture stays, without buttons that could no longer do anything.
    if (this.pictureId && this.lastPicture && this.inPlace && this.permitted()) {
      const { pictureId, lastPicture } = this;
      await this.enqueue(() => this.target.adapter.editPicture!(this.target.chatId, pictureId, lastPicture, [])).catch(() => undefined);
    }
    this.closed = true;
    this.stopTimers();
    this.clearStatus();
    this.wanted = outcome;
    // A patient status that never woke has shown nothing, and ends the same way.
    if (!this.awake) return null;
    if (this.stepsSource) return this.finishSteps(outcome);
    return this.enqueue(async () => {
      await this.applyReaction();
      if (!this.progressId) return null;
      if (!this.separateReply && outcome === "done" && reply !== undefined && fitsOne(reply, this.limit)) {
        const text = await this.checked(reply);
        if (text !== null && fitsOne(text, this.limit) && await this.editTo(text)) return { messageId: this.progressId, text };
      }
      const count = this.steps.length ? ` (${this.steps.length} ${this.steps.length === 1 ? "step" : "steps"})` : "";
      await this.editTo(outcome === "done" ? `Done${count}.` : `Stopped${count}.`);
      return null;
    });
  }
  /**
   * The steps message gets its last line, and the reply goes out the ordinary way (null), so it arrives as a
   * message of its own. Not waited for: a pause the app asked for must not hold the reply back.
   */
  private finishSteps(outcome: "done" | "error"): Promise<null> {
    void this.enqueue(async () => {
      await this.applyReaction();
      if (!this.progressId && !this.pageIds.length && !this.pagesOpen) return;
      // A "wait" answer to the last line is waited out too, a few times at most.
      for (let tries = 0; tries < 3; tries++) {
        const wait = this.pausedUntil - Date.now();
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait).unref());
        const done = this.stepsSource!.pages ? await this.syncPages(outcome) : await this.editTo(this.stepsSource!.render(this.limit, outcome));
        if (done || this.pausedUntil <= Date.now()) return;
      }
    });
    return Promise.resolve(null);
  }
  /**
   * Removes the steps message(s) once a good answer has arrived (the owner's `cleanup`), where the app can. Waits for
   * the last edit first. A message the app will not remove is left as it is.
   */
  async remove(): Promise<void> {
    await this.enqueue(async () => {
      const { adapter, chatId } = this.target;
      if (!adapter.deleteMessage || !this.permitted()) return;
      const ids = this.pageIds.length ? this.pageIds.filter(Boolean) : this.progressId ? [this.progressId] : [];
      for (const id of ids) await adapter.deleteMessage(chatId, id).catch(() => undefined);
    });
  }
  /** Stops everything without a last reaction or edit, for a turn that never became a task. */
  cancel(): void {
    this.closed = true;
    this.stopTimers();
    this.clearStatus();
  }
  private render(): RichText {
    if (this.stepsSource) return this.stepsSource.render(this.limit);
    return { text: renderProgress(this.steps, this.streamBlocked ? "" : this.reply, this.limit, this.target.kindsOnly === true), spans: [] };
  }
  /**
   * The words after the last look, with their code spans only when the look changed nothing: a span measured
   * on other words would mark the wrong ones. Null when the words were held back.
   */
  private async format(rendered: RichText): Promise<{ text: string; format: MessageFormat } | null> {
    const text = await this.checked(rendered.text);
    if (text === null) return null;
    const spans = text === rendered.text ? rendered.spans : [];
    return { text, format: { ...(spans.length ? { spans } : {}), ...(this.stepsSource ? { quiet: true } : {}) } };
  }
  /**
   * The app's working-status line (Slack's assistant status), scrubbed like every word that goes out, sent only when it
   * changes. Two failures in a row (no scope, not an assistant thread) and it is left alone for the rest of the task.
   */
  private status(words: string): void {
    const { adapter, chatId, messageId } = this.target;
    if (this.closed || !adapter.setStatus || !this.awake || words === this.statusShown || this.failures.status >= giveUpAfter || !this.permitted()) return;
    this.statusShown = words;
    void this.enqueue(async () => {
      const checked = await this.checked(words);
      if (checked === null) return;
      await adapter.setStatus!(chatId, messageId, checked).then(() => { this.failures.status = 0; }, () => { this.failures.status++; });
    });
  }
  private clearStatus(): void {
    const { adapter, chatId, messageId } = this.target;
    if (!adapter.setStatus || !this.statusShown || this.failures.status >= giveUpAfter) return;
    this.statusShown = "";
    void this.enqueue(() => adapter.setStatus!(chatId, messageId, "").catch(() => undefined));
  }
  private typing(): void {
    const { adapter, chatId } = this.target;
    if (this.closed || !adapter.sendTyping || this.failures.typing >= giveUpAfter || !this.permitted()) return;
    adapter.sendTyping(chatId).then(() => { this.failures.typing = 0; }, () => { this.failures.typing++; });
  }
  /** Asks for a reaction; quick changes wait a moment so only the latest one is shown. */
  private setState(state: LiveState, now = false): void {
    if (this.closed || !this.target.adapter.react || this.target.react === false) return;
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
    if (!adapter.react || this.target.react === false || !wanted || wanted === this.state || this.failures.react >= giveUpAfter || !this.permitted()) return;
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
      if (this.closed || this.progressId || this.pagesOpen || !this.permitted() || Date.now() < this.pausedUntil) return;
      if (this.stepsSource?.pages) { this.pagesOpen = true; await this.syncPages(); return; }
      const rendered = this.render();
      const out = await this.format(rendered);
      if (out === null) return;
      try {
        // The reply's first words are already in the chat above where this would land: they become the steps, and the
        // reply starts again below them.
        const adopted = await this.target.adopt?.().catch(() => null) ?? null;
        if (adopted) {
          this.progressId = adopted;
          if (await this.put(out.text, out.format)) this.shown = rendered.text;
          else this.scheduleEdit();
          return;
        }
        // An app that does not say which message it sent cannot have it edited; the reply still
        // comes the ordinary way, so nothing more is tried.
        const quote = this.target.quote ? this.target.quote() : this.target.messageId;
        this.progressId = (await this.target.adapter.send(this.target.chatId, out.text, quote,
          Object.keys(out.format).length ? out.format : undefined)) ?? null;
        this.shown = rendered.text;
      } catch (error) {
        const wait = retryAfterMs(error);
        if (!wait) { this.failures.edit++; return; }
        this.pausedUntil = Date.now() + wait;
        this.later(() => void this.openProgress(), wait);
      }
    });
  }
  private scheduleEdit(): void {
    if (this.closed || (!this.progressId && !this.pageIds.length && !this.pagesOpen) || this.editTimer) return;
    this.editTimer = this.later(() => {
      this.editTimer = null;
      void this.enqueue(() => this.pushEdit());
    }, Math.max(this.timing.editEveryMs, this.pausedUntil - Date.now()));
  }
  private async pushEdit(): Promise<void> {
    if (this.closed) return;
    if (Date.now() < this.pausedUntil) { this.scheduleEdit(); return; }
    if (this.stepsSource?.pages) {
      if (!await this.syncPages() && Date.now() < this.pausedUntil) this.scheduleEdit();
      return;
    }
    const rendered = this.render();
    if (rendered.text === this.shown) return;
    const out = await this.format(rendered);
    if (out === null) {
      // The reply so far was held back: stop showing it while it is written, keep the steps.
      if (this.reply && !this.streamBlocked) { this.streamBlocked = true; this.scheduleEdit(); }
      return;
    }
    if (await this.put(out.text, out.format)) this.shown = rendered.text;
    // Waited out: the newest steps go in once the app lets them.
    else if (Date.now() < this.pausedUntil) this.scheduleEdit();
  }
  /** Replaces the progress message's words: plain words (a string, already looked at) or steps with their code spans. */
  private async editTo(content: string | RichText): Promise<boolean> {
    if (typeof content === "string") return this.put(content, {});
    const out = await this.format(content);
    return out !== null && this.put(out.text, out.format);
  }
  /**
   * Brings the steps' messages up to date (`StepsSource.pages`): each message that changed is edited, and lines that
   * no longer fit go out in a new message, quietly. With `each`, a message is never edited: only new ones are sent.
   * False when something could not be done now (a wait asked for, a failure, words held back).
   */
  private async syncPages(final?: "done" | "error"): Promise<boolean> {
    const source = this.stepsSource!;
    const pages = source.pages!(this.limit, final);
    let all = true;
    for (const [index, page] of pages.entries()) {
      if (index < this.pageIds.length) {
        if (source.each || page.text === this.pageShown[index]) continue;
        const out = await this.format(page);
        if (out === null) return false;
        if (await this.putOn(this.pageIds[index]!, out.text, out.format)) this.pageShown[index] = page.text;
        else all = false;
        continue;
      }
      if (!this.permitted() || Date.now() < this.pausedUntil || this.failures.edit >= giveUpAfter) return false;
      const out = await this.format(page);
      if (out === null) return false;
      try {
        // The reply's first words, already in the chat, become the first page, so the steps stay above the answer.
        const adopted = !this.pageIds.length && !source.each ? await this.target.adopt?.().catch(() => null) ?? null : null;
        if (adopted) {
          this.pageIds.push(adopted);
          this.pageShown.push(await this.putOn(adopted, out.text, out.format) ? page.text : "");
          this.progressId ??= adopted;
          continue;
        }
        // The first message quotes the person's as the answer's quoting rule says (reply-style.ts); the rest continue it.
        const quote = this.pageIds.length ? undefined : this.target.quote ? this.target.quote() : this.target.messageId;
        const id = await this.target.adapter.send(this.target.chatId, out.text, quote,
          Object.keys(out.format).length ? out.format : undefined);
        // An app that does not say which message it sent cannot have it edited: one message is all it gets.
        if (!id && !source.each) this.failures.edit = giveUpAfter;
        this.pageIds.push(id ?? "");
        this.pageShown.push(page.text);
        this.progressId ??= id ?? null;
      } catch (error) {
        const wait = retryAfterMs(error);
        if (wait) this.pausedUntil = Date.now() + wait;
        else this.failures.edit++;
        return false;
      }
    }
    return all;
  }
  private async put(text: string, format: MessageFormat): Promise<boolean> {
    return this.progressId ? this.putOn(this.progressId, text, format) : false;
  }
  private async putOn(messageId: string, text: string, format: MessageFormat): Promise<boolean> {
    const { adapter, chatId } = this.target;
    if (!adapter.edit || !messageId || this.failures.edit >= giveUpAfter || !this.permitted()) return false;
    try {
      await adapter.edit(chatId, messageId, text, format.spans?.length ? { spans: format.spans } : undefined);
      this.failures.edit = 0;
      return true;
    } catch (error) {
      // "Too many requests, wait": waited out, not counted against the message.
      const wait = retryAfterMs(error);
      if (wait) this.pausedUntil = Date.now() + wait;
      else this.failures.edit++;
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
