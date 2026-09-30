import { z } from "zod";
import type { Store } from "../store.js";

/**
 * Settings › Chat apps › Replies in each app: per chat app, whether Branch's messages quote the person's message, and
 * whether it puts a reaction on it while it works.
 *
 * Quoting follows OpenClaw's `replyToMode` (off / first / all; Telegram defaults to off there) and Hermes Agent's
 * `reply_to_mode` (off / first / all), with one more choice that is the default here:
 *   - "auto": in a one-to-one chat the reply quotes the person's message only when it would otherwise be unclear which
 *     message it answers: a newer message of theirs arrived before the answer went out, or the message was fetched
 *     late after a restart. In a group the first message of an answer quotes, so everyone sees who is being answered.
 *   - "first": the first message of each answer quotes (Hermes's default), the rest do not.
 *   - "all": every message of an answer quotes.
 *   - "off": nothing quotes.
 * A message never quotes twice for one answer unless the owner chose "all": the steps message and the reply below it are
 * one answer.
 */
export const QuoteModeSchema = z.enum(["auto", "first", "all", "off"]);
export type QuoteMode = z.infer<typeof QuoteModeSchema>;
const StyleSchema = z.object({ quote: QuoteModeSchema.default("auto"), react: z.boolean().default(true) }).strict();
export type ReplyStyle = z.infer<typeof StyleSchema>;
const StylesSchema = z.record(z.string(), StyleSchema);
const ChangeSchema = z.object({ channel: z.string().min(1).max(64), quote: QuoteModeSchema.optional(), react: z.boolean().optional() }).strict();
const key = "chat-reply-style";

export function replyStyles(store: Pick<Store, "get">, owner: string): Record<string, ReplyStyle> {
  const parsed = StylesSchema.safeParse(store.get("settings", owner, key)?.data ?? {});
  return parsed.success ? parsed.data : {};
}
/** One app's choices, by its kind ("telegram"); an app never set gets the defaults. */
export function replyStyle(store: Pick<Store, "get">, owner: string, channel: string): ReplyStyle {
  return replyStyles(store, owner)[channel] ?? StyleSchema.parse({});
}
/** Changes one app's choices; what is not named keeps its value. */
export function saveReplyStyle(store: Pick<Store, "get" | "save">, owner: string, raw: unknown, knownKinds: readonly string[]): Record<string, ReplyStyle> {
  const { channel, ...change } = ChangeSchema.parse(raw);
  if (!knownKinds.includes(channel)) throw new Error("There is no chat app by that name.");
  const styles = { ...replyStyles(store, owner), [channel]: StyleSchema.parse({ ...replyStyle(store, owner, channel), ...change }) };
  store.save("settings", owner, key, styles);
  return styles;
}

/** What one answer knows when it decides whether its next message quotes. */
export interface QuoteState {
  mode: QuoteMode;
  chatKind: "direct" | "group";
  /** A newer message from this chat arrived after the one being answered, or it was fetched late. */
  interleaved: () => boolean;
  /** How many messages of this answer went out, and whether one of them quoted. */
  sent: number;
  quoted: boolean;
}
export function quoteState(mode: QuoteMode, chatKind: "direct" | "group", interleaved: () => boolean): QuoteState {
  return { mode, chatKind, interleaved, sent: 0, quoted: false };
}
/**
 * The message id the next message of an answer quotes, or undefined, and counts that message as sent. `part` says
 * whether it is the answer itself (its words, a question it asks) or a status beside it (the steps message).
 *
 * On "auto" a status message never quotes: the answer carries the quote, once. In a group that is the answer's first
 * message; in a one-to-one chat it is the first answer message sent after the answer became unclear, so a reply that
 * follows its own steps message still quotes when a newer message came in meanwhile. "first" is Hermes's rule: the
 * first message of the answer, whichever it is.
 */
export function nextQuote(state: QuoteState, messageId: string, part: "answer" | "status" = "answer"): string | undefined {
  const first = state.sent === 0;
  state.sent++;
  const quote = state.mode === "all" ? true
    : state.mode === "first" ? first
      : state.mode === "off" || part === "status" || state.quoted ? false
        : state.chatKind === "group" ? true : state.interleaved();
  if (quote) state.quoted = true;
  return quote ? messageId : undefined;
}
