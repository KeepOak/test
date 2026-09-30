import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Store } from "./store.js";
import type { Flows } from "./flows.js";
import type { RunSource } from "./policy.js";
import { nextCronOccurrence, validCron } from "./recurrence.js";
import { zodForShape } from "./flow-graph.js";

const bounded = z.string().min(1).max(120);
const zone = z.string().max(64).refine((value) => {
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }); return true; } catch { return false; }
});
export const SopSchema = z.object({ name: bounded, macroId: z.uuid(), event: z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("cron"), cron: z.string().max(100).refine(validCron), timezone: zone }).strict(),
  z.object({ kind: z.literal("webhook"), triggerId: z.uuid() }).strict(),
  z.object({ kind: z.literal("mqtt"), channel: bounded, chatId: bounded, senderId: bounded, topic: z.string().min(1).max(256).refine((value) => !/[+#\u0000]/.test(value)) }).strict(),
  z.object({ kind: z.literal("device"), vendorId: z.string().regex(/^[0-9a-f]{4}$/), productId: z.string().regex(/^[0-9a-f]{4}$/), serial: z.string().max(120) }).strict(),
]), input: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/), z.union([
  z.string().max(4000), z.number().finite(), z.boolean(), z.array(z.string().max(4000)).max(50),
  z.object({ $event: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/) }).strict(),
])).refine((value) => Object.keys(value).length <= 20) }).strict();
type Definition = z.infer<typeof SopSchema>;
type Proposal = { id: string; at: string; expires: string; input: Record<string, unknown>; source: RunSource; slot: string };
type Binding = Definition & { id: string; enabled: boolean; due: string | null; pending: Proposal[]; slots: string[]; runs: string[]; lastEvent: string | null; hold: string | null };
const key = "sop-event-bindings-v1", maxPending = 10, expiryMs = 10 * 60_000;

/** Events propose work; only an explicit owner action can start the existing graph runner. */
export class SopEvents {
  constructor(private readonly store: Store, private readonly owner: string, private readonly flows: Flows,
    private readonly held: () => boolean, private readonly available: (event: Definition["event"]) => string | null) {}
  private rows(): Binding[] { return (this.store.get("settings", this.owner, key)?.data.bindings ?? []) as Binding[]; }
  private write(rows: Binding[]): void { this.store.save("settings", this.owner, key, { bindings: rows }); }
  private ownerReady(): void {
    this.store.profiles.requireOwner("Event-bound procedures");
    if (this.held()) throw new Error("Unlock Branch and leave lockdown before changing or approving a procedure");
  }
  list(): Binding[] {
    this.ownerReady();
    return this.rows().map((row) => ({ ...row, hold: this.available(row.event) ?? row.hold,
      pending: row.pending.filter((proposal) => Date.parse(proposal.expires) > Date.now()) }));
  }
  save(input: unknown): Binding {
    this.ownerReady();
    const definition = SopSchema.parse(input), rows = this.rows();
    if (rows.length >= 20) throw new Error("Remove a procedure before adding another (limit 20)");
    if (!this.flows.macros().some((macro) => macro.id === definition.macroId)) throw new Error("Choose an existing imported typed macro");
    const event = definition.event;
    if (event.kind === "webhook" && rows.some((row) => row.event.kind === "webhook" && row.event.triggerId === event.triggerId))
      throw new Error("That webhook already belongs to a procedure");
    const row: Binding = { ...definition, id: randomUUID(), enabled: false, due: null, pending: [], slots: [], runs: [], lastEvent: null, hold: this.available(definition.event) };
    this.write([...rows, row]); return row;
  }
  enable(id: string, enabled: boolean): void {
    this.ownerReady();
    const rows = this.rows(), row = rows.find((item) => item.id === id);
    if (!row) throw new Error("Procedure not found");
    if (enabled && this.available(row.event)) throw new Error(this.available(row.event)!);
    row.enabled = enabled; row.pending = [];
    row.due = enabled && row.event.kind === "cron" ? nextCronOccurrence(new Date(), row.event.cron, row.event.timezone).toISOString() : null;
    this.write(rows);
    // Disabling stops future proposals. Existing runs remain visible and cancellable; no hidden rollback.
  }
  remove(id: string): void {
    this.ownerReady(); const rows = this.rows(), row = rows.find((item) => item.id === id);
    if (!row) throw new Error("Procedure not found");
    if (row.runs.some((runId) => ["running", "waiting_approval", "interrupted"].includes(this.flows.graphs.view(runId).status)))
      throw new Error("Cancel or finish this procedure's existing runs before removing it");
    this.write(rows.filter((item) => item.id !== id));
  }
  private offer(row: Binding, payload: Record<string, unknown>, slot: string, source: RunSource): void {
    const now = new Date(), rows = this.rows(), current = rows.find((item) => item.id === row.id);
    if (!current?.enabled || current.slots.includes(slot)) return;
    if (this.held() || this.available(current.event)) { current.hold = this.available(current.event) ?? "Branch is locked or in lockdown"; this.write(rows); return; }
    current.pending = current.pending.filter((item) => Date.parse(item.expires) > now.getTime());
    if (current.pending.length >= maxPending || current.lastEvent && now.getTime() - Date.parse(current.lastEvent) < 60_000) return;
    try {
      const input = Object.fromEntries(Object.entries(current.input).map(([name, value]) => [name,
        typeof value === "object" && !Array.isArray(value) ? payload[value.$event] : value]));
      const macro = this.flows.macros().find((item) => item.id === current.macroId);
      if (!macro) throw new Error("Imported macro was removed");
      if (Buffer.byteLength(JSON.stringify(input), "utf8") > 16_000) throw new Error("Event input exceeds 16 KB");
      zodForShape(macro.definition.input).parse(input);
      current.pending.push({ id: randomUUID(), at: now.toISOString(), expires: new Date(now.getTime() + expiryMs).toISOString(), input, source, slot });
      current.slots = [...current.slots, slot].slice(-50); current.lastEvent = now.toISOString(); current.hold = null;
    } catch (error) { current.hold = error instanceof Error ? error.message.slice(0, 500) : "Event input does not match the macro"; }
    this.write(rows);
  }
  async tick(now: Date): Promise<void> {
    for (const row of this.rows()) {
      if (!row.enabled || row.event.kind !== "cron" || !row.due || Date.parse(row.due) > now.getTime()) continue;
      const due = row.due;
      this.offer(row, { dueAt: due }, `cron:${due}`, "schedule");
      const rows = this.rows(), current = rows.find((item) => item.id === row.id);
      if (current) { current.due = nextCronOccurrence(now, row.event.cron, row.event.timezone).toISOString(); this.write(rows); }
    }
  }
  hasWebhook(triggerId: string): boolean {
    return this.rows().some((item) => item.event.kind === "webhook" && item.event.triggerId === triggerId);
  }
  webhook(triggerId: string, payload: unknown, slot: string): { accepted: boolean; state: string } {
    const row = this.rows().find((item) => item.event.kind === "webhook" && item.event.triggerId === triggerId);
    if (!row) throw new Error("No procedure for this trigger");
    if (!row.enabled) return { accepted: false, state: "procedure-disabled" };
    this.offer(row, payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {}, slot, "trigger");
    const current = this.rows().find((item) => item.id === row.id)!;
    return { accepted: current.pending.some((item) => item.slot === slot), state: current.hold ? "held" : current.pending.some((item) => item.slot === slot) ? "owner-approval-required" : "coalesced-or-rate-held" };
  }
  mqtt(message: { channel: string; chatId: string; senderId: string; messageId: string; text: string; mqttTopic?: string; mqttDuplicate?: boolean }): boolean {
    const rows = this.rows().filter((row) => row.enabled && row.event.kind === "mqtt" && row.event.channel === message.channel && row.event.chatId === message.chatId && row.event.senderId === message.senderId && row.event.topic === message.mqttTopic);
    if (!message.mqttDuplicate) for (const row of rows) this.offer(row, { text: message.text.slice(0, 4000), senderId: message.senderId, chatId: message.chatId, topic: message.mqttTopic }, `mqtt:${message.messageId}`, "channel");
    return rows.length > 0;
  }
  device(device: { vendorId: string; productId: string; serial: string; name: string }): void {
    for (const row of this.rows()) if (row.enabled && row.event.kind === "device" && row.event.vendorId === device.vendorId && row.event.productId === device.productId && row.event.serial === device.serial)
      this.offer(row, { name: device.name.slice(0, 120), serial: device.serial.slice(0, 120) }, `device:${randomUUID()}`, "schedule");
  }
  approve(id: string, proposalId: string): ReturnType<Flows["startGraph"]> {
    this.ownerReady(); const rows = this.rows(), row = rows.find((item) => item.id === id);
    const proposal = row?.pending.find((item) => item.id === proposalId);
    if (!row?.enabled || !proposal || Date.parse(proposal.expires) <= Date.now()) throw new Error("This event proposal expired or was disabled; refresh");
    const unavailable = this.available(row.event); if (unavailable) throw new Error(unavailable);
    if (!this.flows.macros().some((macro) => macro.id === row.macroId)) throw new Error("Imported macro was removed");
    if (row.runs.some((runId) => ["running", "waiting_approval", "interrupted"].includes(this.flows.graphs.view(runId).status)))
      throw new Error("Finish or cancel this procedure's existing run before approving another event");
    // Consume before launching: an uncertain launch must never silently retry tool effects.
    row.pending = row.pending.filter((item) => item.id !== proposalId); this.write(rows);
    const started = this.flows.startGraph(row.macroId, proposal.input, undefined, proposal.source);
    row.runs = [...row.runs, started.runId].slice(-20); this.write(rows); return started;
  }
  reject(id: string, proposalId: string): void {
    this.ownerReady(); const rows = this.rows(), row = rows.find((item) => item.id === id);
    if (!row) throw new Error("Procedure not found"); row.pending = row.pending.filter((item) => item.id !== proposalId); this.write(rows);
  }
}
