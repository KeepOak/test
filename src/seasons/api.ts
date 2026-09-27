import { z } from "zod";
import type { Store } from "../store.js";
import { keep, morning, seenMorning, undoNight, veto, viewCandidate } from "./journal.js";
import type { Rings } from "./rings.js";
import { saveSeasonsSettings, seasonsSettings } from "./settings.js";

/**
 * The web side of Seasons, under /api/seasons. Everything a person reads or undoes is their own night only:
 * `scope` is whoever is asking (the owner, or the household person the window is switched to), and no route takes
 * a scope from the request. The switches and "run tonight's night now" are the owner's.
 *
 * Every route is listed here so the route guard (tests/short-lived-key-routes.mjs) can see it.
 */
export const seasonsRoutes = {
  view: "/api/seasons", settings: "/api/seasons/settings", run: "/api/seasons/rings/run",
  undo: "/api/seasons/rings/undo", veto: "/api/seasons/rings/veto", keep: "/api/seasons/rings/keep",
  morning: "/api/seasons/morning", seen: "/api/seasons/morning/seen",
} as const;
export const handlesSeasonsPath = (path: string): boolean => path === seasonsRoutes.view || path.startsWith(`${seasonsRoutes.view}/`);

export class SeasonsHttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export interface SeasonsHttpDeps {
  store: Store; rings: Rings; method: string; scope: string; owner: string;
  readBody: () => Promise<unknown>;
  /** Refuses unless the owner is asking (the profile switch's own check). */
  requireOwner: (what: string) => void;
}
const Night = z.object({ night: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict();
const Id = z.object({ id: z.string().min(1).max(200) }).strict();

function overview(deps: SeasonsHttpDeps) {
  const { store, rings, scope, owner } = deps;
  return {
    // The switches are the owner's; a household person's window is answered with none.
    settings: scope === owner ? seasonsSettings(store, owner) : null,
    nights: rings.book.nights(scope),
    candidates: rings.book.candidates(scope).slice(0, 200).map((entry) => viewCandidate(store, owner, entry)),
    morning: morning(rings.book, scope),
  };
}

export async function seasonsApi(deps: SeasonsHttpDeps, path: string): Promise<unknown> {
  const { method, rings, store, scope } = deps;
  if (method === "GET" && path === seasonsRoutes.view) return overview(deps);
  if (method === "GET" && path === seasonsRoutes.morning) return { morning: morning(rings.book, scope) };
  if (method !== "POST") throw new SeasonsHttpError(404, "Not found");
  const body = await deps.readBody();
  if (path === seasonsRoutes.settings) {
    deps.requireOwner("The Seasons switches");
    return { settings: saveSeasonsSettings(store, deps.owner, body) };
  }
  if (path === seasonsRoutes.run) {
    deps.requireOwner("Running a night now");
    z.object({}).strict().parse(body ?? {});
    const entry = rings.scopeOf(scope);
    if (!entry) throw new SeasonsHttpError(404, "Not found");
    return rings.night(entry);
  }
  if (path === seasonsRoutes.undo) return { night: await undoNight(store, rings.book, scope, Night.parse(body).night) };
  if (path === seasonsRoutes.veto) return { candidate: await veto(store, rings.book, scope, Id.parse(body).id) };
  if (path === seasonsRoutes.keep) return { candidate: keep(store, rings.book, scope, Id.parse(body).id) };
  if (path === seasonsRoutes.seen) return { night: seenMorning(rings.book, scope, Night.parse(body).night) };
  throw new SeasonsHttpError(404, "Not found");
}
