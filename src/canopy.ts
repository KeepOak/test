import type { Run } from "./contracts.js";
import type { Store } from "./store.js";
import type { Orchard, BoardSummary } from "./orchard/index.js";
import type { CardLive } from "./orchard/api.js";
import { taskInTree } from "./orchard/ancestry.js";

/**
 * Canopy: one live view of everything working in Branch (docs/orchard-canopy.md), for the owner's window.
 *
 *   GET /api/canopy
 *
 * Every Trunk and whether it is paused; every task working, waiting on the owner or paused, with the Trunk it runs as,
 * the task that started it when it is a helper, the Orchard card it works on, the computer its conversation uses and
 * its newest live step; this computer and the owner's paired computers; and every Orchard board with its count per
 * column. It only looks. Steering, pausing and stopping are the task's own routes (/api/runs/<id>/steer, pause, resume,
 * cancel) and a Trunk's pause is its own (/api/trunks/<id>/pause, resume), so every rule those have holds here too.
 */
export const handlesCanopyPath = (path: string): boolean => path === "/api/canopy";

export interface CanopyDeps {
  store: Store;
  owner: string;
  trunks: () => { id: string; name: string; paused: boolean }[];
  /** The owner's paired computers (a phone never counts) and whether each is connected now. */
  computers: () => { id: string; name: string; connected: boolean }[];
  /** This computer's name as the owner gave it, or "" when none was given. */
  here: () => string;
  orchard: Orchard | null;
  liveOf: (runId: string) => CardLive | null;
  /** How many questions each task waits on (a helper's are counted with it too). */
  waiting: () => { runId: string; parentRunId?: string | undefined }[];
  /** The computer a conversation picked, or null for this computer. */
  pickedComputer: (sessionId: string) => string | null;
}

export interface CanopyTask {
  id: string; sessionId: string; title: string; status: Run["status"]; paused: boolean; startedAt: string;
  trunkId: string | null; parentRunId: string | null; card: { id: string; board: string; title: string } | null;
  computer: string; asks: number; step: { icon: string; label: string; state: string } | null;
}
export interface CanopyView {
  trunks: { id: string; name: string; paused: boolean; tasks: string[] }[];
  tasks: CanopyTask[];
  computers: { id: string; name: string; here: boolean; connected: boolean; tasks: string[] }[];
  boards: BoardSummary[];
}

const first = <T>(store: Store, runId: string, kind: string, field: string): T | null => {
  const value = store.events(runId).find((event) => event.kind === kind)?.data[field];
  return value === undefined || value === null ? null : value as T;
};

/** The Trunk a task runs as: its own turn's, else the task at the top of its tree's. */
function trunkOf(store: Store, runId: string): string | null {
  const visited = new Set<string>();
  let next: string | null = runId;
  while (next && !visited.has(next)) {
    visited.add(next);
    const own = first<string>(store, next, "trunk.turn", "trunkId");
    if (own) return own;
    next = first<string>(store, next, "run.started", "parentRunId");
  }
  return null;
}

/** Store.runs is the newest 100 history entries. A live overview must include older work as well. */
function currentRuns(store: Store, owner: string): Run[] {
  const rows = store.sqlite.prepare(`SELECT id FROM tasks WHERE owner=?
    AND session_id NOT IN (SELECT session_id FROM conversation_marks WHERE deleted_at IS NOT NULL)
    AND (status IN ('running','needs_input') OR (status='interrupted'
      AND EXISTS (SELECT 1 FROM events WHERE run_id=tasks.id AND kind='run.paused')
      AND NOT EXISTS (SELECT 1 FROM events e JOIN tasks resumed ON resumed.id=e.run_id
        WHERE resumed.owner=tasks.owner AND e.kind='run.started' AND json_extract(e.data,'$.resumedFrom')=tasks.id)))
    ORDER BY created_at DESC, rowid DESC`).all(owner);
  return rows.map((row) => store.run(String(row.id))).filter((run): run is Run => !!run);
}

export function canopyView(deps: CanopyDeps): CanopyView {
  const { store, owner, orchard } = deps;
  const runs = currentRuns(store, owner);
  const paused = (run: Run) => run.status === "interrupted";
  const asks = deps.waiting();
  const cards = orchard ? orchard.data.cards() : [];
  const tasks: CanopyTask[] = runs.map((run) => {
    const parentRunId = first<string>(store, run.id, "run.started", "parentRunId");
    const card = cards.find((c) => c.runId === run.id) ?? null;
    const live = run.status === "running" ? deps.liveOf(run.id) : null;
    return {
      id: run.id, sessionId: run.sessionId, title: first<string>(store, run.id, "run.titled", "title") ?? run.prompt.split("\n")[0]!.slice(0, 200),
      status: run.status, paused: paused(run), startedAt: run.createdAt, trunkId: trunkOf(store, run.id), parentRunId,
      card: card ? { id: card.id, board: card.board, title: card.title } : null,
      computer: deps.pickedComputer(run.sessionId) ?? "this",
      asks: asks.filter((ask) => taskInTree(store, run.id, ask.runId)).length,
      step: live?.steps.at(-1) ?? null,
    };
  });
  const on = (computer: string) => tasks.filter((task) => task.computer === computer).map((task) => task.id);
  return {
    trunks: deps.trunks().map((trunk) => ({ ...trunk, tasks: tasks.filter((task) => task.trunkId === trunk.id).map((task) => task.id) })),
    tasks,
    computers: [{ id: "this", name: deps.here(), here: true, connected: true, tasks: on("this") },
      ...deps.computers().map((computer) => ({ ...computer, here: false, tasks: on(computer.id) }))],
    boards: orchard ? orchard.boards() : [],
  };
}
