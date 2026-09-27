import { z } from "zod";
import type { Store } from "./store.js";
import { addOnLabels, addOnMode, addOnTools, type AddOnPart } from "./add-ons/settings.js"; // bucket-15
import { askToolFeatures } from "./asks/settings.js"; // mac6/bucket-23
import { interopShipsOn, type InteropPart } from "./interop/settings.js"; // ships-on sweep
import { lockdownOverrides } from "./lockdown.js"; // mac7/lockdown-fix
import { deviceTools } from "./devices/capabilities.js"; // mac7/nodes
import { autonomyToolFeatures } from "./autonomy/settings.js"; // r17-b
import { trunkToolFeatures } from "./trunks/settings.js"; // R17-A
import { codingToolFeatures } from "./coding/settings.js"; // mac7/r17-d
import { personalToolFeatures } from "./personal/settings.js"; // R17-C
import { reachToolFeatures } from "./reach/settings.js"; // r17-i
import { safetyToolFeatures } from "./safety-extras/settings.js"; // mac7/r17-g
import { boardToolFeatures } from "./flows-boards/settings.js"; // r17-h
import { learningToolFeatures } from "./learning-more/settings.js"; // R17-F
import { learnToolFeatures } from "./learn/settings.js"; // mac7/learn

/**
 * The owner's three-way switch for a feature: off, when needed, or on. Each ships as its own
 * settings file says (most off; the owner's rule of 2026-09-26 ships the harmless ones "when needed").
 *
 *   off          the feature refuses in one plain sentence, and its tools are not advertised
 *   when-needed  the feature works, and its tools stay a line in the index (or a search away),
 *                loaded only when the work calls for them — the ordinary tiering in tool-loading.ts
 *   on           the feature works, and its tools are loaded from the first round
 *
 * Older saves only had a yes/no switch. A saved "yes" meant the tools were tiered like any other,
 * which is what "when needed" is now, so that is what it becomes.
 */
export const featureModes = ["off", "when-needed", "on"] as const;
export type FeatureMode = (typeof featureModes)[number];
export const FeatureModeSchema = z.enum(featureModes);

export interface Switched { enabled: boolean; mode: FeatureMode }

/** The mode a saved record stands for, whether it was written before or after the three-way switch. */
export function modeOf(saved: { enabled?: boolean | undefined; mode?: FeatureMode | undefined }): FeatureMode {
  return saved.mode ?? (saved.enabled ? "when-needed" : "off");
}

/**
 * The switch after a change. A mode wins. A bare yes/no (the older tick box) turns the feature off,
 * or back on in the mode it had, "when needed" if it had none.
 */
export function settleSwitch(current: { enabled?: boolean | undefined; mode?: FeatureMode | undefined }, input: { enabled?: boolean | undefined; mode?: FeatureMode | undefined }): Switched {
  const was = modeOf(current);
  let mode: FeatureMode = was;
  if (input.mode) mode = input.mode;
  else if (input.enabled === false) mode = "off";
  else if (input.enabled === true) mode = was === "off" ? "when-needed" : was;
  return { mode, enabled: mode !== "off" };
}

/**
 * Only the fields a caller really sent. A zod `.partial()` still fills in each field's default, so
 * without this, saving one limit would quietly switch the feature off.
 */
export function sentFields<T extends object>(parsed: T, input: unknown): Partial<T> {
  const sent = input && typeof input === "object" ? Object.keys(input) : [];
  return Object.fromEntries(Object.entries(parsed).filter(([key]) => sent.includes(key))) as Partial<T>;
}

/**
 * The same object with every field optional and no defaults, for a form or tool that sends only
 * what changed. Unlike `.partial()`, which in zod 4 still fills each missing field with its default,
 * a field that was not sent stays missing, so merging over the saved settings keeps it.
 */
export function optionalFields<T extends z.ZodRawShape>(schema: z.ZodObject<T>) {
  const shape = Object.fromEntries(Object.entries(schema.shape).map(([key, field]) =>
    [key, (field instanceof z.ZodDefault ? field.unwrap() as z.ZodType : field as z.ZodType).optional()]));
  return z.object(shape as unknown as { [K in keyof T]: z.ZodOptional<T[K] extends z.ZodDefault<infer I> ? I : T[K]> }).strict();
}

/* ---------- which tools each switched feature owns ---------- */

/** The screen and keyboard tools (src/integrations/desktop-tools.ts). */
export const screenTools = ["desktop.screenshot", "desktop.windows", "desktop.read", "desktop.click",
  "desktop.type", "desktop.key", "desktop.open", "desktop.clipboard"] as const;
/** The shared Linux desktop tools (src/integrations/linux-desktop-tools.ts). */
export const sharedDesktopTools = ["desktop.shared.start", "desktop.shared.open", "desktop.shared.type", "desktop.shared.key", "desktop.shared.stop"] as const;
/** Reading aloud with the computer's own voice (src/voice-service.ts). */
export const systemVoiceTools = ["voice.say"] as const;
/** mac7/vault-autofill (R17-068): typing a saved sign-in into a page (src/vault-autofill.ts). */
export const signInFillTools = ["signin.fill"] as const;
/** Bucket 21: the app-builder tools (src/sdk-kit.ts registers them). */
export const sdkKitToolNames = ["sdk.routes", "sdk.route", "sdk.starter"] as const;
/** Bucket 17: watching and saving videos with the owner's own ffmpeg and yt-dlp (src/media-understand.ts). */
export const videoProgramTools = ["media.watch", "media.frames", "media.convert", "media.download", "media.captions"] as const;
/** w911 (A2144): page notes, the owner pointing at one thing on a page (src/integrations/browser-notes-tool.ts). */
export const pageNotesTools = ["browser.notes"] as const;

type Reader = Pick<Store, "get">;
/** mac4/bucket-20: each interop part with tools — its settings record, why it is loaded, and its tools. */
const shipped = (part: InteropPart): FeatureMode => interopShipsOn[part] ?? "off";
export const interopToolFeatures: readonly (readonly [string, string, readonly string[], FeatureMode])[] = [
  ["interop-modes", "ways of working are switched on", ["mode.list", "mode.task"], shipped("modes")],
  ["interop-project-routing", "choosing the project for a request is switched on", ["project.route"], shipped("project-routing")],
  ["interop-fleet", "looking after several assistants is switched on", ["fleet.status", "fleet.send", "fleet.stop"], shipped("fleet")],
  ["interop-handoff", "handing a conversation on is switched on", ["conversation.handoff"], shipped("handoff")],
  ["interop-flow-search", "finding a better flow is switched on", ["flow.search"], shipped("flow-search")],
  ["interop-agent-market", "sharing assistants is switched on", ["assistant.market"], shipped("agent-market")],
];
/** `ships` is what a feature is while nothing was ever saved for it; a saved record it cannot read is off. */
const savedMode = (store: Reader, owner: string, key: string, field: "mode" | "systemVoice" = "mode", ships: FeatureMode = "off"): FeatureMode => {
  if (lockdownOverrides(store, owner, key)) return "off"; // mac7/lockdown-fix: Lockdown wins over a saved mode
  const found = store.get("settings", owner, key);
  if (!found) return ships;
  const data = (found.data ?? {}) as Record<string, unknown>;
  const mode = FeatureModeSchema.safeParse(data[field]);
  if (mode.success) return mode.data;
  return field === "mode" && data.enabled === true ? "when-needed" : "off";
};

/**
 * Each switched feature that has tools, and where its mode is kept. `voice.say` also reads aloud
 * with a provider's voice, so the system voice being off refuses that one route rather than hiding
 * the tool; the refusal lives in the voice service.
 */
const toolFeatures: { reason: string; tools: readonly string[]; hideWhenOff: boolean; mode: (store: Reader, owner: string) => FeatureMode }[] = [
  { reason: "your screen and keyboard are switched on", tools: screenTools, hideWhenOff: true, mode: (s, o) => savedMode(s, o, "desktop-control") },
  { reason: "a shared Linux desktop is switched on", tools: sharedDesktopTools, hideWhenOff: true, mode: (s, o) => savedMode(s, o, "linux-desktop") },
  { reason: "your computer's own voice is switched on", tools: systemVoiceTools, hideWhenOff: false, mode: (s, o) => savedMode(s, o, "voice", "systemVoice") },
  // Bucket 17 hook.
  { reason: "watching and saving videos is switched on", tools: videoProgramTools, hideWhenOff: true, mode: (s, o) => savedMode(s, o, "media-programs") },
  // w911 (A0374) hook: fixing a failed command (src/troubleshoot.ts; the name is written here to avoid an import loop).
  { reason: "fixing failed commands is switched on", tools: ["troubleshoot.run"], hideWhenOff: true, mode: (s, o) => savedMode(s, o, "troubleshoot") },
  // Optional JEV judgments send the bounded state to the provider the owner configured in JEV.
  { reason: "JEV decision support is switched on", tools: ["decisions.judge"], hideWhenOff: true, mode: (s, o) => savedMode(s, o, "jev-decisions") },
  // w911 (A2144) hook: page notes.
  { reason: "page notes are switched on", tools: pageNotesTools, hideWhenOff: true, mode: (s, o) => savedMode(s, o, "page-notes") },
  // ── mac4/bucket-20: talking to other agents and tools (src/interop/settings.ts keeps these lists). ──
  ...interopToolFeatures.map(([key, reason, tools, ships]) => ({ reason, tools, hideWhenOff: true, mode: (s: Reader, o: string) => savedMode(s, o, key, "mode", ships) })),
  // ── mac6/bucket-23: the smaller asks (src/asks/settings.ts keeps these lists). ──
  ...askToolFeatures.map(([key, reason, tools, ships]) => ({ reason, tools, hideWhenOff: true, mode: (s: Reader, o: string) => savedMode(s, o, key, "mode", ships) })),
  // mac7/nodes: the owner's other devices (src/devices/); the mode is kept in the devices record.
  { reason: "using your other devices is switched on", tools: deviceTools, hideWhenOff: true, mode: (s, o) => savedMode(s, o, "devices-book") },
  // ── r17-b: suggestions, standing orders, procedures, readiness, instructions (src/autonomy/settings.ts keeps these lists). ──
  ...autonomyToolFeatures.map(([key, reason, tools, ships]) => ({ reason, tools, hideWhenOff: true, mode: (s: Reader, o: string) => savedMode(s, o, key, "mode", ships) })),
  // ── R17-A: Trunks (src/trunks/settings.ts keeps these lists). ──
  ...trunkToolFeatures.map(([key, reason, tools, ships]) => ({ reason, tools, hideWhenOff: true, mode: (s: Reader, o: string) => savedMode(s, o, key, "mode", ships) })),
  // ── mac7/r17-d: coding polish (src/coding/settings.ts keeps these lists). ──
  ...codingToolFeatures.map(([key, reason, tools, ships]) => ({ reason, tools, hideWhenOff: true, mode: (s: Reader, o: string) => savedMode(s, o, key, "mode", ships) })),
  // ── R17-C: files, voice, devices and personal connectors (src/personal/settings.ts keeps these lists). ──
  ...personalToolFeatures.map(([key, reason, tools, ships]) => ({ reason, tools, hideWhenOff: true, mode: (s: Reader, o: string) => savedMode(s, o, key, "mode", ships) })),
  // ── r17-i: reach and platform (src/reach/settings.ts keeps these lists). ──
  ...reachToolFeatures.map(([key, reason, tools, ships]) => ({ reason, tools, hideWhenOff: true, mode: (s: Reader, o: string) => savedMode(s, o, key, "mode", ships) })),
  // ── mac7/r17-g: the safety extras (src/safety-extras/settings.ts keeps these lists). ──
  ...safetyToolFeatures.map(([key, reason, tools]) => ({ reason, tools, hideWhenOff: true, mode: (s: Reader, o: string) => savedMode(s, o, key) })),
  // ── r17-h: flows and boards (src/flows-boards/settings.ts keeps these lists). ──
  ...boardToolFeatures.map(([key, reason, tools]) => ({ reason, tools, hideWhenOff: true, mode: (s: Reader, o: string) => savedMode(s, o, key) })),
  // ── R17-F: learning, deeper (src/learning-more/settings.ts keeps these lists). ──
  ...learningToolFeatures.map(([key, reason, tools]) => ({ reason, tools, hideWhenOff: true, mode: (s: Reader, o: string) => savedMode(s, o, key) })),
  // ── mac7/learn: understanding something -- the map and the tour (src/learn/settings.ts). ──
  ...learnToolFeatures.map(([key, reason, tools]) => ({ reason, tools, hideWhenOff: true, mode: (s: Reader, o: string) => savedMode(s, o, key) })),
  // mac7/vault-autofill (R17-068): filling a saved sign-in (src/vault-autofill.ts). Written out here
  // rather than imported, because that module reads this one for the three-way switch.
  { reason: "filling a saved sign-in is switched on", tools: signInFillTools, hideWhenOff: true, mode: (s, o) => savedMode(s, o, "vault-autofill") },
  // Bucket 21 hook: tools for people building on Branch (src/sdk-kit.ts).
  { reason: "tools for people building on Branch are switched on", tools: sdkKitToolNames, hideWhenOff: true, mode: (s, o) => savedMode(s, o, "sdk-kit") },
  // ── bucket-15: add-ons other people wrote (src/add-ons/settings.ts keeps these lists). ──
  ...(Object.entries(addOnTools) as [AddOnPart, readonly string[]][]).map(([part, tools]) => ({
    reason: `${addOnLabels[part]} is switched on`, tools, hideWhenOff: true, mode: (s: Reader, o: string) => addOnMode(s, o, part) })),
  // w911 (A0743, A1452) hook: reading whole web pages and following their links (src/web-pages.ts).
  { reason: "reading and crawling web pages is switched on", tools: ["web.page", "web.crawl"], hideWhenOff: true, mode: (s, o) => savedMode(s, o, "web-pages") },
];

/**
 * What the switches mean for one task's tool list: the tools to load from the start ("on"), and the
 * ones not to advertise ("off"). "When needed" adds nothing, because that is the ordinary tiering.
 */
export function switchedToolTiers(store: Reader, owner: string, available: readonly string[]): {
  preload: { name: string; reason: string }[]; hidden: string[];
} {
  const present = new Set(available);
  const preload: { name: string; reason: string }[] = [];
  const hidden: string[] = [];
  for (const feature of toolFeatures) {
    const mode = feature.mode(store, owner);
    const tools = feature.tools.filter((name) => present.has(name));
    if (mode === "on") preload.push(...tools.map((name) => ({ name, reason: feature.reason })));
    if (mode === "off" && feature.hideWhenOff) hidden.push(...tools);
  }
  return { preload, hidden };
}
