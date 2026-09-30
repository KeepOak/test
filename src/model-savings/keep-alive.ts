import type { Store } from "../store.js";
import { readSavings } from "./settings.js";

/**
 * R17-050: keep a Claude connection's prompt cache warm while the owner pauses. The idea is
 * aider's `warm_cache` (Apache-2.0); this is Branch's own code.
 *
 * Nothing happens unless the owner switched it on. After each answered round of a task the same
 * request is scheduled to be sent again, asking for a single token, after the chosen number of
 * minutes. It stops at the chosen number of pings or before a ping would take the pause past its
 * spending cap, whichever comes first, and a new round starts the count again. A ping is priced at
 * twice the full input price before it is sent (a one-hour cache write can cost that much), and one whose price
 * is not known is never sent, because then the cap could not be kept. Every ping is counted in the
 * task's usage and written down as an event.
 */
export interface KeepAlivePing {
  /** The task the ping is counted against. */
  runId: string;
  /** What one ping would cost at the full input price, or null when no price is on file. */
  price: number | null;
  /** Sends the ping and counts what it used in the task's usage. */
  send: () => Promise<void>;
  /**
   * Asked just before each ping: a reason to stop (Lockdown, the conversation gone or working again,
   * the monthly budget or the task's spending limit reached), or null to go on.
   */
  refusal?: () => string | null;
}
export interface KeepAliveTimers {
  set: (run: () => Promise<void>, ms: number) => unknown;
  clear: (handle: unknown) => void;
}
const realTimers: KeepAliveTimers = {
  set: (run, ms) => { const handle = setTimeout(run, ms); handle.unref?.(); return handle; },
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Only connections whose prompt cache lapses after a few quiet minutes are kept warm. */
export const keptWarmProviders: readonly string[] = ["anthropic", "claude-subscription"];

interface Pause { handle: unknown; pings: number; spent: number }

export class KeepAlive {
  private readonly pauses = new Map<string, Pause>();
  constructor(
    private readonly store: Pick<Store, "get" | "event">,
    private readonly timers: KeepAliveTimers = realTimers,
  ) {}

  /** A round was answered: start (or restart) the pause for this conversation. */
  arm(owner: string, sessionId: string, provider: string, ping: KeepAlivePing): void {
    this.cancel(sessionId);
    const card = readSavings(this.store, owner, "keepAlive");
    if (card.mode !== "on" || !keptWarmProviders.includes(provider)) return;
    const pause: Pause = { handle: null, pings: 0, spent: 0 };
    this.pauses.set(sessionId, pause);
    this.schedule(owner, sessionId, pause, ping);
  }

  private schedule(owner: string, sessionId: string, pause: Pause, ping: KeepAlivePing): void {
    const card = readSavings(this.store, owner, "keepAlive");
    pause.handle = this.timers.set(() => this.fire(owner, sessionId, pause, ping).catch(() => undefined), card.everyMinutes * 60_000);
  }

  private async fire(owner: string, sessionId: string, pause: Pause, ping: KeepAlivePing): Promise<void> {
    if (this.pauses.get(sessionId) !== pause) return;
    const card = readSavings(this.store, owner, "keepAlive");
    const refused = ping.refusal?.() ?? null;
    const stop = card.mode !== "on" ? "switched off"
      : refused ? `was refused: ${refused}`
      : pause.pings >= card.maxPings ? "reached its number of pings"
        : ping.price === null ? "has no price on file for this model, so its spending cap could not be kept"
          : pause.spent + ping.price > card.spendCapDollars ? "would have gone past its spending cap" : null;
    if (stop) {
      this.pauses.delete(sessionId);
      this.store.event(ping.runId, "cache.keep_alive_stopped", { pings: pause.pings, spent: pause.spent, reason: `Keeping the cache warm stopped: it ${stop}.` });
      return;
    }
    pause.pings += 1;
    pause.spent += ping.price!;
    try {
      await ping.send();
      this.store.event(ping.runId, "cache.keep_alive", { ping: pause.pings, spentAtMost: pause.spent });
    } catch (error) {
      this.pauses.delete(sessionId);
      this.store.event(ping.runId, "cache.keep_alive_stopped", { pings: pause.pings, reason: `Keeping the cache warm stopped: ${(error as Error).message}` });
      return;
    }
    if (this.pauses.get(sessionId) === pause) this.schedule(owner, sessionId, pause, ping);
  }

  cancel(sessionId: string): void {
    const pause = this.pauses.get(sessionId);
    if (pause) this.timers.clear(pause.handle);
    this.pauses.delete(sessionId);
  }

  /** How many conversations are being kept warm now. */
  get waiting(): number { return this.pauses.size; }

  stop(): void {
    for (const id of [...this.pauses.keys()]) this.cancel(id);
  }
}
