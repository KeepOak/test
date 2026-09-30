import { z } from "zod";
import { ChannelPolicySchema, type ChannelAdapter, type ChannelRouter } from "../channels/router.js";
import { isPostedChannel } from "../channels/parity-switch.js";
import { webhookAddress, webhookSecret } from "../channels/webhook-address.js";
import type { Store } from "../store.js";
import { diagnose } from "../diagnostic-log.js";
import { SetupRefusal, scrub, type Values } from "./check.js";
import { recipeFor, type Recipe } from "./recipes.js";

/**
 * Chat apps set up in the window, connected there and then (CHAT-147). The Set up panel used to save what
 * was pasted and hand back a line for the connections file, and the app stayed silent until the owner
 * wrote it in and restarted Branch. Now the panel's save keeps the same entry here, in the owner's
 * settings, builds the channel exactly as a connections-file entry is built, and attaches it to the
 * running router; Branch connects every saved one again when it starts.
 *
 * Only what the recipe templates is ever written: the entry comes from `data/channel-setup.json` with the
 * owner's plain settings put in, so a request cannot add an `apiBase` or any other key. Secrets stay in
 * the locker under the recipe's names and never reach this record. A channel of the same name from the
 * connections file always wins, so one bot is never read twice.
 */
const settingsKey = "channel-setup-entries";
const EntrySchema = z.object({ entry: z.record(z.string(), z.unknown()), savedAt: z.string().max(40) }).strict();
const EntriesSchema = z.record(z.string().regex(/^[a-z][a-z0-9-]{1,29}$/), EntrySchema);

/** What connecting a saved app came to, in words the owner can act on. */
export interface LiveOutcome {
  /** True when the app is attached and reaching Branch (or, for a posted app, listening for it). */
  connected: boolean;
  /** The channel's name in Branch (its conversations and pairings go by it). */
  channel: string | null;
  /** The bot's own name, once the app said it. */
  botName: string | null;
  /** For an app that posts to Branch: the address to paste into its settings, without this computer's name. */
  address: string | null;
  /** Why it is not connected, or what is still needed; null when there is nothing to say. */
  note: string | null;
}

/** The recipe's entry with the owner's plain settings put in, as an object. Null for the Telegram card. */
export function entryFor(recipe: Recipe, values: Values): Record<string, unknown> | null {
  if (!recipe.entry) return null;
  const fill = (value: unknown): unknown => {
    if (typeof value === "string") {
      const whole = /^\{\{([a-z][A-Za-z]*)\}\}$/.exec(value);
      // A number the service wants as a number (a VK group, a WeCom agent) is written as one.
      if (whole && ["groupId", "agentId", "conversation"].includes(whole[1]!) && /^\d{1,15}$/.test(values[whole[1]!] ?? "")) return Number(values[whole[1]!]);
      return value.replace(/\{\{([a-z][A-Za-z]*)\}\}/g, (_all, name: string) => {
        const given = values[name];
        if (given === undefined) throw new SetupRefusal(400, `${recipe.name} needs a setting this panel does not ask for (${name}).`);
        return given;
      });
    }
    if (Array.isArray(value)) return value.map(fill);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, fill(inner)]));
    return value;
  };
  const entry = fill(recipe.entry) as Record<string, unknown>;
  if (JSON.stringify(entry).includes("…")) throw new SetupRefusal(400, `${recipe.name} cannot be finished from this panel yet.`);
  return entry;
}

export function savedEntries(store: Pick<Store, "get">, owner: string): z.infer<typeof EntriesSchema> {
  const parsed = EntriesSchema.safeParse(store.get("settings", owner, settingsKey)?.data ?? {});
  return parsed.success ? parsed.data : {};
}
/** Keeps (or, with null, forgets) the entry an app was set up with here. */
export function rememberEntry(store: Store, owner: string, id: string, entry: Record<string, unknown> | null): void {
  const all = { ...savedEntries(store, owner) };
  if (entry) all[id] = { entry, savedAt: new Date().toISOString() };
  else delete all[id];
  store.save("settings", owner, settingsKey, all);
}

export interface LiveHost {
  store: Store;
  owner: string;
  router: Pick<ChannelRouter, "attach" | "detach" | "adapter" | "summary">;
  /** Checks an entry with the connections file's own shapes and builds its channel (src/integrations/bootstrap.ts). */
  build: (entry: Record<string, unknown>) => Promise<ChannelAdapter>;
}

/** What this panel attached to each router, by channel name and recipe, so a new save replaces only its own. */
const attachedHere = new WeakMap<object, Map<string, { adapter: ChannelAdapter; recipe: string }>>();
const mine = (router: object) => {
  let map = attachedHere.get(router);
  if (!map) attachedHere.set(router, map = new Map());
  return map;
};
/** One connect at a time per router: a start's own connect and a save made just then must not both attach. */
const queue = new WeakMap<object, Promise<unknown>>();
function inTurn<T>(router: object, work: () => Promise<T>): Promise<T> {
  const run = (queue.get(router) ?? Promise.resolve()).then(work);
  queue.set(router, run.catch(() => undefined));
  return run;
}

const outcome = (partial: Partial<LiveOutcome>): LiveOutcome =>
  ({ connected: false, channel: null, botName: null, address: null, note: null, ...partial });

/** Connects a kept entry now. Values are only used to keep what was pasted out of any error. */
export function connectNow(host: LiveHost, recipe: Recipe, entry: Record<string, unknown>, values: Values = {}): Promise<LiveOutcome> {
  return inTurn(host.router, () => connectOne(host, recipe, entry, values));
}

/** Takes an app this panel connected out of the router, and forgets its entry. Its secrets stay in the locker. */
export function disconnect(host: LiveHost, recipeId: string): Promise<boolean> {
  return inTurn(host.router, async () => {
    const saved = savedEntries(host.store, host.owner)[recipeId];
    rememberEntry(host.store, host.owner, recipeId, null);
    const map = mine(host.router);
    for (const [channel, attached] of map)
      if (attached.recipe === recipeId) { map.delete(channel); await host.router.detach(channel).catch(() => undefined); return true; }
    return saved !== undefined;
  });
}

/** Connects every app saved here, when Branch starts. Each problem is written to the diagnostics, never thrown. */
export async function connectSaved(host: LiveHost): Promise<LiveOutcome[]> {
  const results: LiveOutcome[] = [];
  for (const [id, saved] of Object.entries(savedEntries(host.store, host.owner))) {
    const recipe = recipeFor(id);
    if (!recipe) continue;
    const result = await inTurn(host.router, () => connectOne(host, recipe, saved.entry, {}));
    if (!result.connected && result.note) diagnose("channels", "warn", `${recipe.name}: ${result.note}`);
    results.push(result);
  }
  return results;
}

async function connectOne(host: LiveHost, recipe: Recipe, entry: Record<string, unknown>, values: Values): Promise<LiveOutcome> {
  const map = mine(host.router);
  const channel = typeof entry.id === "string" ? entry.id : recipe.id;
  const ours = map.get(channel);
  if (ours && ours.recipe !== recipe.id)
    return outcome({ channel, note: `Another chat app set up here already uses the name ${channel}. Remove that one first.` });
  const present = host.router.adapter(channel);
  if (present && ours?.adapter !== present)
    return outcome({ channel, note: `${recipe.name} is already connected from the connections file, which wins. Take it out of that file to manage it here.` });
  let adapter: ChannelAdapter;
  try { adapter = await host.build(entry); }
  catch (error) { return outcome({ channel, note: scrub(plain(error), values) }); }
  if (ours) { map.delete(channel); await host.router.detach(channel).catch(() => undefined); }
  map.set(channel, { adapter, recipe: recipe.id });
  try { await host.router.attach(adapter, ChannelPolicySchema.parse({})); }
  catch (error) {
    if (map.get(channel)?.adapter === adapter) map.delete(channel);
    await adapter.stop().catch(() => undefined);
    return outcome({ channel, note: scrub(`${recipe.name} did not connect: ${plain(error)}`, values) });
  }
  const health = adapter.health?.();
  const posted = isPostedChannel(adapter) || recipe.id === "whatsapp" || ["messenger", "instagram"].includes(recipe.id) || entry.type === "chat";
  const address = posted ? webhookAddress(recipe.id === "whatsapp" ? "whatsapp" : "chat", channel, webhookSecret(host.store, host.owner, channel)) : null;
  const note = health?.state === "needs attention" ? health.reason ?? `${recipe.name} needs attention.`
    : posted ? `${recipe.name} sends messages to this computer. Paste this computer's public address followed by ${address} into ${recipe.name}'s settings. Branch must be reachable from the internet at that address, through a reverse proxy or a tunnel you run; nothing arrives until it is.`
      : null;
  return outcome({ connected: health?.state !== "needs attention", channel, botName: adapter.botName(), address, note });
}

const plain = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 400);

/** The window's side of it, for createBranch: connect a saved app now, take one out, and connect them all at start. */
export function liveChannels(host: () => LiveHost) {
  return {
    connect: (recipe: Recipe, entry: Record<string, unknown>, values: Values): Promise<LiveOutcome> => connectNow(host(), recipe, entry, values),
    disconnect: (id: string): Promise<boolean> => disconnect(host(), id),
    connectSaved: (): Promise<LiveOutcome[]> => connectSaved(host()),
  };
}
