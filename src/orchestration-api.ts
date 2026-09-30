import type { IncomingMessage } from "node:http";
import { z } from "zod";
import { errorText } from "./request-errors.js";
import { flowsApi } from "./flows.js";
// Wave 8: the to-do list and reports saved in several forms.
import { remindAbout, todosApi } from "./todos.js";
import { reportsApi } from "./reports.js";
import { batchSets, cachedAnswers, logJsonl, readLog, requestAllowances } from "./dashboards.js";
import { obsidianApi } from "./obsidian.js";
import { embedsApi } from "./embeds.js";
import { projectCheck, saveProjectCheck } from "./code-change.js";
import { codeRunSettings, saveCodeRunSettings } from "./code-run.js";
import { backgroundSettings, saveBackgroundSettings } from "./processes.js";
import { SettleDeferredSchema } from "./deferred.js";
import { specialistStyles, styleShape } from "./specialist-styles.js";
import type { createBranch } from "./index.js";
import { AddOnsApiError, addOnsApi } from "./add-ons/api.js"; // bucket-15

/**
 * The routes for this batch: flows as boxes and arrows, jobs handed over to finish later, programs
 * left running, and the three switches behind them — the project's own check, the programs the
 * owner allows to be left running, and whether small scripts may run at all.
 */
type Branch = Awaited<ReturnType<typeof createBranch>>;
export class OrchestrationApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
const notFound = (): never => { throw new OrchestrationApiError(404, "Endpoint not found"); };

/** Every path this file answers, so the main route file can hand them over in one line. */
export function handlesOrchestrationPath(path: string): boolean {
  return /^\/api\/(flows|deferred|processes|open-work|code-check|code-run|background-programs|specialist-styles|skill-revisions|plugin-catalog|todos|reports|log|request-rates|cached-answers|batch-sets|obsidian|embeds)(\/|$)/.test(path);
}

export async function orchestrationApi(
  app: Branch, request: IncomingMessage, path: string,
  readBody: (request: IncomingMessage, maximumBytes?: number) => Promise<unknown>,
): Promise<unknown> {
  const owner = app.runtime.owner;
  // Every one of these belongs to the owner: they switch host execution on, say which programs may
  // be left running, copy a plugin in, keep a drafted skill, or answer a job handed over earlier.
  app.store.profiles.requireOwner("Flows, programs left running and the switches behind them");
  if (path.startsWith("/api/flows")) {
    const answered = await flowsApi(app.flows, request, path, () => readBody(request));
    return answered ?? notFound();
  }
  // Wave 8: the to-do list, and "Save as report" in its three forms.
  if (path.startsWith("/api/todos")) {
    const answered = await todosApi(app.todos, owner, request, path, () => readBody(request),
      (todo) => remindAbout(app.scheduler, app.runtime.context({}), todo));
    return answered ?? notFound();
  }
  if (path.startsWith("/api/reports")) {
    const answered = await reportsApi(app.store, owner, request, path, () => readBody(request, 512_000));
    return answered ?? notFound();
  }
  // Wave 8: the record with its filters, how busy each connection is, and what asking twice saved.
  if (path === "/api/log" || path === "/api/log/export") {
    const wanted = Object.fromEntries(new URL(request.url ?? "/", "http://local").searchParams);
    const filter = {
      ...(wanted.kind ? { kind: wanted.kind } : {}), ...(wanted.runId ? { runId: wanted.runId } : {}),
      ...(wanted.since ? { since: wanted.since } : {}), ...(wanted.until ? { until: wanted.until } : {}),
      ...(wanted.limit ? { limit: Number(wanted.limit) } : {}),
    };
    const read = readLog(app.store, owner, filter);
    return path === "/api/log/export"
      ? { filename: "record.jsonl", contentType: "application/x-ndjson", body: logJsonl(read.lines), lines: read.lines.length }
      : read;
  }
  if (path === "/api/request-rates")
    return { connections: requestAllowances(app.runtime.models.requests, app.runtime.models.health) };
  if (path === "/api/cached-answers") return cachedAnswers(app.store, owner);
  if (path === "/api/batch-sets") return batchSets(app.store, owner);
  if (path.startsWith("/api/obsidian")) {
    const answered = await obsidianApi(app.store, owner, app.obsidian, request, path, () => readBody(request, 512_000));
    return answered ?? notFound();
  }
  if (path === "/api/embeds") {
    const answered = await embedsApi(app.store, owner, request, path, () => readBody(request));
    return answered ?? notFound();
  }
  if (path.startsWith("/api/deferred")) return deferredApi(app, request, path, readBody);
  if (path.startsWith("/api/skill-revisions")) return revisionsApi(app, request, path, readBody);
  if (path.startsWith("/api/plugin-catalog")) return pluginCatalogApi(app, request, path, readBody);
  if (path === "/api/processes") return processesApi(app, request, readBody);
  if (path.startsWith("/api/open-work")) return openWorkApi(app, request, path);
  if (path === "/api/specialist-styles")
    return { styles: specialistStyles.map((style) => ({ style, ...summaryOf(style) })) };
  if (path === "/api/code-check")
    return request.method === "POST"
      ? saveProjectCheck(app.store, owner, await readBody(request)) : projectCheck(app.store, owner);
  if (path === "/api/code-run")
    return request.method === "POST"
      ? saveCodeRunSettings(app.store, owner, await readBody(request)) : codeRunSettings(app.store, owner);
  if (path === "/api/background-programs")
    return request.method === "POST"
      ? saveBackgroundSettings(app.store, owner, await readBody(request)) : backgroundSettings(app.store, owner);
  return notFound();
}

const summaryOf = (style: string) => {
  const shape = styleShape(style as Parameters<typeof styleShape>[0]);
  return { summary: shape.summary, opens: shape.groups, readOnly: shape.readOnly, plans: shape.plan, thinksAloud: shape.scratch };
};

async function deferredApi(
  app: Branch, request: IncomingMessage, path: string,
  readBody: (request: IncomingMessage, maximumBytes?: number) => Promise<unknown>,
): Promise<unknown> {
  if (request.method === "GET" && path === "/api/deferred") {
    const waiting = new URL(request.url ?? "/", "http://local").searchParams.get("waiting") === "1";
    return { deferred: app.runtime.deferrals.list(waiting ? { waiting: true } : {}) };
  }
  if (request.method === "POST" && path === "/api/deferred/settle") {
    const value = SettleDeferredSchema.parse(await readBody(request));
    return app.runtime.settleDeferred(value.id, value.outcome, value.action);
  }
  return notFound();
}

/**
 * Switching a draft on without the trial needs the owner to say so in as many words. `force` on
 * its own is not enough: the exact sentence below has to come with it, typed by the screen only
 * when the person has pressed a second button that says what they are skipping. Nothing the model
 * can reach passes this — these routes are the owner's own, and the model has no tool for them.
 */
export const skipTrialConfirmation = "I have not tried this draft and I want it anyway";
const revisionBody = z.object({
  skillId: z.string().uuid(), version: z.number().int().min(1).max(20),
  force: z.boolean().optional(), confirm: z.string().max(200).optional(),
}).strict();
/** Drafted better versions of a skill: seeing the changed lines, trying them, and saying yes or no. */
async function revisionsApi(
  app: Branch, request: IncomingMessage, path: string,
  readBody: (request: IncomingMessage, maximumBytes?: number) => Promise<unknown>,
): Promise<unknown> {
  if (request.method === "GET" && path === "/api/skill-revisions") return { revisions: app.skillRevisions.list() };
  if (request.method !== "POST") return notFound();
  const body = revisionBody.parse(await readBody(request));
  if (path === "/api/skill-revisions/try") return app.skillRevisions.tryOut(app.runtime, body.skillId, body.version);
  if (path === "/api/skill-revisions/accept") {
    if (!body.force) return app.skillRevisions.accept(body.skillId, body.version);
    app.store.profiles.requireOwner("Switching on a drafted skill without trying it");
    if (body.confirm !== skipTrialConfirmation)
      throw new Error(`To switch this on without trying it, confirm it in the app. It is refused until the words "${skipTrialConfirmation}" come with the request.`);
    return app.skillRevisions.accept(body.skillId, body.version, { force: true });
  }
  if (path === "/api/skill-revisions/reject") return app.skillRevisions.reject(body.skillId, body.version);
  return notFound();
}

const pluginSource = z.object({ source: z.string().min(1).max(1000), sha256: z.string().regex(/^[0-9a-f]{64}$/).optional() }).strict();
/** Plugins from a folder or one file on this computer: looking first, then copying in. */
async function pluginCatalogApi(
  app: Branch, request: IncomingMessage, path: string,
  readBody: (request: IncomingMessage, maximumBytes?: number) => Promise<unknown>,
): Promise<unknown> {
  if (request.method === "GET" && path === "/api/plugin-catalog") return { plugins: await app.pluginCatalog.list() };
  // ── bucket-15: add-ons other people wrote (src/add-ons/api.ts). ──
  if (path.startsWith("/api/plugin-catalog/add-ons"))
    return addOnsApi(app.addOns, request.method ?? "GET", path, () => readBody(request, 1_000_000)).catch((error: unknown) => {
      throw error instanceof AddOnsApiError ? new OrchestrationApiError(error.status, error.message) : error;
    });
  if (request.method !== "POST") return notFound();
  if (path === "/api/plugin-catalog/evaluate") return app.pluginEvaluations.evaluate(await readBody(request, 1_000_000));
  if (path === "/api/plugin-catalog/status") {
    const body = z.object({ id: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/) }).strict().parse(await readBody(request));
    return app.pluginEvaluations.status(body.id);
  }
  if (path === "/api/plugin-catalog/promote") {
    const body = z.object({ id: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/), evaluationId: z.string().uuid() }).strict().parse(await readBody(request));
    return app.pluginEvaluations.promote(body.id, body.evaluationId);
  }
  if (path === "/api/plugin-catalog/restore") {
    const body = z.object({ id: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/), sha256: z.string().regex(/^[a-f0-9]{64}$/),
      expectedCurrent: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(await readBody(request));
    return app.pluginEvaluations.restore(body.id, body.sha256, body.expectedCurrent);
  }
  if (path === "/api/plugin-catalog/inspect") return app.pluginCatalog.inspect(pluginSource.parse(await readBody(request)).source);
  if (path === "/api/plugin-catalog/install") {
    const body = pluginSource.parse(await readBody(request));
    return app.pluginCatalog.install(body.source, body.sha256 ? { expectSha256: body.sha256 } : {});
  }
  if (path === "/api/plugin-catalog/forget") {
    const { id } = z.object({ id: z.string().min(1).max(40) }).strict().parse(await readBody(request));
    return app.pluginCatalog.forget(id);
  }
  return notFound();
}

/**
 * The lead's workbench (window): what one conversation still has going, for the helpers frame.
 *   GET    /api/open-work?session=<id>                 its tasks with a helper still working (their helpers are read
 *                                                      through GET /api/runs/<id>/steps, so steering and stopping keep
 *                                                      their own rules), its wake-ups, and its programs left running
 *   DELETE /api/open-work/wakeups/<id>?session=<id>   cancels one of its wake-ups
 * A program is stopped through POST /api/processes, a helper through POST /api/runs/<id>/cancel.
 */
function openWorkApi(app: Branch, request: IncomingMessage, path: string): unknown {
  const session = new URL(request.url ?? "/", "http://branch.local").searchParams.get("session") ?? "";
  if (!session || !app.store.ownsSession(app.runtime.owner, session)) throw new OrchestrationApiError(404, "Conversation not found");
  const cancel = /^\/api\/open-work\/wakeups\/([0-9a-f-]{36})$/.exec(path);
  if (cancel && request.method === "DELETE") {
    try { return { cancelled: app.wakeups.cancel(cancel[1]!, session) }; } catch (error) { throw new OrchestrationApiError(404, errorText(error)); }
  }
  if (path !== "/api/open-work" || request.method !== "GET") return notFound();
  const helperRuns = app.store.sqlite.prepare(`SELECT DISTINCT t.id AS id FROM events e JOIN tasks t ON t.id=e.run_id
    JOIN tasks c ON c.id=json_extract(e.data,'$.childRunId')
    WHERE t.session_id=? AND t.owner=? AND e.kind='delegation.background_started' AND c.status IN ('running','needs_input','queued')`)
    .all(session, app.runtime.owner).map((row) => String(row.id));
  return {
    helperRuns,
    wakeups: app.wakeups.list(session).map(({ id, message, nextAt, everyMinutes, cron, timezone, left }) =>
      ({ id, message, nextAt, everyMinutes, cron: cron ?? null, timezone: timezone ?? null, left })),
    programs: app.processes.list({ sessionId: session, active: true }).map(({ id, name, program, startedAt }) => ({ id, name, program, startedAt })),
  };
}

async function processesApi(
  app: Branch, request: IncomingMessage,
  readBody: (request: IncomingMessage, maximumBytes?: number) => Promise<unknown>,
): Promise<unknown> {
  if (request.method === "GET") return { processes: app.processes.list() };
  if (request.method === "POST") {
    const { id } = z.object({ id: z.string().uuid() }).strict().parse(await readBody(request));
    return app.processes.stop(id);
  }
  return notFound();
}
