import { z } from "zod";
import { ownerGitHubConnection } from "./integrations/git-tools.js";
import { repositoryPath } from "./integrations/github.js";
import { startedWithShortLivedKey } from "./key-context.js";
import { currentTaskRun } from "./task-scope.js";
import { lockdownActive } from "./lockdown.js";
import { HttpError } from "./server-http.js";
import type { ToolRegistry } from "./registry.js";
import type { Store } from "./store.js";

type CiApp = { registry: ToolRegistry; store: Store; runtime: { owner: string }; sessionLock: { locked(): boolean } };
const refreshes = new WeakMap<ToolRegistry, number>();

/** Explicit local owner action only; never polls, starts or reruns CI. */
export async function sourceCiApi(app: CiApp, method: string, remote: boolean, body: () => Promise<unknown>) {
  const authorize = () => {
    app.store.profiles.requireOwner("Reading the CI queue");
    if (remote || startedWithShortLivedKey() || currentTaskRun()) throw new HttpError(403, "Read CI from the owner's local app window.");
    if (app.sessionLock.locked() || lockdownActive(app.store, app.runtime.owner)) throw new HttpError(423, "Unlock Branch outside Lockdown before reading CI.");
  };
  authorize();
  if (method !== "POST") throw new HttpError(405, "Choose Refresh CI in the app to read GitHub.");
  const input = z.object({ repo: repositoryPath, selected: z.array(z.number().int().positive()).max(20).default([]) }).strict().parse(await body());
  authorize();
  if (Date.now() - (refreshes.get(app.registry) ?? 0) < 60_000) throw new HttpError(429, "Wait a minute before refreshing CI again.");
  refreshes.set(app.registry, Date.now());
  const result = await ownerGitHubConnection(app.registry).ciQueue(input.repo, input.selected);
  authorize();
  return result;
}
