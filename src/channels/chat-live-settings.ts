import { z } from "zod";
import { chosenFields, markChosen, savedFields, shippedUnlessChosen } from "../ship-on.js";
import type { Store } from "../store.js";

/**
 * The owner's switches for the chat-app extras. Each one is on, off, or "when needed", and each one
 * starts off: a fresh install answers chat messages exactly as it always did.
 *
 * - `liveStatus`: typing, a reaction on your message, and a progress message edited in place.
 *   "When needed" shows nothing for a quick answer and starts all three only once a task has been
 *   working for a few seconds.
 * - `commands`: /stop, /status, /new, /compact, /usage, /btw, /help. "When needed" reads only the
 *   ones that matter while a task works (/stop, /status, /btw, /help), and only while one does;
 *   otherwise a message starting with "/" is an ordinary message.
 * - `steering`: a message sent while a task works is handed to it as a note. "On" also answers
 *   quick messages as one; "when needed" steers without waiting to gather. Off, a message for a
 *   busy chat waits for the task to finish and is then answered on its own.
 * - `splitting`: long replies are split at paragraph breaks and never leave a code block open.
 *   "When needed" does that only for a reply that contains code; off splits as before.
 * - `steps`: "Show steps in chats". In a direct chat the progress message lists each step the task
 *   takes, one line each with its emoji and commands as code, the way the window shows them; off
 *   keeps the short "Working on it" message. Groups always get the short one, so nobody else in a
 *   group sees the paths and commands of the work. "When needed" is the same as on: the steps only
 *   ever show once a task has been working for a while (see `liveStatus`).
 *
 * These are chat-side behaviours with nothing to put in front of the model, so "when needed" is
 * decided by the situation (a slow task, a busy chat, code in the reply) rather than by the tool
 * tiering of src/tool-loading.ts.
 */
export const FeatureSwitchSchema = z.enum(["on", "off", "when-needed"]);
export type FeatureSwitch = z.infer<typeof FeatureSwitchSchema>;
export const ChatLiveSwitchesSchema = z.object({
  liveStatus: FeatureSwitchSchema.default("off"),
  commands: FeatureSwitchSchema.default("off"),
  steering: FeatureSwitchSchema.default("off"),
  splitting: FeatureSwitchSchema.default("off"),
  steps: FeatureSwitchSchema.default("off"),
}).strict();
export type ChatLiveSwitches = z.infer<typeof ChatLiveSwitchesSchema>;
/** A change names only the switches it moves; no defaults, so the others are left alone. */
const SwitchChangeSchema = z.object({
  liveStatus: FeatureSwitchSchema.optional(), commands: FeatureSwitchSchema.optional(),
  steering: FeatureSwitchSchema.optional(), splitting: FeatureSwitchSchema.optional(),
  steps: FeatureSwitchSchema.optional(),
}).strict();
const settingKey = "chat-live-switches";
/**
 * The owner's rule (ships on, 2026-09-26): typing and progress, steering a running task and splitting a long reply only
 * change how Branch answers a chat the owner connected; none of (a)–(f). So do the steps (2026-09-27): they go only to a
 * direct chat with a sender already let in, scrubbed like every reply. Commands typed in a chat app stay off: they
 * reach Branch from outside this window (f).
 */
export const chatLiveShipsOn: Partial<ChatLiveSwitches> = { liveStatus: "when-needed", steering: "when-needed", splitting: "when-needed", steps: "on" };

/**
 * Commands in the owner's own paired direct chat (owner, 2026-09-27: useful features ship on). /stop, /status, /new,
 * /help and the rest act only on that chat's own conversation, so an account the owner approved by pairing code and
 * named as their own (the router's `ownAccount`) reads them even while `commands` is off as shipped. A paired friend,
 * a group, and anyone let in only by an allowlist keep the switch as it is; once the owner sets the switch, their
 * choice holds everywhere, off included.
 */
export function commandsInPairedDm(store: Store, owner: string): boolean {
  const saved = chatLiveSwitches(store, owner);
  return saved.commands === "off" && !chosenFields(store, owner, settingKey).includes("commands") && !onlyCommandsSaved(store, owner);
}
/** A record holding nothing but the commands switch was written by the owner moving it (see ship-on.ts). */
function onlyCommandsSaved(store: Store, owner: string): boolean {
  const data = store.get("settings", owner, settingKey)?.data;
  return !!data && typeof data === "object" && Object.keys(data).length === 1 && "commands" in data;
}
export function chatLiveSwitches(store: Store, owner: string): ChatLiveSwitches {
  const parsed = ChatLiveSwitchesSchema.safeParse(store.get("settings", owner, settingKey)?.data ?? {});
  return parsed.success ? shippedUnlessChosen(store, owner, settingKey, parsed.data, chatLiveShipsOn) : ChatLiveSwitchesSchema.parse({});
}
/** Changes some of the switches; the ones not named keep their value. */
export function saveChatLiveSwitches(store: Store, owner: string, input: unknown): ChatLiveSwitches {
  const change = SwitchChangeSchema.parse(input ?? {});
  const before = store.get("settings", owner, settingKey)?.data;
  const next = ChatLiveSwitchesSchema.parse({ ...chatLiveSwitches(store, owner), ...change });
  store.save("settings", owner, settingKey, next);
  markChosen(store, owner, settingKey, savedFields(before, ChatLiveSwitchesSchema.safeParse(before ?? {}).success, change, chatLiveShipsOn));
  return next;
}
