import { randomUUID } from "node:crypto";
import { z } from "zod";
import { FeatureModeSchema } from "../feature-switches.js";
import { ChannelPolicySchema, type ChannelRouter } from "../channels/router.js";
import { TelegramAdapter, telegramBotId } from "../channels/telegram.js";
import type { Store } from "../store.js";
import { channelPosition } from "./channel-position.js";
import { diagnose } from "../diagnostic-log.js";

/**
 * Telegram, set up from a card instead of a settings file: the owner makes a bot with BotFather,
 * pastes its token (which goes straight into the locker and is never shown again), and pairs their
 * own account with the six-digit code the bot sends back. Ships off; with the switch on (or when
 * needed) Branch connects the bot the next time it starts, unless the settings file already has one.
 */
export const telegramSecretName = "TELEGRAM_BOT_TOKEN";
const settingsKey = "telegram-setup";

export const TelegramSetupInputSchema = z.object({
  mode: FeatureModeSchema.optional(),
  /** BotFather's token: digits, a colon, then about 35 letters, digits, dashes or underscores. */
  token: z.string().trim().regex(/^\d{5,15}:[A-Za-z0-9_-]{30,64}$/, "That does not look like a bot token from BotFather. It is a number, a colon, then a long run of letters and digits.").optional(),
}).strict();

type Router = Pick<ChannelRouter, "summary" | "attach" | "detach" | "adapter">;
interface SecretsLike {
  list(owner: string, project: string): { name: string }[];
  put(owner: string, project: string, name: string, value: string, options: { expiresInDays: number }): Promise<unknown>;
  resolve(owner: string, project: string, names: string[], options: { purpose: "channel" }): Promise<Record<string, string | undefined>>;
}
const secretsOf = (store: Store): SecretsLike => store.secrets as unknown as SecretsLike;

export function telegramMode(store: Pick<Store, "get">, owner: string): z.infer<typeof FeatureModeSchema> {
  const parsed = FeatureModeSchema.safeParse(store.get("settings", owner, settingsKey)?.data.mode);
  return parsed.success ? parsed.data : "off";
}

export function telegramSetupView(store: Store, owner: string, router: Router): Record<string, unknown> {
  let tokenSaved = false;
  try { tokenSaved = secretsOf(store).list(owner, "default").some((secret) => secret.name === telegramSecretName); }
  catch { /* a locked locker says nothing about what it holds */ }
  const connected = router.summary().channels.find((channel) => channel.kind === "telegram");
  const mine = attachedByCard.get(router);
  const card = mine?.ready && connected?.id === mine.adapter.id && router.adapter(connected.id) === mine.adapter
    ? { channel: connected.id, revision: mine.revision } : null;
  return { card, settingsRevision: settingsRevision(store, owner), mode: telegramMode(store, owner), tokenSaved, connected: Boolean(connected), botName: connected?.botName ?? null,
    waiting: router.summary().pending.filter((pair) => pair.channel === connected?.id).length };
}

/** Saves the switch and, when given, the token. The token is never written anywhere but the locker. */
export async function saveTelegramSetup(store: Store, owner: string, input: unknown, requireAccess?: () => void): Promise<void> {
  requireAccess?.();
  const parsed = TelegramSetupInputSchema.parse(input);
  if (parsed.token) await secretsOf(store).put(owner, "default", telegramSecretName, parsed.token, { expiresInDays: 0 });
  requireAccess?.();
  if (parsed.mode || parsed.token) store.save("settings", owner, settingsKey,
    { mode: parsed.mode ?? telegramMode(store, owner), changedAt: new Date().toISOString(), revision: randomUUID() });
}

/** The bot this card attached to each router, and with which token, so a new token replaces it. */
const attachedByCard = new WeakMap<object, { adapter: TelegramAdapter; token: string; revision: string; ready: boolean }>();



export interface GuidedTelegramInput {
  store: Store; owner: string; router: Router; fetch: typeof fetch;
  /** Test-only (createBranch's `telegramApiBase`): a stand-in for api.telegram.org. Never set from a request. */
  apiBase?: string | undefined;
  /**
   * Answer once everything but reaching Telegram is done, and connect after that: the Set up panel's
   * check has just asked Telegram about this token, so the owner's save does not wait on it twice.
   */
  background?: boolean | undefined;
}

/**
 * Connects the bot set up on the card, at start or when its token is saved. Answers why it did not, in a
 * sentence, or null when it connected (or, in the background, is connecting). A Telegram channel from the
 * settings file always wins, so one bot is never read twice; a bot this card connected earlier is
 * replaced when the token saved since is a different one.
 */
export function connectGuidedTelegram(input: GuidedTelegramInput): Promise<string | null> {
  // One at a time per router: the start's own connect and a save made just then must not both replace the bot.
  return serialTelegram(input.router, () => connectOnce(input));
}
const connecting = new WeakMap<object, Promise<unknown>>();
function serialTelegram<T>(router: Router, work: () => Promise<T>): Promise<T> {
  const run = (connecting.get(router) ?? Promise.resolve()).then(work);
  connecting.set(router, run.catch(() => undefined));
  return run;
}

async function connectOnce(input: GuidedTelegramInput): Promise<string | null> {
  if (telegramMode(input.store, input.owner) === "off") return "The Telegram card is switched off.";
  let token: string | undefined;
  try { token = (await secretsOf(input.store).resolve(input.owner, "default", [telegramSecretName], { purpose: "channel" }))[telegramSecretName]; }
  catch { return "The locker is closed, so the bot token could not be read. Unlock Branch and restart it."; }
  if (!token) return "No bot token has been saved yet.";
  const mine = attachedByCard.get(input.router);
  const connected = input.router.summary().channels.find((channel) => channel.kind === "telegram");
  if (connected && (!mine || input.router.adapter(connected.id) !== mine.adapter)) return "Telegram is already connected from the settings file.";
  if (connected && mine?.token === token) return "Telegram is already connected with this bot token.";
  if (connected) await input.router.detach(connected.id);
  return attachCard(input, token);
}

async function attachCard(input: GuidedTelegramInput, token: string): Promise<string | null> {
  const position = channelPosition(input.store, "telegram", input.owner, telegramBotId(token)); // kept per bot
  const adapter = new TelegramAdapter({ id: "telegram", token, fetch: input.fetch, keepTrying: true,
    ...(input.apiBase ? { apiBase: input.apiBase } : {}), ...(position ? { position } : {}) });
  attachedByCard.set(input.router, { adapter, token, revision: randomUUID(), ready: false });
  const attaching = input.router.attach(adapter, ChannelPolicySchema.parse({})).then(() => {
    const card = attachedByCard.get(input.router);
    if (card?.adapter === adapter) card.ready = true;
    return null;
  }, async (error: unknown) => {
    if (attachedByCard.get(input.router)?.adapter === adapter) attachedByCard.delete(input.router);
    await adapter.stop().catch(() => undefined);
    return `Telegram did not connect: ${error instanceof Error ? error.message.replace(/bot[^/\s]*/g, "bot…") : "unknown problem"}`;
  });
  if (!input.background) return attaching;
  void attaching.then((why) => { if (why) diagnose("channels", "warn", why); });
  return null;
}


function settingsRevision(store: Store, owner: string): string {
  const row = store.get("settings", owner, settingsKey);
  return typeof row?.data.revision === "string" ? row.data.revision : row?.updatedAt ?? "default";
}

const ControlSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("off"), channel: z.string().min(1).max(64), revision: z.string().uuid(), expectedMode: FeatureModeSchema, expectedSettingsRevision: z.string().min(1).max(80) }).strict(),
  z.object({ action: z.literal("undo"), receipt: z.string().uuid() }).strict(),
]);
type OffReceipt = { id: string; revision: string; channel: string; previousMode: z.infer<typeof FeatureModeSchema>; expires: number };
const offReceipts = new WeakMap<object, OffReceipt>();
export interface TelegramControlInput extends GuidedTelegramInput { requireAccess: () => void }
/** Token/mode saves share the same queue as connect/off/undo, so they cannot replace an undo snapshot midway. */
export function saveGuidedTelegram(input: TelegramControlInput, body: unknown): Promise<void> {
  return serialTelegram(input.router, () => saveTelegramSetup(input.store, input.owner, body, input.requireAccess));
}
/** Only the exact adapter attached by this card can be switched off; saved-file transports are refused. */
export function controlGuidedTelegram(input: TelegramControlInput, body: unknown): Promise<Record<string, unknown>> {
  const action = ControlSchema.parse(body);
  return serialTelegram(input.router, async () => {
    input.requireAccess();
    return action.action === "off" ? turnCardOff(input, action) : undoCardOff(input, action.receipt);
  });
}
async function turnCardOff(input: TelegramControlInput, action: Extract<z.infer<typeof ControlSchema>, { action: "off" }>): Promise<Record<string, unknown>> {
  const mine = attachedByCard.get(input.router);
  if (!mine?.ready || mine.revision !== action.revision || mine.adapter.id !== action.channel || input.router.adapter(action.channel) !== mine.adapter
    || settingsRevision(input.store, input.owner) !== action.expectedSettingsRevision
    || telegramMode(input.store, input.owner) !== action.expectedMode || action.expectedMode === "off")
    throw new Error("This Telegram connection changed. Read its card again before switching it off.");
  const receipt: OffReceipt = { id: randomUUID(), revision: mine.revision, channel: action.channel, previousMode: action.expectedMode, expires: Date.now() + 60_000 };
  input.store.save("settings", input.owner, settingsKey, { mode: "off", changedAt: new Date().toISOString(), controlRevision: receipt.id });
  offReceipts.set(input.router, receipt);
  await input.router.detach(action.channel);
  return { ...telegramSetupView(input.store, input.owner, input.router), receipt: receipt.id, note: "Telegram is switched off. Its saved token and conversations are kept." };
}
async function undoCardOff(input: TelegramControlInput, receiptId: string): Promise<Record<string, unknown>> {
  const receipt = offReceipts.get(input.router), mine = attachedByCard.get(input.router);
  const saved = input.store.get("settings", input.owner, settingsKey)?.data;
  if (!receipt || receipt.id !== receiptId || receipt.expires < Date.now() || !mine || mine.revision !== receipt.revision
    || saved?.controlRevision !== receipt.id || telegramMode(input.store, input.owner) !== "off"
    || input.router.summary().channels.some((channel) => channel.kind === "telegram"))
    throw new Error("That Telegram undo is no longer current. Open its setup card instead.");
  offReceipts.delete(input.router);
  input.store.save("settings", input.owner, settingsKey, { mode: receipt.previousMode, changedAt: new Date().toISOString() });
  const note = await attachCard(input, mine.token);
  return { ...telegramSetupView(input.store, input.owner, input.router), note: note ?? "The previous Telegram mode is restored. Check its connection status." };
}
