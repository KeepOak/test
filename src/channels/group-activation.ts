import { z } from "zod";
import { audit } from "../audit.js";
import type { Store } from "../store.js";
import { platformSettings } from "../reach/platform.js";
import { ownerCommands, vouchedSenderKinds } from "./owner-commands.js";
import type { ChannelAdapter, InboundMessage } from "./router.js";

/**
 * When the assistant answers in each group chat: only when it is @mentioned, replied to or called by name (how every
 * group starts), or to every message. OpenClaw keeps this per group and lets the owner type `/activation mention` or
 * `/activation always` in the group; Hermes keeps free-response channels. Branch does both: the owner's choice per group
 * is set in Settings › Chat apps or with `/activation` typed in the group from one of the owner's own accounts, on an
 * app that proves who sent each message. A connections-file `activation` stays the default for that app's groups.
 *
 * "Every message" only reaches the assistant where the app hands the bot every message: on Telegram that needs the
 * bot's privacy mode off in BotFather (or the bot made an admin of the group). The app's own answer is asked and said.
 */
export const ActivationSchema = z.enum(["mention", "always"]);
export type Activation = z.infer<typeof ActivationSchema>;
const settingsKey = "chat-group-activation";
const groupKey = (channel: string, chatId: string): string => `${channel}\u0000${chatId}`;
const StoredSchema = z.record(z.string().max(200), z.object({ activation: ActivationSchema, title: z.string().max(200), setAt: z.string().max(40) }).strict());
/** Apps whose servers vouch for the sender of every message (the same four as owner commands from a chat). */
export const vouchedKinds: readonly string[] = vouchedSenderKinds;
const maxGroups = 200;

function stored(store: Pick<Store, "get">, owner: string): z.infer<typeof StoredSchema> {
  const parsed = StoredSchema.safeParse(store.get("settings", owner, settingsKey)?.data ?? {});
  return parsed.success ? parsed.data : {};
}
/** The owner's choice for this group, or null when it follows the app's default. */
export function groupActivation(store: Pick<Store, "get">, owner: string, channel: string, chatId: string): Activation | null {
  return stored(store, owner)[groupKey(channel, chatId)]?.activation ?? null;
}
/** Every group with a choice of its own. */
export function groupActivations(store: Pick<Store, "get">, owner: string): { channel: string; chatId: string; title: string; activation: Activation; setAt: string }[] {
  return Object.entries(stored(store, owner)).map(([key, value]) => {
    const [channel = "", chatId = ""] = key.split("\u0000");
    return { channel, chatId, ...value };
  });
}
export const SetActivationSchema = z.object({
  channel: z.string().min(1).max(64), chatId: z.string().min(1).max(120),
  activation: ActivationSchema.nullable(), title: z.string().max(200).optional(),
}).strict();
/** Sets (or, with null, clears) one group's choice. The caller has checked it is the owner. */
export function setGroupActivation(store: Store, owner: string, input: unknown, by: string): Activation | null {
  const { channel, chatId, activation, title } = SetActivationSchema.parse(input);
  const all = { ...stored(store, owner) };
  const key = groupKey(channel, chatId);
  if (activation) all[key] = { activation, title: title ?? all[key]?.title ?? chatId, setAt: new Date().toISOString() };
  else delete all[key];
  if (Object.keys(all).length > maxGroups) throw new Error(`At most ${maxGroups} groups can have a choice of their own.`);
  store.save("settings", owner, settingsKey, all);
  audit(store, owner, { action: "policy.changed", actor: owner, subject: `when the assistant answers in ${title ?? chatId} on ${channel}`,
    reason: activation === "always" ? `answers every message (${by})` : activation === "mention" ? `answers only when mentioned (${by})` : `follows the app's default (${by})`,
    outcome: "saved" });
  return activation;
}

/** How a group message is answered now: the group's own choice, else the app's. */
export function activationFor(store: Pick<Store, "get">, owner: string, message: Pick<InboundMessage, "channel" | "chatId">, fallback: Activation): Activation {
  return groupActivation(store, owner, message.channel, message.chatId) ?? fallback;
}

const sayReading = async (adapter: ChannelAdapter, chatId: string): Promise<string> => {
  const reading = await adapter.groupReading?.(chatId).catch(() => null);
  return reading?.everyMessage === false && reading.fix ? ` ${reading.fix}` : "";
};

/**
 * The router's first look at a group message, beside `platformGate`: `/activation`, `/activation mention` or
 * `/activation always` from one of the owner's own accounts, on an app that vouches for its senders, is carried out and
 * answered, even when the assistant was not mentioned (Telegram hands a bot its commands in any case). From anybody
 * else it is an ordinary message; one fetched after a restart is let go.
 */
export async function activationGate(store: Store, owner: string, message: InboundMessage, adapter: ChannelAdapter): Promise<{ reply: string | null } | null> {
  if (message.chatKind !== "group") return null;
  const command = /^\/activation(?:@[\w.-]+)?(?:\s+(mention|always))?\s*$/i.exec(message.text.trim());
  if (!command || !vouchedKinds.includes(adapter.kind)) return null;
  // The owner's own accounts: the /platform list, or those marked under Commands from your own chat (who, not what they may run).
  const named = (account: { channel: string; sender: string }) => account.channel === message.channel && account.sender === message.senderId;
  if (!platformSettings(store, owner).owners.some(named) && !ownerCommands(store, owner).accounts.some(named)) return null;
  if (message.caughtUp) return { reply: null };
  const wanted = command[1]?.toLowerCase() as Activation | undefined;
  if (!wanted) {
    const now = groupActivation(store, owner, message.channel, message.chatId);
    return { reply: `${now === "always" ? "I answer every message here." : "I answer here when I am mentioned, replied to or called by name."} Send /activation always or /activation mention to change it.` };
  }
  setGroupActivation(store, owner, { channel: message.channel, chatId: message.chatId, activation: wanted, title: message.chatTitle ?? message.chatId }, `from ${message.channel}`);
  if (wanted === "mention") return { reply: "From now on I answer here only when I am mentioned, replied to or called by name." };
  return { reply: `From now on I answer every message here.${await sayReading(adapter, message.chatId)}` };
}
