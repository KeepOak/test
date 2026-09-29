import type { IncomingMessage } from "node:http";
import { errorText, validationText } from "../request-errors.js";
import { z } from "zod";
import type { Store } from "../store.js";
import type { Runtime } from "../runtime.js";
import { activeModel, sessionTotals } from "../terminal-commands.js";
import { currentPerson } from "../people/context.js";
import { startedWithShortLivedKey } from "../key-context.js";
import {
  allComfort, comfortCardNames, comfortShipsOn, ComfortNetworkSchema, ownerOnlyComfortCards, readComfort, resetComfort, saveComfort,
  shortcutDefaults, statusItems, type ComfortCard,
} from "./settings.js";
import { checkCertificate, validateNetwork, type OutboundNetwork } from "./network.js";
import { busyTasks, updateHold, staleTaskMs, noteUpdateLook, stalledWords, clearUpdateProblem, holdingTasks, noteFailedInstall, noteUpdateCheck, noteUpdateProblem, noteUpdateWait, updatePlan, updateProblem } from "./auto-update.js";
import { sensitiveBrowserTools } from "./browser-safety.js";
import { diagnose } from "../diagnostic-log.js";
import { clearInstallRequest, installRequested } from "./update-now.js";
import { staleAfterMs } from "../activity.js";
import { byCard, inCatalogue, recordedWrite } from "../settings-kit/recorded-write.js"; // Q48

/**
 * R17-S-C: the screen's way in.
 *
 *   GET  /api/comfort              every card's values, what is in force, and the choices offered
 *   POST /api/comfort              { card, values } saves one card; { card, reset: true } puts it back
 *   POST /api/comfort/update-plan  { updaterPhase?, checked? } what the window should do about updates
 *   GET  /api/comfort/update-readiness  owner-only channel, update-by-itself choice and complete busy-task count for desktop handover
 *   GET  /api/comfort/status?session=<id>  the status line's facts, and when each turn started and ended
 *
 * Every change is the owner's: a short-lived key is refused before this is reached (src/server.ts,
 * src/short-lived-keys.ts). The browser and network cards also refuse a household profile.
 */
export class ComfortApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export interface ComfortApp {
  store: Store;
  runtime: Runtime;
  /** The proxy and certificates in force; absent in a program that makes no calls of its own. */
  outbound?: OutboundNetwork;
  /** The request came through the paired door: a phone holding the owner's own key (src/server.ts). */
  pairedDoor?: boolean;
}
export const comfortRoutes: readonly string[] = ["/api/comfort", "/api/comfort/update-plan", "/api/comfort/update-readiness", "/api/comfort/status"];
export const handlesComfortPath = (path: string): boolean => comfortRoutes.includes(path);

const SaveSchema = z.object({
  card: z.enum(comfortCardNames as [ComfortCard, ...ComfortCard[]]),
  values: z.record(z.string(), z.unknown()).optional(),
  reset: z.boolean().optional(),
}).strict();
const PlanSchema = z.object({
  updaterPhase: z.string().max(40).optional(),
  checked: z.boolean().optional(),
  /** The release the updater is talking about, and, when its install just failed, that release (dogfood F1 review). */
  updaterTag: z.string().max(120).optional(),
  failedTag: z.string().max(120).optional(),
  /** Something that went wrong while updating by itself, in the updater's or engine's words: kept and said once. */
  problem: z.string().min(1).max(600).optional(),
}).strict();

/** Only the owner, in the owner's own profile and with the computer's own key, may change these. */
function requireOwnerHere(store: Store, what: string): void {
  if (startedWithShortLivedKey() || currentPerson())
    throw new ComfortApiError(403, `${what} can only be changed by the owner, in the app window.`);
  try { store.profiles.requireOwner(what); } catch (error) { throw new ComfortApiError(400, errorText(error)); }
}
const cardWords: Record<string, string> = { browser: "How carefully the browser acts", network: "The proxy and trusted certificates" };
const updateWords = "Whether Branch updates itself";

/** Integration review: naming automatic updates at all, or putting a changed card back, is the owner's. */
function changesUpdates(store: Store, owner: string, input: z.infer<typeof SaveSchema>): boolean {
  if (input.card !== "notify") return false;
  const now = readComfort(store, owner, "notify");
  // Putting the card back sets updating by itself to how it ships, so it changes updates unless it is that already.
  if (input.reset) return now.autoUpdate !== (comfortShipsOn.notify?.autoUpdate ?? "off") || now.releaseChannel !== "stable";
  return !!input.values && ("autoUpdate" in input.values || "releaseChannel" in input.values);
}

/**
 * The channel decides whether this computer builds and runs every merged change (Beta), so it is chosen only in the
 * app window on this computer. A paired phone carries the owner's key, so it is the door that is refused: naming the
 * channel at all, or putting the card back when that would change the channel too.
 */
function changesChannel(store: Store, owner: string, input: z.infer<typeof SaveSchema>): boolean {
  if (input.card !== "notify") return false;
  if (input.reset) return readComfort(store, owner, "notify").releaseChannel !== "stable";
  return !!input.values && "releaseChannel" in input.values;
}
export const channelPairedRefusal = "The update channel is chosen only in the app window on this computer, not from a paired phone.";

function view(app: ComfortApp) {
  const values = allComfort(app.store, app.runtime.owner);
  return {
    values,
    certificates: values.network.caCertificates.map((entry) => {
      try { return { name: entry.name, subject: checkCertificate(entry.pem), problem: null }; }
      catch (error) { return { name: entry.name, subject: "", problem: errorText(error) }; }
    }),
    network: app.outbound?.state ?? { proxy: "none", certificates: 0 },
    shortcutDefaults, statusItems, sensitiveBrowserTools,
    ownerOnly: ownerOnlyComfortCards,
  };
}

function save(app: ComfortApp, body: unknown) {
  const input = SaveSchema.parse(body);
  const { store, runtime: { owner } } = app;
  if (ownerOnlyComfortCards.includes(input.card)) requireOwnerHere(store, cardWords[input.card]!);
  if (changesUpdates(store, owner, input)) requireOwnerHere(store, updateWords);
  if (app.pairedDoor && changesChannel(store, owner, input)) throw new ComfortApiError(403, channelPairedRefusal);
  const before = readComfort(store, owner, "browser").confirmSensitive;
  // Q48: the cards that are also in Settings are written down like a switch moved there.
  recordedWrite(store, owner, byCard(`comfort-${input.card}`), inCatalogue(`comfort-${input.card}`), () => {
    if (input.reset) resetComfort(store, owner, input.card);
    else if (input.values) {
      // Checked in full before anything is kept, so a refused certificate or proxy never reaches the store.
      if (input.card === "network") validateNetwork(ComfortNetworkSchema.parse({ ...readComfort(store, owner, "network"), ...input.values }));
      saveComfort(store, owner, input.card, input.values);
    }
  });
  if (input.card === "network") app.outbound?.apply(readComfort(store, owner, "network"));
  if (input.card === "browser") forgetYesesWhenConfirming(app, before);
  return view(app);
}

const SessionSchema = z.string().uuid().nullable();
/**
 * What the window's status line and message times need for one conversation. The model is the
 * conversation's own when it has one; the times come from its tasks, oldest first, since a message
 * itself carries no time.
 */
function status(app: ComfortApp, url: URL) {
  const { store, runtime } = app;
  const sessionId = SessionSchema.parse(url.searchParams.get("session") || null);
  const summary = runtime.models.summary(runtime.owner);
  const project = store.projects.active(runtime.owner);
  const chosen = sessionId ? runtime.models.session(runtime.owner, sessionId).preset : null;
  const presetId = chosen ?? summary.activePreset ?? summary.defaultPreset;
  const totals = sessionTotals(runtime, sessionId ?? undefined, activeModel(runtime, presetId));
  const turns = sessionId
    ? store.runs(runtime.owner).filter((run) => run.sessionId === sessionId).reverse()
      .map((run) => ({ startedAt: run.createdAt, finishedAt: run.status === "running" ? null : run.updatedAt }))
    : [];
  return {
    items: readComfort(store, runtime.owner, "display").statusLine,
    timestamps: readComfort(store, runtime.owner, "display").timestamps,
    facts: { model: runtime.models.presets.get(presetId)?.name ?? presetId, used: totals.input + totals.output,
      folder: project.folder ? `${runtime.workspace}/${project.folder}` : runtime.workspace, cost: totals.cost },
    turns,
  };
}

/** Turning "ask before sensitive browser steps" on also ends the yeses already given, as Lockdown does. */
function forgetYesesWhenConfirming(app: ComfortApp, before: boolean): void {
  if (!before && readComfort(app.store, app.runtime.owner, "browser").confirmSensitive) app.runtime.approvals.forgetAll();
}

/** How long a task marked working may record nothing before it is stale: the engine's own figure, never under 15 min. */
function staleMsOf(app: ComfortApp): number {
  const reliability = (app.runtime as { reliability?: Parameters<typeof staleAfterMs>[2] }).reliability;
  return Math.max(staleTaskMs, reliability ? staleAfterMs(app.store, app.runtime.owner, reliability) : 0);
}
/** The tasks holding an update now, stale ones left out and the hold limited (auto-update.ts updateHold). */
function countBusy(app: ComfortApp) {
  return updateHold(app.store, app.runtime.owner, busyTasks(app.store, Date.now(), staleMsOf(app)));
}

function plan(app: ComfortApp, body: unknown) {
  const input = PlanSchema.parse(body ?? {});
  const { store, runtime: { owner } } = app;
  // Integration review: only the owner's window may be told to install; everyone's tasks count as work.
  requireOwnerHere(store, updateWords);
  // A loop that had stopped is looking again: what said so is no longer true.
  if (updateProblem(store, owner)?.message.startsWith(stalledWords)) clearUpdateProblem(store, owner);
  if (input.checked) noteUpdateCheck(store, owner);
  // Never swallowed: a failure is kept (and written to the activity log) until a look goes through cleanly, and the
  // window is told to say it only when it is new, so the same failure every 30 s is not a toast every 30 s.
  const problemIsNew = input.problem ? noteUpdateProblem(store, owner, input.problem) : false;
  if (problemIsNew) diagnose("updater", "warn", `Updating by itself failed: ${input.problem}`);
  if (input.checked && !input.problem && input.updaterPhase !== "error") clearUpdateProblem(store, owner);
  // A failed install is remembered, and said once, so the automatic path does not try that release again by itself.
  const tell = input.failedTag ? noteFailedInstall(store, owner, input.failedTag) : false;
  // Dogfood F4: the window words working tasks and waiting questions apart.
  const held = countBusy(app);
  const { working: workingTasks, asking: askingTasks } = held;
  const busyTasks = workingTasks + askingTasks;
  // The owner's "update now" (update-now.ts) is done once Branch has the newest version.
  if (input.checked && input.updaterPhase === "current") clearInstallRequest(store, owner);
  // The Update button asks this too: tasks working now are offered a wait before anything closes.
  const planned = updatePlan(store, owner, { busyTasks, workingTasks, askingTasks, overdueTasks: held.overdue, updaterPhase: input.updaterPhase,
    updaterTag: input.updaterTag, installRequested: installRequested(store, owner) });
  noteUpdateLook(store, owner, new Date(), { step: planned.step, reason: planned.reason });
  const holding = held.overdue ? [] : holdingTasks(store, owner, Date.now(), staleMsOf(app));
  // A ready update held back leaves its reason in the activity log, once per reason: otherwise nothing says why it waits.
  noteUpdateWait(owner, planned, { channel: readComfort(store, owner, "notify").releaseChannel, version: input.updaterTag ?? null,
    busyTasks, workingTasks, askingTasks, holding, heldSince: held.heldSince, overdueTasks: held.overdue });
  return { ...planned,
    busyTasks, workingTasks, askingTasks, staleTasks: held.stale.length, overdueTasks: held.overdue,
    holding, problem: updateProblem(store, owner), ...(problemIsNew ? { tellProblem: true } : {}),
    ...(tell ? { failed: "The newest version did not install here, so Branch will not try it again by itself. It tries the next one as soon as it lands; Update in Settings tries this one again now." } : {}) };
}

export async function comfortApi(app: ComfortApp, request: IncomingMessage, path: string,
  readBody: (request: IncomingMessage) => Promise<unknown>): Promise<unknown> {
  const method = request.method ?? "GET";
  try {
    if (path === "/api/comfort/update-plan") {
      if (method !== "POST") throw new ComfortApiError(405, "Use POST");
      return plan(app, await readBody(request));
    }
    if (path === "/api/comfort/update-readiness") {
      requireOwnerHere(app.store, updateWords);
      if (method !== "GET") throw new ComfortApiError(405, "Use GET");
      const notify = readComfort(app.store, app.runtime.owner, "notify");
      const busy = countBusy(app);
      return { channel: notify.releaseChannel, busyTasks: busy.working + busy.asking, workingTasks: busy.working, autoUpdate: installRequested(app.store, app.runtime.owner) ? "install" : notify.autoUpdate };
    }
    if (path === "/api/comfort/status") {
      if (method !== "GET") throw new ComfortApiError(405, "Use GET");
      return status(app, new URL(request.url ?? "/", "http://branch.local"));
    }
    if (method === "GET") return view(app);
    if (method === "POST") return save(app, await readBody(request));
    throw new ComfortApiError(405, "Use GET or POST");
  } catch (error) {
    if (error instanceof ComfortApiError) throw error;
    if (error instanceof z.ZodError) throw new ComfortApiError(400, validationText(error));
    throw new ComfortApiError(400, errorText(error));
  }
}
