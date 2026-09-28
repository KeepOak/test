import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ToolContext } from "./contracts.js";
import type { ToolRegistry } from "./registry.js";
import type { Store } from "./store.js";

/**
 * The lead's workbench (SELF-305): a wake-up set inside a conversation, for later or on a repeat ("look at the pull
 * requests every 30 minutes", "remind me in 20 minutes to check the build"). When it is due, its words arrive in that
 * same conversation as a follow-up of the task that set it (Runtime.followUp), so the work carries on where it was,
 * held exactly as that task was: the owner's own conversation stays the owner's, one a chat app carries stays held as
 * the chat's (Runtime.carryOrigin). Wake-ups are saved, so a restart keeps them; one missed while Branch was closed
 * arrives once when it opens again, never once per missed turn. The scheduler's tick looks for due ones.
 */
export const WakeLaterSchema = z.object({
  /** What to tell yourself when it is time: the words arrive as a new message in this conversation. */
  message: z.string().trim().min(1).max(2000),
  /** How long from now, in minutes; or `at`. */
  inMinutes: z.number().min(1).max(10080).optional(),
  /** When, as a full date and time with its zone; or `inMinutes`. */
  at: z.iso.datetime({ offset: true }).optional(),
  /** Wake again this often after the first time, in minutes. */
  everyMinutes: z.number().int().min(5).max(1440).optional(),
  /** How many times in all, counting the first. A repeat without a count stops after 48. */
  times: z.number().int().min(1).max(500).optional(),
}).strict().refine((value) => (value.inMinutes === undefined) !== (value.at === undefined), "Give either inMinutes or at.");

export interface Wakeup {
  id: string; sessionId: string; runId: string; message: string; nextAt: string;
  everyMinutes: number | null; left: number; createdAt: string;
}
const prefix = "wakeup:";
const maxPerConversation = 20;

export class Wakeups {
  constructor(private readonly store: Store, private readonly owner: string,
    private readonly wake: (sessionId: string, text: string, runId: string) => void, private readonly now = () => Date.now()) {}
  private all(): Wakeup[] {
    return this.store.list("settings", this.owner).filter((row) => row.id.startsWith(prefix)).map((row) => row.data as unknown as Wakeup);
  }
  list(sessionId: string): Wakeup[] {
    return this.all().filter((entry) => entry.sessionId === sessionId).sort((a, b) => a.nextAt.localeCompare(b.nextAt));
  }
  set(context: ToolContext, input: z.infer<typeof WakeLaterSchema>): Wakeup {
    const sessionId = this.store.run(context.runId)?.sessionId;
    if (!sessionId) throw new Error("A wake-up belongs to a conversation, and this task has none.");
    if (this.list(sessionId).length >= maxPerConversation) throw new Error(`This conversation already has ${maxPerConversation} wake-ups; cancel one first.`);
    const first = input.at ? Date.parse(input.at) : this.now() + (input.inMinutes ?? 0) * 60_000;
    if (!Number.isFinite(first) || first < this.now() - 60_000) throw new Error("That time has already passed.");
    const entry: Wakeup = { id: randomUUID(), sessionId, runId: context.runId, message: input.message,
      nextAt: new Date(first).toISOString(), everyMinutes: input.everyMinutes ?? null,
      left: input.everyMinutes ? input.times ?? 48 : 1, createdAt: new Date(this.now()).toISOString() };
    this.store.save("settings", this.owner, `${prefix}${entry.id}`, { ...entry });
    if (context.runId) this.store.event(context.runId, "wakeup.set", { id: entry.id, nextAt: entry.nextAt, everyMinutes: entry.everyMinutes, left: entry.left });
    return entry;
  }
  cancel(id: string, sessionId: string): boolean {
    const entry = this.all().find((one) => one.id === id && one.sessionId === sessionId);
    if (!entry) throw new Error("There is no wake-up with that number in this conversation.");
    this.store.delete("settings", this.owner, `${prefix}${id}`);
    return true;
  }
  /** Due ones wake their conversation once each; a repeat moves to its next time after now. */
  async tick(at = new Date(this.now())): Promise<void> {
    for (const entry of this.all()) {
      if (Date.parse(entry.nextAt) > at.getTime()) continue;
      const left = entry.left - 1;
      if (left > 0 && entry.everyMinutes) {
        const step = entry.everyMinutes * 60_000;
        let next = Date.parse(entry.nextAt) + step;
        if (next <= at.getTime()) next = at.getTime() + step; // missed turns coalesce into this one
        this.store.save("settings", this.owner, `${prefix}${entry.id}`, { ...entry, left, nextAt: new Date(next).toISOString() });
      } else this.store.delete("settings", this.owner, `${prefix}${entry.id}`);
      const repeat = entry.everyMinutes ? ` (every ${entry.everyMinutes} minutes; ${left} more to come)` : "";
      try { this.wake(entry.sessionId, `Wake-up you set${repeat}: ${entry.message}`, entry.runId); }
      catch { this.store.delete("settings", this.owner, `${prefix}${entry.id}`); } // its conversation is gone
    }
  }
}

const sessionOf = (store: Store, context: ToolContext): string => store.run(context.runId)?.sessionId ?? "";

export function registerWakeups(registry: ToolRegistry, store: Store, wakeups: Wakeups): void {
  registry.register({
    name: "schedules.wake_later", permission: "schedules.manage", group: "schedules",
    description: "Wake yourself later in this same conversation: after some minutes or at a time, once or repeating (every N minutes). The message arrives here as a new message when it is due, and the work carries on from there. Use it instead of waiting or checking again and again.",
    parameters: WakeLaterSchema,
    execute: async (input, context) => {
      const entry = wakeups.set(context, input);
      return { id: entry.id, nextAt: entry.nextAt, everyMinutes: entry.everyMinutes, times: entry.left };
    },
  });
  registry.register({
    name: "schedules.wakeups", permission: "schedules.read", group: "schedules",
    description: "The wake-ups set in this conversation, soonest first.",
    parameters: z.object({}).strict(),
    execute: async (_input, context) => ({ wakeups: wakeups.list(sessionOf(store, context)).map(({ id, message, nextAt, everyMinutes, left }) =>
      ({ id, message, nextAt, everyMinutes, left })) }),
  });
  registry.register({
    name: "schedules.cancel_wake", permission: "schedules.manage", group: "schedules",
    description: "Cancel a wake-up set in this conversation.",
    parameters: z.object({ id: z.string().uuid() }).strict(),
    execute: async (input, context) => ({ cancelled: wakeups.cancel(input.id, sessionOf(store, context)) }),
  });
}
