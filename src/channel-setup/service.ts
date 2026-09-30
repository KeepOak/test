import { FeatureModeSchema, type FeatureMode } from "../feature-switches.js";
import { encodeQr, maximumQrBytes } from "../remote/qr.js";
import { saveParitySwitches } from "../channels/parity-switch.js";
import { parityKinds } from "../channels/parity-config.js";
import type { Store } from "../store.js";
import { followUpCheck, readValues, runCheck, scrub, SetupRefusal, type Values } from "./check.js";
import { createLink, recipeBook, recipeFor, recipes, type Recipe } from "./recipes.js";
import { entryFor, rememberEntry, savedEntries, type LiveOutcome } from "./live.js";

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

/** Why this engine cannot connect the app at all (iMessage lives in a Mac's Messages), or null. */
export function unavailableOn(id: string, platform: NodeJS.Platform): string | null {
  return id === "imessage" && platform !== "darwin"
    ? "iMessage requires Branch running on a Mac signed in to Messages, with Full Disk Access and Automation permission. Set it up on that Mac; this Windows or Linux engine cannot connect it."
    : null;
}

export function setupList(store: Pick<Store, "get">, owner: string, platform = process.platform): Record<string, unknown> {
  const book = recipeBook();
  return { mode: setupMode(store, owner), checked: book.checked, count: book.recipes.length,
    channels: book.recipes.map((recipe) => ({ id: recipe.id, name: recipe.name, family: recipe.family, ...(recipe.what ? { what: recipe.what } : {}),
      ...(unavailableOn(recipe.id, platform) ? { needsMac: true } : {}) })) };
}

/** Everything the Set up panel shows for one app. Nothing here is secret. */
export function setupPanel(store: Pick<Store, "get">, owner: string, id: string, platform = process.platform): Record<string, unknown> {
  const recipe = recipeFor(id);
  if (!recipe) throw new SetupRefusal(404, "There is no chat app by that name.");
  const create = createLink(recipe);
  const done = (store.get("settings", owner, doneKey)?.data ?? {}) as Record<string, unknown>;
  return {
    unavailableReason: unavailableOn(id, platform),
    prerequisites: recipe.app ? `Sign in to ${recipe.app.name} and complete the account or administrator steps below first. Installation and provider setup determine how long this takes.`
      : "Complete the provider or bridge prerequisites below before checking the connection. Setup time depends on those external steps.",
    id: recipe.id, name: recipe.name, family: recipe.family, turnOn: recipe.turnOn, mode: setupMode(store, owner),
    command: commandFor(recipe.id), app: recipe.app ?? null, noApp: recipe.noApp ?? null, stores: recipe.stores ?? {},
    create: recipe.create ? { url: create, how: recipe.create.how, prefilled: recipe.create.prefilled, needsServer: create === null,
      template: create === null ? recipe.create.url : null } : null,
    noCreate: recipe.noCreate ?? null, steps: recipe.steps ?? [],
    codes: { ios: qrFor(recipe.stores?.ios), android: qrFor(recipe.stores?.android), create: qrFor(create) ?? qrFor(plainLink(recipe)) },
    fields: recipe.fields, paste: recipe.paste.map(({ secret, what, optional }) => ({ secret, what, optional: optional === true })),
    hasCheck: Boolean(recipe.check), noCheck: recipe.noCheck ?? null, pairing: recipe.pairing ?? null,
    saved: done[recipe.id] ?? null, setUpHere: savedEntries(store, owner)[recipe.id] !== undefined, sources: recipe.sources,
  };
}

export interface SetupHost {
  store: Store;
  owner: string;
  /** Already behind the network settings. */
  fetch: typeof fetch;
  /** Internal platform seam for isolated platform tests; never supplied by an HTTP request. */
  platform?: NodeJS.Platform;
  /** The Telegram card from never-break: its save, and connecting the bot right away. */
  telegram?: {
    save: (input: unknown) => Promise<void>;
    /** `background`: answer once all but reaching Telegram is done (see connectGuidedTelegram). */
    connect?: (options?: { background?: boolean }) => Promise<string | null>;
    /** Test-only stand-in for https://api.telegram.org, set in code by createBranch and never from a request. */
    apiBase?: string | undefined;
  };
  /**
   * Every other app: connecting a saved entry to the running Branch now (src/channel-setup/live.ts). Absent when
   * Branch is not running (`branch connect` with no window open), and the app then connects when Branch next starts.
   */
  live?: {
    connect: (recipe: Recipe, entry: Record<string, unknown>, values: Values) => Promise<LiveOutcome>;
    disconnect: (id: string) => Promise<boolean>;
  };
  /**
   * False when the request came through a door (a paired phone's own key, the paired door, a caller beyond this
   * computer: src/remote/window-key.ts). Absent means this computer (the window's own key, or `branch connect`).
   */
  thisComputer?: boolean;
}
/** Apps whose settings name a program on this computer that Branch then starts (signal-cli, keybase, deltachat-rpc-server). */
export const startsAProgram = (recipe: Recipe): boolean => recipe.fields.some((field) => field.name === "path");
const telegramApi = "https://api.telegram.org/";
/** The card's recipe with its check pointed at the stand-in, when a test set one. */
function checkedAt(recipe: Recipe, host: SetupHost): Recipe {
  const base = recipe.turnOn === "guided" ? host.telegram?.apiBase : undefined;
  if (!base || !recipe.check?.url.startsWith(telegramApi)) return recipe;
  return { ...recipe, check: { ...recipe.check, url: `${base.replace(/\/+$/, "")}/${recipe.check.url.slice(telegramApi.length)}` } };
}
export interface SaveInput { values: Record<string, unknown>; enable?: FeatureMode | undefined }

/** The connections-file line, with the owner's plain settings put in. */
export function entryLine(recipe: Recipe, values: Values): string | null {
  if (!recipe.entry) return null;
  return JSON.stringify(recipe.entry)
    .replace(/"\{\{(groupId|agentId|conversation)\}\}"/g, (whole, name: string) => (/^\d{1,15}$/.test(values[name] ?? "") ? values[name]! : whole))
    .replace(/\{\{([a-z][A-Za-z]*)\}\}/g, (_whole, name: string) => (values[name] ?? "…").replace(/["\\]/g, ""));
}

const notRunning = "Branch is not running: it connects the next time it starts.";
async function switchOn(host: SetupHost, recipe: Recipe, values: Values, entry: Record<string, unknown> | null,
  enable: FeatureMode | undefined): Promise<LiveOutcome | string | null> {
  if (recipe.turnOn === "guided") {
    await host.telegram?.save({ token: values.TELEGRAM_BOT_TOKEN, ...(enable ? { mode: enable } : {}) });
    // The check just asked Telegram about this token, so the save does not wait for the bot to connect as
    // well: that asks Telegram again, and a slow answer held the owner's click for up to twenty seconds.
    return enable && enable !== "off" && host.telegram?.connect ? host.telegram.connect({ background: true }) : null;
  }
  if (recipe.turnOn === "switch" && enable) saveParitySwitches(host.store, host.owner, { [recipe.id]: enable }, parityKinds());
  if (!entry) return null;
  // Kept whether or not it connects now, so the next start connects it; "off" keeps it without connecting.
  rememberEntry(host.store, host.owner, recipe.id, entry);
  if (enable === "off") return null;
  return host.live ? host.live.connect(recipe, entry, values) : notRunning;
}

/** Checks what was pasted, keeps it in the locker, and switches the channel on only when asked. */
export async function saveSetup(host: SetupHost, id: string, input: SaveInput): Promise<Record<string, unknown>> {
  if (setupMode(host.store, host.owner) === "off")
    throw new SetupRefusal(409, "Setting up chat apps from here is switched off. Turn it on under Customize, Chat apps.");
  const recipe = recipeFor(id);
  if (!recipe) throw new SetupRefusal(404, "There is no chat app by that name.");
  const unavailable = unavailableOn(id, host.platform ?? process.platform);
  if (unavailable) throw new SetupRefusal(400, unavailable);
  // Saving such an app starts the program it names, now and at every start, so it is set up only at this computer,
  // as everything else that runs a program here is (the /adapt rule in src/commands/catalog.ts).
  if (startsAProgram(recipe) && host.thisComputer === false)
    throw new SetupRefusal(403, `${recipe.name} starts a program on this computer, so it can only be set up in the Branch app on this computer.`);
  if (recipe.turnOn === "guided" && !host.telegram) throw new SetupRefusal(503, "The Telegram card is not available in this launch.");
  const values = readValues(recipe, input.values);
  const entry = entryFor(recipe, values); // refused before anything is asked or kept when the panel cannot finish it
  const checked = await runCheck(checkedAt(recipe, host), values, host.fetch);
  if (checked.ok === false) throw new SetupRefusal(422, checked.reason);
  // Only after the vendor accepted it, and only where "who am I" cannot tell (a Telegram stand-in skips it).
  const further = checked.ok === true && recipe.turnOn !== "guided" ? await followUpCheck(recipe, values, host.fetch, checked.name) : null;
  if (further) throw new SetupRefusal(422, further);
  const secrets = Object.keys(values).filter((name) => /^[A-Z]/.test(name));
  for (const name of secrets)
    if (recipe.turnOn !== "guided") await host.store.secrets.put(host.owner, "default", name, values[name]!, { expiresInDays: 0 });
  let connected: LiveOutcome | string | null;
  // Whatever a save or connect throws is said without what was pasted (a Telegram address carries the token).
  try { connected = await switchOn(host, recipe, values, entry, input.enable); }
  catch (error) { throw new SetupRefusal(500, scrub(`Saving or switching on failed: ${error instanceof Error ? error.message : String(error)}`, values)); }
  const live = connected && typeof connected === "object" ? connected : null;
  const connectNote = live ? live.note : typeof connected === "string" ? connected : null;
  const record = { savedAt: new Date().toISOString(), checked: checked.ok, switched: input.enable ?? null };
  host.store.save("settings", host.owner, doneKey, { ...(host.store.get("settings", host.owner, doneKey)?.data ?? {}), [recipe.id]: record });
  return {
    id: recipe.id, saved: secrets, checked: checked.ok, botName: (checked.ok ? checked.name : null) ?? live?.botName ?? null,
    checkNote: checked.ok === null ? checked.reason : null, switched: input.enable ?? null,
    connected: live ? live.connected : null, channel: live?.channel ?? null, address: live?.address ?? null,
    connectNote: connectNote ? scrub(connectNote, values) : null,
    entry: recipe.turnOn === "guided" ? null : entryLine(recipe, values), pairing: recipe.pairing ?? null,
  };
}

/** Disconnects an app set up here and forgets its settings; what was pasted stays in the locker (Settings › Secrets). */
export async function removeSetup(host: SetupHost, id: string): Promise<Record<string, unknown>> {
  const recipe = recipeFor(id);
  if (!recipe || recipe.turnOn === "guided") throw new SetupRefusal(404, "There is no chat app set up here by that name.");
  if (!savedEntries(host.store, host.owner)[recipe.id]) throw new SetupRefusal(404, `${recipe.name} was not set up here.`);
  if (host.live) await host.live.disconnect(recipe.id);
  else rememberEntry(host.store, host.owner, recipe.id, null);
  return { id: recipe.id, removed: true };
}

/** Every recipe id, for the command's help. */
export const setupIds = (): string[] => recipes().map((recipe) => recipe.id);
