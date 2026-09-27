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

export interface ConnectorsHost {
  store: Store; version: string; ownMcp: OwnMcpServers; ownClis: OwnClis; replyFlags: ReplyFlags;
}

const serverAction = /^\/api\/mcp\/servers\/([a-z][a-z0-9-]{0,29})\/(start|stop|remove)$/;
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
    Empty.parse(await readBody(request));
    const [, id, verb] = action;
    return verb === "start" ? app.ownMcp.start(id!) : verb === "stop" ? app.ownMcp.stop(id!) : app.ownMcp.remove(id!);
  }
  return undefined;
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
