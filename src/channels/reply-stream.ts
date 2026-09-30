import { randomInt } from "node:crypto";
import type { LiveTarget, OutboundGuard } from "./live-status.js";
import { retryAfterMs } from "./live-status.js";
import { chunkText } from "./deliveries.js";

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
      this.shown = "";
      this.words = ""; // those words came before a step; the next model round writes the reply afresh
      return id;
    });
  }
  text(delta: string): void {
    if (this.closed || this.failures >= 2) return;
    // The final output comes from the runtime. Keep only enough preview for the first message.
    this.words = (this.words + delta).slice(0, this.limit * 2);
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      // Hold the unfinished last word: a credential split across deltas must reach the scrub whole.
      const boundary = this.words.search(/\S+\s*$/);
      const words = boundary < 0 ? "" : this.words.slice(0, boundary).trimEnd();
      void this.enqueue(() => this.put(words));
    }, Math.max(this.intervalMs, this.pausedUntil - Date.now()));
    this.timer.unref();
  }
  cancel(finalize = true): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (finalize && this.target.adapter.finishStream) void this.enqueue(async () => {
      if (this.messageId) await this.stop(this.messageId);
    }).catch(() => undefined);
  }
  async finish(text: string): Promise<PlacedReply | null> {
    this.cancel(false);
    return this.enqueue(async () => {
      if (this.deliveryUncertain) throw new ReplyDeliveryUncertain(this.messageId);
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
    try { await this.target.adapter.finishStream?.(this.target.chatId, id); }
    catch { throw this.hold(); }
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
      if (!(this.target.allowed?.() ?? true)) return null;
      const checked = await this.guard(text);
      return checked.blocked ? null : checked.text;
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
      if (!(this.target.allowed?.() ?? true) || !this.target.adapter.edit || Date.now() < this.pausedUntil) return false;
      if (this.messageId) await this.target.adapter.edit(this.target.chatId, this.messageId, text);
      else {
        starting = true;
        const send = this.target.adapter.sendStream?.bind(this.target.adapter) ?? this.target.adapter.send.bind(this.target.adapter);
        this.messageId = await send(this.target.chatId, text, this.target.quote ? this.target.quote() : this.target.messageId) ?? null;
      }
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
    if (this.closed || !(this.target.allowed?.() ?? true) || Date.now() < this.pausedUntil) return false;
    try {
      await this.target.adapter.sendDraft!(this.target.chatId, this.draftId, text);
      this.shown = text;
      this.failures = 0;
      return true;
    } catch (error) {
      const wait = retryAfterMs(error);
      if (wait) { this.pausedUntil = Date.now() + wait; return false; }
      // A topic may refuse drafts even when the bot supports them. Preserve this chat's exact address on fallback.
      this.draftDisabled = true;
      return this.closed ? false : null;
    }
  }
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work);
    this.chain = next.catch(() => undefined);
    return next;
  }
}
