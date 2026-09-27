import { z } from "zod";
import type { Store } from "../store.js";
import { audit } from "../audit.js";
import { lockedDown } from "../lockdown.js";
import { settingsCatalogue, switchPositions, type FieldSpec } from "./catalogue.js";
import { applyWithPins, changesFor, currentValue, holdable, loosens, resetProposals, type Proposal, type Value, type Writer } from "./changes.js";
import { pinnedIds, pinId, pins, savePins, type Pin } from "./pins.js"; // mac7/wake-pins
import { fileMap, lastSave, openFile, saveFile, SlotSchema, undoFile } from "./file-map.js";
import { perFileBytes } from "../context-files.js"; // phase2/accounts
import { presetFor, presets } from "./presets.js";
import { settingsHistory, type ChangeOrigin } from "./history.js";
import { undoSettingsChange, UndoRefused, whySetting } from "./undo.js";
import { exportSettings, maximumSettingsFileBytes, readSettingsFile } from "./transfer.js";
import type { ToolLister } from "../preset-moves.js";

/**
 * R17-S-A: the window's side of understandable settings, under /api/settings-kit. Every route is the
 * owner's alone: a household profile is answered 400, the status every "belongs to the owner" refusal
 * has (src/server.ts answers the owner-only routes the same way before the kit is reached). A short-lived key is
 * refused every change here (none of these routes is on its list in src/short-lived-keys.ts), and the
 * settings file and the owner's own files are on its list of reads it may not make.
 */
export class SettingsKitError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export interface SettingsKitDeps {
  store: Store;
  owner: string;
  workspace: string;
  appVersion: string;
  /** Saves that do more than write the record (see ApplyChoice.writers). */
  writers?: Record<string, Writer> | undefined;
  /** The never-break guard for a file about to be written: why not, or null (src/never-break/protected.ts). */
  guard?: ((target: string) => string | null) | undefined;
  /** The tools Branch has, which a move of the approval preset is weighed on (see changesFor). */
  tools?: ToolLister | undefined;
}

function ownerOnly(deps: SettingsKitDeps, what: string): void {
  try { deps.store.profiles.requireOwner(what); }
  catch (error) { throw new SettingsKitError(400, (error as Error).message); }
}

export const handlesSettingsKitPath = (path: string): boolean => path === "/api/settings-kit" || path.startsWith("/api/settings-kit/");
export const settingsKitBodyBytes = maximumSettingsFileBytes * 2;

const Source = z.discriminatedUnion("source", [
  z.object({ source: z.literal("reset"), key: z.string().max(80).optional() }).strict(),
  z.object({ source: z.literal("preset"), preset: z.string().max(40) }).strict(),
  z.object({ source: z.literal("import"), file: z.string().max(maximumSettingsFileBytes) }).strict(),
  /** One change, from a button such as "Watch me once"; held to the same rules as the rest. */
  z.object({ source: z.literal("set"), key: z.string().max(80), field: z.string().max(80),
    value: z.union([z.string().max(40), z.number(), z.boolean()]) }).strict(),
]);
const Apply = z.object({
  plan: Source,
  accept: z.array(z.string().max(120)).max(500),
  confirmLoosening: z.boolean().default(false),
}).strict();

function proposalsFor(plan: z.infer<typeof Source>): { proposals: Proposal[]; why: string; origin: ChangeOrigin } {
  const window = (source: ChangeOrigin["source"], detail: string): ChangeOrigin => ({ writer: "owner-in-window", source, detail });
  if (plan.source === "reset") {
    if (plan.key && !settingsCatalogue.some((spec) => spec.key === plan.key)) throw new SettingsKitError(404, "There is no such setting to put back.");
    return { proposals: resetProposals(plan.key), why: plan.key ? `put back: ${plan.key}` : "put back: everything", origin: window("reset", plan.key ?? "everything") };
  }
  if (plan.source === "preset") {
    const preset = presetFor(plan.preset);
    if (!preset) throw new SettingsKitError(404, "There is no preset by that name.");
    return { proposals: preset.sets, why: `preset: ${preset.name}`, origin: window("preset", preset.name) };
  }
  if (plan.source === "set")
    return { proposals: [{ key: plan.key, field: plan.field, value: plan.value }], why: "one switch", origin: window("switch", `${plan.key}.${plan.field}`) };
  try { return { proposals: readSettingsFile(plan.file), why: "a settings file", origin: window("import", "a settings file") }; }
  catch (error) { throw new SettingsKitError(400, (error as Error).message); }
}

function overview(deps: SettingsKitDeps) {
  const pinned = pinnedIds(deps.store, deps.store.profiles.ownerName); // mac7/wake-pins
  return {
    settings: settingsCatalogue.map((spec) => ({
      key: spec.key, name: spec.name, t: spec.t, home: spec.home,
      // Q65 review: why this setting cannot be changed from here right now, and whether it can be put back as shipped.
      refused: spec.refuses?.(deps.store, deps.owner) ?? null, canPutBack: !!spec.putBack,
      fields: spec.fields.map((field) => ({ field: field.field, label: field.label, t: field.t, guard: field.guard,
        initial: field.initial, value: currentValue(deps.store, deps.owner, spec, field),
        pinned: pinned.has(pinId(spec.key, field.field)) })),
    })),
    presets: presets.map(({ id, name, t, about, aboutT, sets }) => ({ id, name, t, about, aboutT, count: sets.length })),
    pins: pins(deps.store, deps.store.profiles.ownerName),
  };
}

/**
 * mac7/wake-pins: pinning one setting, or taking the pin off. Only the owner ever reaches this (the
 * whole of this file is theirs), and only a setting the catalogue knows can be pinned, so a pin can
 * never fix something that is not a switch, a choice or a bounded number.
 */
const PinBody = z.object({ key: z.string().max(80), field: z.string().max(80), pinned: z.boolean() }).strict();
function pin(deps: SettingsKitDeps, input: unknown): { pins: Pin[] } {
  const body = PinBody.parse(input);
  const spec = settingsCatalogue.find((entry) => entry.key === body.key);
  const field = spec?.fields.find((entry) => entry.field === body.field);
  if (!spec || !field) throw new SettingsKitError(404, "There is no such setting to pin.");
  const owner = deps.store.profiles.ownerName;
  const rest = pins(deps.store, owner).filter((entry) => pinId(entry.key, entry.field) !== pinId(body.key, body.field));
  const next: Pin[] = body.pinned
    ? [...rest, { key: spec.key, field: field.field, value: currentValue(deps.store, deps.owner, spec, field),
      initial: field.initial, keepsEnabled: spec.keepsEnabled === true, name: spec.name, label: field.label }]
    : rest;
  const saved = savePins(deps.store, owner, next);
  audit(deps.store, deps.owner, { action: "policy.changed", actor: deps.owner,
    subject: `${body.pinned ? "Pinned" : "Unpinned"}: ${spec.name} — ${field.label}`,
    reason: "A pinned setting cannot be changed by anybody else who uses this computer", outcome: "saved" });
  return { pins: saved };
}

function apply(deps: SettingsKitDeps, input: unknown) {
  // Lockdown keeps its own copy of what it took over and writes it back when it ends; a change made
  // underneath it would either loosen it now or be thrown away then.
  if (lockedDown(deps.store, deps.owner)) throw new SettingsKitError(409, "Lockdown is on, so settings cannot be changed from here. Turn it off first.");
  const body = Apply.parse(input);
  const { proposals, why, origin } = proposalsFor(body.plan);
  const { changes, refused } = changesFor(deps.store, deps.owner, proposals, deps.tools);
  let applied, skipped, record;
  try {
    // mac7/wake-pins: one switch moved on purpose may be a pinned one; a preset, a settings file or
    // putting everything back steps over the pinned settings and makes all the rest.
    ({ applied, skipped, record } = applyWithPins(deps.store, deps.owner, changes,
      { accept: body.accept, confirmLoosening: body.confirmLoosening, why, writers: deps.writers,
        pinnedAllowed: body.plan.source === "set", record: origin }));
  } catch (error) { throw new SettingsKitError(409, (error as Error).message); }
  if (body.plan.source === "import" && applied.length)
    audit(deps.store, deps.owner, { action: "data.imported", actor: deps.owner, subject: "settings, from one file",
      reason: `${applied.length} of ${changes.length} proposed changes were made`, outcome: "saved" });
  return { applied, skipped, refused, record: record ?? null, overview: overview(deps) };
}

/** Q48: undo one recorded change. Lockdown refuses it exactly as it refuses any other change here. */
const UndoBody = z.object({ record: z.string().max(80), confirmLoosening: z.boolean().default(false) }).strict();
function undo(deps: SettingsKitDeps, input: unknown) {
  if (lockedDown(deps.store, deps.owner)) throw new SettingsKitError(409, "Lockdown is on, so settings cannot be changed from here. Turn it off first.");
  const body = UndoBody.parse(input);
  try {
    const { applied, record } = undoSettingsChange(deps.store, deps.owner, body.record, { confirmLoosening: body.confirmLoosening, writers: deps.writers, tools: deps.tools });
    return { applied, record, overview: overview(deps) };
  } catch (error) { throw error instanceof UndoRefused ? new SettingsKitError(error.status, error.message) : error; }
}

/** Q48/Q49: the newest change records first, and "why is this on?" for one setting ("/api/settings-kit/why/<key>.<field>"). */
function history(deps: SettingsKitDeps) {
  return { records: settingsHistory(deps.store, deps.owner).slice(-50).reverse() };
}
function why(deps: SettingsKitDeps, setting: string) {
  const answer = whySetting(deps.store, deps.owner, setting);
  if (!answer) throw new SettingsKitError(404, "There is no such setting.");
  return answer;
}

/**
 * Q65 review: the way out for a setting whose saved record cannot be read (voice): the whole record is put
 * back to how Branch ships, because neither the kit nor the setting's own card can change a record they
 * cannot read. The owner's alone, like every route here, and not while Lockdown holds the settings.
 * Q83: it always asks for confirmLoosening, since a record that cannot be read cannot say what it held,
 * unless every field already ships at its most careful value.
 */
const PutBackBody = z.object({ key: z.string().max(80), confirmLoosening: z.boolean().default(false) }).strict();

function putBack(deps: SettingsKitDeps, input: unknown) {
  if (lockedDown(deps.store, deps.owner)) throw new SettingsKitError(409, "Lockdown is on, so settings cannot be changed from here. Turn it off first.");
  const body = PutBackBody.parse(input);
  const spec = settingsCatalogue.find((entry) => entry.key === body.key);
  if (!spec?.putBack) throw new SettingsKitError(404, "That setting has no way to be put back as shipped.");
  // Only a record that cannot be read: a readable one is changed through the kit or its card, where a
  // loosening asks and a pin holds (a stale button in another window must not wipe what the owner just set).
  if (!spec.refuses?.(deps.store, deps.owner)) throw new SettingsKitError(409, `${spec.name} reads as it should, so there is nothing to put back. Change it in its card or with Put settings back.`);
  // Q83 (NAS 1024d5f): put-back is offered only for a record that cannot be read, and such a record cannot be
  // trusted to say what it held, however its keys are spelt or nested. So it always asks, unless every field
  // Branch weighs already ships at its most careful value.
  const loosenings = spec.fields
    .filter((field) => holdable(field).some((value) => loosens(field, value, field.initial as Value, spec)))
    .map((field) => field.label);
  // Q99: put-back replaces the whole record, so a saved value no field above weighs (a spending cap, where
  // speech is turned into words) is named too when it differs from how Branch ships; an unknown key is not.
  const stored = deps.store.get("settings", deps.owner, spec.key)?.data;
  const raw = (typeof stored === "object" && stored !== null && !Array.isArray(stored) ? stored : {}) as Record<string, unknown>;
  const shippedRecord = spec.shipped?.() ?? {};
  const others = Object.keys(raw).filter((key) => !spec.fields.some((field) => field.field.split(".")[0] === key)
    && Object.hasOwn(shippedRecord, key) && JSON.stringify(raw[key]) !== JSON.stringify(shippedRecord[key]));
  if (others.length) loosenings.push(`other saved values Branch cannot weigh: ${others.join(", ")}`);
  if (loosenings.length && !body.confirmLoosening)
    throw new SettingsKitError(409, `${loosenings.length} of these make Branch less careful (${loosenings.join(", ")}). Tick "Yes, make it less careful" to go ahead.`);
  spec.putBack(deps.store, deps.owner);
  audit(deps.store, deps.owner, { action: "policy.changed", actor: deps.owner, subject: `${spec.name}: put back as shipped`,
    reason: "The saved record could not be read, so the whole of it was started again from how Branch ships", outcome: "saved" });
  return { overview: overview(deps) };
}

export async function settingsKitApi(deps: SettingsKitDeps, method: string, path: string, body: () => Promise<unknown>): Promise<unknown> {
  // The switches, the settings file and the text of the owner's own files are the owner's alone.
  ownerOnly(deps, "Settings");
  if (method === "GET" && path === "/api/settings-kit") return overview(deps);
  if (method === "GET" && path === "/api/settings-kit/export") return exportSettings(deps.store, deps.owner, deps.appVersion);
  if (method === "GET" && path === "/api/settings-kit/history") return history(deps);
  const asked = /^\/api\/settings-kit\/why\/([A-Za-z0-9_.:-]{3,160})$/.exec(path);
  if (method === "GET" && asked) return why(deps, asked[1]!);
  if (method === "GET" && path === "/api/settings-kit/files") return { files: fileMap(deps.store, deps.owner, deps.workspace) };
  const slot = /^\/api\/settings-kit\/files\/([a-z][a-z0-9_-]{0,20})$/.exec(path);
  if (method === "GET" && slot) {
    const key = SlotSchema.safeParse(slot[1]);
    if (!key.success) throw new SettingsKitError(404, "There is no such file.");
    // phase2/accounts: whether the last save here can be undone, and the most Branch reads.
    return { ...openFile(deps.store, deps.owner, deps.workspace, key.data), lastSave: lastSave(deps.store, deps.owner, key.data), limit: perFileBytes };
  }
  if (method !== "POST") throw new SettingsKitError(404, "Not found");
  if (path === "/api/settings-kit/preview") {
    const { proposals } = proposalsFor(Source.parse(await body()));
    return changesFor(deps.store, deps.owner, proposals, deps.tools);
  }
  if (path === "/api/settings-kit/apply") return apply(deps, await body());
  if (path === "/api/settings-kit/pins") return pin(deps, await body()); // mac7/wake-pins
  if (path === "/api/settings-kit/undo") return undo(deps, await body()); // Q48
  if (path === "/api/settings-kit/put-back") return putBack(deps, await body()); // Q65 review
  if (path === "/api/settings-kit/files") {
    const input = await body();
    try { return saveFile(deps.store, deps.owner, deps.workspace, input, deps.guard); }
    catch (error) { throw error instanceof z.ZodError ? error : new SettingsKitError(400, (error as Error).message); }
  }
  if (path === "/api/settings-kit/files/undo") { // phase2/accounts: undo of the last save made here
    const input = await body();
    try { return undoFile(deps.store, deps.owner, deps.workspace, input, deps.guard); }
    catch (error) { throw error instanceof z.ZodError ? error : new SettingsKitError(409, (error as Error).message); }
  }
  throw new SettingsKitError(404, "Not found");
}
