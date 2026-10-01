import type { IncomingMessage } from "node:http";
import { z } from "zod";
import type { createBranch } from "../index.js";
import { startedWithShortLivedKey } from "../key-context.js";
import { fromThisComputer } from "../listen-address.js";
import { HttpError } from "../server-http.js";
import { DaytonaRun } from "./daytona-workspace.js";
import { tryToolByHand } from "../playground.js";

type Branch = Awaited<ReturnType<typeof createBranch>>;
export async function daytonaApi(app: Branch, request: IncomingMessage, path: string,
  readBody: (request: IncomingMessage, limit?: number) => Promise<unknown>) {
  const guard = () => {
    app.store.profiles.requireOwner("Daytona cloud workspace");
    if (startedWithShortLivedKey() || !fromThisComputer(request.socket.remoteAddress, request.headers))
      throw new HttpError(403, "Manage paid Daytona workspaces in the owner's local app window.");
  };
  guard();
  if (request.method === "GET" && path === "/api/daytona") return app.daytona.state();
  if (request.method !== "POST") throw new HttpError(404, "Endpoint not found");
  const body = await readBody(request, 8192); guard();
  switch (path) {
    case "/api/daytona/check": return app.daytona.check(body);
    case "/api/daytona/prepare": return app.daytona.prepare(body);
    case "/api/daytona/create": return app.daytona.create(z.object({ token: z.string().uuid() }).strict().parse(body).token);
    case "/api/daytona/reconcile": z.object({}).strict().parse(body); return app.daytona.inspect();
    case "/api/daytona/lifecycle": {
      const value = z.object({ action: z.enum(["stop", "delete"]), name: z.string().max(101), confirm: z.literal(true) }).strict().parse(body);
      return app.daytona.lifecycle(value.action, value.name);
    }
    case "/api/daytona/run": {
      const value = DaytonaRun.extend({ confirm: z.boolean().default(false) }).parse(body);
      return tryToolByHand(app, { name: "daytona.run", arguments: { workspace: value.workspace, command: value.command, timeout: value.timeout }, confirm: value.confirm });
    }
    default: throw new HttpError(404, "Endpoint not found");
  }
}
