/**
 * mac7/usage-bar: reading the allowance a service reports in the headers of its own answers.
 *
 * Branch already made the request; reading what came back is not a separate act, and it costs the
 * owner nothing. That is the whole of what this file does. It never asks a service a question only
 * to read the answer's headers, because on a plan account that question spends the very allowance
 * it is measuring.
 *
 * Two things here are easy to get wrong and are therefore written out carefully:
 *
 * - **Reset values are not all seconds.** OpenAI and Groq document Go-style durations (`1s`, `6m0s`,
 *   `6ms`); Anthropic documents RFC 3339 instants; `Retry-After` is either a count of seconds or an
 *   HTTP date. Anything not recognised becomes `null` — "we were not told" — never a wrong number.
 * - **`6ms` is six milliseconds, not six minutes.** The units are matched longest first for exactly
 *   that reason; getting it the other way round would report a reset 360,000 times too far away.
 */

/** One named allowance a service reports: so many requests, or so many tokens, in a window. */
export interface RateLimitWindow {
  /** Short name, stable enough for a screen to key on: "requests", "tokens", "input-tokens", … */
  id: string;
  /** Plain words for the screen. */
  title: string;
  /** What it counts: requests or tokens, or (ChatGPT's plan window) a share of a plan, limit 100. */
  counts: "requests" | "tokens" | "plan";
  limit: number | null;
  remaining: number | null;
  /** When the allowance refills, as an instant, when the service said. */
  resetAt: string | null;
  /** The same moment as seconds from now, for callers that want a countdown. */
  resetSeconds: number | null;
  /** Which family of headers this came from, so a screen can say where the number is from. */
  source: string;
  /** When Branch read it. Every number on this screen carries its age. */
  measuredAt: string;
}

/**
 * The allowance a service reports, in whichever of the usual header spellings it uses.
 *
 * `windows` is the whole of what was said. `limit`, `remaining` and `resetSeconds` are the requests
 * window flattened, kept because the connection dashboard has read them that way since wave 8.
 */
export interface RateLimitReading {
  windows: RateLimitWindow[];
  limit: number | null;
  remaining: number | null;
  resetSeconds: number | null;
}

const goUnits: [string, number][] = [
  ["ns", 1e-9], ["us", 1e-6], ["µs", 1e-6], ["μs", 1e-6], ["ms", 1e-3],
  ["h", 3600], ["m", 60], ["s", 1],
];
const goDuration = /^-?(?:\d+(?:\.\d+)?(?:ns|us|µs|μs|ms|h|m|s))+$/;
const goPart = /(\d+(?:\.\d+)?)(ns|us|µs|μs|ms|h|m|s)/g;
const rfc3339 = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/;
const httpDate = /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/** A Go-style duration (`1s`, `6m0s`, `500ms`, `1h2m3s`) as seconds, or null when it is not one. */
export function goDurationSeconds(value: string): number | null {
  const text = value.trim();
  if (!goDuration.test(text)) return null;
  let total = 0;
  goPart.lastIndex = 0;
  for (let match = goPart.exec(text); match; match = goPart.exec(text))
    total += Number(match[1]) * (goUnits.find(([unit]) => unit === match![2])?.[1] ?? 0);
  return text.startsWith("-") ? -total : total;
}

/** An instant a service named: RFC 3339 (Anthropic) or an HTTP date (`Retry-After`). */
function instantFrom(value: string): number | null {
  const text = value.trim();
  if (!rfc3339.test(text) && !httpDate.test(text)) return null;
  const at = Date.parse(text);
  return Number.isFinite(at) ? at : null;
}

/**
 * A reset value in any of the documented forms, as the moment the allowance refills.
 * Returns null — honestly — for anything not recognised.
 */
export function resetInstant(value: string | null, now: number): number | null {
  if (value === null) return null;
  const text = value.trim();
  if (text === "") return null;
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return now + Number(text) * 1000;
  const duration = goDurationSeconds(text);
  if (duration !== null) return now + duration * 1000;
  return instantFrom(text);
}

const countFrom = (value: string | null): number | null => {
  if (value === null) return null;
  const parsed = Number(value.trim().replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
};

interface Family { id: string; title: string; counts: "requests" | "tokens"; source: string; names: [string[], string[], string[]] }

/** One family per spelling a service is documented to use. Nothing here is guessed at. */
const families: Family[] = [
  { id: "requests", title: "Requests", counts: "requests", source: "x-ratelimit-* headers",
    names: [["x-ratelimit-limit-requests", "x-ratelimit-limit", "ratelimit-limit"],
      ["x-ratelimit-remaining-requests", "x-ratelimit-remaining", "ratelimit-remaining"],
      ["x-ratelimit-reset-requests", "x-ratelimit-reset", "ratelimit-reset"]] },
  { id: "tokens", title: "Tokens", counts: "tokens", source: "x-ratelimit-* headers",
    names: [["x-ratelimit-limit-tokens"], ["x-ratelimit-remaining-tokens"], ["x-ratelimit-reset-tokens"]] },
  { id: "project-tokens", title: "Tokens in this project", counts: "tokens", source: "x-ratelimit-* headers",
    names: [["x-ratelimit-limit-project-tokens"], ["x-ratelimit-remaining-project-tokens"], ["x-ratelimit-reset-project-tokens"]] },
  { id: "requests", title: "Requests", counts: "requests", source: "anthropic-ratelimit-* headers",
    names: [["anthropic-ratelimit-requests-limit"], ["anthropic-ratelimit-requests-remaining"], ["anthropic-ratelimit-requests-reset"]] },
  { id: "tokens", title: "Tokens", counts: "tokens", source: "anthropic-ratelimit-* headers",
    names: [["anthropic-ratelimit-tokens-limit"], ["anthropic-ratelimit-tokens-remaining"], ["anthropic-ratelimit-tokens-reset"]] },
  { id: "input-tokens", title: "Input tokens", counts: "tokens", source: "anthropic-ratelimit-* headers",
    names: [["anthropic-ratelimit-input-tokens-limit"], ["anthropic-ratelimit-input-tokens-remaining"], ["anthropic-ratelimit-input-tokens-reset"]] },
  { id: "output-tokens", title: "Output tokens", counts: "tokens", source: "anthropic-ratelimit-* headers",
    names: [["anthropic-ratelimit-output-tokens-limit"], ["anthropic-ratelimit-output-tokens-remaining"], ["anthropic-ratelimit-output-tokens-reset"]] },
  { id: "priority-input-tokens", title: "Priority input tokens", counts: "tokens", source: "anthropic-priority-* headers",
    names: [["anthropic-priority-input-tokens-limit"], ["anthropic-priority-input-tokens-remaining"], ["anthropic-priority-input-tokens-reset"]] },
  { id: "priority-output-tokens", title: "Priority output tokens", counts: "tokens", source: "anthropic-priority-* headers",
    names: [["anthropic-priority-output-tokens-limit"], ["anthropic-priority-output-tokens-remaining"], ["anthropic-priority-output-tokens-reset"]] },
];

const pick = (headers: Headers, names: string[]): string | null => {
  for (const name of names) { const value = headers.get(name); if (value !== null) return value; }
  return null;
};

/**
 * The plan window a ChatGPT sign-in reports on each answer: `x-codex-primary-used-percent` (the share used) and
 * `x-codex-primary-reset-at` (when it refills, in Unix seconds, not seconds from now). These are the headers Codex
 * reads (openai/codex, codex-rs/codex-api/src/rate_limits.rs); OpenAI does not document them, so they may go away.
 */
function planWindowFrom(headers: Headers, now: number): RateLimitWindow | null {
  const used = countFrom(headers.get("x-codex-primary-used-percent"));
  if (used === null) return null;
  const resetSeconds = countFrom(headers.get("x-codex-primary-reset-at"));
  const resetAt = resetSeconds === null || resetSeconds <= 0 ? null : resetSeconds * 1000;
  return { id: "plan", title: "Plan window", counts: "plan", limit: 100, remaining: Math.max(0, Math.min(100, 100 - used)),
    resetAt: resetAt === null ? null : new Date(resetAt).toISOString(),
    resetSeconds: resetAt === null ? null : Math.round((resetAt - now) / 1000),
    source: "x-codex-primary-* headers", measuredAt: new Date(now).toISOString() };
}

/**
 * Every allowance a service reported in one answer's headers, or null when it reported none.
 * The clock is a parameter so a test can say what "now" is.
 */
export function readRateLimit(headers: Headers, now: number = Date.now()): RateLimitReading | null {
  const at = new Date(now).toISOString();
  const windows: RateLimitWindow[] = [];
  for (const family of families) {
    const [limitNames, remainingNames, resetNames] = family.names;
    const limit = countFrom(pick(headers, limitNames));
    const remaining = countFrom(pick(headers, remainingNames));
    const resetAt = resetInstant(pick(headers, resetNames), now);
    if (limit === null && remaining === null && resetAt === null) continue;
    windows.push({ id: family.id, title: family.title, counts: family.counts, limit, remaining,
      resetAt: resetAt === null ? null : new Date(resetAt).toISOString(),
      resetSeconds: resetAt === null ? null : Math.round((resetAt - now) / 1000),
      source: family.source, measuredAt: at });
  }
  const plan = planWindowFrom(headers, now);
  if (plan) windows.push(plan);
  /* "Wait this long" is the only thing some services say. It is an allowance reading too. */
  const wait = resetInstant(headers.get("retry-after"), now);
  if (wait !== null && !windows.some((window) => window.resetAt !== null))
    windows.push({ id: "retry-after", title: "Asked us to wait", counts: "requests", limit: null, remaining: null,
      resetAt: new Date(wait).toISOString(), resetSeconds: Math.round((wait - now) / 1000),
      source: "retry-after header", measuredAt: at });
  if (!windows.length) return null;
  const first = windows.find((window) => window.counts === "requests") ?? windows[0]!;
  return { windows, limit: first.limit, remaining: first.remaining, resetSeconds: first.resetSeconds };
}

/* ---------- a subscription's windows, as the official clients read them ---------- */

/**
 * One window of a subscription plan, exactly as the service said it: the share used, how long the
 * window is, and when it refills. `minutes` and `resetAt` are null when the service did not say.
 */
export interface PlanWindowSaid {
  /** "primary" / "secondary" (ChatGPT) or "five_hour" / "seven_day" (Claude). */
  id: string;
  usedPercent: number;
  minutes: number | null;
  resetAt: string | null;
  measuredAt: string;
}

const planHeader = (headers: Headers, name: string): number | null => {
  const value = headers.get(name);
  if (value === null || value.trim() === "") return null;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * Both plan windows a ChatGPT sign-in reports on each answer, read the way Codex reads them
 * (openai/codex, codex-rs/codex-api/src/rate_limits.rs, `parse_rate_limit_for_limit`):
 * `x-codex-{primary,secondary}-used-percent`, `-window-minutes` and `-reset-at` (Unix seconds).
 * Like Codex, a window whose used share is missing is not a window, and one that says 0% used with
 * no length and no reset says nothing. OpenAI does not document these headers, so they may go away.
 */
export function codexPlanWindows(headers: Headers, now: number): PlanWindowSaid[] {
  const out: PlanWindowSaid[] = [];
  for (const id of ["primary", "secondary"] as const) {
    const used = planHeader(headers, `x-codex-${id}-used-percent`);
    if (used === null) continue;
    const minutes = planHeader(headers, `x-codex-${id}-window-minutes`);
    const resetSeconds = planHeader(headers, `x-codex-${id}-reset-at`);
    if (used === 0 && !minutes && resetSeconds === null) continue;
    out.push({ id, usedPercent: Math.max(0, Math.min(100, used)), minutes: minutes && minutes > 0 ? Math.round(minutes) : null,
      resetAt: resetSeconds !== null && resetSeconds > 0 ? new Date(resetSeconds * 1000).toISOString() : null,
      measuredAt: new Date(now).toISOString() });
  }
  return out;
}
