import type { UpdateChannel, UpdateStatus } from "./updater.js";

/**
 * "Keep Branch up to date by itself", run by the app itself rather than by its window's page: the owner never presses
 * Update, and Branch updates whether a window is open, closed to the tray, still loading, or not there at all (only the
 * detached gateway running). The page only shows what this loop is doing.
 *
 * Each look is one small call to the engine's plan (`/api/comfort/update-plan`), which says whether to look for a
 * newer version, install the one found, or wait; a look for a newer version is itself one small git request. The
 * engine keeps the owner's choice, the failed release not to retry, and the problem to say once. It runs every 30
 * seconds while it may matter (updating by itself on Beta, or an update found and waiting), and backs off to every five
 * minutes while nothing changes (updating is off, or Stable, which is looked at once a day). A look never runs beside
 * another, and never while an install is under way.
 */
export interface LoopPlan {
  mode: "off" | "check" | "install";
  step: "nothing" | "check" | "install";
  reason: string;
  failed?: string;
  tellProblem?: boolean;
}
export interface LoopFacts {
  updaterPhase?: string; updaterTag?: string; failedTag?: string; checked?: boolean; problem?: string;
}
export interface UpdateLoopOptions {
  /** The owner's choice and the channel, from the engine (`/api/comfort/update-readiness`). */
  readiness: () => Promise<{ channel: UpdateChannel; autoUpdate: "off" | "check" | "install" }>;
  /** The engine's plan for these facts (`/api/comfort/update-plan`). */
  plan: (facts: LoopFacts) => Promise<LoopPlan>;
  updater: {
    readonly status: UpdateStatus; readonly inProgress: boolean; readonly selectedChannel: UpdateChannel;
    setChannel(channel: UpdateChannel): unknown; check(): Promise<UpdateStatus>;
  };
  /** Installs what was found, the way the Update button does (the switch included). A wait is thrown as UpdateDeferredError. */
  install: () => Promise<void>;
  /** Said once, in the updater's own words, when something failed (never silently). */
  tell?: (words: string) => void;
  fastMs?: number; slowMs?: number;
  setTimer?: (run: () => void, ms: number) => { cancel(): void };
}

/** What the engine is told about the updater: its phase, the release it means, and one whose install just failed. */
export function factsOf(status: UpdateStatus | null): LoopFacts {
  const tag = status?.release?.tag;
  return { ...(status?.phase ? { updaterPhase: status.phase } : {}), ...(tag ? { updaterTag: tag } : {}),
    ...(status?.phase === "error" && status.outcome && tag ? { failedTag: tag } : {}) };
}

const ownWords = (error: unknown): string => String((error as Error)?.message ?? error ?? "").trim();

export class UpdateLoop {
  private timer: { cancel(): void } | null = null;
  private running = false;
  private stopped = false;
  private told = "";
  /** The last plan, for the window's status line. */
  last: { plan: LoopPlan | null; wait: string | null; at: string | null } = { plan: null, wait: null, at: null };
  constructor(private readonly options: UpdateLoopOptions) {}

  start(firstMs = 60_000): void { this.stopped = false; this.schedule(firstMs); }
  stop(): void { this.stopped = true; this.timer?.cancel(); this.timer = null; }

  private schedule(ms: number): void {
    if (this.stopped) return;
    this.timer?.cancel();
    const set = this.options.setTimer ?? ((run, after) => { const handle = setTimeout(run, after); handle.unref?.(); return { cancel: () => clearTimeout(handle) }; });
    this.timer = set(() => { void this.look(); }, ms);
  }
  private say(words: string): void {
    if (!words || words === this.told) return;
    this.told = words;
    this.options.tell?.(words);
  }

  /** One look: read the choice, ask the plan, look for a newer version or install the one found. Answers the next wait. */
  async look(): Promise<number> {
    const fast = this.options.fastMs ?? 30_000, slow = this.options.slowMs ?? 5 * 60_000;
    if (this.running || this.options.updater.inProgress) { this.schedule(fast); return fast; }
    this.running = true;
    let next = slow;
    try {
      const choice = await this.options.readiness();
      if (choice.autoUpdate === "off") return next;
      if (this.options.updater.selectedChannel !== choice.channel) this.options.updater.setChannel(choice.channel);
      let plan = await this.options.plan(factsOf(this.options.updater.status));
      if (plan.failed) this.say(plan.failed);
      if (plan.step === "check") {
        const status = await this.options.updater.check();
        if (status.phase === "error") { await this.report(status.message, { ...factsOf(status), checked: true }); return fast; }
        plan = await this.options.plan({ ...factsOf(status), checked: true });
      }
      this.last = { plan, wait: null, at: new Date().toISOString() };
      if (plan.step === "install") {
        try { await this.options.install(); }
        catch (error) {
          if ((error as Error)?.name === "UpdateDeferredError") this.last.wait = ownWords(error);
          else await this.report(this.options.updater.status.phase === "error" ? this.options.updater.status.message : ownWords(error), factsOf(this.options.updater.status));
        }
      }
      // Beta updating by itself, or a version found and waiting: looked at again soon. Otherwise, rarely.
      next = choice.autoUpdate === "install" && (choice.channel === "beta" || this.options.updater.status.phase === "available") ? fast : slow;
      return next;
    } catch (error) {
      this.say(ownWords(error));
      next = fast;
      return next;
    } finally {
      this.running = false;
      this.schedule(next);
    }
  }
  private async report(words: string, facts: LoopFacts): Promise<void> {
    try {
      const plan = await this.options.plan({ ...facts, problem: words.slice(0, 600) });
      if (plan.tellProblem || plan.failed) { this.told = ""; this.say([words, plan.failed].filter(Boolean).join(" ")); }
    } catch { this.say(words); }
  }
}
