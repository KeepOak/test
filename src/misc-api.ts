import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { audit, auditCsv, AuditQuerySchema, type AuditQuery } from "./audit.js";
import { clarifyingQuestions, promptWithAnswers, askFirstSettings, saveAskFirstSettings } from "./ask-first.js";
import { configureRepositoryContext, repositoryContextSettings } from "./context-providers.js";
import { decisionsFromRules, mergeCategoryRules } from "./tool-categories.js";
import { nextPolicy, readPolicy, savePolicy } from "./policy.js";
import { policyChangeRefusal, withoutConfirm } from "./policy-change-guard.js"; // Q257
import { IssueLinkSchema } from "./integrations/issue-context.js";
import type { createBranch } from "./index.js";
import { byCard, recordedWrite } from "./settings-kit/recorded-write.js"; // Q48
import { ownAudit } from "./household-state.js"; // Q259

/**
 * The routes for the smaller things in this batch: the record of what the assistant was allowed to
 * do, deciding approvals a kind at a time, being asked questions before a task starts, the practice
 * workspace, how passages are ordered, model connections plugins brought, and pulling an issue into
 * a task from its address. They live here so the main route file stays readable.
 */
type Branch = Awaited<ReturnType<typeof createBranch>>;
export class MiscApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
const notFound = (): never => { throw new MiscApiError(404, "Endpoint not found"); };

/** Every path this file answers, so the main route file can hand them over in one line. */
export function handlesMiscPath(path: string): boolean {
  return /^\/api\/(audit|approvals\/categories|ask-first|practice|retrieval|providers\/plugins|issues)(\/|$)/.test(path);
}

export async function miscApi(
  app: Branch, request: IncomingMessage, path: string,
  readBody: (request: IncomingMessage, maximumBytes?: number) => Promise<unknown>,
): Promise<unknown> {
  const owner = app.runtime.owner;
  if (path.startsWith("/api/audit")) return auditApi(app, request, path, owner);
  if (path === "/api/approvals/categories") return categoriesApi(app, request, owner, readBody);
  if (path.startsWith("/api/ask-first")) return askFirstApi(app, request, path, owner, readBody);
  if (path.startsWith("/api/practice")) return practiceApi(app, request, path, owner, readBody);
  if (path.startsWith("/api/retrieval")) return retrievalApi(app, request, path, owner, readBody);
  if (path === "/api/providers/plugins") return providerPluginsApi(app, request, readBody);
  if (path === "/api/issues/context") return issueContextApi(app, request, readBody);
  return notFound();
}

async function auditApi(app: Branch, request: IncomingMessage, path: string, owner: string): Promise<unknown> {
  if (request.method !== "GET" || path !== "/api/audit") return notFound();
  const query = filterFrom(new URL(request.url ?? "/", "http://local").searchParams);
  // Q259: the record is the owner's; a household person at the window reads the part about their own tasks only.
  if (!app.store.profiles.isOwner()) return ownAudit(app, query);
  const entries = app.store.audit.list(owner, query);
  return { entries, counts: app.store.audit.counts(owner) };
}
/** The filters a web address can carry, in the shape the record understands. */
function filterFrom(query: URLSearchParams): AuditQuery {
  const value: Record<string, unknown> = {};
  for (const name of ["action", "source", "origin", "from", "to"]) {
    const found = query.get(name);
    if (found) value[name] = found;
  }
  const limit = Number(query.get("limit") ?? 0);
  if (limit > 0) value.limit = Math.min(limit, 1000);
  return AuditQuerySchema.parse(value);
}
/** The same record as a spreadsheet file; it writes its own answer, like the other exports. */
export function auditCsvResponse(app: Branch, request: IncomingMessage, response: ServerResponse): void {
  const owner = app.runtime.owner, query = filterFrom(new URL(request.url ?? "/", "http://local").searchParams);
  // Q259: as GET /api/audit: a household person saves the part about their own tasks, and is named as who saved it.
  const household = !app.store.profiles.isOwner();
  const entries = household ? ownAudit(app, query).entries : app.store.audit.list(owner, query);
  const actor = household ? app.store.profiles.scope() : owner;
  audit(app.store, owner, { action: "data.exported", actor, subject: "the record of what the assistant was allowed to do", reason: "Saved as a spreadsheet file", outcome: "saved" });
  response.writeHead(200, {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": 'attachment; filename="what-it-was-allowed-to-do.csv"',
    "cache-control": "no-store",
  });
  response.end(auditCsv(entries));
}

async function categoriesApi(
  app: Branch, request: IncomingMessage, owner: string,
  readBody: (request: IncomingMessage, maximumBytes?: number) => Promise<unknown>,
): Promise<unknown> {
  // Q259: the owner's approval rules, a kind at a time; a household person is sent none, as GET /api/policy sends no policy.
  if (request.method === "GET")
    return { categories: app.store.profiles.isOwner() ? decisionsFromRules(app.registry, readPolicy(app.store, owner).rules) : [] };
  if (request.method === "POST") {
    // Only the kinds named in the request change; every other rule the owner has is kept.
    const { confirmLoosening, input } = withoutConfirm(await readBody(request));
    const current = readPolicy(app.store, owner);
    const rules = mergeCategoryRules(app.registry, current.rules, input);
    // Q257: refused under Lockdown, and a kind made less strict needs the owner's yes to loosening.
    const refusal = policyChangeRefusal(app.store, owner, nextPolicy(current, { rules }), confirmLoosening, app.registry);
    if (refusal) throw new MiscApiError(409, refusal);
    const policy = recordedWrite(app.store, owner, byCard("policy"), ["policy"],
      () => savePolicy(app.store, owner, { rules }, "Decided a whole kind of thing at once in the approval settings"));
    return { policy, categories: decisionsFromRules(app.registry, policy.rules) };
  }
  return notFound();
}

async function askFirstApi(
  app: Branch, request: IncomingMessage, path: string, owner: string,
  readBody: (request: IncomingMessage, maximumBytes?: number) => Promise<unknown>,
): Promise<unknown> {
  if (path === "/api/ask-first/settings") {
    if (request.method === "GET") return askFirstSettings(app.store, owner);
    if (request.method === "POST") return saveAskFirstSettings(app.store, owner, await readBody(request));
  }
  if (path === "/api/ask-first" && request.method === "POST")
    return clarifyingQuestions(app.store, app.runtime.models, owner, await readBody(request));
  if (path === "/api/ask-first/answers" && request.method === "POST")
    return promptWithAnswers(await readBody(request, 128 * 1024));
  return notFound();
}

async function practiceApi(
  app: Branch, request: IncomingMessage, path: string, owner: string,
  readBody: (request: IncomingMessage, maximumBytes?: number) => Promise<unknown>,
): Promise<unknown> {
  if (path !== "/api/practice") return notFound();
  if (request.method === "GET") return app.practice.state(owner);
  if (request.method === "POST") return app.practice.switch(owner, await readBody(request));
  return notFound();
}

async function retrievalApi(
  app: Branch, request: IncomingMessage, path: string, owner: string,
  readBody: (request: IncomingMessage, maximumBytes?: number) => Promise<unknown>,
): Promise<unknown> {
  if (path === "/api/retrieval") {
    if (request.method === "GET")
      return { ...app.retrieval.view(owner), ...repositoryContextSettings(app.store, owner),
        providers: app.contextProviders.list() };
    if (request.method === "POST") return app.retrieval.configure(owner, await readBody(request));
  }
  if (path === "/api/retrieval/context" && request.method === "POST")
    return configureRepositoryContext(app.store, owner, await readBody(request));
  if (path === "/api/retrieval/pipelines" && request.method === "POST")
    return app.retrieval.configurePipelines(owner, await readBody(request));
  if (path === "/api/retrieval/search" && request.method === "POST") {
    const asked = z.object({
      query: z.string().trim().min(1).max(500),
      pipeline: z.string().trim().min(1).max(60).optional(),
      collection: z.string().trim().min(1).max(120).optional(),
    }).strict().parse(await readBody(request));
    return app.retrieval.search(owner, asked.query, undefined, {
      ...(asked.pipeline ? { pipeline: asked.pipeline } : {}),
      ...(asked.collection ? { collection: spellingsOf(app, owner, asked.collection) } : {}),
    });
  }
  return notFound();
}

/**
 * Both ways of naming one knowledge base — what the owner called it and the id the panel writes —
 * so a pipeline chosen on the card is found whichever of the two it was keyed under.
 */
function spellingsOf(app: Branch, owner: string, collection: string): string[] {
  try {
    const found = app.knowledgeBases.one(owner, collection);
    return [...new Set([collection, found.id, found.name])];
  } catch { return [collection]; }
}

async function providerPluginsApi(
  app: Branch, request: IncomingMessage,
  readBody: (request: IncomingMessage, maximumBytes?: number) => Promise<unknown>,
): Promise<unknown> {
  if (request.method === "GET") return { providers: app.providerPlugins.list() };
  if (request.method === "POST") return app.providerPlugins.addPreset(await readBody(request));
  return notFound();
}

async function issueContextApi(
  app: Branch, request: IncomingMessage,
  readBody: (request: IncomingMessage, maximumBytes?: number) => Promise<unknown>,
): Promise<unknown> {
  if (request.method !== "POST") return notFound();
  const { url } = IssueLinkSchema.parse(await readBody(request));
  const issues = app.issues;
  if (!issues) throw new MiscApiError(400, "No issue tracker is switched on in this launch's integration settings");
  const context = await issues.contextFor(url, 2);
  if (!context) throw new MiscApiError(404, "That does not look like an issue address this assistant can read");
  return context;
}
