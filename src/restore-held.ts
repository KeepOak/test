import { z } from "zod";
import { audit } from "./audit.js";
import { restoreHeldKey, type HeldRow } from "./backup.js";
import { recordedWrite } from "./settings-kit/recorded-write.js";
import { lockdownActive } from "./lockdown.js";
import { lockdownSettingsRefusal } from "./policy-change-guard.js";
import { HttpError } from "./server-http.js";
import { specFor } from "./settings-kit/catalogue.js";
import type { Store } from "./store.js";

/**
 * Q168 B: rows a restore took from a backup but did not put in place, because each says where the owner's
 * words go or who gets in (src/backup.ts `heldForTheOwner`). They wait here for the owner's yes, group by
 * group, and this computer's own value stays until then. The list lives in one setting that stays on this
 * computer, so a backup never carries it.
 */
const HeldRowSchema = z.object({ owner: z.string().min(1).max(200), id: z.string().min(1).max(200), data: z.string().max(4_000_000) }).strict();
const maxHeldRows = 500;
const HeldListSchema = z.object({ rows: z.array(HeldRowSchema).max(maxHeldRows).default([]), restoredAt: z.string().nullable().default(null) }).strict();
const AnswerSchema = z.object({
  use: z.array(z.string().min(1).max(200)).max(500).default([]),
  keep: z.array(z.string().min(1).max(200)).max(500).default([]),
}).strict();

/** Who put a held row in place, for the settings history: the owner, in the window, from a restore. */
const restoredByTheOwner = { writer: "owner-in-window", source: "import", detail: "a restore, on the owner's yes" } as const;

/** A model account is only half of where the owner's words go without its connection, so the two are one group. */
const groupOf = (id: string): string => (id === "model-connections" ? "accounts" : id);
export interface HeldGroup { group: string; ids: string[] }

export class RestoreHeld {
  constructor(private readonly store: Store) {}
  private get owner(): string { return this.store.profiles.ownerName; }
  private read(): z.infer<typeof HeldListSchema> {
    const saved = HeldListSchema.safeParse(this.store.get("settings", this.owner, restoreHeldKey)?.data ?? {});
    return saved.success ? saved.data : HeldListSchema.parse({});
  }
  private write(rows: HeldRow[]): void {
    if (rows.length) this.store.save("settings", this.owner, restoreHeldKey, { rows, restoredAt: new Date().toISOString() });
    else this.store.delete("settings", this.owner, restoreHeldKey);
  }
  /**
   * Adds what one restore held. A row the list already has (same owner and id) takes the newer file's value; the
   * rest of an earlier restore's list stays waiting, so a second restore never answers the first one's rows.
   */
  merge(held: readonly HeldRow[]): HeldGroup[] {
    // Q186: the list's own limits are kept when it is written, or one odd row (an id past 200 characters) or one
    // row too many would make the whole list unreadable, and everything waiting would be lost. A row left out
    // here is simply not brought back: this computer's own value stays, as for any row the owner keeps.
    const fit = held.filter((row) => HeldRowSchema.safeParse(row).success);
    if (fit.length) {
      const key = (row: HeldRow) => `${row.owner}\u0000${row.id}`;
      const fresh = new Set(fit.map(key));
      this.write([...this.read().rows.filter((row) => !fresh.has(key(row))), ...fit].slice(-maxHeldRows));
    }
    return this.groups();
  }
  /** What is waiting, grouped as the owner answers it. */
  groups(): HeldGroup[] {
    const groups = new Map<string, Set<string>>();
    for (const row of this.read().rows) groups.set(groupOf(row.id), (groups.get(groupOf(row.id)) ?? new Set()).add(row.id));
    return [...groups].map(([group, ids]) => ({ group, ids: [...ids].sort() }));
  }
  /** The owner's own list, from the owner's own window. */
  list(): { held: HeldGroup[] } {
    this.store.profiles.requireOwner("What a restore is waiting to hear about");
    return { held: this.groups() };
  }
  /**
   * The owner's answer: each group in `use` is put in place from the backup, each in `keep` is dropped and this
   * computer's own value stays. Anything not named keeps waiting. Checked for the owner inside, whoever calls.
   */
  answer(input: unknown): { used: string[]; kept: string[]; held: HeldGroup[] } {
    this.store.profiles.requireOwner("Answering what a restore is waiting to hear about");
    const { use, keep } = AnswerSchema.parse(input ?? {});
    // Putting a backup's row in place can loosen what Lockdown holds (a spending limit, the approval rules), so under
    // Lockdown nothing is put in place, even on the owner's yes; keeping this computer's own value is always fine.
    if (use.length && lockdownActive(this.store, this.owner)) throw new HttpError(409, lockdownSettingsRefusal);
    const both = use.filter((group) => keep.includes(group));
    if (both.length) throw new Error(`Say either use or keep for ${both.join(", ")}, not both.`);
    const rows = this.read().rows, waiting = new Set(rows.map((row) => groupOf(row.id)));
    const unknown = [...use, ...keep].filter((group) => !waiting.has(group));
    if (unknown.length) throw new Error(`Nothing from a restore is waiting for ${unknown.join(", ")}.`);
    const chosen = rows.filter((one) => use.includes(groupOf(one.id)));
    // Q48 (NAS e699303): a held row can be a Settings setting ("When to check with me", which chats may do what),
    // so putting it in place is written down as a change, per owner, like any other.
    for (const owner of new Set(chosen.map((row) => row.owner))) {
      const mine = chosen.filter((row) => row.owner === owner);
      const settings = [...new Set(mine.map((row) => row.id))].filter((id) => specFor(id) !== undefined);
      recordedWrite(this.store, owner, restoredByTheOwner, settings, () => {
        for (const row of mine) this.store.save("settings", row.owner, row.id, JSON.parse(row.data) as Record<string, unknown>);
      });
    }
    this.write(rows.filter((row) => !use.includes(groupOf(row.id)) && !keep.includes(groupOf(row.id))));
    // NAS 49b183b: each answer is in the audit log, as pairing a sender or changing the rules is anywhere else.
    for (const [groups, outcome] of [[use, "used"], [keep, "kept"]] as const)
      for (const group of groups) audit(this.store, this.owner, { action: "data.imported", actor: this.owner, outcome,
        subject: `From a restore: ${group}`, reason: outcome === "used" ? "The owner put the backup's value in place." : "The owner kept this computer's own value." });
    return { used: use, kept: keep, held: this.groups() };
  }
}
