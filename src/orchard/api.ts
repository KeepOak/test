import { z } from "zod";
import { errorText, validationText } from "../request-errors.js";
import { BoardOffError, offSentence } from "../flows-boards/settings.js";
import { StartsElsewhereError } from "../trunks/starts-in.js";
import type { Orchard } from "./index.js";
import { actorName, type Card } from "./model.js";

/**
 * Orchard's routes, the owner's alone: src/server.ts asks the owner's own profile before any of them, and the caller
 * layer (src/caller-policy.ts) has already refused every change to a short-lived key, a household person and a person's
 * own key (tests/short-lived-key-routes.mjs lists each route).
 *
 *   GET  /api/orchard[?board=<id>]                  the boards, and one board's cards by column, each growing card with
 *                                                   its task's newest live steps and the questions it waits on
 *   GET  /api/orchard/cards/<id>                    one card with its comments and the cards waiting on it
 *   POST /api/orchard/boards                        {name, project?}
 *   POST /api/orchard/boards/<id>                   {name?, atOnce?, stopAfter?}
 *   POST /api/orchard/boards/<id>/remove            an empty board
 *   POST /api/orchard/cards                         {title, notes?, board?, assignee?, after?}
 *   POST /api/orchard/cards/<id>/<action>           edit | move | assign | link | unlink | comment | grow | reset | remove
 *   POST /api/orchard/cards/<id>/comment-edit       {comment, text}: the owner's own comment
 *   POST /api/orchard/cards/<id>/comment-remove     {comment}: any comment
 *
 * Stopping a card's task, pausing and steering it are the task's own routes (/api/runs/<id>/cancel, pause, steer), so
 * their rules hold here too; the card follows the task's record.
 */
export const handlesOrchardPath = (path: string): boolean => path === "/api/orchard" || path.startsWith("/api/orchard/");

export class OrchardHttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** One question a card's task (or a helper it started) waits on, bound to its exact request by its fingerprint. */
export interface CardAsk { runId: string; sessionId: string; fingerprint: string; tool: string; label: string; question: string;
  target: string; bytes?: string | undefined; onceOnly?: boolean | undefined }
export interface CardLive { status: string; steps: { icon: string; label: string; state: string }[] }

export interface OrchardHttpDeps {
  orchard: Orchard;
  on: () => boolean;
  method: string;
  query: URLSearchParams;
  readBody: () => Promise<unknown>;
  /** The newest few live steps of a task, scrubbed (src/live-steps.ts), or null once it is gone. */
  liveOf: (runId: string) => CardLive | null;
  /** Every question waiting on the owner now, each with the task it belongs to and that task's parent, if a helper. */
  waiting: () => (CardAsk & { parentRunId?: string | undefined })[];
}

const boardRoute = /^\/api\/orchard\/boards\/([a-f0-9-]{36})(?:\/(remove))?$/;
const cardRoute = /^\/api\/orchard\/cards\/([a-f0-9-]{36})(?:\/(edit|move|assign|link|unlink|comment|comment-edit|comment-remove|grow|reset|remove))?$/;
const BoardQuery = z.string().uuid().optional();

/** A growing card with what its task is doing now and what it waits on. */
function withLive(card: Card, deps: OrchardHttpDeps, asks: ReturnType<OrchardHttpDeps["waiting"]>) {
  if (!deps.orchard.occupies(card) || !card.runId) return card;
  const mine = asks.filter((ask) => deps.orchard.containsRun(card.runId!, ask.runId))
    .map(({ runId, sessionId, fingerprint, tool, label, question, target, bytes, onceOnly }) =>
      ({ runId, sessionId, fingerprint, tool, label, question, target, ...(bytes ? { bytes } : {}), ...(onceOnly ? { onceOnly } : {}) }));
  return { ...card, live: deps.liveOf(card.runId), asks: mine };
}

async function read(deps: OrchardHttpDeps, path: string): Promise<unknown> {
  const { orchard, query } = deps;
  if (path === "/api/orchard") {
    const view = orchard.view(BoardQuery.parse(query.get("board") ?? undefined));
    const asks = deps.waiting();
    return { ...view, lanes: Object.fromEntries(Object.entries(view.lanes).map(([lane, cards]) => [lane, cards.map((card) => withLive(card, deps, asks))])) };
  }
  const card = cardRoute.exec(path);
  if (card && !card[2]) {
    const { comments_, ...rest } = orchard.card(card[1]!);
    return { card: withLive(rest, deps, deps.waiting()), comments: comments_ };
  }
  return undefined;
}

async function write(deps: OrchardHttpDeps, path: string): Promise<unknown> {
  const { orchard, readBody } = deps;
  const owner = { kind: "owner" } as const;
  if (path === "/api/orchard/boards") return { board: orchard.addBoard(await readBody()) };
  if (path === "/api/orchard/cards") return { card: orchard.add(await readBody(), owner) };
  const board = boardRoute.exec(path);
  if (board) return board[2] ? orchard.removeBoard(board[1]!) : { board: orchard.editBoard(board[1]!, await readBody()) };
  const card = cardRoute.exec(path);
  if (!card || !card[2]) return undefined;
  const id = card[1]!;
  switch (card[2]) {
    case "edit": return { card: orchard.edit(id, await readBody()) };
    case "move": return { card: await orchard.move(id, await readBody()) };
    case "assign": return { card: orchard.assign(id, await readBody()) };
    case "link": return { card: orchard.link(id, await readBody()) };
    case "unlink": return { card: orchard.unlink(id, await readBody()) };
    case "comment": return { comment: orchard.comment(id, await readBody(), owner), by: actorName(owner) };
    case "comment-edit": return { comment: orchard.editComment(id, await readBody()) };
    case "comment-remove": return orchard.removeComment(id, await readBody());
    case "grow": return { card: await orchard.start(id) };
    case "reset": return { card: orchard.reset(id) };
    default: return orchard.remove(id);
  }
}

export async function orchardApi(deps: OrchardHttpDeps, path: string): Promise<unknown> {
  try {
    if (!deps.on()) throw new BoardOffError(offSentence("kanban"));
    const answer = deps.method === "GET" ? await read(deps, path) : deps.method === "POST" ? await write(deps, path) : undefined;
    if (answer === undefined) throw new OrchardHttpError(404, "Not found");
    return answer;
  } catch (error) {
    if (error instanceof OrchardHttpError) throw error;
    if (error instanceof BoardOffError) throw new OrchardHttpError(409, error.message);
    if (error instanceof StartsElsewhereError) throw new OrchardHttpError(409, error.message);
    if (error instanceof z.ZodError) throw new OrchardHttpError(400, validationText(error));
    throw new OrchardHttpError(400, errorText(error));
  }
}
