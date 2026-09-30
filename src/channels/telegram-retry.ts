/**
 * How the Telegram adapter waits after Telegram turns a request away.
 *
 * - "Too many requests" carries `parameters.retry_after`: wait exactly that long, then ask again. A group that became a
 *   supergroup carries `parameters.migrate_to_chat_id`: ask again at once with the new chat id. A server error or a
 *   network failure backs off. Adapted from grammY's auto-retry (`src/mod.ts`, https://github.com/grammyjs/auto-retry,
 *   MIT, Copyright (c) 2021-2024 KnorpelSenf).
 * - 409 Conflict on getUpdates means another program reads this bot (a second poller, or a webhook still set): the
 *   webhook is removed and polling backs off from 30 seconds up to ten minutes with jitter. Adapted from OpenClaw's
 *   `extensions/telegram/src/polling-session-restart-policy.ts` and `polling-session.ts`
 *   (https://github.com/openclaw/openclaw, MIT, Copyright (c) 2026 OpenClaw Foundation).
 */
export interface BackoffPolicy { initialMs: number; maxMs: number; factor: number; jitter: number }

/** 409 Conflict: another poller or a webhook (OpenClaw's TELEGRAM_POLL_RESTART_POLICY). */
export const conflictBackoff: BackoffPolicy = { initialMs: 30_000, maxMs: 600_000, factor: 2, jitter: 0.2 };
/** A poll that failed for any other reason (a server error, the network): 2 s, 4 s, 8 s ... up to a minute. */
export const pollBackoff: BackoffPolicy = { initialMs: 2_000, maxMs: 60_000, factor: 2, jitter: 0 };

/** The wait before try number `attempt` (1 for the first retry), with up to `jitter` of it added at random. */
export function backoffDelay(policy: BackoffPolicy, attempt: number, random = Math.random): number {
  const base = Math.min(policy.maxMs, policy.initialMs * policy.factor ** Math.max(0, attempt - 1));
  return Math.round(Math.min(policy.maxMs, base * (1 + policy.jitter * random())));
}

/** What a refused Telegram request carried, on the error thrown for it. */
export interface TelegramFailure {
  /** The HTTP status; absent when Telegram was never reached (the network failed). */
  status?: number;
  /** Seconds Telegram asked to be left alone (429 Too Many Requests). */
  retryAfter?: number;
  /** The chat's new id after a group became a supergroup. */
  migrateTo?: number;
  description?: string;
}

export function telegramFailure(method: string, status: number,
  parsed: { description?: string | undefined; parameters?: { retry_after?: number | undefined; migrate_to_chat_id?: number | undefined } | undefined }): Error & TelegramFailure {
  const wait = parsed.parameters?.retry_after, moved = parsed.parameters?.migrate_to_chat_id;
  return Object.assign(new Error(`Telegram ${method} failed: ${parsed.description ?? status}`), {
    status, ...(parsed.description ? { description: parsed.description } : {}),
    ...(typeof wait === "number" && wait > 0 ? { retryAfter: wait } : {}),
    ...(typeof moved === "number" ? { migrateTo: moved } : {}),
  });
}

/**
 * The longest "too many requests" wait sat out inside one request. A longer one is thrown with `retryAfter`, so the
 * delivery ledger schedules the message for then and a live status pauses, rather than one send holding up every
 * channel's sends behind it.
 */
export const maxInCallWaitSeconds = 5;
/** Requests safe to repeat after a server error or a lost connection: asking twice does no harm. */
export const repeatable = new Set(["getMe", "getFile", "answerCallbackQuery", "setMessageReaction", "editMessageText",
  "setMyShortDescription", "deleteWebhook"]);
