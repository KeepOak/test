import { watchEngine, type ProofWatch } from "../engine-proof.js";

/**
 * Whether the window may talk to its engine's address right now. Nothing goes there, above all not the window's key,
 * until the program at that address has proved it is the engine (src/engine-proof.ts). The proof's connection is kept
 * open, so when the engine stops (a background engine restarting, the app's own engine starting again) the window
 * knows at once, holds its requests, and asks for the proof again until the engine is back.
 */
export interface EngineAccess {
  /** True while the engine at the window's address has proved itself and has not stopped since. */
  ready(): boolean;
  /** The proved engine's process (src/engine-proof.ts), while `ready()`; null otherwise. */
  boot(): string | null;
  /** Called each time the engine proves itself again; returns a function that stops the calls. */
  onReady(listener: () => void): () => void;
  /** Called the moment a proved engine is gone (its connection ended, or main saw its process end). */
  onLost(listener: () => void): () => void;
}

export interface EngineGateOptions {
  origin: string;
  /** The window's key as it is now; it only ever signs the challenge's answer check, it is never sent. */
  key: () => string;
  /** Something else that must also hold (the app's own engine says it is serving at this address). */
  also?: () => boolean;
  watch?: (origin: string, key: string) => ProofWatch;
  /** How long to wait before asking again after the `attempt`-th failed try in a row. */
  retryMs?: (attempt: number) => number;
  log?: (line: string) => void;
}

const defaultRetry = (attempt: number): number => Math.min(2000, 100 * 2 ** Math.min(attempt, 5));

export class EngineGate implements EngineAccess {
  private proven: string | null = null;
  private stopped = false;
  private current: ProofWatch | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly lostListeners = new Set<() => void>();
  constructor(private readonly options: EngineGateOptions) {}

  ready(): boolean { return this.proven !== null && !this.stopped && (this.options.also?.() ?? true); }

  boot(): string | null { return this.ready() ? this.proven : null; }

  onReady(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onLost(listener: () => void): () => void {
    this.lostListeners.add(listener);
    return () => this.lostListeners.delete(listener);
  }

  /** Main saw the engine's process end: it is gone now, whatever its connection has said so far. */
  lost(): void {
    if (!this.proven) return;
    this.current?.close(); // its `ended` follows, which says so to the listeners and asks for the proof again
  }

  /** Resolves true once the engine has proved itself, or false after `timeoutMs`. */
  whenReady(timeoutMs: number): Promise<boolean> {
    if (this.ready()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const late = setTimeout(() => { off(); resolve(false); }, timeoutMs);
      late.unref?.();
      const off = this.onReady(() => { clearTimeout(late); off(); resolve(true); });
    });
  }

  start(): void { if (!this.current && !this.timer && !this.stopped) void this.prove(0); }

  /** Asks again at once (the app's own engine said it is back), without waiting out a retry. */
  nudge(): void {
    if (this.stopped || this.proven || this.current) return;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    void this.prove(0);
  }

  stop(): void {
    this.stopped = true;
    this.proven = null;
    if (this.timer) clearTimeout(this.timer);
    this.current?.close();
  }

  private tell(listeners: Set<() => void>): void {
    for (const listener of [...listeners]) {
      try { listener(); } catch (error) { this.options.log?.(`Engine gate: ${(error as Error).message}`); }
    }
  }

  private async prove(attempt: number): Promise<void> {
    if (this.stopped) return;
    const watch = (this.options.watch ?? watchEngine)(this.options.origin, this.options.key());
    this.current = watch;
    const proved = await watch.proved;
    if (this.stopped) { watch.close(); return; }
    if (proved === null) {
      this.current = null;
      this.timer = setTimeout(() => { this.timer = null; void this.prove(attempt + 1); }, (this.options.retryMs ?? defaultRetry)(attempt));
      this.timer.unref?.();
      return;
    }
    this.proven = proved;
    const provedAt = Date.now();
    this.tell(this.listeners);
    await watch.ended;
    this.proven = null;
    this.current = null;
    this.tell(this.lostListeners);
    if (this.stopped) return;
    this.options.log?.("The engine's connection ended; the window waits until it proves itself again.");
    // A connection that ends at once, again and again, is asked again after a growing wait rather than in a tight loop.
    if (Date.now() - provedAt >= 1000) { void this.prove(0); return; }
    this.timer = setTimeout(() => { this.timer = null; void this.prove(attempt + 1); }, (this.options.retryMs ?? defaultRetry)(attempt));
    this.timer.unref?.();
  }
}
