import { z } from "zod";
import { FeatureModeSchema } from "../feature-switches.js";
import { ChannelPolicySchema, type ChannelRouter } from "../channels/router.js";
import { TelegramAdapter } from "../channels/telegram.js";
import type { Store } from "../store.js";
import { channelPosition, type ChannelPosition } from "./channel-position.js";
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
  return { mode: telegramMode(store, owner), tokenSaved, connected: Boolean(connected), botName: connected?.botName ?? null,
    waiting: router.summary().pending.filter((pair) => pair.channel === connected?.id).length };
}

/** Saves the switch and, when given, the token. The token is never written anywhere but the locker. */
export async function saveTelegramSetup(store: Store, owner: string, input: unknown): Promise<void> {
  const parsed = TelegramSetupInputSchema.parse(input);
  if (parsed.token) await secretsOf(store).put(owner, "default", telegramSecretName, parsed.token, { expiresInDays: 0 });
  if (parsed.mode) store.save("settings", owner, settingsKey, { mode: parsed.mode, changedAt: new Date().toISOString() });
}

/** The bot this card attached to each router, and with which token, so a new token replaces it. */
const attachedByCard = new WeakMap<object, { adapter: TelegramAdapter; token: string }>();

/** The bot's own id is the number before the colon in its token. */
const botIdOf = (token: string): string => token.split(":")[0] ?? "";

/**
 * Where the card's bot was read up to, kept only while it is the same bot: Telegram numbers each
 * bot's updates on their own, so a position from a replaced bot would skip the new bot's messages.
 */
function cardPosition(store: Store, owner: string, token: string): ChannelPosition | undefined {
  const inner = channelPosition(store, "telegram", owner);
  if (!inner) return undefined;
  const bot = botIdOf(token);
  const kept = store.get("settings", owner, positionBotKey)?.data.bot;
  const same = kept === undefined || kept === bot; // a position saved before this was kept is the same bot's
  return {
    load: () => (same ? inner.load() : 0),
    save: (offset) => { inner.save(offset); store.save("settings", owner, positionBotKey, { bot }); },
  };
}
const positionBotKey = "telegram-setup-position-bot";

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
  const run = (connecting.get(input.router) ?? Promise.resolve()).then(() => connectOnce(input));
  connecting.set(input.router, run.catch(() => undefined));
  return run;
}
const connecting = new WeakMap<object, Promise<unknown>>();

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
  const position = cardPosition(input.store, input.owner, token);
  const adapter = new TelegramAdapter({ id: "telegram", token, fetch: input.fetch, keepTrying: true,
    ...(input.apiBase ? { apiBase: input.apiBase } : {}), ...(position ? { position } : {}) });
  attachedByCard.set(input.router, { adapter, token });
  const attaching = input.router.attach(adapter, ChannelPolicySchema.parse({})).then(() => null, async (error: unknown) => {
    if (attachedByCard.get(input.router)?.adapter === adapter) attachedByCard.delete(input.router);
    await adapter.stop().catch(() => undefined);
    return `Telegram did not connect: ${error instanceof Error ? error.message.replace(/bot[^/\s]*/g, "bot…") : "unknown problem"}`;
  });
  if (!input.background) return attaching;
  void attaching.then((why) => { if (why) diagnose("channels", "warn", why); });
  return null;
}
