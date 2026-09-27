import { spawn } from "node:child_process";
import { chatgptAccountId, chatgptDefaults, type ChatGPTAuth } from "../chatgpt-auth.js";
import type { PlanWindowSaid } from "../rate-limit-headers.js";
import { startCall } from "../windows-command.js";

/**
 * What a plan sign-in has left, read on request from the service itself, without sending a message (so nothing of the
 * plan is spent). Each source is the one the service's own program uses for its own usage screen:
 *
 * - ChatGPT: `GET https://chatgpt.com/backend-api/wham/usage`, which OpenAI's Codex asks for its /status screen, with
 *   the sign-in Branch already holds. It answers `rate_limit.primary_window` / `secondary_window`, each with
 *   `used_percent`, `limit_window_seconds` and `reset_at` (Unix seconds).
 * - Claude Code: Branch never reads Claude Code's sign-in; it runs the `claude` program and asks it, over the program's
 *   own stream-json control channel (the one Anthropic's Agent SDK uses), for `get_usage`. The program reads its own
 *   plan usage and answers `rate_limits.five_hour` / `seven_day`, each `{ utilization (percent, 0 to 100), resets_at
 *   (ISO) }`, the same figures `/usage` prints. No prompt is sent. Only that one answer line is read; the rest the
 *   program prints (its activity statistics included) is dropped unread.
 */

/* ---------- ChatGPT ---------- */

export const chatgptUsageUrl = "https://chatgpt.com/backend-api/wham/usage";
interface WindowBody { used_percent?: unknown; limit_window_seconds?: unknown; reset_at?: unknown }

function chatgptWindow(id: "primary" | "secondary", body: WindowBody | null | undefined, now: number): PlanWindowSaid | null {
  const used = Number(body?.used_percent);
  if (!body || typeof body !== "object" || body.used_percent === undefined || body.used_percent === null || !Number.isFinite(used)) return null;
  const seconds = Number(body.limit_window_seconds), reset = Number(body.reset_at);
  return { id, usedPercent: Math.max(0, Math.min(100, used)), minutes: Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds / 60) : null,
    resetAt: Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000).toISOString() : null, measuredAt: new Date(now).toISOString() };
}
/** The windows in ChatGPT's usage answer. An answer in any other shape gives none: no share is ever guessed. */
export function chatgptUsageWindows(body: unknown, now: number): PlanWindowSaid[] {
  const limit = body && typeof body === "object" ? (body as { rate_limit?: { primary_window?: WindowBody; secondary_window?: WindowBody } }).rate_limit : undefined;
  if (!limit || typeof limit !== "object") return [];
  return [chatgptWindow("primary", limit.primary_window, now), chatgptWindow("secondary", limit.secondary_window, now)].filter((w) => w !== null);
}

export const chatgptUnread = (why: string): string => `ChatGPT did not say what is left just now (${why}), so the last reading is shown.`;

/** One read of a ChatGPT sign-in's plan usage, through the same sign-in (and its token refresh) its answers use. */
export async function readChatGPTUsage(auth: ChatGPTAuth, fetchImpl: typeof fetch, userAgent: string, now: () => number): Promise<PlanWindowSaid[]> {
  const token = await auth.accessToken();
  const accountId = chatgptAccountId(token);
  let response: Response;
  try {
    response = await fetchImpl(chatgptUsageUrl, {
      method: "GET", redirect: "error", signal: AbortSignal.timeout(20_000),
      headers: { authorization: `Bearer ${token}`, accept: "application/json", originator: chatgptDefaults.originator, "user-agent": userAgent,
        ...(accountId ? { "chatgpt-account-id": accountId } : {}) },
    });
  } catch { throw new Error(chatgptUnread("it could not be reached")); }
  if (!response.ok) throw new Error(chatgptUnread(`HTTP ${response.status}`));
  const windows = chatgptUsageWindows(await response.json().catch(() => null), now());
  if (!windows.length) throw new Error(chatgptUnread("its answer named no window"));
  return windows;
}

/* ---------- Claude Code ---------- */

interface ClaudeLimit { utilization?: unknown; resets_at?: unknown }
export interface ClaudeUsageAnswer { rateLimitsAvailable: boolean; rateLimits: Record<string, ClaudeLimit | null> | null }
/** Runs the program with this environment and hands back its `get_usage` answer, or throws a sentence. */
export type ClaudeUsageRead = (env: NodeJS.ProcessEnv) => Promise<ClaudeUsageAnswer>;

const claudeWindows = { five_hour: 300, seven_day: 10080 } as const;
/**
 * The 5-hour and weekly windows of Claude Code's `get_usage` answer. Here `utilization` is a percent (0 to 100) and
 * `resets_at` an ISO time; the `rate_limit_event` lines of its answers say a fraction and Unix seconds instead
 * (src/plan-windows.ts). The ids are the same, so a reading from either replaces the other.
 */
export function claudeUsageWindows(answer: ClaudeUsageAnswer, now: number): PlanWindowSaid[] {
  const out: PlanWindowSaid[] = [];
  for (const [id, minutes] of Object.entries(claudeWindows)) {
    const one = answer.rateLimits?.[id];
    const used = one && typeof one.utilization === "number" && Number.isFinite(one.utilization) ? one.utilization : null;
    if (used === null) continue;
    const reset = typeof one!.resets_at === "string" && Number.isFinite(Date.parse(one!.resets_at)) ? new Date(one!.resets_at).toISOString() : null;
    out.push({ id, usedPercent: Math.max(0, Math.min(100, used)), minutes, resetAt: reset, measuredAt: new Date(now).toISOString() });
  }
  return out;
}

export const claudeNoLimits = "Claude Code did not give its limits just now. Its sign-in may have run out: run claude in a terminal to sign in again.";
export const claudeUnread = (why: string): string => `Claude Code did not say what is left just now (${why}), so the last reading is shown.`;

/**
 * The program started to answer one question about itself: no hooks of the owner's, no tool servers, nothing written
 * to its history. `-p` with stream-json in and out keeps it on its control channel; no prompt is ever written to it.
 */
export const claudeUsageArgs: readonly string[] = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
  "--settings", JSON.stringify({ disableAllHooks: true }), "--strict-mcp-config", "--no-session-persistence"];
const claudeUsageTimeoutMs = 120_000;
const requestLine = (id: string, subtype: string): string => `${JSON.stringify({ type: "control_request", request_id: id, request: { subtype } })}\n`;

/** The `get_usage` answer in one printed line, or null when the line is anything else. */
export function claudeUsageAnswer(line: string): ClaudeUsageAnswer | "refused" | null {
  if (!line.includes("\"control_response\"") || !line.includes("\"branch-usage\"")) return null;
  let parsed: { type?: unknown; response?: { subtype?: unknown; request_id?: unknown; response?: Record<string, unknown> } };
  try { parsed = JSON.parse(line); } catch { return null; }
  if (parsed.type !== "control_response" || parsed.response?.request_id !== "branch-usage") return null;
  if (parsed.response.subtype !== "success") return "refused";
  const body = parsed.response.response ?? {};
  const limits = body.rate_limits;
  return { rateLimitsAvailable: body.rate_limits_available === true,
    rateLimits: limits && typeof limits === "object" ? limits as Record<string, ClaudeLimit | null> : null };
}

export const runClaudeUsage: ClaudeUsageRead = (env) => new Promise((resolve, reject) => {
  const start = startCall("claude", [...claudeUsageArgs], env);
  const child = spawn(start.command, start.args, { stdio: ["pipe", "pipe", "ignore"], windowsHide: true, shell: false, env });
  let done = false, partial = "";
  const finish = (error: Error | null, answer?: ClaudeUsageAnswer): void => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    child.kill();
    if (error) reject(error); else resolve(answer!);
  };
  const timer = setTimeout(() => finish(new Error(claudeUnread("it took longer than two minutes"))), claudeUsageTimeoutMs);
  timer.unref?.();
  child.on("error", (error: NodeJS.ErrnoException) => finish(new Error(error.code === "ENOENT"
    ? "\"claude\" is not on this computer, so Branch cannot ask Claude Code what is left." : claudeUnread("it could not be started"))));
  child.on("close", () => finish(new Error(claudeUnread("it closed without answering"))));
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    const lines = (partial + chunk).split("\n");
    partial = lines.pop() ?? "";
    if (partial.length > 1_000_000) partial = ""; // one line that never ends is not an answer
    for (const line of lines) {
      const answer = claudeUsageAnswer(line);
      if (answer === "refused") finish(new Error(claudeUnread("it refused the question")));
      else if (answer) finish(null, answer);
    }
  });
  child.stdin.on("error", () => undefined);
  // The program's own start-up handshake first, as the Agent SDK sends it, then the one question.
  child.stdin.write(requestLine("branch-start", "initialize"));
  child.stdin.write(requestLine("branch-usage", "get_usage"));
});
