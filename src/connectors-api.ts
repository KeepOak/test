/**
 * eng-connectors: the routes for the connector catalogue and the owner's own MCP servers, command-line tools on this
 * computer, What's new, and flagged replies. Every change is the owner's: short-lived keys and household profiles are
 * refused before these run (src/short-lived-keys.ts, src/household-routes.ts), and each change says so again here.
 * `undefined` means the path is not one of these.
 */
import type { IncomingMessage } from "node:http";
import { z } from "zod";
import { catalogueByCategory, mcpCatalogue } from "./mcp-catalogue.js";
import { notesFor } from "./release-notes.js";
import { HttpError, readJsonBody as readBody } from "./server-http.js";
import { startedWithShortLivedKey } from "./key-context.js";
import type { OwnMcpServers } from "./mcp-own-servers.js";
import type { OwnClis } from "./own-clis.js";
import type { ReplyFlags } from "./reply-flags.js";
import type { Store } from "./store.js";
import type { IssueAccess } from "./integrations/issue-tools.js";
import type { SessionLock } from "./session-lock.js";
import { HealthCheck, HealthAuthorityError, withHealthCheck } from "./health-check.js";

export interface ConnectorsHost {
  store: Store; version: string; ownMcp: OwnMcpServers; ownClis: OwnClis; replyFlags: ReplyFlags;
  issues?: IssueAccess | null;
  sessionLock: Pick<SessionLock, "locked" | "onLocked">;
}

const serverAction = /^\/api\/mcp\/servers\/([a-z][a-z0-9-]{0,29})\/(start|stop|remove|timeout|test)$/;
const flagRemove = /^\/api\/reply-flags\/([a-f0-9-]{36})\/remove$/;
const Empty = z.object({}).strict();

async function serversApi(app: ConnectorsHost, request: IncomingMessage, path: string): Promise<unknown> {
  if (path === "/api/mcp/catalogue" && request.method === "GET") {
    const file = mcpCatalogue();
    return { checked: file.checked, count: file.connectors.length, categories: catalogueByCategory(file) };
  }
  // Keys and household profiles may look, but only the owner at the window sees what answering a start question takes.
  if (path === "/api/mcp/servers" && request.method === "GET") return app.ownMcp.list(app.store.profiles.isOwner() && !startedWithShortLivedKey());
  if (path === "/api/mcp/servers" && request.method === "POST") {
    app.store.profiles.requireOwner("Adding a tool server");
    return app.ownMcp.add(await readBody(request, 65536));
  }
  const action = serverAction.exec(path);
  if (action && request.method === "POST") {
    app.store.profiles.requireOwner("Changing a tool server");
    const [, id, verb] = action;
    if (verb === "test") return checkOwnServer(app, request, id!);
    if (verb === "timeout") {
      const body = z.object({ seconds: z.unknown() }).strict().parse(await readBody(request));
      return app.ownMcp.setCallTimeout(id!, body.seconds);
    }
    Empty.parse(await readBody(request));
    return verb === "start" ? app.ownMcp.start(id!) : verb === "stop" ? app.ownMcp.stop(id!) : app.ownMcp.remove(id!);
  }
  return undefined;
}

/** Owner admission remains bound across a slow body and the existing connection's ping. */
async function checkOwnServer(app: ConnectorsHost, request: IncomingMessage, id: string): Promise<unknown> {
  const who = app.store.profiles.active()?.id ?? null;
  const controller = new AbortController();
  const refuse = () => controller.abort(new HttpError(403, "The original owner request is no longer authorized."));
  const check = () => {
    controller.signal.throwIfAborted();
    app.store.profiles.requireOwner("Checking your tool server");
    if (startedWithShortLivedKey() || (app.store.profiles.active()?.id ?? null) !== who)
      throw new HttpError(403, "Only the original owner request can check this tool server.");
    if (app.sessionLock.locked()) throw new HttpError(423, "Unlock Branch before checking your tool server.");
  };
  check();
  const offProfile = app.store.profiles.onSwitched(refuse);
  const offLock = app.sessionLock.onLocked(refuse);
  request.once("aborted", refuse);
  try {
    Empty.parse(await readBody(request));
    check();
    const health = await app.ownMcp.test(id, controller.signal);
    check();
    return { health };
  } finally {
    offProfile(); offLock(); request.off("aborted", refuse);
  }
}

async function clisApi(app: ConnectorsHost, request: IncomingMessage, path: string): Promise<unknown> {
  if (path === "/api/clis" && request.method === "GET") return app.ownClis.list();
  if (path === "/api/clis" && request.method === "POST") {
    app.store.profiles.requireOwner("Allowing a command-line tool");
    return app.ownClis.add(await readBody(request));
  }
  if (path === "/api/clis/remove" && request.method === "POST") {
    app.store.profiles.requireOwner("Removing a command-line tool");
    return app.ownClis.remove(await readBody(request));
  }
  return undefined;
}

async function flagsApi(app: ConnectorsHost, request: IncomingMessage, path: string): Promise<unknown> {
  if (path === "/api/reply-flags" && request.method === "GET") return { flags: app.replyFlags.marks() };
  if (path === "/api/reply-flags" && request.method === "POST") {
    app.store.profiles.requireOwner("Reporting a reply");
    return app.replyFlags.add(await readBody(request));
  }
  // Only the owner asking gets the flags out, and never a short-lived key: a POST, which fails closed to keys.
  if (path === "/api/reply-flags/export" && request.method === "POST") {
    app.store.profiles.requireOwner("Exporting your reports");
    Empty.parse(await readBody(request));
    return app.replyFlags.exported();
  }
  const remove = flagRemove.exec(path);
  if (remove && request.method === "POST") {
    app.store.profiles.requireOwner("Removing a report");
    Empty.parse(await readBody(request));
    return app.replyFlags.remove(remove[1]!);
  }
  return undefined;
}

export async function connectorsApi(app: ConnectorsHost, request: IncomingMessage, path: string): Promise<unknown> {
  if (path === "/api/connectors/accounts" && request.method === "GET") {
    app.store.profiles.requireOwner("Your connected account checks");
    return { accounts: (app.issues?.available() ?? []).filter((id) => id === "github" || id === "linear") };
  }
  const check = /^\/api\/connectors\/accounts\/(github|linear)\/test$/.exec(path);
  if (check && request.method === "POST") {
    app.store.profiles.requireOwner("Checking your connected account");
    const original = app.issues;
    const authority = new HealthCheck(app.store, app.store.profiles.ownerName, app.sessionLock, request);
    return withHealthCheck(authority, async () => {
      authority.bindConnection(() => app.issues === original);
      Empty.parse(await readBody(request));
      if (!original) throw new HttpError(409, "No issue tracker accounts are configured.");
      if (app.issues !== original) throw new HttpError(403, "The connected account changed. Check it again.");
      const health = await original.checkAccount(check[1] as "github" | "linear");
      if (app.issues !== original) throw new HttpError(403, "The connected account changed. Check it again.");
      return { health };
    }).catch(error => { if (error instanceof HealthAuthorityError) throw new HttpError(error.status, error.message); throw error; });
  }
  if (path === "/api/release-notes" && request.method === "GET") return notesFor(app.version);
  if (path.startsWith("/api/mcp/")) return serversApi(app, request, path);
  if (path === "/api/clis" || path.startsWith("/api/clis/")) return clisApi(app, request, path);
  if (path === "/api/reply-flags" || path.startsWith("/api/reply-flags/")) {
    const answer = await flagsApi(app, request, path);
    if (answer === undefined) throw new HttpError(404, "Endpoint not found");
    return answer;
  }
  return undefined;
}
