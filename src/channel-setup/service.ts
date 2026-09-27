import { FeatureModeSchema, type FeatureMode } from "../feature-switches.js";
import { encodeQr, maximumQrBytes } from "../remote/qr.js";
import { saveParitySwitches } from "../channels/parity-switch.js";
import { parityKinds } from "../channels/parity-config.js";
import type { Store } from "../store.js";
import { readValues, runCheck, scrub, SetupRefusal, type Values } from "./check.js";
import { createLink, recipeBook, recipeFor, recipes, type Recipe } from "./recipes.js";

/**
 * "Set up a chat app": the switch, what the Set up panel shows, and checking and saving what the
 * owner pasted. The panel can always be looked at; saving a token or switching a channel on needs
 * the switch (it ships off) and the owner. The token goes into the locker and nowhere else.
 */
const settingsKey = "channel-setup";
const doneKey = "channel-setup-done";

export function setupMode(store: Pick<Store, "get">, owner: string): FeatureMode {
  const parsed = FeatureModeSchema.safeParse(store.get("settings", owner, settingsKey)?.data.mode);
  return parsed.success ? parsed.data : "off";
}
export function saveSetupMode(store: Pick<Store, "save">, owner: string, input: unknown): FeatureMode {
  const parsed = FeatureModeSchema.safeParse((input as { mode?: unknown } | null)?.mode);
  if (!parsed.success) throw new SetupRefusal(400, "Choose off, when needed or on.");
  store.save("settings", owner, settingsKey, { mode: parsed.data, changedAt: new Date().toISOString() });
  return parsed.data;
}

export interface QrRows { size: number; rows: string[] }
/** A square code drawn here, or null when the link is too long for one (Slack's filled-in page). */
export function qrFor(link: string | null | undefined): QrRows | null {
  if (!link || new TextEncoder().encode(link).length > maximumQrBytes) return null;
  const matrix = encodeQr(link);
  return { size: matrix.size, rows: matrix.modules.map((row) => row.map((dark) => (dark ? "1" : "0")).join("")) };
}

/** A filled-in link too long for a square code falls back to the same page unfilled (Slack). */
function plainLink(recipe: Recipe): string | null {
  const url = recipe.create?.url ?? "";
  return url.includes("{{manifest}}") ? url.replace(/[?&]manifest_json=\{\{manifest\}\}/, "") : null;
}

/** The one command, as typed in each kind of terminal. It is the same everywhere `branch` exists. */
export function commandFor(id: string): { posix: string; windows: string } {
  return { posix: `branch connect ${id}`, windows: `branch connect ${id}` };
}

export function setupList(store: Pick<Store, "get">, owner: string): Record<string, unknown> {
  const book = recipeBook();
  return { mode: setupMode(store, owner), checked: book.checked, count: book.recipes.length,
    channels: book.recipes.map((recipe) => ({ id: recipe.id, name: recipe.name, family: recipe.family, ...(recipe.what ? { what: recipe.what } : {}) })) };
}

/** Everything the Set up panel shows for one app. Nothing here is secret. */
export function setupPanel(store: Pick<Store, "get">, owner: string, id: string): Record<string, unknown> {
  const recipe = recipeFor(id);
  if (!recipe) throw new SetupRefusal(404, "There is no chat app by that name.");
  const create = createLink(recipe);
  const done = (store.get("settings", owner, doneKey)?.data ?? {}) as Record<string, unknown>;
  return {
    id: recipe.id, name: recipe.name, family: recipe.family, turnOn: recipe.turnOn, mode: setupMode(store, owner),
    command: commandFor(recipe.id), app: recipe.app ?? null, noApp: recipe.noApp ?? null, stores: recipe.stores ?? {},
    create: recipe.create ? { url: create, how: recipe.create.how, prefilled: recipe.create.prefilled, needsServer: create === null,
      template: create === null ? recipe.create.url : null } : null,
    noCreate: recipe.noCreate ?? null, steps: recipe.steps ?? [],
    codes: { ios: qrFor(recipe.stores?.ios), android: qrFor(recipe.stores?.android), create: qrFor(create) ?? qrFor(plainLink(recipe)) },
    fields: recipe.fields, paste: recipe.paste.map(({ secret, what, optional }) => ({ secret, what, optional: optional === true })),
    hasCheck: Boolean(recipe.check), noCheck: recipe.noCheck ?? null, pairing: recipe.pairing ?? null,
    saved: done[recipe.id] ?? null, sources: recipe.sources,
  };
}

export interface SetupHost {
  store: Store;
  owner: string;
  /** Already behind the network settings. */
  fetch: typeof fetch;
  /** The Telegram card from never-break: its save, and connecting the bot right away. */
  telegram?: { save: (input: unknown) => Promise<void>; connect?: () => Promise<string | null> };
}
export interface SaveInput { values: Record<string, unknown>; enable?: FeatureMode | undefined }

/** The connections-file line, with the owner's plain settings put in. */
export function entryLine(recipe: Recipe, values: Values): string | null {
  if (!recipe.entry) return null;
  return JSON.stringify(recipe.entry)
    .replace(/"\{\{(groupId|agentId|conversation)\}\}"/g, (whole, name: string) => (/^\d{1,15}$/.test(values[name] ?? "") ? values[name]! : whole))
    .replace(/\{\{([a-z][A-Za-z]*)\}\}/g, (_whole, name: string) => (values[name] ?? "…").replace(/["\\]/g, ""));
}

async function switchOn(host: SetupHost, recipe: Recipe, values: Values, enable: FeatureMode | undefined): Promise<string | null> {
  if (recipe.turnOn === "guided") {
    await host.telegram?.save({ token: values.TELEGRAM_BOT_TOKEN, ...(enable ? { mode: enable } : {}) });
    return enable && enable !== "off" && host.telegram?.connect ? host.telegram.connect() : null;
  }
  if (recipe.turnOn === "switch" && enable) saveParitySwitches(host.store, host.owner, { [recipe.id]: enable }, parityKinds());
  return null;
}

/** Checks what was pasted, keeps it in the locker, and switches the channel on only when asked. */
export async function saveSetup(host: SetupHost, id: string, input: SaveInput): Promise<Record<string, unknown>> {
  if (setupMode(host.store, host.owner) === "off")
    throw new SetupRefusal(409, "Setting up chat apps from here is switched off. Turn it on under Customize, Chat apps.");
  const recipe = recipeFor(id);
  if (!recipe) throw new SetupRefusal(404, "There is no chat app by that name.");
  if (recipe.turnOn === "guided" && !host.telegram) throw new SetupRefusal(503, "The Telegram card is not available in this launch.");
  const values = readValues(recipe, input.values);
  const checked = await runCheck(recipe, values, host.fetch);
  if (checked.ok === false) throw new SetupRefusal(422, checked.reason);
  const secrets = Object.keys(values).filter((name) => /^[A-Z]/.test(name));
  for (const name of secrets)
    if (recipe.turnOn !== "guided") await host.store.secrets.put(host.owner, "default", name, values[name]!, { expiresInDays: 0 });
  let connectNote: string | null;
  // Whatever a save or connect throws is said without what was pasted (a Telegram address carries the token).
  try { connectNote = await switchOn(host, recipe, values, input.enable); }
  catch (error) { throw new SetupRefusal(500, scrub(`Saving or switching on failed: ${error instanceof Error ? error.message : String(error)}`, values)); }
  const record = { savedAt: new Date().toISOString(), checked: checked.ok, switched: input.enable ?? null };
  host.store.save("settings", host.owner, doneKey, { ...(host.store.get("settings", host.owner, doneKey)?.data ?? {}), [recipe.id]: record });
  return {
    id: recipe.id, saved: secrets, checked: checked.ok, botName: checked.ok ? checked.name : null,
    checkNote: checked.ok === null ? checked.reason : null, switched: input.enable ?? null,
    connectNote: connectNote ? scrub(connectNote, values) : null,
    entry: recipe.turnOn === "guided" ? null : entryLine(recipe, values), pairing: recipe.pairing ?? null,
  };
}

/** Every recipe id, for the command's help. */
export const setupIds = (): string[] => recipes().map((recipe) => recipe.id);
