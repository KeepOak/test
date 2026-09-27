import { z } from "zod";
import type { Store } from "../store.js";
import { keep, morning, seenMorning, undoNight, veto, viewCandidate } from "./journal.js";
import type { Rings } from "./rings.js";
import type { Gardener } from "./gardener.js";
import type { Budding } from "./budding.js";
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
  gardenUndo: "/api/seasons/garden/undo", gardenPrune: "/api/seasons/garden/prune",
  gardenReroot: "/api/seasons/garden/reroot", gardenPin: "/api/seasons/garden/pin",
  connector: "/api/seasons/budding/connector", declineConnector: "/api/seasons/budding/decline-connector",
  branch: "/api/seasons/budding/branch",
  branchArrived: "/api/seasons/budding/branch-arrived",
} as const;
export const handlesSeasonsPath = (path: string): boolean => path === seasonsRoutes.view || path.startsWith(`${seasonsRoutes.view}/`);

export class SeasonsHttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export interface SeasonsHttpDeps {
  store: Store; rings: Rings; gardener: Gardener; budding: Budding; method: string; scope: string; owner: string;
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
    morning: morning(rings.book, scope, store),
    // The skills are the owner's: a household person's window is answered with no garden.
    garden: scope === owner ? garden(deps.gardener) : null,
    buds: scope === owner ? deps.budding.list().map((bud) => ({ id: bud.id, task: bud.task, gap: bud.gap,
      stage: bud.stage, connectors: bud.connectors, tool: bud.tool, error: bud.error, output: bud.output?.slice(0, 2000),
      serverId: bud.serverId, branchConfirmed: bud.branchConfirmed })) : null,
  };
}
function garden(gardener: Gardener) {
  const settings = gardener.settings();
  return {
    seeds: gardener.book.seeds().map((seed) => ({ ...seed, state: gardener.stateOf(seed) })),
    ledger: gardener.book.ledger(),
    indexCost: gardener.indexCost(), indexBudget: settings.indexBudget,
  };
}
const Pin = z.object({ id: z.string().min(1).max(200), pinned: z.boolean() }).strict();
/** The garden's changes, all the owner's alone. */
function gardenChange(deps: SeasonsHttpDeps, path: string, body: unknown): unknown {
  deps.requireOwner("The Gardener");
  if (path === seasonsRoutes.gardenUndo) return { entry: deps.gardener.undo(Id.parse(body).id) };
  if (path === seasonsRoutes.gardenPrune) return { entry: deps.gardener.pruneSeed(Id.parse(body).id) };
  if (path === seasonsRoutes.gardenReroot) return { entry: deps.gardener.reroot(Id.parse(body).id) };
  if (path === seasonsRoutes.gardenPin) { const { id, pinned } = Pin.parse(body); return { seed: deps.gardener.pin(id, pinned) }; }
  throw new SeasonsHttpError(404, "Not found");
}

export async function seasonsApi(deps: SeasonsHttpDeps, path: string): Promise<unknown> {
  const { method, rings, store, scope } = deps;
  if (method === "GET" && path === seasonsRoutes.view) return overview(deps);
  if (method === "GET" && path === seasonsRoutes.morning) return { morning: morning(rings.book, scope, store) };
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
  if (path === seasonsRoutes.keep) return { candidate: await keep(store, rings.book, scope, Id.parse(body).id) };
  if (path === seasonsRoutes.seen) return { night: seenMorning(rings.book, scope, Night.parse(body).night) };
  if (path.startsWith("/api/seasons/garden/")) return gardenChange(deps, path, body);
  if (path.startsWith("/api/seasons/budding/")) {
    deps.requireOwner("Budding decisions");
    if (path === seasonsRoutes.connector) {
      const input = z.object({ id: z.string().uuid(), connectorId: z.string().min(1).max(40) }).strict().parse(body);
      return { bud: await deps.budding.approveConnector(input.id, input.connectorId) };
    }
    if (path === seasonsRoutes.declineConnector) return { bud: deps.budding.declineConnector(Id.parse(body).id) };
    if (path === seasonsRoutes.branch) return { bud: deps.budding.requestBranch(Id.parse(body).id) };
    if (path === seasonsRoutes.branchArrived) return { bud: deps.budding.confirmBranch(Id.parse(body).id) };
  }
  throw new SeasonsHttpError(404, "Not found");
}
