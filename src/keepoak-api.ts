import { z } from "zod";
import type { IncomingMessage } from "node:http";
import type { KeepOakConnection } from "./keepoak-connection.js";
import { HttpError, readJsonBody } from "./server-http.js";
import { startedWithShortLivedKey } from "./key-context.js";
import type { Store } from "./store.js";

export interface KeepOakHost { store: Store; keepoak?: KeepOakConnection }
const Empty = z.object({}).strict();

export async function keepoakApi(app: KeepOakHost, request: IncomingMessage, path: string): Promise<unknown> {
  app.store.profiles.requireOwner("Connecting KeepOak");
  if (startedWithShortLivedKey()) throw new HttpError(403, "Connect KeepOak in the owner's app window.");
  if (!app.keepoak) throw new HttpError(503, "The KeepOak connection is unavailable in this engine.");
  if (path === "/api/keepoak" && request.method === "GET") return app.keepoak.state();
  const action = /^\/api\/keepoak\/(enable|begin|poll|cancel|profile|disconnect)$/.exec(path)?.[1];
  if (!action || request.method !== "POST") throw new HttpError(404, "Endpoint not found");
  Empty.parse(await readJsonBody(request, 1024));
  app.store.profiles.requireOwner("Connecting KeepOak");
  if (startedWithShortLivedKey()) throw new HttpError(403, "Connect KeepOak in the owner's app window.");
  switch (action) {
    case "enable": return app.keepoak.enable();
    case "begin": return app.keepoak.begin();
    case "poll": return app.keepoak.poll();
    case "cancel": return app.keepoak.cancel();
    case "profile": return app.keepoak.profile();
    case "disconnect": return app.keepoak.disconnect();
  }
}
