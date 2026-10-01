import { request } from "node:http";

/**
 * Owner's PC 2026-09-29: the daemon's engine sat behind its gateway for more than five hours without being reachable,
 * alive and idle, and nothing noticed until the owner did. The gateway only replaced an engine whose process ended. It
 * now asks the engine's own address on a timer while the engine is ready, and when nothing has answered for
 * `unresponsiveMs` it says so once and has the engine started again.
 *
 * Adapted, with credit, from two MIT projects: OpenClaw's armable stall watchdog
 * (src/channels/transport/stall-watchdog.ts, github.com/openclaw/openclaw): armed only while it applies, it reports
 * once per arming, and a failing callback never escapes its timer. Hermes Agent's desktop backend health
 * (apps/desktop/electron/backend-health.ts, github.com/NousResearch/hermes-agent): a short timeout per probe inside a
 * generous budget, because a busy engine can stall its event loop for tens of seconds without being gone.
 */
export interface EngineWatchdogOptions {
  /** True when the engine answered (any answer at all). */
  probe: () => Promise<boolean>;
  /** The engine answered: whatever was holding requests back for a dead address can let go. */
  onAnswer?: () => void;
  /** Nothing answered for `silentMs`: called once, and the watchdog disarms itself. */
  onUnresponsive: (silentMs: number) => void;
  everyMs?: number;
  unresponsiveMs?: number;
  now?: () => number;
  /** Arranges the next tick; tests tick by hand. */
  schedule?: (tick: () => void, ms: number) => { unref?: () => void } | undefined;
}

export const watchdogDefaults = { everyMs: 15_000, timeoutMs: 5_000, unresponsiveMs: 90_000 };

export class EngineWatchdog {
  private armed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private silentSince: number | null = null;
  private lastTick: number | null = null;
  private generation = 0;
  constructor(private readonly options: EngineWatchdogOptions) {}

  private get everyMs(): number { return this.options.everyMs ?? watchdogDefaults.everyMs; }
  private now(): number { return (this.options.now ?? Date.now)(); }

  arm(): void {
    this.disarm();
    this.armed = true;
    this.generation++;
    this.next();
  }

  disarm(): void {
    this.armed = false;
    this.silentSince = this.lastTick = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** One look: asks the engine and counts how long it has been silent. */
  async tick(): Promise<void> {
    if (!this.armed) return;
    const generation = this.generation, at = this.now();
    // Woken long after its time: the computer slept (or this process could not run), and that silence is not the engine's.
    if (this.lastTick !== null && at - this.lastTick > this.everyMs * 3) this.silentSince = null;
    const answered = await this.options.probe().catch(() => false);
    if (!this.armed || generation !== this.generation) return;
    this.lastTick = this.now(); // the next tick is timed from here, after the probe's own wait
    if (answered) {
      this.silentSince = null;
      this.safely(() => this.options.onAnswer?.());
      return;
    }
    this.silentSince ??= at;
    const silentMs = this.now() - this.silentSince;
    if (silentMs < (this.options.unresponsiveMs ?? watchdogDefaults.unresponsiveMs)) return;
    this.disarm();
    this.safely(() => this.options.onUnresponsive(silentMs));
  }

  private next(): void {
    const run = () => { this.timer = undefined; void this.tick().finally(() => { if (this.armed) this.next(); }); };
    const schedule = this.options.schedule ?? ((tick, ms) => setTimeout(tick, ms));
    const handle = schedule(run, this.everyMs);
    handle?.unref?.();
    if (!this.options.schedule) this.timer = handle as ReturnType<typeof setTimeout>;
  }

  private safely(action: () => void): void {
    try { action(); } catch { /* a failing callback must never stop the gateway */ }
  }
}

/**
 * Whether anything answers HTTP at the engine's own port, on a fresh connection (never one shared with forwarded
 * requests) within `timeoutMs`. Any status counts, a refusal for a missing key included: the question is whether the
 * engine's server still answers, not whether this request was allowed.
 */
export function engineAnswers(port: number, timeoutMs = watchdogDefaults.timeoutMs): Promise<boolean> {
  return new Promise((resolve) => {
    const asked = request({ host: "127.0.0.1", port, method: "GET", path: "/api/alive", agent: false,
      headers: { host: `127.0.0.1:${port}` }, timeout: timeoutMs }, (answer) => {
      answer.resume();
      answer.once("end", () => asked.destroy());
      resolve(true);
    });
    asked.once("timeout", () => { asked.destroy(); resolve(false); });
    asked.once("error", () => resolve(false));
    asked.end();
  });
}
