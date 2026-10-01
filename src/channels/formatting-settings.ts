import { z } from "zod";
import type { Store } from "../store.js";
import type { ChannelAdapter, MessageFormat } from "./router.js";

const key = "chat-formatting";
const ModeSchema = z.enum(["native", "plain"]);
const SettingsSchema = z.record(z.string(), ModeSchema);
const InputSchema = z.object({ channel: z.string().min(1).max(64), mode: ModeSchema }).strict();
type FormattingStore = Pick<Store, "get" | "save">;

export function channelFormats(store: Pick<Store, "get">, owner: string): Record<string, "native" | "plain"> {
  const parsed = SettingsSchema.safeParse(store.get("settings", owner, key)?.data ?? {});
  return parsed.success ? parsed.data : {};
}
export const channelFormatting = (store: Pick<Store, "get">, owner: string, channel: string): "native" | "plain" =>
  channelFormats(store, owner)[channel] ?? "native";

export function saveChannelFormatting(store: FormattingStore, owner: string, raw: unknown, knownKinds: readonly string[]) {
  const { channel, mode } = InputSchema.parse(raw);
  if (!knownKinds.includes(channel)) throw new Error("There is no chat app by that name.");
  const formats = { ...channelFormats(store, owner), [channel]: mode };
  store.save("settings", owner, key, formats);
  return formats;
}

const originals = new WeakMap<ChannelAdapter, { send: ChannelAdapter["send"]; edit: ChannelAdapter["edit"] }>();
function stripChatStyle(text: string): string {
  return text.replace(/!?\[([^\]\n]+)\]\(([^)\n]+)\)/g, "$1 ($2)")
    .replace(/^(?: {0,3}#{1,6}\s+| {0,3}>\s?)/gm, "")
    .replace(/(\*\*|__|~~)(?=\S)([^\n]*?\S)\1/g, "$2")
    .replace(/(^|[\s(])([*_])(?=\S)([^\n]*?\S)\2(?=$|[\s).,!?:;])/gm, "$1$3");
}
/** Drop presentation markers, retaining code contents and link destinations as ordinary text. */
export function plainChatText(text: string, spans?: MessageFormat["spans"]): string {
  if (spans?.length) {
    let plain = "", end = 0;
    for (const span of [...spans].sort((a, b) => a.offset - b.offset)) {
      const next = span.offset + span.length;
      if (!Number.isInteger(span.offset) || !Number.isInteger(span.length) || span.offset < end || span.length <= 0 || next > text.length) continue;
      plain += plainChatText(text.slice(end, span.offset)) + text.slice(span.offset, next);
      end = next;
    }
    return plain + plainChatText(text.slice(end));
  }
  const code = /^ {0,3}(`{3,}|~{3,})[^\n]*\n([\s\S]*?)^ {0,3}\1[ \t]*$|`([^`\n]+)`/gm;
  let plain = "", end = 0;
  for (const match of text.matchAll(code)) {
    plain += stripChatStyle(text.slice(end, match.index));
    plain += match[2]?.replace(/\n$/, "") ?? match[3] ?? "";
    end = match.index + match[0].length;
  }
  return plain + stripChatStyle(text.slice(end));
}
/** Keep the adapter's identity and method receiver; reconnecting never wraps a wrapper. */
export function installChannelFormatting(adapter: ChannelAdapter, mode: () => "native" | "plain"): void {
  adapter.configureFormatting?.(mode);
  let original = originals.get(adapter);
  if (!original) {
    original = { send: adapter.send.bind(adapter), edit: adapter.edit?.bind(adapter) };
    originals.set(adapter, original);
  }
  const send = original.send, edit = original.edit;
  const format = (value?: MessageFormat): MessageFormat | undefined => mode() === "plain"
    ? { ...value, plain: true, spans: undefined } : value;
  const words = (text: string, value?: MessageFormat) => mode() === "plain" ? plainChatText(text, value?.spans) : text;
  adapter.send = (chat, text, reply, value, gate) => send(chat, words(text, value), reply, format(value), gate);
  if (edit) adapter.edit = (chat, message, text, value, gate) => edit(chat, message, words(text, value), format(value), gate);
}
