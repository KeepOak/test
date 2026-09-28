import { saveProgressAt, shareLeft } from "./usage-glance.js";
import type { LimitRow } from "./usage-limits.js";

/**
 * The owner's request (2026-09-27): "For all the platforms that offer resets, we need a way to offer that too from the
 * app usage bar." What each service offers when a plan runs out, in its own words, and the one page where the owner does
 * it. Researched from each provider's own documentation on 2026-09-27 (briefs/status/usage-resets.md holds the table and
 * every source). An entry is here only when its page was confirmed on an official source; the others are in the notes.
 *
 * Nothing here buys anything. No provider offers an API that adds usage, and Branch never fills in a checkout: the
 * action only opens the provider's own page in the owner's browser, where the owner decides. The desktop window opens
 * these exact pages and no others (src/desktop/updater-ipc.ts, isOfferUrl).
 */
export type OfferTrigger =
  /** A plan window measured at 95% used or more, or the sign-in said it reached its plan limit. */
  | "plan"
  /** The service refused the last request for want of credit (HTTP 402, documented by the service). */
  | "credit";

export interface OfferEntry {
  /** Also the word key the window says it with: glance.offer.<id>. */
  id: string;
  /** The rows it applies to: a sign-in's list ("chatgpt", "cli-claude-code") or a key's catalogue id ("openrouter"). */
  providers: readonly string[];
  /** The option's name in the provider's own words. */
  option: string;
  /** The provider's page for it. Opened as it is: no account or email is ever put into it. */
  url: string;
  trigger: OfferTrigger;
  /** Where the option and the page were confirmed. */
  source: string;
}

export const usageOffers: readonly OfferEntry[] = [
  { id: "claude", providers: ["cli-claude-code"], option: "Usage credits", url: "https://claude.ai/settings/usage", trigger: "plan",
    source: "https://support.claude.com/en/articles/12429409-manage-extra-usage-for-paid-claude-plans" },
  { id: "chatgpt", providers: ["chatgpt", "cli-codex"], option: "Credits", url: "https://chatgpt.com/codex/settings/usage", trigger: "plan",
    source: "https://learn.chatgpt.com/docs/pricing" },
  { id: "copilot", providers: ["cli-copilot"], option: "Budget for GitHub AI Credits", url: "https://github.com/settings/billing", trigger: "plan",
    source: "https://docs.github.com/en/billing/how-tos/set-up-budgets" },
  { id: "openrouter", providers: ["openrouter"], option: "Credits", url: "https://openrouter.ai/settings/credits", trigger: "credit",
    source: "https://openrouter.ai/docs/faq" },
];

/** What a row carries when its service offers more: the entry's id, its page, and the option in the provider's words. */
export interface UsageOffer { id: string; url: string; option: string }

const exact = (url: string): string | null => {
  try { const u = new URL(url); return u.protocol === "https:" && !u.username && !u.password && !u.search && !u.hash ? u.origin + u.pathname : null; } catch { return null; }
};
/** True only for one of the catalogue's pages, exactly: never a prefix, a lookalike, or the page with anything added to it. */
export function isOfferUrl(url: unknown): boolean {
  if (typeof url !== "string") return false;
  const wanted = exact(url);
  return wanted !== null && usageOffers.some((entry) => exact(entry.url) === wanted);
}

export const offerEntryFor = (provider: string | undefined): OfferEntry | null =>
  provider ? usageOffers.find((entry) => entry.providers.includes(provider)) ?? null : null;

/** A plan window a service measured at 95% used or more, whose refill time has not passed yet. */
function planNearLimit(row: LimitRow, now: number): boolean {
  return row.windows.some((window) => {
    const share = shareLeft(window);
    const refilled = window.resetAt !== null && Date.parse(window.resetAt) <= now;
    return window.kind === "plan" && window.state === "measured" && share !== null && 100 - share >= saveProgressAt && !refilled;
  });
}
/** Whether a row is at or near its limit, by what the service said: its plan window, its plan limit, or no credit left. */
export function atOrNearLimit(row: LimitRow, now: number): boolean {
  return row.limited === true || row.outOfCredit === true || planNearLimit(row, now);
}

/** The offer for one row, or null: only where its service offers more and the row is at or near its limit. */
export function offerFor(row: LimitRow, now: number): UsageOffer | null {
  const entry = offerEntryFor(row.provider);
  if (!entry) return null;
  const due = entry.trigger === "credit" ? row.outOfCredit === true : row.limited === true || planNearLimit(row, now);
  return due ? { id: entry.id, url: entry.url, option: entry.option } : null;
}

/** The rows with each one's offer, and "near its limit" marked for the rows the pool's sentence is shown on. */
export function withOffers(rows: LimitRow[], now: number): LimitRow[] {
  return rows.map((row) => {
    const offer = offerFor(row, now), near = atOrNearLimit(row, now);
    return { ...row, ...(near ? { limitNear: true as const } : {}), ...(offer ? { offer } : {}) };
  });
}
