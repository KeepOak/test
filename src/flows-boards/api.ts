import { z } from "zod";
import { errorText, validationText } from "../request-errors.js";
import { InputsSchema } from "../recipes.js";
import type { FlowsBoards } from "./index.js";
import { boardLabels, BoardModeSchema, BoardOffError, boardParts, BoardPartSchema, requirePart } from "./settings.js";
import { busyModes } from "./waiting-line.js";
import { StartsElsewhereError } from "../trunks/starts-in.js"; // Q44
import { byCard, inCatalogue, recordedWrite } from "../settings-kit/recorded-write.js"; // Q48

/**
 * The web side of R17-H: the owner's routes under /api/flows-boards/. The server checks the owner's
 * own profile before any of them, and a short-lived key is refused every change here by the
 * fail-closed rule in src/short-lived-keys.ts. Reads answer whatever the switches say.
 */
export const handlesFlowsBoardsPath = (path: string): boolean => path === "/api/flows-boards" || path.startsWith("/api/flows-boards/");

export class FlowsBoardsHttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export interface FlowsBoardsHttpDeps {
  boards: FlowsBoards;
  method: string;
  query: URLSearchParams;
  readBody: () => Promise<unknown>;
}

const SwitchBody = z.object({ part: BoardPartSchema, mode: BoardModeSchema }).strict();
const RunBody = z.object({ inputs: InputsSchema.default({}) }).strict();
const FollowUpBody = z.object({ sessionId: z.string().uuid(), id: z.string().uuid() }).passthrough();
const SendBody = z.object({ sessionId: z.string().uuid(), prompt: z.string().trim().min(1).max(16000) }).strict();
const AnswerBody = z.object({ despiteUnchecked: z.boolean().default(false), expectedRequest: z.string().max(65536).optional() }).strict();
const cardRoute = /^\/api\/flows-boards\/board\/cards\/([a-f0-9-]{36})\/(move|handoff|work|reset|remove)$/;
const flowRoute = /^\/api\/flows-boards\/flows\/([a-f0-9-]{36})\/(steps|fork)$/;
const recipeRoute = /^\/api\/flows-boards\/recipes\/([a-f0-9-]{36})\/(checks|run)$/;
const widgetRoute = /^\/api\/flows-boards\/widgets\/([a-f0-9-]{36})\/(accept|dismiss|remove)$/;
const queueRoute = /^\/api\/flows-boards\/waiting\/queue\/([a-f0-9-]{36})\/(edit|move|remove)$/;
const followRoute = /^\/api\/flows-boards\/waiting\/followups\/(edit|move|remove)$/;
const installRoute = /^\/api\/flows-boards\/installs\/([a-f0-9-]{36})\/(approve|decline)$/;

type Route = (deps: FlowsBoardsHttpDeps, path: string) => Promise<unknown>;
const without = <T extends Record<string, unknown>>(body: T, ...keys: string[]): Record<string, unknown> =>
  Object.fromEntries(Object.entries(body).filter(([key]) => !keys.includes(key)));

const top: Route = async ({ boards, method, readBody }, path) => {
  if (path === "/api/flows-boards")
    return { modes: boards.modes(), labels: boardLabels, parts: boardParts, waiting: boards.waitingForOwner(),
      busyMode: boards.waiting.busyMode(), busyModes };
  if (path === "/api/flows-boards/switch" && method === "POST") {
    const { part, mode } = SwitchBody.parse(await readBody());
    return { part, mode: recordedWrite(boards.store, boards.owner, byCard(`flowboards-${part}`), inCatalogue(`flowboards-${part}`),
      () => boards.setMode(part, { mode })) };
  }
  return undefined;
};

const flows: Route = async ({ boards, method, readBody }, path) => {
  if (path === "/api/flows-boards/flows") return { runs: boards.timeTravel.runs() };
  const match = flowRoute.exec(path);
  if (!match) return undefined;
  if (match[2] === "steps") return boards.timeTravel.steps(match[1]!);
  if (method === "POST") return boards.timeTravel.fork(match[1]!, await readBody());
  return undefined;
};

const recipes: Route = async ({ boards, method, readBody }, path) => {
  if (path === "/api/flows-boards/recipes") {
    requirePart(boards.store, boards.owner, "recipe-checks");
    return { procedures: boards.store.list("procedures", boards.owner).map((record) => {
      const data = record.data as { definition?: { name?: string }; status?: string };
      return { id: record.id, name: String(data.definition?.name ?? record.id), status: String(data.status ?? ""), checks: boards.recipes.get(record.id) };
    }) };
  }
  const match = recipeRoute.exec(path);
  if (!match || method !== "POST") return undefined;
  if (match[2] === "checks") return { checks: boards.recipes.save(match[1]!, await readBody()) };
  return boards.runChecked(match[1]!, RunBody.parse(await readBody()).inputs);
};

const board: Route = async ({ boards, method, query, readBody }, path) => {
  if (path === "/api/flows-boards/board") return boards.kanban.view(query.get("project") ?? undefined);
  if (path === "/api/flows-boards/board/cards" && method === "POST") return { card: boards.kanban.add(await readBody(), "owner") };
  if (path === "/api/flows-boards/board/settings" && method === "POST") return { settings: boards.kanban.saveSettings(await readBody()) };
  const match = cardRoute.exec(path);
  if (!match || method !== "POST") return undefined;
  const [, id, action] = match as unknown as [string, string, string];
  if (action === "move") return { card: boards.kanban.move(id, await readBody(), "owner") };
  if (action === "handoff") return { card: boards.kanban.handoff(id, await readBody(), "owner") };
  if (action === "work") return boards.kanban.work(id);
  if (action === "reset") return { card: boards.kanban.reset(id) };
  return boards.kanban.remove(id);
};

const widgets: Route = async ({ boards, method }, path) => {
  if (path === "/api/flows-boards/widgets") {
    requirePart(boards.store, boards.owner, "widgets");
    return { widgets: boards.widgets.list(), waiting: boards.widgets.waiting() };
  }
  const match = widgetRoute.exec(path);
  if (!match || method !== "POST") return undefined;
  if (match[2] === "remove") return boards.widgets.remove(match[1]!);
  return boards.widgets.decide(match[1]!, match[2] === "accept");
};

const waiting: Route = async ({ boards, method, query, readBody }, path) => {
  if (path === "/api/flows-boards/waiting") {
    requirePart(boards.store, boards.owner, "waiting-line");
    const session = query.get("session");
    return { followUps: session ? boards.waiting.followUps(z.string().uuid().parse(session)) : [], busyMode: boards.waiting.busyMode(),
      everywhere: boards.waiting.everywhere(), tasks: boards.waiting.tasks() };
  }
  if (method !== "POST") return undefined;
  if (path === "/api/flows-boards/busy") return { busyMode: boards.waiting.saveBusyMode(await readBody()) };
  if (path === "/api/flows-boards/busy/send") {
    const { sessionId, prompt } = SendBody.parse(await readBody());
    return boards.waiting.send(sessionId, prompt);
  }
  const follow = followRoute.exec(path);
  if (follow) {
    const body = FollowUpBody.parse(await readBody());
    const rest = without(body, "sessionId", "id");
    if (follow[1] === "edit") return { followUps: boards.waiting.editFollowUp(body.sessionId, body.id, rest) };
    if (follow[1] === "move") return { followUps: boards.waiting.moveFollowUp(body.sessionId, body.id, rest) };
    return { followUps: boards.waiting.removeFollowUp(body.sessionId, body.id) };
  }
  const queued = queueRoute.exec(path);
  if (!queued) return undefined;
  if (queued[2] === "edit") { boards.waiting.editQueued(queued[1]!, await readBody()); return { edited: true }; }
  if (queued[2] === "move") { boards.waiting.moveQueued(queued[1]!, await readBody()); return { moved: true }; }
  return boards.waiting.removeQueued(queued[1]!);
};

const installs: Route = async ({ boards, method, readBody }, path) => {
  if (path === "/api/flows-boards/installs") {
    requirePart(boards.store, boards.owner, "install-requests");
    return { requests: boards.installs.list() };
  }
  const match = installRoute.exec(path);
  if (!match || method !== "POST") return undefined;
  const { despiteUnchecked, expectedRequest } = AnswerBody.parse((await readBody()) ?? {});
  return { request: await boards.installs.answer(match[1]!, match[2] === "approve", {
    despiteUnchecked, ...(expectedRequest !== undefined ? { expectedRequest } : {}),
  }) };
};

const routes: Route[] = [top, flows, recipes, board, widgets, waiting, installs];

export async function flowsBoardsApi(deps: FlowsBoardsHttpDeps, path: string): Promise<unknown> {
  try {
    for (const route of routes) {
      const answer = await route(deps, path);
      if (answer !== undefined) return answer;
    }
    throw new FlowsBoardsHttpError(404, "Not found");
  } catch (error) {
    if (error instanceof FlowsBoardsHttpError) throw error;
    if (error instanceof BoardOffError) throw new FlowsBoardsHttpError(409, error.message);
    if (error instanceof StartsElsewhereError) throw new FlowsBoardsHttpError(409, error.message); // Q44
    if (error instanceof z.ZodError) throw new FlowsBoardsHttpError(400, validationText(error));
    throw new FlowsBoardsHttpError(400, errorText(error));
  }
}
