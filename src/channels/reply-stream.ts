import { randomInt } from "node:crypto";
import type { LiveTarget, OutboundGuard } from "./live-status.js";
import { retryAfterMs } from "./live-status.js";
import { chunkText } from "./deliveries.js";
import type { SendGate } from "./router.js";

/** An outbound acknowledgement is missing; another message is not a safe fallback. */
export class ReplyDeliveryUncertain extends Error {
  constructor(readonly messageId: string | null = null) {
    super("Reply delivery was not acknowledged. Reconcile the original message before sending another answer.");
    this.name = "ReplyDeliveryUncertain";
  }
}
export interface PlacedReply { messageId: string; text: string; rest?: string[] }
/** The reply has its own message; tool progress never becomes the answer. */
export class ReplyStream {
  private words = "";
  private messageId: string | null = null;
  private shown = "";
  private readonly draftId = randomInt(1, 0x7fffffff);
  private draftDisabled = false;
  private deliveryUncertain = false;
  private closed = false;
  private readonly sending = new AbortController();
  private taskSignal: AbortSignal | null = null;
  private failures = 0;
  private pausedUntil = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly limit: number;
  constructor(private readonly target: LiveTarget, private readonly guard: OutboundGuard,
    private readonly intervalMs = 1500) {
    this.limit = Math.min(target.adapter.maxTextLength ?? 3500, 3500);
  }
  get uncertain(): boolean { return this.deliveryUncertain; }
  round(): void { this.words = ""; }
  /**
   * The steps message is about to open below this reply's first words: they are handed over to become the steps (see
   * LiveTarget.adopt), and the reply starts again in a new message below. Waits for a send in flight, so the order in
   * the chat is known. Null when this reply has no message yet.
   */
  surrender(): Promise<string | null> {
    return this.enqueue(async () => {
      const id = this.messageId;
      if (!id) return null;
      await this.stop(id);
      this.messageId = null;
      this.placing = false; // the reply's next words open its new message at once
      this.shown = "";
      this.words = ""; // those words came before a step; the next model round writes the reply afresh
      return id;
    });
  }
  text(delta: string): void {
    if (this.closed || this.failures >= 2) return;
    try { this.gate().check(); } catch { this.cancel(false); return; }
    // The final output comes from the runtime. Keep only enough preview for the first message.
    this.words = (this.words + delta).slice(0, this.limit * 2);
    if (this.timer) return;
    // chat-speed: the reply's first words go out as soon as there is one whole word, not an edit interval later
    // (Hermes' gateway/stream_consumer.py sends its first message at once too); after that, one edit per interval.
    if (!this.messageId && !this.placing && Date.now() >= this.pausedUntil) {
      const whole = this.wholeWords();
      if (!whole) return; // not one whole word yet: the next piece decides
      this.placing = true;
      void this.enqueue(() => this.put(whole));
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const words = this.wholeWords();
      void this.enqueue(() => this.put(words));
    }, Math.max(this.intervalMs, this.pausedUntil - Date.now()));
    this.timer.unref();
  }
  /** Whether the first words were already sent for (the message may not be back yet). */
  private placing = false;
  private shownOnce = false;
  /** Called once, when the reply's first words are in the chat (the router times it: `channel.first_shown`). */
  onFirstShown: (() => void) | null = null;
  private firstShown(): void { if (!this.shownOnce) { this.shownOnce = true; this.onFirstShown?.(); } }
  /** Hold the unfinished last word: a credential split across deltas must reach the scrub whole. */
  private wholeWords(): string {
    const boundary = this.words.search(/\S+\s*$/);
    return boundary < 0 ? "" : this.words.slice(0, boundary).trimEnd();
  }
  private closeAdmission(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
  cancel(finalize = true): void {
    this.closeAdmission();
    this.sending.abort(new Error("Reply preview was cancelled"));
    if (finalize && this.target.adapter.finishStream) void this.enqueue(async () => {
      if (this.messageId) await this.stop(this.messageId);
    }).catch(() => undefined);
  }
  /** Close admission and settle every earlier preview/stop before an error can become a fresh reply. */
  async finishError(): Promise<boolean> {
    this.closeAdmission();
    return this.enqueue(async () => {
      // A queued write can acquire its id (or lose its acknowledgement) after cancellation.
      // Stop only that exact acknowledged message, including when another failure already held it.
      if (this.messageId) {
        try { await this.stop(this.messageId); }
        catch { return false; }
      }
      return !this.deliveryUncertain && this.allowed();
    });
  }
  async finish(text: string): Promise<PlacedReply | null> {
    this.closeAdmission();
    return this.enqueue(async () => {
      if (this.deliveryUncertain) throw new ReplyDeliveryUncertain(this.messageId);
      if (!this.allowed()) throw this.hold();
      // Native drafts have no message id: the caller persists the full answer with its ordinary send path.
      if (!this.messageId) return null;
      const id = this.messageId;
      try {
        const checked = await this.checked(text);
        if (checked === null) return null;
        const [first, ...rest] = chunkText(checked, this.limit);
        if (!first || !await this.write(first, !!this.target.adapter.sendStream)) {
          // An acknowledged preview exists for ordinary adapters too. A failed edit must not
          // turn that exact message into a blind fresh-send fallback.
          throw this.hold();
        }
        return { messageId: id, text: first, ...(rest.length ? { rest } : {}) };
      } finally {
        // Even a blocked final snapshot or failed edit must stop the acknowledged preview.
        // A missing stop acknowledgement throws, holding delivery rather than sending another answer.
        await this.stop(id);
      }
    });
  }
  private hold(): ReplyDeliveryUncertain {
    this.deliveryUncertain = true;
    return new ReplyDeliveryUncertain(this.messageId);
  }
  private async stop(id: string): Promise<void> {
    try {
      const gate = this.gate();
      gate.check();
      await this.target.adapter.finishStream?.(this.target.chatId, id, gate);
      gate.check();
    }
    catch { throw this.hold(); }
  }
  private allowed(): boolean {
    return !this.sending.signal.aborted && !this.taskSignal?.aborted && (this.target.allowed?.() ?? true);
  }
  private gate(): SendGate {
    const task = this.taskSignal ??= this.target.signal?.() ?? null;
    const signal = task ? AbortSignal.any([this.sending.signal, task]) : this.sending.signal;
    return { signal, check: () => {
      signal.throwIfAborted();
      if (!this.allowed()) throw new Error("Reply delivery is no longer allowed");
    } };
  }
  private async put(text: string): Promise<void> {
    if (this.closed || !text.trim() || Date.now() < this.pausedUntil || this.failures >= 2) return;
    const checked = await this.checked(text);
    if (checked === null) return;
    const first = chunkText(checked, this.limit)[0];
    if (first) await this.write(first);
  }
  private async checked(text: string): Promise<string | null> {
    try {
      const gate = this.gate();
      gate.check();
      const checked = await this.guard(text);
      gate.check();
      return checked.blocked || !this.allowed() ? null : checked.text;
    } catch { return null; }
  }
  private async write(text: string, reconcile = false): Promise<boolean> {
    if (this.deliveryUncertain) return false;
    if (!reconcile && text === this.shown) return true;
    if (!this.messageId && !this.draftDisabled && this.target.adapter.sendDraft) {
      const drafted = await this.draft(text);
      if (drafted !== null) return drafted;
    }
    let starting = false;
    try {
      if (!this.allowed() || !this.target.adapter.edit || Date.now() < this.pausedUntil) return false;
      const gate = this.gate();
      gate.check();
      if (this.messageId) await this.target.adapter.edit(this.target.chatId, this.messageId, text, undefined, gate);
      else {
        starting = true;
        const replyTo = this.target.quote ? this.target.quote() : this.target.messageId;
        this.messageId = await (this.target.adapter.sendStream
          ? this.target.adapter.sendStream(this.target.chatId, text, replyTo, gate)
          : this.target.adapter.send(this.target.chatId, text, replyTo, undefined, gate)) ?? null;
        if (this.messageId) this.firstShown();
      }
      gate.check();
      if (!this.messageId) { this.deliveryUncertain ||= starting; this.failures = 2; return false; }
      this.shown = text;
      this.failures = 0;
      return true;
    } catch (error) {
      // A missing acknowledgement may hide an existing stream. Never retry that start as another answer.
      if (starting) { this.deliveryUncertain = true; this.failures = 2; return false; }
      const wait = retryAfterMs(error);
      if (wait) this.pausedUntil = Date.now() + wait;
      else this.failures++;
      return false;
    }
  }
  /** Hermes Agent's draft-to-edit fallback (MIT), using the same guarded, serialized preview as ordinary edits. */
  private async draft(text: string): Promise<boolean | null> {
    if (this.closed || !this.allowed() || Date.now() < this.pausedUntil) return false;
    try {
      const gate = this.gate();
      gate.check();
      await this.target.adapter.sendDraft!(this.target.chatId, this.draftId, text, gate);
      gate.check();
      this.firstShown();
      this.shown = text;
      this.failures = 0;
      return true;
    } catch (error) {
      const wait = retryAfterMs(error);
      if (wait) { this.pausedUntil = Date.now() + wait; return false; }
      // A topic may refuse drafts even when the bot supports them. Preserve this chat's exact address on fallback.
      this.draftDisabled = true;
      return this.closed || !this.allowed() ? false : null;
    }
  }
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work);
    this.chain = next.catch(() => undefined);
    return next;
  }
}
