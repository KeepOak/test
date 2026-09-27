import { z } from "zod";
import type { Store } from "../store.js";

/**
 * Bucket 20 (wave mac4): talking to other agents and tools. Each part has the owner's three-way
 * switch — off, when needed, on — kept in a settings record of its own. What each ships as is
 * `interopShipsOn` below; a saved record that cannot be read is off.
 *
 *   off          the part refuses in one plain sentence; its tools are not in the catalog at all
 *   when-needed  it works, and its tools are a line in the index until the work calls for them
 *   on           it works, and its tools are loaded from the first round
 *
 * The schema is written out here rather than imported from feature-switches.ts, because that file
 * reads these same records to decide what to preload, and the two must not import each other.
 */
export const interopParts = [
  "agent-protocol", "client-tools", "modes", "project-routing", "fleet", "handoff", "flow-search", "agent-market",
] as const;
export type InteropPart = (typeof interopParts)[number];
export const InteropPartSchema = z.enum(interopParts);

const ModeSchema = z.enum(["off", "when-needed", "on"]);
export type InteropMode = z.infer<typeof ModeSchema>;
const RecordSchema = z.object({ mode: ModeSchema.default("off") }).strict();

/** The settings record a part's switch is kept in. */
export const interopKey = (part: InteropPart): string => `interop-${part}`;

/**
 * What each part is while nothing has been saved for it. A saved record that is damaged still reads as off.
 * Kept off: the Agent Protocol (an HTTP door for outside programs to hand Branch work) and tools lent by a
 * program (a socket other programs connect to), because each lets something from outside in, rule (a).
 */
export const interopShipsOn: Partial<Record<InteropPart, InteropMode>> = {
  // The owner's rule (ships on, 2026-09-26): a mode only narrows what a task could already do; none of (a)–(f).
  modes: "when-needed",
  // The owner's rule (ships on, 2026-09-26): scores the owner's projects on words, and only the owner switches; none of (a)–(f).
  "project-routing": "when-needed",
  // Kept off, by the owner's rule (off for spending, sending, outside access, heavy disk): fleet and handoff reach assistants and devices outside this task; flow-search spends on repeated model
  // tries; agent-market brings in outside content.
};

/** What each part is, in the owner's words, for the card and for a refusal. */
export const interopLabels: Record<InteropPart, string> = {
  "agent-protocol": "Taking work over the Agent Protocol",
  "client-tools": "Tools lent by a connected program",
  modes: "Ways of working (modes)",
  "project-routing": "Choosing the project for a request",
  fleet: "Looking after several assistants at once",
  handoff: "Carrying on a conversation somewhere else",
  "flow-search": "Finding a better flow automatically",
  "agent-market": "Sharing and bringing in whole assistants",
};

/** The tools each part owns, so the catalog can leave them out while the part is off. */
export const interopTools: Record<InteropPart, readonly string[]> = {
  "agent-protocol": [],
  "client-tools": [],
  modes: ["mode.list", "mode.task"],
  "project-routing": ["project.route"],
  fleet: ["fleet.status", "fleet.send", "fleet.stop"],
  handoff: ["conversation.handoff"],
  "flow-search": ["flow.search"],
  "agent-market": ["assistant.market"],
};

export function interopMode(store: Pick<Store, "get">, owner: string, part: InteropPart): InteropMode {
  const found = store.get("settings", owner, interopKey(part));
  if (!found) return interopShipsOn[part] ?? "off";
  const saved = RecordSchema.safeParse(found.data ?? {});
  return saved.success ? saved.data.mode : "off";
}

export function allInteropModes(store: Pick<Store, "get">, owner: string): Record<InteropPart, InteropMode> {
  return Object.fromEntries(interopParts.map((part) => [part, interopMode(store, owner, part)])) as Record<InteropPart, InteropMode>;
}

export function saveInteropMode(store: Store, owner: string, part: InteropPart, input: unknown): InteropMode {
  const { mode } = RecordSchema.parse(input);
  store.save("settings", owner, interopKey(part), { mode });
  return mode;
}

/** Throws the one plain sentence a switched-off part answers with. */
export function requireInterop(store: Pick<Store, "get">, owner: string, part: InteropPart): void {
  if (interopMode(store, owner, part) === "off")
    throw new InteropOffError(`${interopLabels[part]} is switched off. The owner can switch it on in Customize.`);
}

export class InteropOffError extends Error {
  override name = "InteropOffError";
}
