import { z } from "zod";
import { FeatureModeSchema, modeOf, optionalFields, settleSwitch, type FeatureMode } from "./feature-switches.js";
import type { Store } from "./store.js";
import { unsetRecord } from "./ship-on.js";
import type { RateLimitReading } from "./rate-limit-headers.js";

/**
 * mac7/usage-bar: how much of each service's allowance is left, for every connection attached.
 *
 * The rule the whole feature exists for: **Branch shows what it was told, says who told it, says
 * when, and says plainly where it was told nothing.** Every other product in this space fills the
 * silence with arithmetic of its own and prints it in the same typeface as a real number. Branch
 * does not. A row is in exactly one of three states, and a reader learns the vocabulary once:
 *
 *   measured       a service said this, in a header on Branch's own traffic or at an endpoint it
 *                  documents and Branch is allowed to call
 *   estimated      Branch worked it out from its own counting; the row says so and says from what
 *   not published  the service publishes nothing Branch may lawfully read. This is a good answer,
 *                  not an error, and it renders as a sentence with no bar at all
 *
 * What Branch will never do to fill a row, whatever other menu-bar apps do: read another
 * application's credential file or Keychain item, import browser cookies, call an endpoint the
 * provider has not documented, drive a provider's own program to harvest a figure it prints, or
 * make a request whose only purpose is to read the headers that come back — on a plan account that
 * request spends the very allowance it is measuring.
 */

export const limitStates = ["measured", "estimated", "not_published"] as const;
export type LimitState = (typeof limitStates)[number];

export interface LimitWindow {
  id: string;
  title: string;
  /** What the window counts. Money has no denominator a provider gave us, so it is never a share. */
  kind: "requests" | "tokens" | "money" | "plan";
  limit: number | null;
  remaining: number | null;
  /** When it refills, as the service said, never as a guess. */
  resetAt: string | null;
  /** When Branch read it, so every number on the screen carries its age. */
  measuredAt: string | null;
  /** Whether this one window was said or worked out. A row can hold both kinds. */
  state: LimitState;
  /** Where the number came from, in words the owner can check: "from the response headers". */
  from: string;
}

export interface LimitRow {
  /** The connection, or for a sign-in the list its models share ("chatgpt", "cli-claude-code"): one row per account, not per model. */
  connection: string;
  connectionName: string;
  /** Every model connection this row speaks for, so a screen can find the row for the model in use. */
  presets: string[];
  /** A plan sign-in: its windows are measured per account, and "Measure now" may ask it. */
  signIn: boolean;
  /** The account inside a pool, when a connection has several. Never the key, never a token. */
  account: string | null;
  accountLabel: string | null;
  /** True for the account this connection would use next. Marked, never merged. */
  inUse: boolean;
  state: LimitState;
  windows: LimitWindow[];
  /** The sentence shown when there is no bar, and the footnote when there is. */
  note: string;
  /** Present (true) when Check now reads this row's plan from the service itself (POST /api/usage/limits/refresh). */
  readable?: true;
  /** The service this row is paid through: a sign-in's list ("chatgpt", "cli-claude-code") or a key's catalogue id. */
  provider?: string;
  /** The sign-in said it reached its plan limit, and that limit has not refilled yet. */
  limited?: true;
  /** accountLabel is the sign-in's verified email or name. */
  verified?: true;
  /** The service refused this key's last request for want of credit (HTTP 402). */
  outOfCredit?: true;
  /** This account's list moves the work to its next account when one reaches its limit (src/accounts/pool-provider.ts). */
  switches?: true;
  /** At or near its limit, by what the service said (src/usage-offers.ts atOrNearLimit). */
  limitNear?: true;
  /** What the service offers for more usage, where it offers any and the row is at or near its limit (src/usage-offers.ts). */
  offer?: { id: string; url: string; option: string };
}

export interface LimitsView {
  rows: LimitRow[];
  /** "3 of 5 connections report a limit. The other 2 do not publish one." */
  summary: string;
  /** True when nothing is attached at all, so the screen shows a sentence and a link, not a zero. */
  empty: boolean;
}

export const notPublished = "This service does not say what it allows.";
export const runsHere = "Runs on this computer. There is no limit to report.";
export const notMeasured = "Not measured yet. It shows after this account's next message.";
export const noLimitReported = "No limit reported.";

/* ---------- the switch ---------- */

/**
 * Only the asking is behind a switch. Reading a header on an answer Branch already received costs
 * nothing and asks nobody anything, so it is always on. Asking OpenRouter its key's allowance on a
 * timer ships "when needed" too (the owner's rule, 2026-09-27): it reads the owner's own connection's
 * usage from its documented, free endpoint and sends nothing of the owner's out, so it is none of (a)–(f).
 */
export const usageLimitsShipsAs: FeatureMode = "when-needed";
export const UsageLimitsSettingsSchema = z.object({
  mode: FeatureModeSchema.default("off"),
  enabled: z.boolean().default(false),
}).strict();
export type UsageLimitsSettings = z.infer<typeof UsageLimitsSettingsSchema>;
const settingsKey = "usage-limits";

export function usageLimitsSettings(store: Pick<Store, "get">, owner: string): UsageLimitsSettings {
  const data = store.get("settings", owner, settingsKey)?.data;
  // Nothing saved reads as it ships; this record holds only its switch, so a saved "off" was the owner's (src/ship-on.ts).
  if (unsetRecord(data)) return { mode: usageLimitsShipsAs, enabled: true };
  const saved = UsageLimitsSettingsSchema.safeParse(data);
  const value = saved.success ? saved.data : UsageLimitsSettingsSchema.parse({});
  const mode: FeatureMode = modeOf(value);
  return { ...value, mode, enabled: mode !== "off" };
}

export function saveUsageLimitsSettings(store: Pick<Store, "get" | "save">, owner: string, input: unknown): UsageLimitsSettings {
  const current = usageLimitsSettings(store, owner);
  const wanted = optionalFields(UsageLimitsSettingsSchema).parse(input ?? {});
  const next = UsageLimitsSettingsSchema.parse({ ...current, ...wanted, ...settleSwitch(current, wanted) });
  store.save("settings", owner, settingsKey, next);
  return next;
}

/* ---------- building the rows ---------- */

/** What a polled source last handed back, already in the shape a row wants. */
export interface PolledReading { windows: LimitWindow[]; note: string | null }

export interface LimitsConnection {
  id: string;
  name: string;
  /** True when the model runs on this computer, so there is no allowance to speak of. */
  local: boolean;
  /** The list this connection's accounts belong to; connections in one list share one row per account. */
  group?: string;
  /** The service's plan name for a sign-in ("ChatGPT plan"), shown instead of the model's name. */
  planName?: string;
  /** A plan sign-in, measured per account from what the service says on its answers. */
  signIn?: boolean;
  /** Paid by API key: no reading means "No limit reported". */
  keyed?: boolean;
  /** The service it is paid through (LimitRow.provider). */
  provider?: string;
  /** The service refused its last request for want of credit (HTTP 402). */
  outOfCredit?: boolean;
}
export interface LimitsAccount {
  account: string;
  label: string;
  inUse: boolean;
  /** Share of the plan window left, 0 to 100, **only when the service reported it**. */
  remaining: number | null;
  /** True for a subscription sign-in, whose plan window no provider publishes an endpoint for. */
  signIn: boolean;
  /** When the plan window refills, only when the service said. */
  resetAt?: string | null;
  /** This account's own windows as the service said them (every plan window, or a key's own headers). */
  windows?: LimitWindow[];
  /** Its plan can be read from the service on request, sending no message (POST /api/usage/limits/refresh). */
  readable?: boolean;
  /** Why the last such read gave no figure, in the engine's words. */
  note?: string | null;
  /** It said it reached its plan limit, and the limit has not refilled yet. */
  limited?: boolean;
  /** Its list moves on to the next account at a limit. */
  switches?: boolean;
  /** Its label is who the service said the sign-in is (its email or name), not a name Branch or the owner gave it. */
  verified?: boolean;
}
export interface LimitsDeps {
  connections: LimitsConnection[];
  /** The last allowance this connection reported on traffic Branch was making anyway. */
  reading: (connection: string) => RateLimitReading | null;
  /** Accounts in this connection's pool, or an empty list when it has no pool. */
  accounts: (connection: string) => LimitsAccount[];
  /** What the one polled source last said for this connection, when there is one. */
  polled: (connection: string) => PolledReading | null;
  /** How many calls Branch itself made in the last minute, for the estimated case. */
  callsLastMinute: (connection: string) => number;
  now: number;
}

/** Windows from the headers a service sent on Branch's own traffic. Measured, every one. */
function fromHeaders(reading: RateLimitReading | null, callsLastMinute: number): LimitWindow[] {
  if (!reading) return [];
  return reading.windows.map((window) => {
    const said = { id: window.id, title: window.title, kind: window.counts, limit: window.limit,
      resetAt: window.resetAt, measuredAt: window.measuredAt, from: `from the ${window.source}` } as const;
    if (window.remaining !== null) return { ...said, remaining: window.remaining, state: "measured" as const };
    /* A limit with no remainder beside it: Branch may only say what it counted itself, and say so. */
    if (window.limit === null || window.counts !== "requests")
      return { ...said, remaining: null, state: "measured" as const };
    return { ...said, remaining: Math.max(0, window.limit - callsLastMinute), state: "estimated" as const,
      from: `estimated from Branch's own count of ${callsLastMinute} call(s) in the last minute, against the limit the ${window.source} gave` };
  });
}

/** The plan window a ChatGPT sign-in reports on its own answers. Measured, and unofficial. */
function planWindow(account: LimitsAccount, now: number): LimitWindow | null {
  if (account.remaining === null) return null;
  return { id: "plan", title: "Plan window", kind: "plan", limit: 100, remaining: account.remaining,
    resetAt: account.resetAt ?? null, measuredAt: new Date(now).toISOString(), state: "measured",
    from: "from a header on Branch's own traffic; the service reports this unofficially, and it is not in the published API" };
}

const stateOf = (windows: LimitWindow[]): LimitState =>
  windows.some((window) => window.state === "measured") ? "measured"
    : windows.some((window) => window.state === "estimated") ? "estimated" : "not_published";

function noteFor(row: { local: boolean; signIn: boolean; keyed: boolean; state: LimitState }): string {
  if (row.local) return runsHere;
  if (row.state !== "not_published") return "";
  if (row.signIn) return notMeasured;
  return row.keyed ? noLimitReported : notPublished;
}

/** Connections grouped by their list, in the order they were registered: a sign-in's models share one group. */
function groupsOf(connections: LimitsConnection[]): LimitsConnection[][] {
  const groups = new Map<string, LimitsConnection[]>();
  for (const connection of connections) {
    const key = connection.group ?? connection.id;
    groups.set(key, [...(groups.get(key) ?? []), connection]);
  }
  return [...groups.values()];
}

/**
 * One row per connection, and one row per account where a connection has several — never summed.
 * Two accounts' windows do not add up: plan accounts are not interchangeable, and API keys in one
 * organisation share a single limit, so adding their remainders together makes a false number.
 */
export function limitsView(deps: LimitsDeps): LimitsView {
  const rows: LimitRow[] = [];
  for (const group of groupsOf(deps.connections)) {
    const connection = group[0]!, signIn = connection.signIn ?? false, key = connection.group ?? connection.id;
    const accounts = deps.accounts(connection.id);
    /* A sign-in's windows belong to an account, never to the model that happened to carry them. */
    const shared = connection.local || signIn ? [] : [...fromHeaders(deps.reading(connection.id), deps.callsLastMinute(connection.id)),
      ...(deps.polled(connection.id)?.windows ?? [])];
    const polledNote = deps.polled(connection.id)?.note ?? null;
    const seats: (LimitsAccount | null)[] = accounts.length ? accounts : [null];
    for (const seat of seats) {
      const own = seat?.windows ?? (seat ? [planWindow(seat, deps.now)].filter((one) => one !== null) : []);
      const windows = [...shared, ...own];
      const state = connection.local ? "not_published" : stateOf(windows);
      rows.push({
        connection: key, connectionName: connection.planName ?? connection.name, presets: group.map((one) => one.id), signIn,
        account: seat?.account ?? null, accountLabel: seat?.label ?? null, inUse: seat?.inUse ?? true,
        state, windows,
        note: polledNote ?? seat?.note ?? noteFor({ local: connection.local, signIn: signIn || (seat?.signIn ?? false), keyed: connection.keyed ?? false, state }),
        ...(seat?.readable ? { readable: true as const } : {}),
        ...(connection.provider ? { provider: connection.provider } : {}),
        ...(seat?.limited ? { limited: true as const } : {}),
        ...(seat?.verified ? { verified: true as const } : {}),
        ...(seat?.switches ? { switches: true as const } : {}),
        ...(!seat && connection.outOfCredit ? { outOfCredit: true as const } : {}),
      });
    }
  }
  const reporting = rows.filter((row) => row.state !== "not_published").length;
  return { rows, empty: rows.length === 0, summary: limitsSummary(reporting, rows.length) };
}
/** Redesign phase 1 (integration review): the summary line in plain singular and plural. */
export function limitsSummary(reporting: number, total: number): string {
  if (total === 0) return "No model connection is set up yet.";
  if (total === 1) return reporting ? "Your one connection reports a limit." : "Your one connection does not publish a limit.";
  const silent = total - reporting;
  return `${reporting} of ${total} connections ${reporting === 1 ? "reports" : "report"} a limit.`
    + (silent === 1 ? " The other one does not publish one." : silent ? ` The other ${silent} do not publish one.` : "");
}

/* ---------- the same rows in words, so every place says the same thing ---------- */

/** "as of 4 min ago", or null when nobody said when. A figure with no age is never given one. */
export function ageText(measuredAt: string | null, now: number): string | null {
  if (measuredAt === null) return null;
  const seconds = Math.max(0, Math.round((now - Date.parse(measuredAt)) / 1000));
  if (!Number.isFinite(seconds)) return null;
  if (seconds < 90) return "as of just now";
  const minutes = Math.round(seconds / 60);
  return minutes < 90 ? `as of ${minutes} min ago` : `as of ${Math.round(minutes / 60)} h ago`;
}

/** One window in words. A share only where the service gave both sides of it. */
export function windowText(window: LimitWindow, now: number): string {
  const share = window.kind !== "money" && window.limit !== null && window.limit > 0 && window.remaining !== null
    ? `${Math.round(Math.max(0, Math.min(100, (window.remaining / window.limit) * 100)))}% left`
    : window.remaining === null ? "left: not said"
      : `${window.remaining} left of ${window.limit ?? "an unstated allowance"}`;
  const said = window.state === "estimated" ? `estimate — ${window.from}` : window.from;
  return [`${window.title}: ${share}`, said, ageText(window.measuredAt, now)].filter((part) => part).join(" · ");
}

/**
 * The whole panel as plain lines, for `branch usage`, the phone's compact list and the dashboard.
 * One design, one set of words: the window shows the same sentences with bars drawn beside them.
 */
export function limitLines(view: LimitsView, now: number): string[] {
  const lines: string[] = [];
  for (const row of view.rows) {
    const who = row.accountLabel ? `${row.connectionName} — ${row.accountLabel}${row.inUse ? " (in use)" : ""}` : row.connectionName;
    if (row.state === "not_published") { lines.push(`${who}: ${row.note}`); continue; }
    lines.push(`${who}:`);
    for (const window of row.windows) lines.push(`  ${windowText(window, now)}`);
    if (row.note) lines.push(`  ${row.note}`);
  }
  lines.push(view.summary);
  return lines;
}
