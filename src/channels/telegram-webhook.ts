import { timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const TelegramWebhookConfigSchema = z.object({
  publicOrigin: z.string().url().refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash
      && url.pathname === "/" && ["", "443", "80", "88", "8443"].includes(url.port);
  }, "Use a public HTTPS origin with a Telegram-supported port, without a path, credentials or query"),
  secretTokenSecret: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
}).strict();
export interface TelegramWebhookOptions { url: string; secretToken: string; currentUrl?: () => string }
export class TelegramWebhookUnavailable extends Error {}
const secret = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/);
export function validateTelegramWebhook(value: TelegramWebhookOptions): TelegramWebhookOptions {
  secret.parse(value.secretToken);
  const url = new URL(value.url);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
    || !["", "443", "80", "88", "8443"].includes(url.port)) throw new Error("Telegram's webhook requires a public HTTPS URL on a supported port.");
  return value;
}
export function verifyTelegramWebhook(expected: string, supplied: string | string[] | undefined): void {
  if (typeof supplied !== "string" || !secret.safeParse(supplied).success) throw new Error("Telegram webhook secret rejected.");
  const first = Buffer.from(expected), second = Buffer.from(supplied);
  if (!first.length || first.length !== second.length || !timingSafeEqual(first, second)) throw new Error("Telegram webhook secret rejected.");
}

interface InboxStore {
  get(table: "settings", owner: string, id: string): { data: unknown } | undefined;
  save(table: "settings", owner: string, id: string, data: Record<string, unknown>): unknown;
}
const entry = z.object({ id: z.number().int().nonnegative().safe(), raw: z.string().max(262_144) }).strict();
const State = z.object({ pending: z.array(entry).max(128), done: z.array(z.object({ id: z.number().int().nonnegative().safe(), at: z.number() }).strict()).max(4096) }).strict();

/** Acknowledge only after a bounded private inbox write; replay unfinished deliveries on restart. */
export class TelegramWebhookInbox {
  private readonly key: string;
  constructor(private readonly store: InboxStore, private readonly owner: string, channel: string, botId: string) {
    this.key = `telegram-webhook-inbox:${channel}:${botId}`;
  }
  private read() {
    const saved = this.store.get("settings", this.owner, this.key);
    const state = saved ? State.parse(saved.data) : State.parse({ pending: [], done: [] });
    state.done = state.done.filter((one) => one.at > Date.now() - 86_400_000);
    return state;
  }
  enqueue(id: number, raw: string): boolean {
    const state = this.read();
    if (state.pending.some((one) => one.id === id) || state.done.some((one) => one.id === id)) return false;
    if (state.pending.length >= 128 || state.pending.length + state.done.length >= 4096
      || Buffer.byteLength(raw) + state.pending.reduce((sum, one) => sum + Buffer.byteLength(one.raw), 0) > 2_097_152)
      throw new Error("Telegram's durable webhook inbox is full. Retry delivery later.");
    state.pending.push(entry.parse({ id, raw }));
    this.store.save("settings", this.owner, this.key, state);
    return true;
  }
  pending(): z.infer<typeof entry>[] { return this.read().pending; }
  has(id: number): boolean {
    const state = this.read();
    return state.pending.some((one) => one.id === id) || state.done.some((one) => one.id === id);
  }
  complete(id: number): void {
    const state = this.read();
    if (!state.pending.some((one) => one.id === id)) return;
    state.pending = state.pending.filter((one) => one.id !== id);
    state.done.push({ id, at: Date.now() });
    this.store.save("settings", this.owner, this.key, State.parse(state));
  }
}
