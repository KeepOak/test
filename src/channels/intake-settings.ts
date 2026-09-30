import { z } from "zod";
import type { Store } from "../store.js";

/**
 * Settings › Chat apps: what a Trunk sees and staying connected (pass 17 part D §8).
 *
 * - `edited`: an edited message is answered as its latest version (Telegram's edited messages).
 * - `albums`: photos sent together as one album are waited for and arrive as one message.
 * - `splitWaitMs`: messages from one chat that arrive within this long of the first are joined into one turn, so a
 *   long message an app split in two is answered once (off, one second or three).
 * - `watchdog`: an app with no contact for `stalledAfterSeconds` is stalled; stalled for `reconnectMinutes` it is
 *   started again, and if that does not bring it back its card says so. An app that is merely quiet (reached, with
 *   nothing new) is never restarted.
 * - `presence`: the bot's short description says "Online" while Branch runs and "Offline, back soon" once it stops.
 *   Off until the owner chooses: it changes what everybody sees on the bot's profile.
 *
 * All but `presence` ship on: they change only how Branch reads what already arrived and keeps its own connections
 * working; nothing is sent, spent or deleted.
 */
export const ChatIntakeSchema = z.object({
  edited: z.boolean().default(true),
  albums: z.boolean().default(true),
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
  const next = ChatIntakeSchema.parse({ ...readChatIntake(store, owner), ...change });
  store.save("settings", owner, intakeKey, next);
  return next;
}
/** How long an album's photos are waited for, at least, when albums are joined. */
export const albumWaitMs = 1000;
/** The words the bot's short description says (presence). */
export const presenceWords = { online: "Online", offline: "Offline, back soon" } as const;
