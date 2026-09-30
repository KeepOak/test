import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/**
 * A Telegram Mini App's launch data (`initData`), checked the way Telegram documents it
 * (core.telegram.org/bots/webapps, "Validating data received via the Mini App"): every field but `hash`, sorted by name,
 * as `name=value` lines; the key is HMAC-SHA-256 of the bot's token keyed with "WebAppData"; `hash` must be the hex
 * HMAC-SHA-256 of those lines under that key. Only the bot's own token can make it, so the Telegram user it names is
 * the person who opened the Mini App from that bot. It is only as fresh as `auth_date`, which is checked too.
 */
export class MiniAppRefusal extends Error {
  constructor(readonly status: 400 | 401 | 403 | 404 | 409 | 423 | 429 | 503, message: string) { super(message); }
}
export interface MiniAppUser {
  /** The Telegram user's id, as Branch's Telegram chats name the sender. */
  userId: string;
  /** Where it was opened from, when Telegram says ("sender" or "private" for a private chat); null from a button. */
  chatType: string | null;
  authDate: number;
}
/** How old launch data may be. The Mini App asks for a session as it opens, so a few minutes is plenty. */
export const initDataMaxAgeMs = 10 * 60_000;
const notFromTelegram = "This didn't come from your Telegram. Open it again from the button in your chat.";
const UserSchema = z.object({ id: z.number().int().positive() }).loose();

export function verifyInitData(raw: unknown, botToken: string, now = Date.now(), maxAgeMs = initDataMaxAgeMs): MiniAppUser {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 8192 || !botToken) throw new MiniAppRefusal(401, notFromTelegram);
  const params = new URLSearchParams(raw), names = [...params.keys()];
  if (new Set(names).size !== names.length) throw new MiniAppRefusal(401, notFromTelegram);
  const hash = params.get("hash") ?? "";
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new MiniAppRefusal(401, notFromTelegram);
  const lines = [...params.entries()].filter(([name]) => name !== "hash")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([name, value]) => `${name}=${value}`).join("\n");
  const key = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expected = createHmac("sha256", key).update(lines).digest();
  if (!timingSafeEqual(expected, Buffer.from(hash, "hex"))) throw new MiniAppRefusal(401, notFromTelegram);
  const authDate = Number(params.get("auth_date"));
  if (!Number.isSafeInteger(authDate) || authDate * 1000 > now + 60_000 || now - authDate * 1000 > maxAgeMs)
    throw new MiniAppRefusal(401, "This was opened too long ago. Close it and open it again from your chat.");
  let user: unknown = null;
  try { user = JSON.parse(params.get("user") ?? "null"); } catch { /* refused just below */ }
  const parsed = UserSchema.safeParse(user);
  if (!parsed.success) throw new MiniAppRefusal(401, notFromTelegram);
  return { userId: String(parsed.data.id), chatType: params.get("chat_type"), authDate };
}

/** The launch data Telegram would make for this user (tests and the stand-in Telegram only; it needs the token). */
export function signInitData(fields: Record<string, string>, botToken: string): string {
  const lines = Object.entries(fields).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([name, value]) => `${name}=${value}`).join("\n");
  const key = createHmac("sha256", "WebAppData").update(botToken).digest();
  const hash = createHmac("sha256", key).update(lines).digest("hex");
  return new URLSearchParams({ ...fields, hash }).toString();
}
