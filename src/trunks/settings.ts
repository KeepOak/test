import { z } from "zod";
import type { Store } from "../store.js";
import { lockdownOverrides } from "../lockdown.js"; // mac7/lockdown-fix

/**
 * Bucket R17-A (wave mac7): Trunks, Branch's named long-lived agents. Each part has the owner's
 * three-way switch — off, when needed, on — kept in a settings record of its own. What each ships as
 * is `trunkShipsOn` below; a saved record that cannot be read is off. A fresh install still has no
 * Trunks until the owner makes one.
 *
 *   off          the part refuses in one plain sentence; its tools are not in the catalog at all
 *   when-needed  it works, and its tools are a line in the index until the work calls for them
 *   on           it works, and its tools are loaded from the first round
 *
 * The schema is written out here rather than imported from feature-switches.ts, because that file
 * reads these same records to decide what to preload, and the two must not import each other.
 */
export const trunkParts = ["trunks", "rooms", "messages", "routines", "teach", "conversations"] as const; // phase2/rooms: conversations
export type TrunkPart = (typeof trunkParts)[number];
export const TrunkPartSchema = z.enum(trunkParts);

const ModeSchema = z.enum(["off", "when-needed", "on"]);
export type TrunkMode = z.infer<typeof ModeSchema>;
const RecordSchema = z.object({ mode: ModeSchema.default("off") }).strict();

/** The settings record a part's switch is kept in. */
export const trunkKey = (part: TrunkPart): string => `trunks-${part}`;

/** What each part is while nothing has been saved for it. A saved record that is damaged still reads as off. */
export const trunkShipsOn: Partial<Record<TrunkPart, TrunkMode>> = {
  // The owner's rule (ships on, 2026-09-26): a Trunk exists only once the owner makes one, and answers on the configured model; none of (a)–(f).
  trunks: "when-needed",
  // The owner's rule (ships on, 2026-09-26): a room holds only the owner's own Trunks on this computer; none of (a)–(f).
  rooms: "when-needed",
  // The owner's rule (ships on, 2026-09-26): messages pass between the owner's own Trunks on this computer; none of (a)–(f).
  messages: "when-needed",
  // The owner's rule (ships on, 2026-09-26): a routine is an ordinary schedule the owner makes, held by every schedule rule; none of (a)–(f).
  routines: "when-needed",
  // The owner's rule (ships on, 2026-09-26): learns only from a task the owner did after pressing "Watch me", secrets taken out; none of (a)–(f).
  teach: "when-needed",
};

/** What each part is, in the owner's words, for the card and for a refusal. */
export const trunkLabels: Record<TrunkPart, string> = {
  trunks: "Trunks, your named assistants",
  rooms: "Rooms where Trunks talk together",
  messages: "Trunks messaging each other",
  routines: "Routines a Trunk owns",
  teach: "Teaching a Trunk by showing it once",
  conversations: "Choosing a Trunk to answer in any conversation", // phase2/rooms
};

/** The tools each part owns, so the catalog can leave them out while the part is off. */
export const trunkTools: Record<TrunkPart, readonly string[]> = {
  trunks: [],
  rooms: [],
  messages: ["trunk.message"],
  routines: [],
  teach: [],
  conversations: [],
};

/** For src/feature-switches.ts: each part with tools — its settings record, why it is loaded, and its tools. */
export const trunkToolFeatures: readonly (readonly [string, string, readonly string[], TrunkMode])[] = trunkParts
  .filter((part) => trunkTools[part].length > 0)
  .map((part) => [trunkKey(part), `${trunkLabels[part].charAt(0).toLowerCase()}${trunkLabels[part].slice(1)} is switched on`, trunkTools[part], trunkShipsOn[part] ?? "off"] as const);

export function trunkMode(store: Pick<Store, "get">, owner: string, part: TrunkPart): TrunkMode {
  if (lockdownOverrides(store, owner, trunkKey(part))) return "off"; // mac7/lockdown-fix
  const found = store.get("settings", owner, trunkKey(part));
  let mode: TrunkMode = trunkShipsOn[part] ?? "off";
  if (found) {
    const saved = RecordSchema.safeParse(found.data ?? {});
    if (!saved.success) return "off";
    mode = saved.data.mode;
  }
  // Every other part needs Trunks themselves: with those off, nothing of theirs works either.
  if (part !== "trunks" && mode !== "off" && trunkMode(store, owner, "trunks") === "off") return "off";
  return mode;
}

export function allTrunkModes(store: Pick<Store, "get">, owner: string): Record<TrunkPart, TrunkMode> {
  return Object.fromEntries(trunkParts.map((part) => [part, trunkMode(store, owner, part)])) as Record<TrunkPart, TrunkMode>;
}

export function saveTrunkMode(store: Store, owner: string, part: TrunkPart, input: unknown): TrunkMode {
  const { mode } = RecordSchema.parse(input);
  store.save("settings", owner, trunkKey(part), { mode });
  return mode;
}

export class TrunkOffError extends Error {
  override name = "TrunkOffError";
}

/** Throws the one plain sentence a switched-off part answers with. */
export function requireTrunkPart(store: Pick<Store, "get">, owner: string, part: TrunkPart): void {
  if (trunkMode(store, owner, part) === "off")
    throw new TrunkOffError(`${trunkLabels[part]} is switched off. The owner can switch it on in Customize → Specialists, under Trunks.`);
}

/** Tools that run programs on the computer: a Trunk gets them only when its own switch allows it (T-15). */
export const commandPermissions: readonly string[] = ["shell.execute", "code.execute", "remote.execute", "process.manage"];
