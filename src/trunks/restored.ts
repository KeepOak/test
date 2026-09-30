import { z } from "zod";
import { audit } from "../audit.js";
import { lockdownActive } from "../lockdown.js";
import { looseningRefusal } from "../policy-change-guard.js";
import { HttpError } from "../server-http.js";
import type { Store } from "../store.js";
import { HeldListSchema, restoredTrunksKey, type Had, type HeldTrunk } from "./restore-narrow.js";
export { restoredTrunksKey } from "./restore-narrow.js";

/**
 * #484 (the lead's call): a backup carries the owner's Trunks (their governance `trunk:<id>` records, src/backup.ts),
 * and a restore brings each one back cut down, the way a Trunk brought in from a file is (src/trunks/share.ts): paused,
 * look-only, no tool servers, no chat apps or commands, the owner's own keys. What it had waits here, one Trunk at a
 * time, until the owner gives it back (with their separate yes, `confirmLoosening`, and never under Lockdown) or keeps it
 * as it is (how the Trunk is cut down: src/trunks/restore-narrow.ts).
 */
const AnswerSchema = z.object({ id: z.string().uuid(), answer: z.enum(["give", "keep"]), confirmLoosening: z.boolean().optional() }).strict();

/** What giving a Trunk back would let it do again, in plain words, one line each; empty when it had nothing more. */
export function regains(had: Had, now: { permissions: readonly string[] }): string[] {
  const more = had.permissions.filter((permission) => !now.permissions.includes(permission));
  return [
    !had.permissions.length ? "use every tool you allow, not only the ones that look" : more.length ? `use ${more.join(", ")}` : "",
    had.mcpServers.length ? `use the tool servers ${had.mcpServers.join(", ")}` : "",
    had.reach.channels.length ? `answer on the chat apps ${had.reach.channels.join(", ")}` : "",
    had.reach.commands ? "take commands in its chat apps" : "",
    !had.keys.copyFromOwner ? "use its own sign-ins instead of yours" : "",
    Object.keys(had.keys.accounts).length ? `use the accounts it chose (${Object.entries(had.keys.accounts).map(([pool, account]) => `${pool}: ${account}`).join(", ")})` : "",
    !had.paused ? "start work again (it comes back paused)" : "",
  ].filter(Boolean);
}

export class RestoredTrunks {
  constructor(private readonly store: Store) {}
  private get owner(): string { return this.store.profiles.ownerName; }
  private read(): HeldTrunk[] {
    const saved = HeldListSchema.safeParse(this.store.get("settings", this.owner, restoredTrunksKey)?.data ?? {});
    return saved.success ? saved.data.trunks : [];
  }
  private write(trunks: readonly HeldTrunk[]): void {
    if (trunks.length) this.store.save("settings", this.owner, restoredTrunksKey, { trunks });
    else this.store.delete("settings", this.owner, restoredTrunksKey);
  }
  private record(id: string): Record<string, unknown> | undefined {
    return this.store.get("governance", this.owner, `trunk:${id}`)?.data as Record<string, unknown> | undefined;
  }
  /** The Trunks waiting, each with what it would get back; one no longer here is dropped. The owner's alone. */
  list(): { trunks: { id: string; name: string; title: string; regains: string[] }[] } {
    this.store.profiles.requireOwner("Restoring a backup");
    const waiting = this.read().filter((trunk) => this.record(trunk.id));
    return { trunks: waiting.map((trunk) => ({ id: trunk.id, name: trunk.name, title: `Give ${trunk.name} back what it had`,
      regains: regains(trunk.had, { permissions: (this.record(trunk.id)?.permissions as string[] | undefined) ?? [] }) })) };
  }
  /**
   * The owner's answer for one Trunk. "keep" leaves it as the restore made it. "give" puts back what it had: that makes
   * Branch less careful, so it needs the owner's separate yes and is refused under Lockdown (src/policy-change-guard.ts).
   */
  answer(input: unknown): ReturnType<RestoredTrunks["list"]> {
    this.store.profiles.requireOwner("Restoring a backup");
    const { id, answer, confirmLoosening } = AnswerSchema.parse(input);
    const waiting = this.read(), held = waiting.find((trunk) => trunk.id === id), record = this.record(id);
    if (!held || !record) throw new HttpError(404, "No restored Trunk is waiting with that id");
    if (answer === "give") {
      const words = regains(held.had, { permissions: (record.permissions as string[] | undefined) ?? [] });
      const refusal = looseningRefusal(words.length ? `${held.name} would ${words.join("; ")}` : null, confirmLoosening === true, lockdownActive(this.store, this.owner));
      if (refusal) throw new HttpError(409, refusal);
      const { paused: wasPaused, ...had } = held.had;
      const { pausedAt: _pausedAt, ...rest } = record;
      this.store.save("governance", this.owner, `trunk:${id}`, { ...rest, ...had, paused: wasPaused, ...(wasPaused ? { pausedAt: record.pausedAt } : {}), updatedAt: new Date().toISOString() });
      audit(this.store, this.owner, { action: "policy.changed", actor: this.owner, subject: `Trunk "${held.name}" after a restore`,
        reason: words.length ? `Given back what it had: it may ${words.join("; ")}` : "Given back what it had", outcome: "saved" });
    } else audit(this.store, this.owner, { action: "data.imported", actor: this.owner, subject: `Trunk "${held.name}" after a restore`,
      reason: "Kept as the restore brought it back: paused and look-only", outcome: "saved" });
    this.write(waiting.filter((trunk) => trunk.id !== id));
    return this.list();
  }
}
