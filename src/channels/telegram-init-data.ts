import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/** Telegram Mini App launch data, verified with this bot's token. No client-provided identity is trusted. */
export interface TelegramLaunch { senderId: string; hash: string; authDate: number }
export const telegramLaunchAgeSeconds = 180;
const User = z.object({ id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), is_bot: z.boolean().optional() }).passthrough();
export class TelegramLaunchRefusal extends Error {}
const refuse = (): never => { throw new TelegramLaunchRefusal("Open a fresh screen link in your own direct chat with Branch."); };

/**
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 * The WebAppData HMAC is different from the Telegram login widget's token hash. Hash is excluded from the check
 * string; every other field, including a newer signature field, is included. Replay consumption belongs to the
 * screen-session bootstrap, after its owner/PIN/window checks succeed.
 */
export function verifyTelegramLaunch(raw: string, botToken: string, nowSeconds = Math.floor(Date.now() / 1000)): TelegramLaunch {
  if (!raw || raw.length > 8192 || /%(?![0-9a-f]{2})/i.test(raw) || !Number.isSafeInteger(nowSeconds) || nowSeconds < 0) refuse();
  const fields = new URLSearchParams(raw), entries = [...fields.entries()];
  if (new Set(entries.map(([key]) => key)).size !== entries.length || entries.some(([key]) => !/^[a-z_]{1,40}$/.test(key))) refuse();
  const hash = fields.get("hash") ?? "", date = fields.get("auth_date") ?? "";
  if (!/^[a-f0-9]{64}$/i.test(hash) || !/^\d{10,11}$/.test(date)) refuse();
  const authDate = Number(date), age = nowSeconds - authDate;
  if (!Number.isSafeInteger(authDate) || age < -5 || age > telegramLaunchAgeSeconds) refuse();
  const check = entries.filter(([key]) => key !== "hash").sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`).join("\n");
  const key = createHmac("sha256", "WebAppData").update(botToken).digest();
  const wanted = createHmac("sha256", key).update(check).digest();
  if (!timingSafeEqual(wanted, Buffer.from(hash, "hex"))) refuse();
  let user: z.infer<typeof User>;
  try { user = User.parse(JSON.parse(fields.get("user") ?? "")); } catch { return refuse(); }
  if (user.is_bot || (fields.has("chat_type") && fields.get("chat_type") !== "private")) refuse();
  if (fields.has("chat")) {
    let chat: unknown; try { chat = JSON.parse(fields.get("chat")!); } catch { return refuse(); }
    if (!chat || typeof chat !== "object" || (chat as { type?: unknown }).type !== "private") refuse();
  }
  return { senderId: String(user.id), hash: hash.toLowerCase(), authDate };
}
