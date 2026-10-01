import { z } from "zod";
import type { Store } from "../store.js";
import { chosenFields, markChosen } from "../ship-on.js";

/**
 * Bucket 15: add-ons other people wrote. Each part has the owner's three-way switch — off, when
 * needed, on. What each ships as is `addOnShipsOn` (the owner's ship-on rule, src/ship-on.ts); nothing here installs
 * or runs by itself either way.
 *
 *   off          the part refuses in one plain sentence; its tools are not in the catalog at all
 *   when-needed  it works, and its tools are a line in the index until the work calls for them
 *   on           it works, and its tools are loaded from the first round
 *
 * One more choice sits beside the switches: whether plugin files the owner put in the plugins
 * folder by hand also run in their own walled program. RES-251: it ships on, so no plugin runs inside
 * Branch unless the owner chose that for the plugins they placed themselves (and said yes to it being
 * less careful); add-ons installed from a package or a list always run walled, whatever this says.
 */
export const addOnParts = ["packages", "lists", "filters", "pipelines", "drafts", "search", "export"] as const;
export type AddOnPart = (typeof addOnParts)[number];
export const AddOnPartSchema = z.enum(addOnParts);
const ModeSchema = z.enum(["off", "when-needed", "on"]);
export type AddOnMode = z.infer<typeof ModeSchema>;

export const AddOnSettingsSchema = z.object({
  modes: z.object(Object.fromEntries(addOnParts.map((part) => [part, ModeSchema.default("off")])) as Record<AddOnPart, z.ZodDefault<typeof ModeSchema>>).strict().prefault({}),
  /** Also run hand-placed plugin files in their own walled program (RES-251: ships on, `pluginsShipWalled`). */
  wallEveryPlugin: z.boolean().default(false),
  /** Windows only: run add-on code as its own program even though Windows has no file and network wall. */
  windowsWithoutWall: z.boolean().default(false),
  /**
   * RES-251: hand-placed plugins the owner lets run inside Branch, one by one (a model connection or a chat service
   * lives only there). Adding one is less careful: the owner's yes, never under Lockdown (`AddOns.setInside`).
   */
  insideBranch: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,39}$/)).max(50).default([]),
  /** RES-251: those already switched on when the wall started shipping on, kept running as before until the owner walls them. */
  grandfathered: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,39}$/)).max(50).default([]),
}).strict();
export type AddOnSettings = z.infer<typeof AddOnSettingsSchema>;

export const addOnSettingsKey = "add-ons";
/** RES-251: a hand-placed plugin runs in its own program unless the owner chose otherwise. */
export const pluginsShipWalled = true;

/** What each part is, in the owner's words, for the card and for a refusal. */
export const addOnLabels: Record<AddOnPart, string> = {
  packages: "Installing add-on packages (Branch, Claude Code, Codex and Gemini CLI formats)",
  lists: "Add-on lists you name",
  filters: "Your own filters on what goes in and out",
  pipelines: "Reading a Pipelines server",
  drafts: "Letting the assistant draft an add-on for you to review",
  search: "Search sources that plugins bring",
  export: "Branch as a plugin for Claude Code and Codex",
};

/** The tools each part owns, so the catalog can leave them out while the part is off. */
export const addOnTools: Partial<Record<AddOnPart, readonly string[]>> = {
  drafts: ["addon.draft"],
  search: ["addon.search"],
};

/**
 * The owner's rule (ships on, 2026-09-26): lists and a Pipelines server are read only from where the owner names, filters
 * can only make things stricter, a draft waits for the owner's review, search reads only sources the owner's plugins
 * bring, and export writes a folder the owner adds elsewhere; none of (a)–(f). Packages stay off: installing one looks
 * its servers up in a public database and runs code other people wrote (b, f).
 */
export const addOnShipsOn: Partial<Record<AddOnPart, AddOnMode>> = {
  lists: "when-needed", filters: "when-needed", pipelines: "when-needed", drafts: "when-needed", search: "when-needed", export: "when-needed",
};

type Reader = Pick<Store, "get">;
export function addOnSettings(store: Reader, owner: string): AddOnSettings {
  const parsed = AddOnSettingsSchema.safeParse(store.get("settings", owner, addOnSettingsKey)?.data ?? {});
  if (!parsed.success) return AddOnSettingsSchema.parse({});
  // Every part is written each time one is saved, so only a part the owner set keeps a saved "off" (src/ship-on.ts).
  const chosen = new Set(chosenFields(store, owner, addOnSettingsKey));
  const modes = { ...parsed.data.modes };
  for (const [part, mode] of Object.entries(addOnShipsOn) as [AddOnPart, AddOnMode][]) if (!chosen.has(`modes.${part}`)) modes[part] = mode;
  return { ...parsed.data, modes, wallEveryPlugin: chosen.has("wallEveryPlugin") ? parsed.data.wallEveryPlugin : pluginsShipWalled };
}

export function addOnMode(store: Reader, owner: string, part: AddOnPart): AddOnMode {
  return addOnSettings(store, owner).modes[part];
}

/** Saves a change: only the modes that were sent move, and the rest keep what they had. */
export function saveAddOnSettings(store: Pick<Store, "get" | "save">, owner: string, input: unknown): AddOnSettings {
  const change = z.object({
    modes: z.object(Object.fromEntries(addOnParts.map((part) => [part, ModeSchema.optional()]))).strict().optional(),
    wallEveryPlugin: z.boolean().optional(),
    windowsWithoutWall: z.boolean().optional(),
  }).strict().parse(input ?? {});
  const current = addOnSettings(store, owner);
  const sent = Object.fromEntries(Object.entries(change.modes ?? {}).filter(([, mode]) => mode !== undefined));
  const next = AddOnSettingsSchema.parse({
    ...current,
    modes: { ...current.modes, ...sent },
    wallEveryPlugin: change.wallEveryPlugin ?? current.wallEveryPlugin,
    windowsWithoutWall: change.windowsWithoutWall ?? current.windowsWithoutWall,
  });
  store.save("settings", owner, addOnSettingsKey, next);
  markChosen(store, owner, addOnSettingsKey, [...Object.keys(sent).map((part) => `modes.${part}`), ...(change.wallEveryPlugin === undefined ? [] : ["wallEveryPlugin"])]);
  return next;
}

/** RES-251: what a change would make less careful, in words, or null when it only tightens. */
export function addOnLooser(before: AddOnSettings, input: unknown): string | null {
  const change = (input && typeof input === "object" ? input : {}) as { wallEveryPlugin?: unknown; windowsWithoutWall?: unknown };
  const found: string[] = [];
  if (change.wallEveryPlugin === false && before.wallEveryPlugin)
    found.push("plugins you placed yourself would run inside Branch, with its reach over this computer");
  if (change.windowsWithoutWall === true && !before.windowsWithoutWall)
    found.push("add-on code other people wrote would run on Windows with no wall around your files and the internet");
  return found.length ? found.join("; ") : null;
}

export const partOffSentence = (part: AddOnPart): string =>
  `"${addOnLabels[part]}" is switched off. Switch it on in Customize, Plugins, to use it.`;

/** Throws the plain sentence when a part is off. */
export function requirePart(store: Reader, owner: string, part: AddOnPart): void {
  if (addOnMode(store, owner, part) === "off") throw new Error(partOffSentence(part));
}
