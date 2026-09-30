import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ToolContext } from "./contracts.js";
import type { ToolRegistry } from "./registry.js";
import type { Store } from "./store.js";
import { nextCronOccurrence, validCron } from "./recurrence.js";

/**
 * The lead's workbench (SELF-305): a wake-up set inside a conversation, for later or on a repeat ("look at the pull
 * requests every 30 minutes", "remind me in 20 minutes to check the build"). When it is due, its words arrive in that
 * same conversation as a follow-up of the task that set it (Runtime.followUp), so the work carries on where it was,
 * held exactly as that task was: the owner's own conversation stays the owner's, one a chat app carries stays held as
 * the chat's (Runtime.carryOrigin). Wake-ups are saved, so a restart keeps them; one missed while Branch was closed
 * arrives once when it opens again, never once per missed turn. The scheduler's tick looks for due ones.
 * A repeat is every N minutes, or a five-field cron in a timezone ("0 9 * * 1-5" in America/New_York), the same
 * rule the scheduler keeps (src/recurrence.ts). A wake-up that could not be delivered while its conversation is still
 * here is tried again a few minutes later, three times at most, and each miss is written on the task that set it.
 */
const timezone = z.string().min(1).max(64).refine((zone) => {
  try { new Intl.DateTimeFormat("en-US", { timeZone: zone }); return true; } catch { return false; }
}, "Unknown timezone");
export const WakeLaterSchema = z.object({
  /** What to tell yourself when it is time: the words arrive as a new message in this conversation. */
  message: z.string().trim().min(1).max(2000),
  /** How long from now, in minutes; or `at`, or `cron`. */
  inMinutes: z.number().min(1).max(10080).optional(),
  /** When, as a full date and time with its zone; or `inMinutes`, or `cron`. */
  at: z.iso.datetime({ offset: true }).optional(),
  /** Wake again this often after the first time, in minutes. */
  everyMinutes: z.number().int().min(5).max(1440).optional(),
  /** A five-field cron (minute hour day-of-month month weekday) read in `timezone`, in place of inMinutes, at and everyMinutes. */
  cron: z.string().trim().max(100).refine(validCron, "Invalid five-field cron expression").optional(),
  /** The timezone a cron is read in, such as America/New_York. */
  timezone: timezone.optional(),
  /** How many times in all, counting the first. A repeat without a count stops after 48. */
  times: z.number().int().min(1).max(500).optional(),
}).strict()
  .refine((value) => [value.inMinutes, value.at, value.cron].filter((one) => one !== undefined).length === 1, "Give one of inMinutes, at or cron.")
  .refine((value) => !value.cron || (value.timezone !== undefined && value.everyMinutes === undefined), "A cron needs a timezone and no everyMinutes.");

export interface Wakeup {
  id: string; sessionId: string; runId: string; message: string; nextAt: string;
  everyMinutes: number | null; left: number; createdAt: string;
  /** A cron repeat and its timezone, when it repeats by the clock rather than every N minutes. */
  cron?: string | null; timezone?: string | null;
  /** Deliveries missed in a row while the conversation was still here. */
  misses?: number;
}
const prefix = "wakeup:";
const maxPerConversation = 20;
const retryMs = 5 * 60_000;
const maxMisses = 3;
const repeats = (entry: Pick<Wakeup, "everyMinutes" | "cron">): boolean => Boolean(entry.everyMinutes || entry.cron);

export class Wakeups {
  constructor(private readonly store: Store, private readonly owner: string,
    private readonly wake: (sessionId: string, text: string, runId: string) => void, private readonly now = () => Date.now()) {}
  private all(): Wakeup[] {
    return this.store.list("settings", this.owner).filter((row) => row.id.startsWith(prefix)).map((row) => row.data as unknown as Wakeup);
  }
  private save(entry: Wakeup): void { this.store.save("settings", this.owner, `wakeup:${entry.id}`, { ...entry }); }
  private drop(entry: Wakeup): void { this.store.delete("settings", this.owner, `wakeup:${entry.id}`); }
  list(sessionId: string): Wakeup[] {
    return this.all().filter((entry) => entry.sessionId === sessionId).sort((a, b) => a.nextAt.localeCompare(b.nextAt));
  }
  set(context: ToolContext, input: z.infer<typeof WakeLaterSchema>): Wakeup {
    const sessionId = this.store.run(context.runId)?.sessionId;
    if (!sessionId) throw new Error("A wake-up belongs to a conversation, and this task has none.");
    // A helper's own conversation is not where anyone listens: it tells its lead instead (helpers.tell_lead).
    if (context.depth > 0) throw new Error("A helper cannot set wake-ups. Tell your lead with helpers.tell_lead what it should come back to.");
    if (this.list(sessionId).length >= maxPerConversation) throw new Error(`This conversation already has ${maxPerConversation} wake-ups; cancel one first.`);
    const now = this.now();
    const first = input.cron ? nextCronOccurrence(new Date(now), input.cron, input.timezone!).getTime()
      : input.at ? Date.parse(input.at) : now + (input.inMinutes ?? 0) * 60_000;
    if (!Number.isFinite(first) || first < now - 60_000) throw new Error("That time has already passed.");
    const entry: Wakeup = { id: randomUUID(), sessionId, runId: context.runId, message: input.message,
      nextAt: new Date(first).toISOString(), everyMinutes: input.everyMinutes ?? null,
      left: repeats({ everyMinutes: input.everyMinutes ?? null, cron: input.cron ?? null }) ? input.times ?? 48 : 1,
      createdAt: new Date(now).toISOString(), cron: input.cron ?? null, timezone: input.cron ? input.timezone ?? null : null };
    this.save(entry);
    if (context.runId) this.store.event(context.runId, "wakeup.set", { id: entry.id, nextAt: entry.nextAt, everyMinutes: entry.everyMinutes, cron: entry.cron, left: entry.left });
    return entry;
  }
  cancel(id: string, sessionId: string): boolean {
    const entry = this.all().find((one) => one.id === id && one.sessionId === sessionId);
    if (!entry) throw new Error("There is no wake-up with that number in this conversation.");
    this.drop(entry);
    return true;
  }
  /** When a repeat is due next after `after`: by its cron, else its step; missed turns coalesce into one. */
  private nextOf(entry: Wakeup, after: number): number {
    if (entry.cron && entry.timezone) return nextCronOccurrence(new Date(after), entry.cron, entry.timezone).getTime();
    const step = (entry.everyMinutes ?? 0) * 60_000;
    const next = Date.parse(entry.nextAt) + step;
    return next <= after ? after + step : next;
  }
  /** Due ones wake their conversation once each; a repeat moves to its next time after now. */
  async tick(at = new Date(this.now())): Promise<void> {
    for (const entry of this.all()) {
      if (Date.parse(entry.nextAt) > at.getTime()) continue;
      const left = entry.left - 1;
      const next = left > 0 && repeats(entry) ? { ...entry, left, misses: 0, nextAt: new Date(this.nextOf(entry, at.getTime())).toISOString() } : null;
      if (next) this.save(next); else this.drop(entry);
      const every = entry.cron ? `on "${entry.cron}" (${entry.timezone})` : `every ${entry.everyMinutes} minutes`;
      const repeat = repeats(entry) ? ` (${every}; ${left} more to come)` : "";
      try { this.wake(entry.sessionId, `Wake-up you set${repeat}: ${entry.message}`, entry.runId); }
      catch (error) { this.missed(entry, next, at.getTime(), error); }
    }
  }
  /**
   * A wake-up that could not be delivered: dropped with its conversation; otherwise written on the task that set it
   * and tried again in a few minutes (a repeat keeps its own next turn if that comes sooner), three misses at most.
   */
  private missed(entry: Wakeup, next: Wakeup | null, now: number, error: unknown): void {
    if (!this.store.ownsSession(this.owner, entry.sessionId)) { this.drop(entry); return; }
    const misses = (entry.misses ?? 0) + 1;
    const reason = (error instanceof Error ? error.message : String(error)).slice(0, 200);
    try { this.store.event(entry.runId, "wakeup.not_delivered", { id: entry.id, reason, misses, willRetry: misses < maxMisses }); } catch { /* its task is gone */ }
    if (misses >= maxMisses) return;
    const retry = new Date(now + retryMs).toISOString();
    this.save({ ...(next ?? entry), left: (next?.left ?? 0) + 1, misses, nextAt: next && next.nextAt < retry ? next.nextAt : retry });
  }
}

const sessionOf = (store: Store, context: ToolContext): string => store.run(context.runId)?.sessionId ?? "";

export function registerWakeups(registry: ToolRegistry, store: Store, wakeups: Wakeups): void {
  registry.register({
    name: "schedules.wake_later", permission: "schedules.manage", group: "schedules",
    description: "Wake yourself later in this same conversation: after some minutes, at a time, repeating every N minutes, or on a five-field cron in a timezone. The message arrives here as a new message when it is due, and the work carries on from there. Wake-ups are saved and survive a restart. Use it instead of waiting or checking again and again.",
    parameters: WakeLaterSchema,
    execute: async (input, context) => {
      const entry = wakeups.set(context, input);
      return { id: entry.id, nextAt: entry.nextAt, everyMinutes: entry.everyMinutes, cron: entry.cron, timezone: entry.timezone, times: entry.left };
    },
  });
  registry.register({
    name: "schedules.wakeups", permission: "schedules.read", group: "schedules",
    description: "The wake-ups set in this conversation, soonest first.",
    parameters: z.object({}).strict(),
    execute: async (_input, context) => ({ wakeups: wakeups.list(sessionOf(store, context)).map(({ id, message, nextAt, everyMinutes, cron, timezone: zone, left }) =>
      ({ id, message, nextAt, everyMinutes, cron: cron ?? null, timezone: zone ?? null, left })) }),
  });
  registry.register({
    name: "schedules.cancel_wake", permission: "schedules.manage", group: "schedules",
    description: "Cancel a wake-up set in this conversation.",
    parameters: z.object({ id: z.string().uuid() }).strict(),
    execute: async (input, context) => ({ cancelled: wakeups.cancel(input.id, sessionOf(store, context)) }),
  });
}
