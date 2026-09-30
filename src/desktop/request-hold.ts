import type { EngineAccess } from "./engine-gate.js";

/**
 * The window's requests to its engine's address, held while the engine is not there (restarting, or not yet proved to
 * be the engine), and let go the moment it is. A request still held after `timeoutMs` is refused, so a page never
 * waits for good. Kept apart from main.ts so it can be checked without Electron.
 */
export class RequestHold {
  private readonly waiting = new Set<(go: boolean) => void>();
  constructor(private readonly access: EngineAccess, private readonly timeoutMs = 30000) {
    access.onReady(() => this.release());
  }

  /** Calls `answer(true)` as soon as the engine is there, or `answer(false)` once it has waited too long. */
  when(answer: (go: boolean) => void): void {
    if (this.access.ready()) { answer(true); return; }
    let done = false;
    const once = (go: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      this.waiting.delete(once);
      answer(go);
    };
    const timer = setTimeout(() => once(false), this.timeoutMs);
    timer.unref?.();
    this.waiting.add(once);
  }

  get held(): number { return this.waiting.size; }

  private release(): void {
    if (!this.access.ready()) return;
    for (const go of [...this.waiting]) go(true);
  }
}
