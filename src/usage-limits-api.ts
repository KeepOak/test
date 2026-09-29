import type { IncomingMessage } from "node:http";
import { z } from "zod";
import { errorText } from "./request-errors.js";
import { currentPerson } from "./people/context.js";
import { startedWithShortLivedKey } from "./key-context.js";
import { accountsServiceFor } from "./accounts/service.js";
import { presetRunsLocally, type ModelRouter } from "./models.js";
import { primaryAccount } from "./accounts/settings.js";
import { planLimitWindow } from "./plan-windows.js";
import type { Store } from "./store.js";
import type { SessionLock } from "./session-lock.js";
import { limitsView, saveUsageLimitsSettings, usageLimitsSettings, type LimitsAccount, type LimitsView } from "./usage-limits.js";
import { askable, nextDelayMs, OpenRouterKeyReader } from "./usage-limits-openrouter.js";
import { glanceFrom, saveProgressNote, saveUsageGlanceSettings, usageGlanceSettings, type GlanceMonth, type UsageGlance } from "./usage-glance.js";
import { pricingSettings } from "./pricing.js";
import { checkProgram } from "./accounts/sign-ins.js";
import type { AccountsService } from "./accounts/service.js";
import { byCard, recordedWrite } from "./settings-kit/recorded-write.js"; // Q48
import { savedConnections } from "./connections-preset.js";
import { withOffers } from "./usage-offers.js";

/**
 * mac7/usage-bar: the screen's one way in.
 *
 *   GET  /api/usage/limits            every connection, every account, in its honest state
 *   POST /api/usage/limits/settings   the switch behind the one polled source
 *
 * Owner-gated exactly the way `src/model-savings/api.ts` gates its cards, and for the same reason:
 * these rows say what the owner's paid-for connections have left, which is the owner's business and
 * nobody else's. A short-lived key and a household profile are both refused before anything is read
 * — not shown a filtered view, refused — so there is no path by which somebody else in the house
 * learns what the owner is spending or how near a cap it is.
 */
export class UsageLimitsError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export interface LimitsApp {
  store: Store;
  sessionLock?: Pick<SessionLock, "refusal">;
  runtime: { owner: string; models: ModelRouter; steer?: (runId: string, text: string) => unknown };
}

const readers = new WeakMap<ModelRouter, OpenRouterKeyReader>();
const readerFor = (models: ModelRouter): OpenRouterKeyReader =>
  readers.get(models) ?? (readers.set(models, new OpenRouterKeyReader()), readers.get(models)!);
/** Test seam: hand in a reader whose fetch is a fake, so no test ever reaches the network. */
export const useKeyReader = (models: ModelRouter, reader: OpenRouterKeyReader): void => { readers.set(models, reader); };

function requireOwnerHere(store: Store): void {
  if (startedWithShortLivedKey() || currentPerson())
    throw new UsageLimitsError(403, "Only the owner can see what each connection has left, in the app window.");
  try { store.profiles.requireOwner("What each connection has left"); }
  catch (error) { throw new UsageLimitsError(403, errorText(error)); }
}

/* In plain words: what said so, never how it was read (the owner, 2026-09-27: no header names, no plumbing). */
const planFrom = { chatgpt: "as ChatGPT reported it on Branch's own answers",
  cli: "as Claude Code reported it on its own answers" } as const;
const planNames: Record<string, string> = { chatgpt: "ChatGPT plan", "cli-claude-code": "Claude plan" };
const firstLabel = (pool: string): string => (pool === "chatgpt" ? "First sign-in" : "Your sign-in");

/**
 * The accounts behind a connection, as rows. Never the key, never a token — the label only. A plan
 * sign-in always has at least its first account, whose windows are read even with lists switched off.
 */
function accountsFor(app: LimitsApp, connection: string): LimitsAccount[] {
  const service = accountsServiceFor(app.runtime.models);
  const preset = app.runtime.models.presets.get(connection);
  const found = service && preset ? service.poolFor(preset) : null;
  if (!service || !found) return [];
  const signIn = found.kind !== "api-key";
  const pool = service.on() ? service.pool(found.pool) : null;
  if (!pool && !signIn) return [];
  const from = found.kind === "chatgpt" ? planFrom.chatgpt : planFrom.cli;
  const listed = pool?.accounts ?? [{ id: primaryAccount, label: firstLabel(found.pool), disabled: false }];
  const next = pool ? service.usedNext(found.pool) : primaryAccount;
  // What pool-provider.ts rotates on: moving on switched on, and two or more switched-on accounts to move between.
  const usable = pool ? service.usablePool(found.pool) : null;
  const switches = !!usable?.autoSwitch && usable.accounts.filter((account) => !account.disabled).length >= 2;
  return listed.map((account) => {
    const shown = service.presentation(found.pool, account, found.kind);
    return {
    // Who the sign-in is (its email, where the service said it), else the name it was given.
    account: account.id, label: shown.label, inUse: account.id === next && shown.ready === true, signIn,
    // The label is who the service said the sign-in is (#605's verified identity), not a name it was given.
    verified: Boolean(shown.identity?.email ?? shown.identity?.name),
    limited: signIn && service.stateOf(found.pool, account.id).limitedUntil > service.now(), switches,
    remaining: null,
    ...(signIn ? { ...(shown.ready === true && service.canReadPlan(found.pool) ? { readable: true } : {}),
      note: shown.signInProblem ?? service.planNotes.get(`${found.pool}/${account.id}`) ?? null } : {}),
    /* Straight from what the service said, per account. `smartOrder()`'s stand-in for an unknown never comes near here. */
    ...(signIn ? { windows: shown.ready === false ? [] : service.planWindows.get(found.pool, account.id).map((window) => planLimitWindow(window, from)) } : {}),
    };
  });
}
/** The list a connection's accounts belong to, and what kind: sign-ins share one row per account. */
function groupOf(app: LimitsApp, id: string): { group?: string; planName?: string; signIn?: boolean; keyed?: boolean; provider?: string } {
  const service = accountsServiceFor(app.runtime.models);
  const preset = app.runtime.models.presets.get(id);
  const found = service && preset ? service.poolFor(preset) : null;
  if (!found) return {};
  if (found.kind === "api-key") {
    // The key's service, as the connection was saved (the same record poolFor read it from).
    const catalogId = savedConnections(service!.deps.store, service!.deps.owner).find((saved) => saved.id === id)?.catalogId;
    return { keyed: true, ...(catalogId ? { provider: catalogId } : {}) };
  }
  if (found.kind === "cli" && found.pool !== "cli-claude-code") return { group: found.pool, provider: found.pool };
  return { group: found.pool, signIn: true, provider: found.pool, ...(planNames[found.pool] ? { planName: planNames[found.pool] } : {}) };
}
/** The service's own answer to the last request was 402, "payment required": it has no credit left for this key. */
function outOfCredit(app: LimitsApp, id: string): boolean {
  const health = app.runtime.models.health.get(id);
  return health.lastStatus === 402 && health.lastErrorAt !== null && (health.lastOkAt === null || health.lastErrorAt > health.lastOkAt);
}

/** Ask the one askable source, when the switch is on and the polite interval has passed. */
async function maybeRefresh(app: LimitsApp): Promise<void> {
  if (!usageLimitsSettings(app.store, app.runtime.owner).enabled) return;
  const service = accountsServiceFor(app.runtime.models);
  const reader = readerFor(app.runtime.models);
  /* The panel is open — the owner is looking at it right now — so this is the 2-minute case. */
  const delay = nextDelayMs({ panelOpenedAgoMs: 0, workingAgoMs: null, onBattery: false });
  for (const preset of app.runtime.models.presets.values()) {
    if (!reader.due(preset.id, delay)) continue;
    const kind = service?.on() ? service.poolFor(preset)?.kind ?? null : null;
    await reader.refresh(preset.id, askable(preset, kind));
  }
}

export async function usageLimits(app: LimitsApp): Promise<LimitsView> {
  requireOwnerHere(app.store);
  await maybeRefresh(app);
  await accountsServiceFor(app.runtime.models)?.readIdentities().catch(() => undefined);
  return limitsNow(app);
}
/** The rows from what Branch already holds. Asks nobody anything, so the ring may read it often. */
export function limitsNow(app: LimitsApp): LimitsView {
  const reader = readerFor(app.runtime.models);
  const busy = new Map(app.runtime.models.requests.rates().map((rate) => [rate.connection, rate.lastMinute]));
  const now = Date.now();
  const view = limitsView({
    connections: [...app.runtime.models.presets.values()].map((preset) => ({
      id: preset.id, name: preset.name, local: presetRunsLocally(preset), ...groupOf(app, preset.id),
      ...(outOfCredit(app, preset.id) ? { outOfCredit: true } : {}),
    })),
    reading: (id) => app.runtime.models.health.get(id).rateLimit,
    accounts: (id) => accountsFor(app, id),
    polled: (id) => reader.reading(id),
    callsLastMinute: (id) => busy.get(id) ?? 0,
    now,
  });
  return { ...view, rows: withOffers(view.rows, now) };
}

/* ---------- redesign phase 1: the ring under the message box, and saving progress at 95% ---------- */

const ownerHere = (store: Store): boolean => {
  try { requireOwnerHere(store); return true; } catch { return false; }
};
const runningTasks = (app: LimitsApp) => app.store.runs(app.runtime.owner).filter((run) => run.status === "running");
function readUsageIdentities(app: LimitsApp): Promise<void> {
  const service = accountsServiceFor(app.runtime.models);
  const pools = [...app.runtime.models.presets.values()].flatMap((preset) => {
    const found = service?.poolFor(preset);
    return found && found.kind !== "api-key" ? [found.pool] : [];
  });
  return service?.readIdentities([...new Set(pools)]).catch(() => undefined) ?? Promise.resolve();
}

/**
 * GET /api/usage/glance. Anybody but the owner in the app window is told only that there is nothing
 * to show: not refused, so a household profile or a short-lived key never sees an error for it, and
 * never a number either.
 */
export function usageGlance(app: LimitsApp, now = Date.now()): UsageGlance {
  if (!ownerHere(app.store)) return { available: false };
  // Who each sign-in is, read for the next look; this one answers from what is already known, and never waits.
  void readUsageIdentities(app);
  const glance = glanceFrom(limitsNow(app), usageGlanceSettings(app.store, app.runtime.owner), runningTasks(app).length, now,
    monthSpend(app.store, app.runtime.owner, now), app.runtime.models.settings(app.runtime.owner).activePreset);
  const addable = addableNow(app);
  return addable.length && glance.available ? { ...glance, addable } : glance;
}

/** Fast status readings arrive with the first view; slow profiles hydrate without holding the usage surface closed. */
export async function readUsageGlance(app: LimitsApp): Promise<UsageGlance> {
  if (!ownerHere(app.store) || app.sessionLock?.refusal("GET", usageGlancePath)) return { available: false };
  let ready = false, timer: ReturnType<typeof setTimeout> | undefined;
  const reading = readUsageIdentities(app).then(() => { ready = true; });
  try { await Promise.race([reading, new Promise<void>((resolve) => { timer = setTimeout(resolve, 200); })]); }
  finally { clearTimeout(timer); }
  if (app.sessionLock?.refusal("GET", usageGlancePath)) return { available: false };
  const glance = usageGlance(app);
  return glance.available && !ready ? { ...glance, identitiesPending: true } : glance;
}

/* ---------- a Claude Code signed in on this computer but not added yet ----------
 * The popover lists connections, so a Claude Code subscription the owner is signed in to here, but never added to
 * Branch, did not show at all. Looking at the popover asks Claude Code's own status command (at most every five
 * minutes; nothing else of the program's is read), and while it says signed in the popover offers one Connect, the same
 * POST /api/providers/cli-agents the Add an account dialog uses. */
export interface AddableRow { program: string; connectionName: string; note: string }
const claudeLooked = new WeakMap<AccountsService, { at: number; signedIn: boolean | null }>();
const lookEveryMs = 5 * 60_000;
const claudeAddable = "Claude Code is signed in on this computer. Connect it to see what its plan has left here.";
function addableNow(app: LimitsApp): AddableRow[] {
  const service = accountsServiceFor(app.runtime.models);
  if (!service || app.runtime.models.presets.has("cli-claude-code")) return [];
  return claudeLooked.get(service)?.signedIn === true ? [{ program: "claude-code", connectionName: "Claude plan", note: claudeAddable }] : [];
}
async function lookForClaude(app: LimitsApp): Promise<void> {
  const service = accountsServiceFor(app.runtime.models);
  if (!service || app.runtime.models.presets.has("cli-claude-code")) return;
  const last = claudeLooked.get(service);
  if (last && service.now() - last.at < lookEveryMs) return;
  claudeLooked.set(service, { at: service.now(), signedIn: last?.signedIn ?? null });
  const found = await checkProgram({ service }, { id: "claude-code" }, service.deps.statusRun).catch(() => null);
  claudeLooked.set(service, { at: service.now(), signedIn: found?.installed === true && found.signedIn === true });
}
/** The same month the Usage screen adds up: the ledger's UTC days of this calendar month. */
function monthSpend(store: Store, owner: string, now: number): GlanceMonth {
  const month = new Date(now).toISOString().slice(0, 7);
  const days = store.usageStore().aggregateUsage("90d", "day", pricingSettings(store, owner).overrides)
    .filter((day) => day.date.startsWith(month));
  return {
    cost: days.reduce((total, day) => total + (day.pricedRuns ? day.estimatedCost : 0), 0),
    pricedRuns: days.reduce((total, day) => total + day.pricedRuns, 0),
    unpricedRuns: days.reduce((total, day) => total + day.unpricedRuns, 0),
  };
}
/** Sends each of the owner's running tasks the note asking it to write down where it is. */
function saveProgress(app: LimitsApp): { asked: number } {
  let asked = 0;
  for (const run of runningTasks(app)) {
    try { app.runtime.steer?.(run.id, saveProgressNote); asked += 1; } catch { /* finished a moment ago */ }
  }
  return { asked };
}
export const usageGlancePath = "/api/usage/glance";

/**
 * POST /api/usage/limits/measure {connection, account}: "Measure now". One tiny real request to that
 * sign-in (a little of its plan window, no money), then the rows as they now stand. API keys are
 * refused here, not only hidden on the screen, because asking one costs money.
 */
async function measureNow(app: LimitsApp, input: unknown): Promise<LimitsView> {
  const body = (input ?? {}) as { connection?: unknown; account?: unknown };
  const service = accountsServiceFor(app.runtime.models);
  if (typeof body.connection !== "string" || typeof body.account !== "string" || !service)
    throw new UsageLimitsError(400, "Say which connection and which account to measure.");
  try { await service.measure(body.connection, body.account, AbortSignal.timeout(120_000)); }
  catch (error) { throw new UsageLimitsError(400, errorText(error)); }
  return limitsNow(app);
}

/**
 * POST /api/usage/limits/refresh {connection, account}: "Check now", and each look at the popover. Reads that sign-in's
 * plan from the service itself, sending no message (AccountsService.readPlan: one read at a time, never more often
 * than its interval), then answers the popover's rows as they now stand.
 */
const RefreshSchema = z.object({ connection: z.string().min(1).max(64), account: z.string().regex(/^(primary|[a-f0-9]{8})$/) }).strict();
async function refreshPlan(app: LimitsApp, input: unknown): Promise<UsageGlance> {
  const parsed = RefreshSchema.safeParse(input ?? {});
  const service = accountsServiceFor(app.runtime.models);
  if (!parsed.success || !service) throw new UsageLimitsError(400, "Say which connection and which account to check.");
  try { await service.readPlan(parsed.data.connection, parsed.data.account); }
  catch (error) { throw new UsageLimitsError(400, errorText(error)); }
  return readUsageGlance(app);
}

export const usageLimitsPaths = ["/api/usage/limits", "/api/usage/limits/settings", "/api/usage/limits/measure", "/api/usage/limits/refresh", "/api/usage/limits/look",
  "/api/usage/glance/settings", "/api/usage/save-progress"] as const;
export const handlesUsageLimitsPath = (path: string): boolean => (usageLimitsPaths as readonly string[]).includes(path);

export async function usageLimitsRoute(app: LimitsApp, request: IncomingMessage, path: string,
  readBody: () => Promise<unknown>): Promise<unknown> {
  const method = request.method ?? "GET";
  if (path === "/api/usage/glance/settings") {
    requireOwnerHere(app.store);
    if (method === "POST") return { settings: saveUsageGlanceSettings(app.store, app.runtime.owner, await readBody()) };
    return { settings: usageGlanceSettings(app.store, app.runtime.owner) };
  }
  if (path === "/api/usage/save-progress") {
    requireOwnerHere(app.store);
    if (method !== "POST") throw new UsageLimitsError(405, "Use POST");
    return saveProgress(app);
  }
  if (path === "/api/usage/limits/look") {
    requireOwnerHere(app.store);
    if (method !== "POST") throw new UsageLimitsError(405, "Use POST");
    z.object({}).strict().parse(await readBody() ?? {});
    await lookForClaude(app);
    return readUsageGlance(app);
  }
  if (path === "/api/usage/limits/refresh") {
    requireOwnerHere(app.store);
    if (method !== "POST") throw new UsageLimitsError(405, "Use POST");
    return refreshPlan(app, await readBody());
  }
  if (path === "/api/usage/limits/measure") {
    requireOwnerHere(app.store);
    if (method !== "POST") throw new UsageLimitsError(405, "Use POST");
    return { ...await measureNow(app, await readBody()), settings: usageLimitsSettings(app.store, app.runtime.owner) };
  }
  if (path === "/api/usage/limits/settings") {
    requireOwnerHere(app.store);
    if (method === "POST") {
      const input = await readBody();
      return { usageLimits: recordedWrite(app.store, app.runtime.owner, byCard("usage-limits"), ["usage-limits"],
        () => saveUsageLimitsSettings(app.store, app.runtime.owner, input)) };
    }
    return { usageLimits: usageLimitsSettings(app.store, app.runtime.owner) };
  }
  if (method !== "GET") throw new UsageLimitsError(405, "Use GET");
  return { ...await usageLimits(app), settings: usageLimitsSettings(app.store, app.runtime.owner) };
}
