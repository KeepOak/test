import { z } from "zod";
import { audit } from "../audit.js";
import type { Store } from "../store.js";
import type { TrunkRecords } from "./record.js";
import type { ComputersPort } from "./starts-in.js";

/**
 * P17-D §9: which computers a Trunk may use, and how many tasks it may run at once.
 *
 * A computer is "this" (this PC: its screen, mouse and apps) or one of the owner's paired computers, by its
 * id in the device book (a paired phone is a device, not a computer, and is never on the list). A Trunk
 * with nothing saved may use every computer and has no limit, exactly as before this existed. Once the
 * owner saves a list it is exact:
 *   - without "this", the Trunk's turns lose the desktop tools (src/trunks/index.ts, shapeOf);
 *   - a paired computer not on it is out of sight of the device tools and refused by name, and the
 *     window cannot pick it for one of the Trunk's conversations (src/devices/tools.ts, src/devices/api.ts);
 *   - the first entry is where a new conversation starts, when the conversation has picked nothing;
 *   - "at once", when set, is how many tasks may run as the Trunk side by side; one more is refused in
 *     words before it starts (src/runtime.ts, trunkAtOnce).
 *
 * Kept in `governance` under `trunk-computers:<id>`, off the Trunk record, so the generic edit cannot
 * change it and a shared Trunk file never carries it. Every change is the owner's and is written in
 * the activity log, since it widens or narrows what a Trunk may reach.
 */
export const thisComputer = "this";
const ComputerIdSchema = z.union([z.literal(thisComputer), z.string().regex(/^[a-f0-9]{16}$/, "Choose one of your computers")]);
export const TrunkComputersSchema = z.object({
  allowed: z.array(ComputerIdSchema).max(20)
    .refine((ids) => new Set(ids).size === ids.length, "Name each computer once"),
  atOnce: z.number().int().min(1).max(4).nullable().default(null),
}).strict();
export type TrunkComputersSaved = z.infer<typeof TrunkComputersSchema>;

export interface TrunkComputersView {
  /** False while nothing is saved: every computer is allowed and there is no limit. */
  limited: boolean;
  /** The computers it may use, in order; the first is where a new conversation starts. */
  allowed: string[];
  atOnce: number | null;
  /** Every computer there is to choose from: this PC, then the paired computers. */
  computers: { id: string; name: string | null }[];
}

export interface TrunkComputersDeps {
  store: Store;
  owner: string;
  records: TrunkRecords;
  computers: ComputersPort;
  /** The tasks running as this Trunk right now. */
  runsOf: (trunkId: string) => string[];
}

const key = (trunkId: string): string => `trunk-computers:${trunkId}`;

export class TrunkComputers {
  constructor(private readonly deps: TrunkComputersDeps) {}

  private known(): string[] { return [thisComputer, ...this.deps.computers().map((computer) => computer.id)]; }

  /** What the owner saved, with computers that have since been unpaired left out; null while nothing is saved. */
  saved(trunkId: string): TrunkComputersSaved | null {
    const parsed = TrunkComputersSchema.safeParse(this.deps.store.get("governance", this.deps.owner, key(trunkId))?.data);
    if (!parsed.success) return null;
    const known = new Set(this.known());
    const allowed = parsed.data.allowed.filter((id) => known.has(id));
    const atOnce = parsed.data.atOnce === null ? null : Math.min(parsed.data.atOnce, Math.max(1, allowed.length));
    return { allowed, atOnce };
  }

  view(trunkId: string): TrunkComputersView {
    this.deps.records.get(trunkId);
    const saved = this.saved(trunkId);
    return {
      limited: saved !== null,
      allowed: saved?.allowed ?? this.known(),
      atOnce: saved?.atOnce ?? null,
      computers: [{ id: thisComputer, name: null }, ...this.deps.computers().map(({ id, name }) => ({ id, name }))],
    };
  }

  /**
   * Replaces the list and the limit. Only this computer and the owner's paired computers may be named, and
   * "at once" can never be more than the computers it may use; either is refused before anything is saved.
   */
  set(trunkId: string, input: unknown): TrunkComputersView {
    const trunk = this.deps.records.get(trunkId);
    const next = TrunkComputersSchema.parse(input ?? {});
    const known = new Set(this.known());
    if (next.allowed.some((id) => !known.has(id)))
      throw Object.assign(new Error("That computer is not one of yours. Choose This computer or one you have paired."), { status: 400 });
    if (next.atOnce !== null && next.atOnce > Math.max(1, next.allowed.length))
      throw Object.assign(new Error("At once can't be more than the computers it may use."), { status: 400 });
    this.deps.store.save("governance", this.deps.owner, key(trunkId), next);
    audit(this.deps.store, this.deps.owner, { action: "trunk.computers", actor: this.deps.owner, subject: `Trunk "${trunk.name}"`,
      reason: `It may use ${next.allowed.length} computer${next.allowed.length === 1 ? "" : "s"}${next.atOnce === null ? "" : `, ${next.atOnce} at once`}`,
      outcome: "changed" });
    return this.view(trunkId);
  }

  /** Whether the Trunk may use this computer; true while nothing is saved. */
  allows(trunkId: string, computerId: string): boolean {
    const saved = this.saved(trunkId);
    return saved === null || saved.allowed.includes(computerId);
  }

  /** Where a new conversation of the Trunk starts, or null while nothing is saved. */
  first(trunkId: string): string | null {
    return this.saved(trunkId)?.allowed[0] ?? null;
  }

  /** Why the Trunk may not start another task now (it runs as many as the owner allowed at once), or null. */
  atOnceRefusal(trunkId: string): string | null {
    const limit = this.saved(trunkId)?.atOnce ?? null;
    if (limit === null) return null;
    const running = this.deps.runsOf(trunkId).length;
    if (running < limit) return null;
    const name = this.deps.records.find(trunkId)?.name ?? "This Trunk";
    return `${name} is already running ${running} task${running === 1 ? "" : "s"}, as many as it may run at once, so this did not start. Wait for one to finish, or raise At once under Its computers.`;
  }
}
