import type { IncomingMessage } from "node:http";
import { currentPerson } from "./people/context.js";
import { startedWithShortLivedKey } from "./key-context.js";
import { accountsServiceFor } from "./accounts/service.js";
import { presetRunsLocally, type ModelRouter } from "./models.js";
import { remainingShown } from "./accounts/pool.js";
import type { Store } from "./store.js";
import { limitsView, saveUsageLimitsSettings, usageLimitsSettings, type LimitsAccount, type LimitsView } from "./usage-limits.js";
import { askable, nextDelayMs, OpenRouterKeyReader } from "./usage-limits-openrouter.js";
import { glanceFrom, saveProgressNote, saveUsageGlanceSettings, usageGlanceSettings, type GlanceMonth, type UsageGlance } from "./usage-glance.js";
import { pricingSettings } from "./pricing.js";
import { byCard, recordedWrite } from "./settings-kit/recorded-write.js"; // Q48

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

interface LimitsApp {
  store: Store;
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
  catch (error) { throw new UsageLimitsError(403, (error as Error).message); }
}

/** The accounts in a connection's pool, as rows. Never the key, never a token — the label only. */
function accountsFor(app: LimitsApp, connection: string): LimitsAccount[] {
  const service = accountsServiceFor(app.runtime.models);
  const preset = app.runtime.models.presets.get(connection);
  if (!service || !preset || !service.on()) return [];
  const found = service.poolFor(preset);
  const pool = found ? service.pool(found.pool) : null;
  if (!found || !pool) return [];
  const preferred = pool.defaultAccount ?? pool.accounts[0]?.id ?? null;
  return pool.accounts.map((account) => ({
    account: account.id, label: account.label ?? account.id, inUse: account.id === preferred,
    /* Straight from the reading. `smartOrder()`'s stand-in for an unknown never comes near here. */
    remaining: remainingShown(service.stateOf(found.pool, account.id)),
    signIn: found.kind !== "api-key",
  }));
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
  return limitsNow(app);
}
/** The rows from what Branch already holds. Asks nobody anything, so the ring may read it often. */
function limitsNow(app: LimitsApp): LimitsView {
  const reader = readerFor(app.runtime.models);
  const busy = new Map(app.runtime.models.requests.rates().map((rate) => [rate.connection, rate.lastMinute]));
  return limitsView({
    connections: [...app.runtime.models.presets.values()].map((preset) => ({
      id: preset.id, name: preset.name, local: presetRunsLocally(preset),
    })),
    reading: (id) => app.runtime.models.health.get(id).rateLimit,
    accounts: (id) => accountsFor(app, id),
    polled: (id) => reader.reading(id),
    callsLastMinute: (id) => busy.get(id) ?? 0,
    now: Date.now(),
  });
}

/* ---------- redesign phase 1: the ring under the message box, and saving progress at 95% ---------- */

const ownerHere = (store: Store): boolean => {
  try { requireOwnerHere(store); return true; } catch { return false; }
};
const runningTasks = (app: LimitsApp) => app.store.runs(app.runtime.owner).filter((run) => run.status === "running");

/**
 * GET /api/usage/glance. Anybody but the owner in the app window is told only that there is nothing
 * to show: not refused, so a household profile or a short-lived key never sees an error for it, and
 * never a number either.
 */
export function usageGlance(app: LimitsApp, now = Date.now()): UsageGlance {
  if (!ownerHere(app.store)) return { available: false };
  return glanceFrom(limitsNow(app), usageGlanceSettings(app.store, app.runtime.owner), runningTasks(app).length, now,
    monthSpend(app.store, app.runtime.owner, now), app.runtime.models.settings(app.runtime.owner).activePreset);
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

export const usageLimitsPaths = ["/api/usage/limits", "/api/usage/limits/settings",
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
