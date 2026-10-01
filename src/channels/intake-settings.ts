import { z } from "zod";
import type { Store } from "../store.js";

/**
 * Settings › Chat apps: what a Trunk sees and staying connected (pass 17 part D §8).
 *
 * - `edited`: an edited message is answered as its latest version (Telegram's edited messages).
 * - `albums`: photos sent together as one album are waited for and arrive as one message.
 * - `splitWaitMs`: after a message long enough to be the first piece of one an app split (`splitPieceChars`), the same
 *   person's messages that arrive within this long are joined into one turn, so it is answered once (off, one second
 *   or three). A shorter message is never waited on (chat-speed).
 * - `watchdog`: an app with no contact for `stalledAfterSeconds` is stalled; stalled for `reconnectMinutes` it is
 *   started again, and if that does not bring it back its card says so. An app that is merely quiet (reached, with
 *   nothing new) is never restarted.
 * - `presence`: the bot's short description says "Online" while Branch runs and "Offline, back soon" once it stops.
 *   Off until the owner chooses: it changes what everybody sees on the bot's profile.
 *
 * `dmPolicies` limits direct messages on each exact connection: approved uses existing sender rules; owner
 * requires a named, transport-vouched owner account before the usual rules. It never changes group admission.
 *
 * All connection-health and message-shaping options but `presence` ship on: they change only how Branch reads what already arrived and keeps its own connections
 * working; nothing is sent, spent or deleted.
 */
const DmPoliciesSchema = z.record(z.string().trim().min(1).max(64), z.enum(["owner", "approved"]))
  .refine((policies) => Object.keys(policies).length <= 200, "At most 200 chat apps may have a direct-message policy");

export const ChatIntakeSchema = z.object({
  dmPolicies: DmPoliciesSchema.default({}),
  edited: z.boolean().default(true),
  albums: z.boolean().default(true),
  /** Telegram photos, videos and documents enter tasks. Voice notes keep their separate controls. */
  telegramMedia: z.boolean().default(true),
  splitWaitMs: z.union([z.literal(0), z.literal(1000), z.literal(3000)]).default(1000),
  watchdog: z.boolean().default(true),
  reconnectMinutes: z.union([z.literal(1), z.literal(3), z.literal(10)]).default(3),
  stalledAfterSeconds: z.number().int().min(30).max(3600).default(90),
  presence: z.boolean().default(false),
}).strict();
export type ChatIntake = z.infer<typeof ChatIntakeSchema>;
const intakeKey = "chat-intake";

export function readChatIntake(store: Pick<Store, "get">, owner: string): ChatIntake {
  const parsed = ChatIntakeSchema.safeParse(store.get("settings", owner, intakeKey)?.data ?? {});
  return parsed.success ? parsed.data : ChatIntakeSchema.parse({});
}
/** Saves the fields named; the others keep their value. */
export function saveChatIntake(store: Pick<Store, "get" | "save">, owner: string, input: unknown): ChatIntake {
  const change = ChatIntakeSchema.partial().strict().parse(input ?? {});
  const current = readChatIntake(store, owner);
  const next = ChatIntakeSchema.parse({ ...current, ...change, dmPolicies: { ...current.dmPolicies, ...change.dmPolicies } });
  store.save("settings", owner, intakeKey, next);
  return next;
}
/** How long an album's photos are waited for, at least, when albums are joined. */
export const albumWaitMs = 1000;
/**
 * chat-speed: an app splits only a message too long to send whole (Telegram at 4,096 characters), so `splitWaitMs` is
 * waited only after a message at least this long; every other message starts its turn at once. The same line as
 * NousResearch/hermes-agent (MIT) `_SPLIT_THRESHOLD` in plugins/platforms/telegram/adapter.py and openclaw/openclaw
 * (MIT) extensions/telegram/src/bot-handlers.inbound-buffer.ts, which both wait longer only for a 4,000-character piece.
 */
export const splitPieceChars = 4000;
/** The words the bot's short description says (presence). */
export const presenceWords = { online: "Online", offline: "Offline, back soon" } as const;
