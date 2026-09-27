import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { collectMetrics, prometheusText } from "./metrics.js";
import { ruleSentence } from "./policy-resources.js";
import { PolicyRuleSchema, evaluatePolicy, isReadOnlyPermission, readPolicy, savePolicy } from "./policy.js";
import { resourceOf } from "./policy-resources.js";
import { pricingSettings } from "./pricing.js";
import { saveTraceExportSettings, traceExportSettings } from "./tracing-export.js";
import type { createBranch } from "./index.js";
import { byCard, recordedWrite } from "./settings-kit/recorded-write.js"; // Q48
import { lockedDown } from "./lockdown.js";

/**
 * The routes for this batch: the spans of a task, sending traces somewhere, the counters page, the
 * approval rules read as sentences, and trying a decision out before saving a rule. They live here
 * so the main route file stays readable.
 */
type Branch = Awaited<ReturnType<typeof createBranch>>;
export class TracingApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
const notFound = (): never => { throw new TracingApiError(404, "Endpoint not found"); };

/** Every path this file answers, so the main route file can hand them over in one line. */
export function handlesTracingPath(path: string): boolean {
  return /^\/api\/(tracing|rules)(\/|$)/.test(path);
}

export async function tracingApi(
  app: Branch, request: IncomingMessage, path: string,
  readBody: (request: IncomingMessage, maximumBytes?: number) => Promise<unknown>,
): Promise<unknown> {
  if (path.startsWith("/api/tracing")) return tracing(app, request, path, readBody);
  if (path.startsWith("/api/rules")) return rules(app, request, path, readBody);
  return notFound();
}

async function tracing(
  app: Branch, request: IncomingMessage, path: string,
  readBody: (request: IncomingMessage, maximumBytes?: number) => Promise<unknown>,
): Promise<unknown> {
  // The steps of a task and where they are sent are the owner's own: a second person's profile on
  // this computer is refused here, the same way saved workflows and the owner's secrets are.
  app.store.profiles.requireOwner("The steps of a task and where they are sent");
  const owner = app.runtime.owner;
  if (path === "/api/tracing/settings") {
    if (request.method === "GET") return { settings: traceExportSettings(app.store, owner), destinations: destinationHelp() };
    if (request.method === "POST") return { settings: saveTraceExportSettings(app.store, owner, await readBody(request)) };
  }
  if (path === "/api/tracing/spans" && request.method === "GET") {
    const query = new URL(request.url ?? "/", "http://local").searchParams;
    const runId = query.get("run");
    const limit = Math.min(Number(query.get("limit") ?? 100) || 100, 500);
    const spans = runId
      ? app.store.spans.forRun(runId).filter((span) => span.owner === owner)
      : app.store.spans.recent(owner, limit);
    return { spans };
  }
  if (path === "/api/tracing/test" && request.method === "POST") {
    const settings = traceExportSettings(app.store, owner);
    if (!settings.enabled) throw new TracingApiError(400, "Turn sending traces on first, then try again");
    const results = await app.traceExport.sendSpans(app.store.spans.recent(owner, 5), "A test trace was sent");
    const failed = results.find((result) => !result.ok);
    return { sent: results.reduce((total, result) => total + result.sent, 0), ok: !failed, error: failed?.error ?? null };
  }
  return notFound();
}

/** What each destination is, in plain words, for the settings screen. */
function destinationHelp(): { id: string; label: string; description: string }[] {
  return [
    { id: "otlp", label: "A tracing tool of my own", description: "Anything that reads OpenTelemetry, such as Jaeger, Grafana Tempo or an OpenTelemetry collector." },
    { id: "langfuse", label: "Langfuse", description: "Send them to a Langfuse server. Put the key in Settings as a saved secret and refer to it here." },
    { id: "langsmith", label: "LangSmith", description: "Send them to LangSmith. Put the key in Settings as a saved secret and refer to it here." },
  ];
}

const RevokeSchema = z.object({
  session: z.string().uuid(),
  tool: z.string().trim().min(1).max(100),
  target: z.string().max(500).default(""),
}).strict();
const TestDecisionSchema = z.object({
  tool: z.string().trim().min(1).max(100),
  target: z.string().trim().max(500).default(""),
}).strict();

async function rules(
  app: Branch, request: IncomingMessage, path: string,
  readBody: (request: IncomingMessage, maximumBytes?: number) => Promise<unknown>,
): Promise<unknown> {
  const owner = app.runtime.owner;
  // What a conversation is allowed to do right now belongs to whoever is having it: the answers are
  // kept per conversation, so anybody may ask about their own. Everything below this line is the
  // owner's rule list, which a second person's profile may neither read nor loosen.
  if (path === "/api/rules/allowed" && request.method === "GET") {
    const sessionId = new URL(request.url ?? "/", "http://local").searchParams.get("session") ?? "";
    const mine = sessionId ? app.store.ownsSession(app.store.profiles.scope(), sessionId) : false;
    return {
      session: sessionId,
      grants: mine ? app.runtime.allowedNow(sessionId) : [],
      /* The standing rules that say "go ahead", so the list is the whole picture rather than half
         of it: a yes kept for this conversation, and a rule kept for good. The rule list is the
         owner's, so a second person's profile sees only their own conversation's yeses. */
      standing: app.store.profiles.isOwner()
        ? readPolicy(app.store, owner).rules
            .map((rule, index) => ({ index, rule, sentence: ruleSentence(rule) }))
            .filter((entry) => entry.rule.decision === "allow")
        : [],
    };
  }
  /** Takes back one yes this conversation had remembered; it asks again the next time. */
  if (path === "/api/rules/allowed/revoke" && request.method === "POST") {
    const { session, tool, target } = RevokeSchema.parse(await readBody(request));
    /* Only your own conversation's yeses, so nobody can reach into somebody else's. */
    if (!app.store.ownsSession(app.store.profiles.scope(), session))
      throw new TracingApiError(404, "There is no conversation of yours with that number");
    const revoked = app.runtime.revokeGrant(session, tool, target);
    if (!revoked) throw new TracingApiError(404, "That conversation is not allowing this any more");
    return { revoked, grants: app.runtime.allowedNow(session) };
  }
  app.store.profiles.requireOwner("The approval rules");
  if (path === "/api/rules" && request.method === "GET") {
    const policy = readPolicy(app.store, owner);
    return { rules: policy.rules.map((rule, index) => ({ index, rule, sentence: ruleSentence(rule) })) };
  }
  // unhold-approvals: while Lockdown is on the saved list is Lockdown's own ask-everything rule, and Lockdown
  // puts the owner's list back when it ends, so a rule added or removed now would loosen it or be lost.
  if ((path === "/api/rules/add" || path === "/api/rules/remove") && request.method === "POST" && lockedDown(app.store, owner))
    throw new TracingApiError(409, "Lockdown is on, so settings cannot be changed from here. Turn it off first.");
  if (path === "/api/rules/add" && request.method === "POST") {
    const rule = PolicyRuleSchema.parse(await readBody(request));
    const current = readPolicy(app.store, owner);
    const policy = recordedWrite(app.store, owner, byCard("policy"), ["policy"],
      () => savePolicy(app.store, owner, { rules: [rule, ...current.rules] }, "A rule was added in the approval settings"));
    return { rules: policy.rules.map((each, index) => ({ index, rule: each, sentence: ruleSentence(each) })) };
  }
  if (path === "/api/rules/remove" && request.method === "POST") {
    const { index } = z.object({ index: z.number().int().min(0) }).strict().parse(await readBody(request));
    const current = readPolicy(app.store, owner);
    if (index >= current.rules.length) throw new TracingApiError(404, "There is no rule at that position");
    const policy = recordedWrite(app.store, owner, byCard("policy"), ["policy"], () => savePolicy(app.store, owner,
      { rules: current.rules.filter((_rule, at) => at !== index) }, "A rule was removed in the approval settings"));
    return { rules: policy.rules.map((each, at) => ({ index: at, rule: each, sentence: ruleSentence(each) })) };
  }
  if (path === "/api/rules/test" && request.method === "POST") {
    const { tool, target } = TestDecisionSchema.parse(await readBody(request));
    const permission = app.registry.permissionOf(tool);
    const resource = resourceOf(tool, permission, target, { path: target, url: target });
    const outcome = evaluatePolicy(readPolicy(app.store, owner), {
      tool, target, readOnly: isReadOnlyPermission(permission), resource,
    });
    return {
      decision: outcome.decision,
      because: outcome.rule ? ruleSentence(outcome.rule) : "No rule covers this, so it goes ahead.",
      resource,
    };
  }
  return notFound();
}

/**
 * Batch 20 (wave 8): the logs route. Everything a task wrote down, newest first, as one JSON
 * object per line — the shape a log shipper reads without being taught anything. It needs the same
 * local key as every other route, it answers only the owner's own tasks, and it is filtered with
 * `run`, `kind` (comma-separated) and `limit`. Saved passwords and keys are taken back out on the
 * way, the same as everywhere else.
 *
 * There is deliberately no Grafana or Loki client here: a collector of the owner's already reads
 * OpenTelemetry, so the way to Grafana is to point one at the OTLP address under Settings → Tracing
 * rather than to teach Branch a second protocol. See docs/configuration.md.
 */
export function logsResponse(app: Branch, request: IncomingMessage, response: ServerResponse): void {
  app.store.profiles.requireOwner("What your tasks wrote down");
  const query = new URL(request.url ?? "/", "http://local").searchParams;
  const kinds = (query.get("kind") ?? "").split(",").map((kind) => kind.trim()).filter(Boolean).slice(0, 20);
  const limit = Math.min(Math.max(Number(query.get("limit") ?? 200) || 200, 1), 2000);
  const runId = query.get("run");
  const rows = runId ? app.store.events(runId) : app.store.recentEvents(app.runtime.owner, limit);
  const mine = runId && app.store.run(runId)?.owner !== app.runtime.owner ? [] : rows;
  const lines = mine
    .filter((event) => !kinds.length || kinds.includes(event.kind))
    .slice(0, limit)
    .map((event) => app.runtime.hideSecrets(JSON.stringify(event)));
  response.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" });
  response.end(lines.length ? lines.join("\n") + "\n" : "");
}

/**
 * The counters, as the plain text a monitoring tool scrapes. It writes its own answer because the
 * format is text rather than JSON; the same local key protects it as every other route.
 */
export function metricsResponse(app: Branch, response: ServerResponse): void {
  const { overrides } = pricingSettings(app.store, app.runtime.owner);
  const monthly = app.store.usageStore().getMonthlyStats(undefined, overrides);
  const snapshot = collectMetrics(app.store.sqlite, app.runtime.owner, monthly.estimatedCost);
  response.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8", "cache-control": "no-store" });
  response.end(prometheusText(snapshot));
}
