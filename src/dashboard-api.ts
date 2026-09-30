import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { z } from "zod";
import type { ToolContext } from "./contracts.js";
import { ownerOnly } from "./self-development.js";
import type { createBranch } from "./index.js";
import type { Store } from "./store.js";
import type { TokenScope } from "./session-tokens.js";
import { FeatureModeSchema } from "./feature-switches.js";
import { readRunning } from "./install/running.js";
import { assistantIdentity } from "./identity.js";
import { preferences } from "./preferences.js";
import { lockdownActive } from "./lockdown.js";
import { busyTasks } from "./comfort/auto-update.js";
import { lockdownSettingsRefusal } from "./policy-change-guard.js";
import { hereOnly, throughADoor } from "./remote/window-key.js";
import {
  activitySection, healthSection, nowSection, restartPlan, restartWords, spendSection, type SummaryDeps,
} from "./dashboard-summary.js";

/**
 * The owner's control dashboard (wave mac3): a page of its own at /dashboard that shows at a glance
 * what Branch is doing, whether its parts are healthy, what it has cost, and what is happening now,
 * with the few controls an owner reaches for from a phone or a screen on the wall. It is served by
 * Branch itself behind the same key and the same host rules as the app window, so it is reachable over
 * the paired address exactly when the app is.
 *
 * Like every new feature it has the owner's three-way switch and ships off:
 * - off: the page and its files are not served at all, and the summary refuses (Restart the engine does not
 *   wait on this switch: it is Settings' own button too, the key of this computer only, and the app on this
 *   computer only while the dashboard is off);
 * - on: the page keeps itself up to date — the figures every few seconds and the live updates of
 *   what is happening;
 * - when-needed: the page is served but reads everything once, when it is opened or Refresh is
 *   pressed, and keeps nothing open in between.
 *
 * Looking needs any key that may look. Stopping a task goes through the existing route, so a key that
 * may start tasks may stop them. Everything else here — the switch itself, pausing every automation
 * and restarting the engine — needs the master key of this computer; a short-lived key never does it.
 */
type Branch = Awaited<ReturnType<typeof createBranch>>;

export const DashboardSettingsSchema = z.object({
  mode: FeatureModeSchema.default("off"),
}).strict();
export type DashboardSettings = z.infer<typeof DashboardSettingsSchema>;

const PausedSchema = z.object({
  at: z.string(),
  schedules: z.array(z.string()).max(1000),
  triggers: z.array(z.string()).max(1000),
}).strict();
type Paused = z.infer<typeof PausedSchema>;

const SETTINGS_ID = "dashboard";
const PAUSED_ID = "dashboard-paused";

export function dashboardSettings(store: Store, owner: string): DashboardSettings {
  const saved = DashboardSettingsSchema.safeParse(store.get("settings", owner, SETTINGS_ID)?.data ?? {});
  return saved.success ? saved.data : DashboardSettingsSchema.parse({});
}
export function saveDashboardSettings(store: Store, owner: string, input: unknown): DashboardSettings {
  const value = DashboardSettingsSchema.parse(input);
  store.save("settings", owner, SETTINGS_ID, value);
  return value;
}

/** The page and its own files. While the switch is off none of them is served. */
export function isDashboardFile(path: string): boolean {
  return path === "/dashboard" || path.startsWith("/dashboard/");
}
export function handlesDashboardPath(path: string): boolean {
  return path === "/api/dashboard" || path.startsWith("/api/dashboard/");
}

/** What the key on this request may do on the page: everything, start and stop tasks, or only look. */
export type DashboardAccess = "full" | "run" | "read";
export function dashboardAccess(
  request: IncomingMessage, masterKey: string, scopeOf: (supplied: string) => TokenScope | null,
): DashboardAccess {
  const supplied = Buffer.from(/^Bearer (\S+)$/.exec(String(request.headers.authorization ?? ""))?.[1] ?? "");
  const master = Buffer.from(masterKey);
  if (supplied.length === master.length && timingSafeEqual(supplied, master)) return "full";
  return scopeOf(supplied.toString()) === "run" ? "run" : "read";
}

export class DashboardApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
const masterOnly = (access: DashboardAccess, what: string) => {
  if (access !== "full")
    throw new DashboardApiError(403, `${what} needs the key of the computer Branch runs on, not a short-lived key.`);
};

/** Pauses every waiting schedule and switches off every trigger, remembering which, so resuming touches only those. */
export function pauseAutomations(app: Branch, now = new Date()): Paused {
  const owner = app.runtime.owner;
  const earlier = pausedRecord(app.store, owner);
  const schedules = app.store.list("schedules", owner).filter((record) => record.data.status === "pending");
  for (const record of schedules) app.store.save("schedules", owner, record.id, { ...record.data, status: "paused" });
  const triggers = app.triggers.list(owner).filter((trigger) => trigger.enabled);
  for (const trigger of triggers) app.triggers.setEnabled(owner, trigger.id, false);
  const paused: Paused = {
    at: earlier?.at ?? now.toISOString(),
    schedules: [...new Set([...(earlier?.schedules ?? []), ...schedules.map((record) => record.id)])],
    triggers: [...new Set([...(earlier?.triggers ?? []), ...triggers.map((trigger) => trigger.id)])],
  };
  app.store.save("settings", owner, PAUSED_ID, paused);
  return paused;
}

/** Starts again only what the dashboard paused; anything the owner paused by hand stays paused. */
export function resumeAutomations(app: Branch): { schedules: number; triggers: number } {
  const owner = app.runtime.owner;
  const paused = pausedRecord(app.store, owner);
  let schedules = 0, triggers = 0;
  for (const id of paused?.schedules ?? []) {
    const record = app.store.get("schedules", owner, id);
    if (record?.data.status !== "paused") continue;
    app.store.save("schedules", owner, id, { ...record.data, status: "pending" });
    schedules += 1;
  }
  for (const id of paused?.triggers ?? []) {
    const trigger = app.triggers.list(owner).find((entry) => entry.id === id);
    if (!trigger || trigger.enabled) continue;
    app.triggers.setEnabled(owner, id, true);
    triggers += 1;
  }
  app.store.delete("settings", owner, PAUSED_ID);
  return { schedules, triggers };
}

function pausedRecord(store: Store, owner: string): Paused | null {
  const parsed = PausedSchema.safeParse(store.get("settings", owner, PAUSED_ID)?.data);
  return parsed.success ? parsed.data : null;
}

export interface DashboardDeps extends SummaryDeps {
  /** Sends a signal to this process; tests hand in a fake so nothing is really stopped. */
  signal?: (pid: number, name: NodeJS.Signals) => void;
  setExitCode?: (code: number) => void;
  /** How often a restart that waits for no task to be working looks again; tests make it short. */
  idleCheckMs?: number;
}

/**
 * Restarts the engine that works in the background. It stops the way Ctrl+C stops it — work saved,
 * the address let go — but with exit code 75, so the sign-in file (launchd's KeepAlive on a Mac,
 * systemd's Restart=always on Linux, which only a stop on purpose's 78 prevents) starts it again. Anywhere nothing would start it again it
 * is refused, because a restart that only stops would leave the owner with no Branch at all.
 */
async function restartEngine(dataDir: string, deps: DashboardDeps): Promise<unknown> {
  const pid = deps.pid ?? process.pid;
  const plan = restartPlan({
    platform: deps.platform ?? process.platform, env: deps.env ?? process.env, pid,
    running: await (deps.running ?? readRunning)(dataDir), hosted: deps.hosted,
  });
  if (!plan.possible) throw new DashboardApiError(409, restartWords[plan.reason]);
  const setExitCode = deps.setExitCode ?? ((code: number) => { process.exitCode = code; });
  const signal = deps.signal ?? ((target: number, name: NodeJS.Signals) => { process.kill(target, name); });
  setTimeout(() => { setExitCode(75); signal(pid, "SIGTERM"); }, 300);
  return { restarting: true };
}

/** selfdev: Branch restarting its own engine, as the Restart the engine button does. */
export const restartToolName = "branch.restart_engine";
/**
 * selfdev: the tool the lead uses to restart its own engine (stuck, or to take up a new build). Only the owner's own
 * task (their designated default Trunk counts as theirs) may; never a household person's, a key's, a chat's or another
 * Trunk's. Whether it asks first is the owner's rule for it (Settings › Branch itself › Restarting its own engine).
 * Work is saved and, with Carry on interrupted work by itself on, safe steps carry on after the restart.
 */
export function registerRestartTool(app: Branch, dataDir: string, deps: DashboardDeps = {}): void {
  if (app.registry.names().includes(restartToolName)) return;
  app.registry.register({
    name: restartToolName, permission: "process.manage", reach: "local",
    description: "Restart Branch's own engine, when it is stuck or to take up a new build. Work in progress is saved and safe steps carry on by themselves after the restart. Say why.",
    parameters: z.object({ why: z.string().trim().min(1).max(300) }).strict(),
    target: (input: { why: string }) => `restart Branch's engine: ${input.why}`,
    execute: async (_input: { why: string }, context: ToolContext) => {
      ownerOnly(context, app.store, (turn) => app.runtime.ownersDefaultTurn(turn), "restart Branch's engine");
      return restartEngine(dataDir, deps);
    },
    // Last: a settings-key scan (tests/backup-classified.test.mjs) must not read this group and the next fields as a key.
    group: "settings" });
}

const RestartSchema = z.object({ whenIdle: z.boolean().optional() }).strict();
let waitingToRestart: NodeJS.Timeout | null = null;
/**
 * selfdev: Reload without dropping work (Settings › Branch itself). Nothing is cut off: the restart waits until no task
 * is working, looking every five seconds, and then restarts as the button does (work saved, the address let go, the
 * computer's own service starting it again). Asked twice, it waits once. Refused where nothing would start it again.
 */
async function restartWhenIdle(app: Branch, dataDir: string, deps: DashboardDeps): Promise<unknown> {
  const pid = deps.pid ?? process.pid;
  const plan = restartPlan({ platform: deps.platform ?? process.platform, env: deps.env ?? process.env, pid,
    running: await (deps.running ?? readRunning)(dataDir), hosted: deps.hosted });
  if (!plan.possible) throw new DashboardApiError(409, restartWords[plan.reason]);
  const working = () => busyTasks(app.store).working;
  if (!working()) return restartEngine(dataDir, deps);
  if (!waitingToRestart) {
    waitingToRestart = setInterval(() => {
      if (working()) return;
      clearInterval(waitingToRestart!); waitingToRestart = null;
      void restartEngine(dataDir, deps).catch(() => undefined);
    }, deps.idleCheckMs ?? 5000);
    waitingToRestart.unref();
  }
  return { restarting: false, waiting: true, working: working() };
}

async function summary(app: Branch, dataDir: string, access: DashboardAccess, deps: DashboardDeps): Promise<unknown> {
  const owner = app.runtime.owner;
  return app.runtime.hideSecrets({
    mode: dashboardSettings(app.store, owner).mode,
    access,
    assistant: assistantIdentity(app.store, owner).name,
    /** Light or dark and the rest of the look, so the page wears what the window wears. */
    appearance: preferences(app.store, owner),
    paused: pausedRecord(app.store, owner),
    now: await nowSection(app, dataDir, deps),
    health: await healthSection(app, dataDir, deps),
    spend: spendSection(app, deps),
    activity: activitySection(app),
  });
}

const PauseSchema = z.object({ paused: z.boolean() }).strict();

/** Everything under /api/dashboard. */
export async function dashboardApi(
  app: Branch, request: IncomingMessage, path: string,
  context: { dataDir: string; access: DashboardAccess; readBody: () => Promise<unknown>; deps?: DashboardDeps },
): Promise<unknown> {
  const owner = app.runtime.owner, method = request.method ?? "GET", deps = context.deps ?? {};
  app.store.profiles.requireOwner("The dashboard");
  if (path === "/api/dashboard/settings") {
    if (method === "GET") return { ...dashboardSettings(app.store, owner), access: context.access };
    masterOnly(context.access, "Switching the dashboard");
    // A phone's own key counts as the owner's, so a door (a paired phone, the paired address) is refused by name:
    // switching the dashboard is this computer's window's alone.
    if (throughADoor(request)) throw new DashboardApiError(403, hereOnly);
    const body = await context.readBody();
    // Under Lockdown the dashboard may be switched off, never on: it is one more page that can be reached.
    if (lockdownActive(app.store, owner) && DashboardSettingsSchema.parse(body).mode !== "off")
      throw new DashboardApiError(409, lockdownSettingsRefusal);
    return saveDashboardSettings(app.store, owner, body);
  }
  // Restarting the engine is also Settings › Branch itself's and Gateway's own button, so it does not wait on the
  // dashboard's switch: the key of this computer only, and, while the dashboard is off, the app on this computer only
  // (never through a door), since no page reachable from elsewhere offers it then.
  if (path === "/api/dashboard/restart" && method === "POST") {
    masterOnly(context.access, "Restarting Branch");
    if (dashboardSettings(app.store, owner).mode === "off" && throughADoor(request)) throw new DashboardApiError(403, hereOnly);
    const { whenIdle } = RestartSchema.parse(await context.readBody().catch(() => ({})) ?? {});
    return whenIdle ? restartWhenIdle(app, context.dataDir, deps) : restartEngine(context.dataDir, deps);
  }
  // Pausing every automation is also Automations › Scheduled's own row, so, like restarting, it does not wait on the
  // dashboard's switch: the key of this computer only, and, while the dashboard is off, never through a door.
  if (path === "/api/dashboard/automations") {
    masterOnly(context.access, "Pausing every automation");
    if (dashboardSettings(app.store, owner).mode === "off" && throughADoor(request)) throw new DashboardApiError(403, hereOnly);
    if (method === "GET") return { paused: pausedRecord(app.store, owner) };
    if (method !== "POST") throw new DashboardApiError(405, "Use GET or POST");
    const { paused } = PauseSchema.parse(await context.readBody());
    return paused ? { paused: pauseAutomations(app) } : { resumed: resumeAutomations(app) };
  }
  if (dashboardSettings(app.store, owner).mode === "off")
    throw new DashboardApiError(404, "The dashboard is switched off. Turn it on under Customize › Everywhere › Dashboard in the browser.");
  if (path === "/api/dashboard" && method === "GET") return summary(app, context.dataDir, context.access, deps);
  throw new DashboardApiError(404, "Not found");
}
