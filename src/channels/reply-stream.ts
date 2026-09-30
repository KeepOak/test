import type { LiveTarget, OutboundGuard } from "./live-status.js";
import { retryAfterMs } from "./live-status.js";
import { chunkText, openFenceAt } from "./deliveries.js";
import type { FeatureSwitch } from "./chat-live-settings.js";

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
    private readonly intervalMs = 1500,
    /** UP-CHAT-012: the owner's careful-splitting switch, as the ledger reads it (deliveries.ts `chunkText`). */
    private readonly splitting: () => FeatureSwitch = () => "off") {
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
      const [first, ...rest] = this.chunks(checked);
      if (first && await this.write(first)) return { messageId: this.messageId!, text: first, ...(rest.length ? { rest } : {}) };
      return first ? this.fallback(checked) : null;
    });
  }
  /**
   * UP-CHAT-012: the last edit failed, so the chat still shows the partial words. When the answer begins with them, they
   * stay as its head and only the unseen rest is sent after them. Otherwise the whole answer is sent afresh (null) and
   * the partial is deleted where the app can, so the chat never shows half an answer and then all of it.
   * Adapted from Hermes Agent (MIT), gateway/stream_consumer_fallback.py `_send_fallback_final` and `_continuation_text`.
   */
  private async fallback(checked: string): Promise<PlacedReply | null> {
    const shown = this.shown, id = this.messageId!;
    if (shown && checked.startsWith(shown)) {
      const tail = checked.slice(shown.length).trim();
      return { messageId: id, text: shown, ...(tail ? { rest: this.chunks(tail) } : {}) };
    }
    const adapter = this.target.adapter;
    if (adapter.deleteMessage && (this.target.allowed?.() ?? true)) await adapter.deleteMessage(this.target.chatId, id).catch(() => undefined);
    return null;
  }
  private chunks(text: string): string[] {
    return chunkText(text, this.limit, this.splitting());
  }
  private async put(text: string): Promise<void> {
    if (this.closed || !text.trim() || Date.now() < this.pausedUntil || this.failures >= 2) return;
    const checked = await this.checked(text);
    if (checked === null) return;
    const first = this.chunks(checked)[0];
    if (first) await this.write(closeFence(first, this.limit));
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
      else this.messageId = await this.target.adapter.send(this.target.chatId, text, this.target.quote ? this.target.quote() : this.target.messageId) ?? null;
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

/**
 * A preview cut while a code block is still open is shown with the block closed, so the rest of the words are not
 * shown as code (Hermes Agent, MIT, gateway/stream_consumer_fences.py). A preview with no room left is shown as it is.
 */
export function closeFence(text: string, limit: number): string {
  const open = openFenceAt(text, text.length);
  const closed = open ? `${text}
${open.close}` : text;
  return closed.length <= limit ? closed : text;
}
