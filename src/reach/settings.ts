import { z } from "zod";
import { lockdownOverrides } from "../lockdown.js";
import type { Store } from "../store.js";

/**
 * Bucket R17-I: "reach and platform". Each part has the owner's three-way switch — off, when needed,
 * on — kept in a settings record of its own. What each ships as is `reachShipsOn` below; a saved
 * record that cannot be read is off.
 *
 *   off          the part refuses in one plain sentence; its tools are not in the catalog at all, and
 *                nothing of it runs by itself (no polling, no watching, no connection)
 *   when-needed  it works, and its tools are a line in the index until the work calls for them
 *   on           it works, and its tools are loaded from the first round
 *
 * The mode schema is written out here, as src/asks/settings.ts and src/autonomy/settings.ts do,
 * because feature-switches.ts reads these same records and the two must not import each other.
 */
export const reachParts = [
  "machines", "remote-trunks", "background-screen", "video", "relay", "send", "platform-pause",
  "agent-git", "skill-bundles", "usb", "notes", "arena",
] as const;
export type ReachPart = (typeof reachParts)[number];
export const ReachPartSchema = z.enum(reachParts);

export const ReachModeSchema = z.enum(["off", "when-needed", "on"]);
export type ReachMode = z.infer<typeof ReachModeSchema>;
const RecordSchema = z.object({ mode: ReachModeSchema.default("off") }).strict();

export const reachKey = (part: ReachPart): string => `reach-${part}`;

/**
 * What each part is while nothing has been saved for it. A saved record that is damaged still reads as off.
 * Kept off, by the owner's rule: Trunks on other computers and the relay (each takes messages in from
 * outside, (a)); using apps in the background (it drives any app without the screen-and-keyboard switch,
 * which ships off, (d)); making videos (a paid video service beside the model provider, (b)); sharing
 * the assistant through git (it sends the assistant somewhere new, (c)); and `branch send` (it sends
 * messages into chat apps, and the owner's rule keeps sending off until the owner turns it on).
 */
export const reachShipsOn: Partial<Record<ReachPart, ReachMode>> = {
  // The owner's rule (ships on, 2026-09-26): pausing a chat app is the owner's alone and only quietens Branch; none of (a)–(f).
  "platform-pause": "when-needed",
  // The owner's rule (ships on, 2026-09-26): notes stay in Branch's database, and a rewrite is a suggestion from the configured model; none of (a)–(f).
  notes: "when-needed",
  // Kept off, by the owner's rule (off for spending, sending, outside access, heavy disk): machines reaches other computers; skill-bundles brings in outside content; a plugged USB device starts
  // tasks; arena spends on two model connections at once.
};

/** What each part is, in the owner's words, for the card and for a refusal. */
export const reachLabels: Record<ReachPart, string> = {
  machines: "Other computers running Branch, side by side",
  "remote-trunks": "Trunks on other computers",
  "background-screen": "Using apps in the background",
  video: "Making videos",
  relay: "A relay that holds your chat app accounts",
  send: "Sending a message to a chat from a script",
  "platform-pause": "Pausing a chat app from a chat",
  "agent-git": "Sharing the assistant through git",
  "skill-bundles": "Skill bundles",
  usb: "Starting a task when a USB device is plugged in",
  notes: "Notes with rewriting",
  arena: "Model arena",
};

/** The tools each part owns, so the catalog can leave them out while the part is off. */
export const reachTools: Record<ReachPart, readonly string[]> = {
  machines: ["machines.list", "machines.look"],
  "remote-trunks": ["trunks.remote.roster", "trunks.remote.message"],
  "background-screen": ["screen.background"],
  video: ["video.generate"],
  relay: [],
  send: [],
  "platform-pause": [],
  "agent-git": [],
  "skill-bundles": ["skills.bundle.preview"],
  usb: ["usb.devices"],
  notes: ["notes.list", "notes.rewrite"],
  arena: [],
};

/** For src/feature-switches.ts: each part with tools — its settings record, why it is loaded, and its tools. */
export const reachToolFeatures: readonly (readonly [string, string, readonly string[], ReachMode])[] = reachParts
  .filter((part) => reachTools[part].length > 0)
  .map((part) => [reachKey(part), `${reachLabels[part].charAt(0).toLowerCase()}${reachLabels[part].slice(1)} is switched on`, reachTools[part], reachShipsOn[part] ?? "off"] as const);

/** The mode in use: Lockdown answers "off" for the outward parts, whatever was saved (mac7/lockdown-fix). */
export function reachMode(store: Pick<Store, "get">, owner: string, part: ReachPart): ReachMode {
  return lockdownOverrides(store, owner, reachKey(part)) ? "off" : savedReachMode(store, owner, part);
}

/** The mode as the owner saved it, for putting tools in the catalog: Lockdown refuses at use instead. */
export function savedReachMode(store: Pick<Store, "get">, owner: string, part: ReachPart): ReachMode {
  const found = store.get("settings", owner, reachKey(part));
  if (!found) return reachShipsOn[part] ?? "off";
  const saved = RecordSchema.safeParse(found.data ?? {});
  return saved.success ? saved.data.mode : "off";
}

export function allReachModes(store: Pick<Store, "get">, owner: string): Record<ReachPart, ReachMode> {
  return Object.fromEntries(reachParts.map((part) => [part, reachMode(store, owner, part)])) as Record<ReachPart, ReachMode>;
}

export function saveReachMode(store: Store, owner: string, part: ReachPart, input: unknown): ReachMode {
  const { mode } = RecordSchema.parse(input);
  store.save("settings", owner, reachKey(part), { mode });
  return mode;
}

export class ReachOffError extends Error {
  override name = "ReachOffError";
}

export const reachOffSentence = (part: ReachPart): string =>
  `${reachLabels[part]} is switched off. The owner can switch it on in Branch, under Settings.`;

/** Throws the one plain sentence a switched-off part answers with. */
export function requireReach(store: Pick<Store, "get">, owner: string, part: ReachPart): void {
  if (reachMode(store, owner, part) === "off") throw new ReachOffError(reachOffSentence(part));
}

/** A settings record of this bucket, parsed, or the schema's defaults when it is missing or broken. */
export function reachRecord<T extends z.ZodType>(store: Pick<Store, "get">, owner: string, key: string, schema: T): z.infer<T> {
  const saved = schema.safeParse(store.get("settings", owner, key)?.data ?? {});
  return saved.success ? saved.data : schema.parse({});
}

/** One line of untrusted text made safe to quote inside a prompt: no line breaks, spaces squeezed, capped. */
export function quoteLine(text: string, max = 300): string {
  return text.replace(/[\r\n\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}
