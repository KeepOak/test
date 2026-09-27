import { z } from "zod";
import { blockerKinds, modelKinds } from "./blockers.js";
import type { Store } from "../store.js";

/**
 * mac7/adapt: where a task stopped, written down, so it can carry on from there.
 *
 * This is the whole of "carry on, do not start again". A task that cannot go on writes down the
 * steps it has already finished and the one step it stopped on; when the missing thing arrives,
 * that record — not the original request — is what the task is handed back. The steps in `done` are
 * never run a second time, and the record says so plainly rather than trusting anyone to remember.
 *
 * Written down the way the one-click setups are (`SetupJobs`), so a stop survives Branch closing.
 */

const BlockerSchema = z.object({
  kind: z.enum(blockerKinds),
  what: z.string().max(200),
  modelKind: z.union([z.enum(modelKinds), z.literal("")]),
  said: z.string().max(400),
}).strict();

const StopSchema = z.object({
  id: z.string().max(80),
  /** The task this belongs to, so the right one carries on. */
  runId: z.string().max(80),
  sessionId: z.string().max(80).nullable(),
  /** What the task was doing, in plain words. */
  what: z.string().max(200),
  /** The steps already finished. Carrying on never does one of these again. */
  done: z.array(z.string().max(200)).max(200),
  /** The step it stopped on: the first one it does when it carries on. */
  nextStep: z.string().max(200),
  blocker: BlockerSchema,
  at: z.string(),
  /** When it carried on, or null while it is still stopped. */
  carriedOnAt: z.string().nullable(),
  /** What it could do afterwards that it could not before; empty while it is still stopped. */
  gained: z.string().max(400),
  /** When the owner chose "Leave it stopped": it is kept, still stopped, but no longer offered as waiting. */
  leftAt: z.string().nullable().optional(),
}).strict();
export type AdaptStop = z.infer<typeof StopSchema>;

export const stopsSetting = "adapt-stops";
const StopsRow = z.object({ stops: z.array(StopSchema).max(40).default([]) }).strict();

/** The written-down stops, newest first. */
export class AdaptStops {
  constructor(private readonly store: Pick<Store, "get" | "save">, private readonly owner: string) {}
  all(): AdaptStop[] {
    const row = StopsRow.safeParse(this.store.get("settings", this.owner, stopsSetting)?.data ?? {});
    return row.success ? [...row.data.stops].sort((a, b) => b.at.localeCompare(a.at)) : [];
  }
  get(id: string): AdaptStop | undefined { return this.all().find((stop) => stop.id === id); }
  /** The stops still waiting for what they are missing, newest first. */
  waiting(): AdaptStop[] { return this.all().filter((stop) => stop.carriedOnAt === null && !stop.leftAt); }
  put(stop: AdaptStop): AdaptStop {
    const valid = StopSchema.parse(stop);
    const kept = [valid, ...this.all().filter((one) => one.id !== stop.id)].slice(0, 40);
    this.store.save("settings", this.owner, stopsSetting, { stops: kept });
    return valid;
  }
  update(id: string, change: Partial<AdaptStop>): AdaptStop | undefined {
    const stop = this.get(id);
    return stop ? this.put({ ...stop, ...change }) : undefined;
  }
  forget(id: string): void {
    this.store.save("settings", this.owner, stopsSetting, { stops: this.all().filter((stop) => stop.id !== id) });
  }
}

/** What a task hands in when it cannot go on. */
export const StopRequestSchema = z.object({
  runId: z.string().max(80).default(""),
  sessionId: z.string().max(80).nullish(),
  what: z.string().trim().min(1).max(200),
  done: z.array(z.string().trim().min(1).max(200)).max(200).default([]),
  nextStep: z.string().trim().min(1).max(200),
  /** The sentence that stopped it, exactly as Branch said it. */
  said: z.string().trim().min(1).max(400),
}).strict();
export type StopRequest = z.infer<typeof StopRequestSchema>;
