import type { Run } from "./contracts.js";
import type { Store } from "./store.js";
import { prepareSpokenText, SentenceChunker, spokenSentences } from "./voice-spoken-text.js";

/** Consumes Runtime's already gated prose callback, never provider reasoning or ungated text.
 * Outlet-filtered/held replies and cache hits use the completed-reply fallback instead.
 * Each announced model start gets its own generation. Provider-internal retry callbacks have no
 * rollback metadata; speech already heard cannot be retracted when the final answer changes.
 */
export class SpokenReplyStream {
  private run: Run | undefined;
  private raw = "";
  private chunker = new SentenceChunker();
  private generation = 0;
  private sequence = 0;
  private sentences = 0;
  private off: (() => void) | undefined;
  private ended = false;
  private complete = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  get result(): { requestId: string; generation: number; sentences: number; complete: boolean } {
    return { requestId: this.requestId, generation: this.generation, sentences: this.sentences, complete: this.complete };
  }

  constructor(private readonly store: Store, private readonly requestId: string,
    private readonly scrub: (text: string) => string, private readonly current: (run: Run) => boolean) {}

  start(run: Run): void {
    this.run = run;
    this.timer = setInterval(() => { if (!this.current(run)) this.stop(); }, 250);
    this.timer.unref();
    this.off = this.store.onEvent((id, kind) => {
      if (id !== run.id || this.ended) return;
      if (kind === "run.finished") { const finished = this.store.run(id); if (finished) this.finish(finished); return; }
      if (kind !== "model.started") return;
      this.raw = ""; this.chunker = new SentenceChunker(); this.sequence = 0; this.sentences = 0;
      this.generation++;
      this.emit("reset", {});
    });
  }

  feed(delta: string): void {
    if (!this.run || this.ended || !this.current(this.run)) { this.stop(); return; }
    if (this.raw.length + delta.length > 200_000) { this.stop(); return; }
    this.raw += delta;
    for (const sentence of this.chunker.feed(delta)) this.say(sentence);
  }

  finish(run: Run): void {
    if (this.ended) return;
    if (run.status !== "completed" || !this.current(run)) { this.stop(); return; }
    const matches = run.status === "completed" && this.current(run) &&
      prepareSpokenText(this.scrub(this.raw)) === prepareSpokenText(this.scrub(run.output));
    if (matches) for (const tail of this.chunker.flush()) this.say(tail);
    if (this.ended) return;
    this.complete = matches && this.sentences > 0 && !this.ended;
    this.emit("ended", { complete: this.complete, sentences: this.sentences, status: run.status });
    this.ended = true; this.clear();
  }

  stop(): void {
    if (this.ended) return;
    this.emit("stopped", {});
    this.ended = true; this.clear();
  }
  private clear(): void { this.off?.(); this.off = undefined; if (this.timer) clearInterval(this.timer); this.timer = undefined; }

  private say(raw: string): void {
    if (this.ended) return;
    // Scrub assembled prose before splitting to the request boundary: split secrets stay together.
    for (const text of spokenSentences(this.scrub(raw))) {
      if (!text || this.sentences >= 128) { if (text) this.stop(); return; }
      this.emit("sentence", { text, sequence: this.sequence++ });
      this.sentences++;
    }
  }

  private emit(kind: string, data: Record<string, unknown>): void {
    const run = this.run;
    if (!run || (kind !== "stopped" && !this.current(run))) return;
    this.store.event(run.id, `voice.reply.${kind}`, { requestId: this.requestId, sessionId: run.sessionId,
      generation: this.generation, ...data });
  }
}
