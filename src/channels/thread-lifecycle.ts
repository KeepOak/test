import { z } from "zod";
import type { Store } from "../store.js";
import { chatThread, freshThread } from "./threads.js";

const maximumMs = 365 * 24 * 60 * 60_000;
const DurationSchema = z.number().int().min(0).max(maximumMs);
const LifecycleSchema = z.object({ idleTimeoutMs: DurationSchema.default(0), maxAgeMs: DurationSchema.default(0) }).strict();
export type ChatThreadLifecycle = z.infer<typeof LifecycleSchema>;
const keyFor = (channel: string, chatId: string): string => `chat-session-lifecycle:${channel}:${chatId}`;
// Adapted from OpenClaw commands-session.ts (MIT): these values turn a duration off; bare numbers mean hours.
const offValues = new Set(["off", "disable", "disabled", "none", "0"]);
export function sessionDurationMs(raw: string): number {
  const text = raw.trim().toLowerCase();
  if (offValues.has(text)) return 0;
  const match = /^(\d+(?:\.\d+)?)(m|h|d)?$/.exec(text);
  if (!match) throw new Error("Use a duration such as 30m, 24h or 7d, or off.");
  const unit = match[2] ?? "h", factor = unit === "m" ? 60_000 : unit === "d" ? 86400_000 : 3600_000;
  const ms = Number(match[1]) * factor;
  if (!Number.isSafeInteger(ms) || ms < 60_000 || ms > maximumMs) throw new Error("Choose between one minute and 365 days, or off.");
  return ms;
}
export function chatThreadLifecycle(store: Store, owner: string, channel: string, chatId: string): ChatThreadLifecycle {
  const parsed = LifecycleSchema.safeParse(store.get("settings", owner, keyFor(channel, chatId))?.data ?? {});
  return parsed.success ? parsed.data : LifecycleSchema.parse({});
}
export function saveChatThreadLifecycle(store: Store, owner: string, channel: string, chatId: string,
  change: Partial<ChatThreadLifecycle>): ChatThreadLifecycle {
  store.profiles.requireOwner("Changing a chat's session expiry");
  const next = LifecycleSchema.parse({ ...chatThreadLifecycle(store, owner, channel, chatId), ...change });
  store.save("settings", owner, keyFor(channel, chatId), next);
  return next;
}

/** OpenClaw's earliest-expiry calculation, adapted to Branch's saved thread and immutable session start. */
export function expireChatThread(store: Store, owner: string, channel: string, chatId: string, now = Date.now()): string | null {
  const saved = chatThread(store, owner, channel, chatId);
  if (!saved?.sessionId || !store.ownsSession(owner, saved.sessionId)) return null;
  const policy = chatThreadLifecycle(store, owner, channel, chatId);
  if (!policy.idleTimeoutMs && !policy.maxAgeMs) return null;
  if (store.sqlite.prepare("SELECT id FROM tasks WHERE session_id=? AND owner=? AND status IN ('running','needs_input') LIMIT 1")
    .get(saved.sessionId, owner)) return null;
  const session = store.sqlite.prepare("SELECT created_at FROM sessions WHERE id=? AND owner=?").get(saved.sessionId, owner);
  const boundAt = Date.parse(String(session?.created_at ?? ""));
  if (!Number.isFinite(boundAt) || !Number.isFinite(now)) return null;
  const updated = Date.parse(saved.updatedAt), lastActivity = Number.isFinite(updated) ? Math.max(updated, boundAt) : boundAt;
  const deadlines = [
    ...(policy.idleTimeoutMs ? [{ at: lastActivity + policy.idleTimeoutMs, reason: "idle limit" }] : []),
    ...(policy.maxAgeMs ? [{ at: boundAt + policy.maxAgeMs, reason: "maximum age" }] : []),
  ].sort((a, b) => a.at - b.at);
  if (!deadlines[0] || now < deadlines[0].at) return null;
  freshThread(store, owner, channel, chatId);
  return deadlines[0].reason;
}
