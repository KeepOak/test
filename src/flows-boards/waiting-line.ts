import { z } from "zod";
import { startedWithShortLivedKey } from "../key-context.js";
import { currentPerson } from "../people/context.js";
import type { RunQueue } from "../run-queue.js";
import type { FollowUp, Runtime } from "../runtime.js";
import { partRecord, requirePart } from "./settings.js";

/**
 * R17-073: the waiting line you can change, and a choice of what happens when you type while the
 * assistant works (Hermes' `/queue` and `/busy`, MIT; written for Branch).
 *
 * Two lines already exist and are only extended here:
 * - a conversation's next messages (`Runtime.followUp`, kept in the `followups:<conversation>`
 *   record), which run in order once the conversation is free;
 * - the app's waiting line of tasks (src/run-queue.ts), for work that waits for room.
 * Both can now be read, reworded, moved and taken out while they wait. Nothing that has started can
 * be reworded; a started task is stopped with the ordinary Stop.
 *
 * While a task works, what you type can wait its turn (queue, as before), be handed to the task
 * straight away (steer, the existing out-of-band note in src/steer.ts), or stop the task and go next
 * (interrupt).
 */
export const busyModes = ["queue", "steer", "interrupt"] as const;
export type BusyMode = (typeof busyModes)[number];
const BusySchema = z.object({ mode: z.enum(busyModes).default("queue") }).strict();
const busyKey = "flowboards-busy-mode";

export const MoveSchema = z.object({ direction: z.enum(["up", "down", "first", "last"]) }).strict();
export type Direction = z.infer<typeof MoveSchema>["direction"];
const PromptSchema = z.object({ prompt: z.string().trim().min(1).max(16000) }).strict();

/**
 * Integration review: changing either line, and what typing does while a task works, is the owner's
 * alone. A queued message runs with the marks of whoever queued it, so a short-lived key or a household
 * person rewording (or jumping ahead of) the owner's message would run their words as the owner's.
 */
export const waitingOwnerRefusal = "Only the owner can change the waiting line, in the Branch app or the owner's own terminal.";

export interface BusySend { mode: BusyMode; working: boolean; message: string; position?: number }

export class WaitingLine {
  constructor(private readonly runtime: Runtime, private readonly queue: RunQueue) {}
  private get store() { return this.runtime.store; }
  private get owner() { return this.runtime.owner; }
  private change(): void {
    requirePart(this.store, this.owner, "waiting-line");
    if (startedWithShortLivedKey() || currentPerson() || !this.store.profiles.isOwner()) throw new Error(waitingOwnerRefusal);
  }

  busyMode(): BusyMode { return partRecord(this.store, this.owner, busyKey, BusySchema).mode; }
  saveBusyMode(input: unknown): BusyMode {
    this.change();
    const { mode } = BusySchema.parse(input);
    this.store.save("settings", this.owner, busyKey, { mode });
    return mode;
  }

  /* ---------- a conversation's next messages ---------- */

  private mine(sessionId: string): FollowUp[] {
    if (!this.store.ownsSession(this.owner, sessionId)) throw new Error("Conversation not found");
    return this.runtime.queued(sessionId);
  }
  private keep(sessionId: string, items: FollowUp[]): FollowUp[] {
    this.store.save("settings", this.owner, `followups:${sessionId}`, { items });
    return items;
  }
  private find(items: FollowUp[], id: string): number {
    const index = items.findIndex((item) => item.id === id);
    if (index < 0) throw new Error("That message is no longer waiting; it may have started already.");
    return index;
  }

  followUps(sessionId: string): FollowUp[] { return this.mine(sessionId); }

  /** Every conversation that has messages waiting, for the card in Automations. */
  everywhere(): { sessionId: string; items: FollowUp[] }[] {
    return this.store.list("settings", this.owner)
      .filter((record) => record.id.startsWith("followups:"))
      .map((record) => ({ sessionId: record.id.slice("followups:".length), items: (record.data as { items?: FollowUp[] }).items ?? [] }))
      .filter((entry) => entry.items.length > 0 && this.store.ownsSession(this.owner, entry.sessionId));
  }

  /** The app's tasks still waiting for room, in the order they will start. */
  tasks(): { id: string; prompt: string; source: string; position: number | null }[] {
    return this.queue.list(this.owner).filter((entry) => entry.status === "waiting")
      .map(({ id, prompt, source, position }) => ({ id, prompt, source, position }));
  }

  editFollowUp(sessionId: string, id: string, input: unknown): FollowUp[] {
    this.change();
    const { prompt } = PromptSchema.parse(input);
    const items = [...this.mine(sessionId)];
    const index = this.find(items, id);
    items[index] = { ...items[index]!, prompt };
    return this.keep(sessionId, items);
  }

  moveFollowUp(sessionId: string, id: string, input: unknown): FollowUp[] {
    this.change();
    const { direction } = MoveSchema.parse(input);
    const items = [...this.mine(sessionId)];
    return this.keep(sessionId, moved(items, this.find(items, id), direction));
  }

  removeFollowUp(sessionId: string, id: string): FollowUp[] {
    this.change();
    const items = [...this.mine(sessionId)];
    items.splice(this.find(items, id), 1);
    return this.keep(sessionId, items);
  }

  /* ---------- the app's waiting line of tasks ---------- */

  private waitingRow(id: string): { priority: number; created_at: string } {
    const row = this.store.sqlite.prepare("SELECT priority, created_at FROM run_queue WHERE owner=? AND id=? AND status='waiting'").get(this.owner, id);
    if (!row) throw new Error("That task is no longer waiting; it may have started already.");
    return { priority: Number(row.priority), created_at: String(row.created_at) };
  }

  editQueued(id: string, input: unknown): void {
    this.change();
    const { prompt } = PromptSchema.parse(input);
    this.waitingRow(id);
    this.store.sqlite.prepare("UPDATE run_queue SET prompt=?, updated_at=? WHERE owner=? AND id=? AND status='waiting'")
      .run(prompt, new Date().toISOString(), this.owner, id);
  }

  /**
   * Moves a waiting task among the others of the same kind. What the owner asked for is always served
   * before anything automatic, so a move never jumps that order: it changes the order within it.
   */
  moveQueued(id: string, input: unknown): void {
    this.change();
    const { direction } = MoveSchema.parse(input);
    const { priority } = this.waitingRow(id);
    const peers = this.store.sqlite.prepare("SELECT id, created_at FROM run_queue WHERE owner=? AND status='waiting' AND priority=? ORDER BY created_at, id")
      .all(this.owner, priority).map((row) => ({ id: String(row.id), at: String(row.created_at) }));
    const times = peers.map((peer) => peer.at).sort();
    const order = moved(peers, peers.findIndex((peer) => peer.id === id), direction);
    // The same times, handed out again in the new order, keep every other task's place among the rest.
    const spaced = distinct(times);
    const update = this.store.sqlite.prepare("UPDATE run_queue SET created_at=? WHERE owner=? AND id=?");
    order.forEach((peer, index) => update.run(spaced[index]!, this.owner, peer.id));
  }

  removeQueued(id: string): { cancelled: boolean } {
    this.change();
    this.waitingRow(id);
    return { cancelled: this.queue.cancel(this.owner, id).cancelled };
  }

  /* ---------- typing while it works ---------- */

  /** What the owner typed into a conversation that may be working, handled as the busy mode says. */
  send(sessionId: string, prompt: string, mode = this.busyMode()): BusySend {
    this.change();
    const text = PromptSchema.parse({ prompt }).prompt;
    if (!this.store.ownsSession(this.owner, sessionId)) throw new Error("Conversation not found");
    const row = this.store.sqlite.prepare("SELECT id FROM tasks WHERE owner=? AND session_id=? AND status='running' ORDER BY created_at DESC LIMIT 1")
      .get(this.owner, sessionId);
    const working = row ? { id: String(row.id) } : null;
    // A steered message is handed to the task as its own note; one it can no longer read (it finished meanwhile, or
    // was already writing its last answer) becomes its own next turn. It is never joined to another message.
    if (working && mode === "steer" && text.length <= 2000) {
      try {
        this.runtime.steer(working.id, text, undefined, { lateTurn: true });
        return { mode, working: true, message: "Passed on to the task that is working; it reads it before its next step." };
      } catch { /* the task finished between the check and the steer: the message waits its turn below */ }
    }
    const queued = this.runtime.followUp(sessionId, text);
    if (working && mode === "interrupt") {
      // It goes in front of anything already waiting, then the task is stopped and the line moves on.
      const items = this.runtime.queued(sessionId);
      const index = items.findIndex((item) => item.id === queued.id);
      if (index > 0) this.keep(sessionId, moved(items, index, "first"));
      this.runtime.cancel(working.id);
      return { mode, working: true, position: 1, message: "Stopped the task that was working; this goes next." };
    }
    return { mode: "queue", working: Boolean(working), position: queued.position,
      message: queued.position > 1 ? `Waiting behind ${queued.position - 1} other message(s).` : "This goes next." };
  }
}

function moved<T>(items: T[], index: number, direction: Direction): T[] {
  if (index < 0) throw new Error("That item is no longer waiting.");
  const next = [...items];
  const [item] = next.splice(index, 1);
  const to = direction === "first" ? 0 : direction === "last" ? next.length
    : direction === "up" ? Math.max(0, index - 1) : Math.min(next.length, index + 1);
  next.splice(to, 0, item!);
  return next;
}

/** Sorted times made strictly increasing, by a millisecond where two were the same. */
function distinct(times: string[]): string[] {
  const out: string[] = [];
  for (const time of times) {
    const last = out.at(-1);
    const at = Date.parse(time);
    out.push(last && Date.parse(last) >= at ? new Date(Date.parse(last) + 1).toISOString() : new Date(at).toISOString());
  }
  return out;
}
