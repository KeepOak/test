import { z } from "zod";
import { audit } from "../audit.js";
import type { Store } from "../store.js";
import type { Trunk, TrunkRecords } from "./record.js";

/**
 * eng-trunk-controls: pausing a Trunk, or all of them. A paused Trunk starts nothing new: its
 * schedules and routines are held, a trigger or a chat app aimed at its conversation is turned away,
 * a standing order in its conversation waits, and in a room it sits the turn out. Each says so in
 * words (`pausedWords`). A task already running finishes, unless the owner pauses "now", which
 * stops that task too. Every pause and resume is written in the activity log.
 */
export const PauseSchema = z.object({
  /** Stop the task it is running as well, instead of letting it finish. */
  now: z.boolean().default(false),
}).strict();

/** What every place that skips a paused Trunk says. */
export function pausedWords(trunk: Pick<Trunk, "name">, what: string): string {
  return `${trunk.name} is paused, so ${what}. Resume it under Customize → Trunks.`;
}

export interface PauseDeps {
  store: Store;
  owner: string;
  records: TrunkRecords;
  /** The tasks running as this Trunk right now. */
  runsOf: (trunkId: string) => string[];
  cancel: (runId: string) => boolean;
}

export class TrunkPause {
  constructor(private readonly deps: PauseDeps) {}

  /** Why a Trunk may not start anything now, in words, or null when it may. */
  refusal(trunkId: string, what = "it did not start anything new"): string | null {
    const trunk = this.deps.records.find(trunkId);
    return trunk?.paused ? pausedWords(trunk, what) : null;
  }

  pause(id: string, input: unknown): { trunk: Trunk; stopped: number } {
    const { now } = PauseSchema.parse(input ?? {});
    const trunk = this.set(this.deps.records.get(id), true);
    // Saved first, so nothing queued or waiting in a room starts in the moment between.
    const stopped = now ? this.stop(trunk.id) : 0;
    this.log(`Trunk "${trunk.name}"`, "paused", this.why(now, stopped));
    return { trunk, stopped };
  }

  resume(id: string): { trunk: Trunk } {
    const trunk = this.set(this.deps.records.get(id), false);
    this.log(`Trunk "${trunk.name}"`, "resumed", "It may start new work again");
    return { trunk };
  }

  pauseAll(input: unknown): { paused: number; stopped: number } {
    const { now } = PauseSchema.parse(input ?? {});
    const trunks = this.deps.records.list().map((trunk) => this.set(trunk, true));
    const stopped = now ? trunks.reduce((sum, trunk) => sum + this.stop(trunk.id), 0) : 0;
    this.log("All Trunks", "paused", this.why(now, stopped));
    return { paused: trunks.length, stopped };
  }

  resumeAll(): { resumed: number } {
    const trunks = this.deps.records.list().map((trunk) => this.set(trunk, false));
    this.log("All Trunks", "resumed", "They may start new work again");
    return { resumed: trunks.length };
  }

  private set(trunk: Trunk, paused: boolean): Trunk {
    const { paused: _was, pausedAt: _at, ...rest } = trunk;
    return this.deps.records.put(paused ? { ...rest, paused: true, pausedAt: new Date().toISOString() } : rest);
  }
  private stop(trunkId: string): number {
    return this.deps.runsOf(trunkId).filter((runId) => this.deps.cancel(runId)).length;
  }
  private why(now: boolean, stopped: number): string {
    if (!now) return "Nothing new starts; a task already running finishes";
    return `Paused now: nothing new starts, and ${stopped} running task${stopped === 1 ? " was" : "s were"} stopped`;
  }
  private log(subject: string, outcome: string, reason: string): void {
    audit(this.deps.store, this.deps.owner, { action: "trunk.paused", actor: this.deps.owner, subject, reason, outcome });
  }
}
