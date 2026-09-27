import { ZodError } from "zod";
import { errorText } from "../contracts.js";
import type { Runtime } from "../runtime.js";
import type { Learn } from "./index.js";
import { LearnOffError, learnLabel } from "./settings.js";
import { validationText } from "../request-errors.js";

/**
 * mac7/learn: the routes behind the map and the tour, under /api/learn.
 *
 * They sit behind the same key and host rules as everything else, and each one is written here so
 * the route guard (tests/short-lived-key-routes.mjs) can see it. Reading the map and the tour only
 * looks; changing the switch is the owner's.
 */
export const learnRoutes = {
  view: "/api/learn", map: "/api/learn/map", tour: "/api/learn/tour",
  cost: "/api/learn/cost", switch: "/api/learn/switch",
} as const;
export const handlesLearnPath = (path: string): boolean =>
  path === learnRoutes.view || path.startsWith(`${learnRoutes.view}/`);

export class LearnHttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export interface LearnHttpDeps {
  learn: Learn; runtime: Runtime; method: string; readBody: () => Promise<unknown>; scope: string;
}

/** Answers one request under /api/learn, or throws a LearnHttpError. */
export async function learnApi(deps: LearnHttpDeps, path: string): Promise<unknown> {
  const owner = deps.runtime.owner;
  try {
    if (deps.method === "GET" && path === learnRoutes.view)
      return { label: learnLabel, settings: deps.learn.settings(owner) };
    if (deps.method === "POST") {
      if (path === learnRoutes.switch) return { settings: deps.learn.save(await deps.readBody(), owner) };
      if (path === learnRoutes.map) return deps.runtime.hideSecrets(await deps.learn.map(owner, await deps.readBody()));
      if (path === learnRoutes.cost) return deps.runtime.hideSecrets(await deps.learn.cost(owner, await deps.readBody()));
      if (path === learnRoutes.tour)
        return deps.runtime.hideSecrets(await deps.learn.tour(owner, await deps.readBody(), AbortSignal.timeout(180000)));
    }
    throw new LearnHttpError(404, "Endpoint not found");
  } catch (error) {
    if (error instanceof LearnHttpError) throw error;
    const status = error instanceof LearnOffError ? 409 : error instanceof ZodError ? 400
      : /not found|no longer saved|there is no|there are no/i.test(errorText(error)) ? 404 : 400;
    const message = error instanceof ZodError
      ? validationText(error) : errorText(error);
    throw new LearnHttpError(status, deps.runtime.hideSecrets(message));
  }
}
