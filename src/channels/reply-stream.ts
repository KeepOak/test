import type { LiveTarget, OutboundGuard } from "./live-status.js";
import { retryAfterMs } from "./live-status.js";
import { chunkText } from "./deliveries.js";

export interface PlacedReply { messageId: string; text: string; rest?: string[] }
/** The reply has its own message; tool progress never becomes the answer. */
export class ReplyStream {
  private words = "";
  private messageId: string | null = null;
  private shown = "";
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
      this.messageId = null;
      this.placing = false; // the reply's next words open its new message at once
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
  /** Hold the unfinished last word: a credential split across deltas must reach the scrub whole. */
  private wholeWords(): string {
    const boundary = this.words.search(/\S+\s*$/);
    return boundary < 0 ? "" : this.words.slice(0, boundary).trimEnd();
  }
  cancel(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
  async finish(text: string): Promise<PlacedReply | null> {
    this.cancel();
    return this.enqueue(async () => {
      if (!this.messageId) return null;
      const checked = await this.checked(text);
      if (checked === null) return null;
      const [first, ...rest] = chunkText(checked, this.limit);
      if (!first || !await this.write(first)) return null;
      return { messageId: this.messageId!, text: first, ...(rest.length ? { rest } : {}) };
    });
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
  private async write(text: string): Promise<boolean> {
    if (text === this.shown) return true;
    try {
      if (!(this.target.allowed?.() ?? true) || !this.target.adapter.edit || Date.now() < this.pausedUntil) return false;
      if (this.messageId) await this.target.adapter.edit(this.target.chatId, this.messageId, text);
      else {
        this.messageId = await this.target.adapter.send(this.target.chatId, text, this.target.quote ? this.target.quote() : this.target.messageId) ?? null;
        if (this.messageId && !this.shownOnce) { this.shownOnce = true; this.onFirstShown?.(); }
      }
      if (!this.messageId) { this.failures = 2; return false; }
      this.shown = text;
      this.failures = 0;
      return true;
    } catch (error) {
      const wait = retryAfterMs(error);
      if (wait) this.pausedUntil = Date.now() + wait;
      else this.failures++;
      return false;
    }
  }
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work);
    this.chain = next.catch(() => undefined);
    return next;
  }
}
