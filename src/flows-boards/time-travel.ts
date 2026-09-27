import { z } from "zod";
import { errorText } from "../contracts.js";
import { compileGraph } from "../flow-graph.js";
import type { FlowGraphRunner, GraphRunView } from "../flow-graph-run.js";
import type { Store } from "../store.js";
import { boardMode, requirePart } from "./settings.js";

/**
 * R17-069: going back to an earlier step of a flow, changing a value, and running a copy from there
 * (LangGraph's time travel and fork, `libs/langgraph/langgraph/pregel/main.py`, MIT; written for
 * Branch). The graph runner (src/flow-graph-run.ts) already keeps where a run has got to; one marked
 * line there hands this file the whole state after every box, so any box can be gone back to.
 *
 * Going back never changes the run it came from. A copy is a new task of its own, with the boxes up
 * to the chosen one copied across as they were, so its recording (Inbox › History) reads from the
 * start, and the original stays as the "undo". The copy runs as the owner's own flow run does: every
 * tool a box uses is held to the approval rules through the one tool gate, and a copy of a run a task
 * started keeps to that task's tools.
 */
const maxStateBytes = 64 * 1024;
const made = new WeakSet<object>();

function ensureTables(store: Pick<Store, "sqlite">): void {
  if (made.has(store.sqlite)) return;
  store.sqlite.exec(`CREATE TABLE IF NOT EXISTS flow_graph_steps(run_id TEXT NOT NULL, seq INTEGER NOT NULL,
    owner TEXT NOT NULL, node_id TEXT NOT NULL, name TEXT NOT NULL, next_node TEXT, state TEXT, loops TEXT NOT NULL DEFAULT '{}',
    at TEXT NOT NULL, PRIMARY KEY(run_id, seq));
    CREATE TABLE IF NOT EXISTS flow_graph_forks(run_id TEXT PRIMARY KEY, owner TEXT NOT NULL, from_run TEXT NOT NULL,
    from_seq INTEGER NOT NULL, changed TEXT NOT NULL DEFAULT '[]', at TEXT NOT NULL)`);
  made.add(store.sqlite);
}

export interface StepPoint { runId: string; owner: string; seq: number; nodeId: string; name: string; nextNode: string | null }

/**
 * The hook the graph runner calls after each box (and once before the first, as step 0). It writes
 * nothing while the part is off, and a state too large to keep is marked as one that cannot be gone
 * back to rather than cut short. It never throws: a flow must not stop because of this.
 */
export function recordFlowStep(store: Store, point: StepPoint, state: Record<string, unknown>, loops: Record<string, number>): void {
  try {
    if (boardMode(store, point.owner, "time-travel") === "off") return;
    ensureTables(store);
    const text = JSON.stringify(state);
    store.sqlite.prepare(`INSERT OR REPLACE INTO flow_graph_steps(run_id,seq,owner,node_id,name,next_node,state,loops,at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(point.runId, point.seq, point.owner, point.nodeId, point.name.slice(0, 120),
      point.nextNode, Buffer.byteLength(text) > maxStateBytes ? null : text, JSON.stringify(loops), new Date().toISOString());
  } catch { /* going back is a convenience; the flow carries on regardless */ }
}

/** Whether any step of this run was kept, so it can be gone back into. */
export function hasFlowSteps(store: Store, runId: string): boolean {
  try {
    ensureTables(store);
    return !!store.sqlite.prepare("SELECT 1 AS found FROM flow_graph_steps WHERE run_id=? LIMIT 1").get(runId);
  } catch { return false; }
}

export interface FlowStep { seq: number; nodeId: string; name: string; nextNode: string | null; state: Record<string, unknown> | null; at: string }
export interface FlowSteps { run: GraphRunView; steps: FlowStep[]; forkedFrom: { runId: string; seq: number; changed: string[] } | null }

export const ForkSchema = z.object({
  seq: z.number().int().min(0).max(10_000),
  /** New values for the flow's own state, checked against what the flow says each value is. */
  changes: z.record(z.string().max(40), z.unknown()).default({}),
}).strict();

export interface TimeTravelDeps {
  store: Store; owner: string; graphs: FlowGraphRunner;
  /** A saved graph flow's definition, by id. */
  definition: (flowId: string) => unknown;
}

export class FlowTimeTravel {
  private readonly working = new Map<string, Promise<GraphRunView>>();
  constructor(private readonly deps: TimeTravelDeps) {}

  /** Q119 (NAS 911afbf): the Trunk whose run this is, or null for the owner's own; read without stamping anyone. */
  whose(runId: string): string | null { return this.deps.graphs.trunkOf(runId); }
  /** Every step of one run with the state as it stood after it, oldest first. */
  steps(runId: string): FlowSteps {
    requirePart(this.deps.store, this.deps.owner, "time-travel");
    const run = this.deps.graphs.view(runId);
    ensureTables(this.deps.store);
    const rows = this.deps.store.sqlite.prepare("SELECT * FROM flow_graph_steps WHERE run_id=? AND owner=? ORDER BY seq")
      .all(runId, this.deps.owner);
    const fork = this.deps.store.sqlite.prepare("SELECT * FROM flow_graph_forks WHERE run_id=? AND owner=?").get(runId, this.deps.owner);
    return {
      run,
      steps: rows.map((row) => ({ seq: Number(row.seq), nodeId: String(row.node_id), name: String(row.name),
        nextNode: row.next_node === null ? null : String(row.next_node),
        state: row.state === null ? null : JSON.parse(String(row.state)) as Record<string, unknown>, at: String(row.at) })),
      forkedFrom: fork ? { runId: String(fork.from_run), seq: Number(fork.from_seq), changed: JSON.parse(String(fork.changed)) as string[] } : null,
    };
  }

  /** Recent runs of graph flows that can be gone back into, newest first. */
  runs(limit = 20): { runId: string; flowId: string; status: string; steps: number; updatedAt: string }[] {
    requirePart(this.deps.store, this.deps.owner, "time-travel");
    ensureTables(this.deps.store);
    return this.deps.store.sqlite.prepare(`SELECT r.run_id, r.flow_id, r.status, r.updated_at, COUNT(s.seq) AS steps
      FROM flow_graph_runs r JOIN flow_graph_steps s ON s.run_id = r.run_id WHERE r.owner=? GROUP BY r.run_id
      ORDER BY r.updated_at DESC LIMIT ?`).all(this.deps.owner, Math.max(1, Math.min(50, limit)))
      .map((row) => ({ runId: String(row.run_id), flowId: String(row.flow_id), status: String(row.status),
        steps: Number(row.steps), updatedAt: String(row.updated_at) }));
  }

  /** Runs a copy from just after step `seq`, with some values changed. The original is left as it was. */
  fork(runId: string, input: unknown): { runId: string; fromRun: string; fromSeq: number; changed: string[] } {
    const { store, owner } = this.deps;
    requirePart(store, owner, "time-travel");
    const { seq, changes } = ForkSchema.parse(input);
    const { run, steps } = this.steps(runId);
    const point = steps.find((step) => step.seq === seq);
    if (!point) throw new Error("That step is not on file for this run, so there is nothing to go back to.");
    if (!point.state) throw new Error("The state after that step was too large to keep, so the flow cannot go back to it.");
    if (!point.nextNode) throw new Error("That was the last step of the flow, so there is nothing to run from there.");
    const compiled = compileGraph(this.deps.definition(run.flowId));
    try { compiled.stateSchema.parse(changes); } catch (error) {
      throw new Error(`Those values do not fit this flow: ${errorText(error)}`);
    }
    const state = { ...point.state, ...changes };
    // Q122: a copy of a run that cannot be carried on from here (its Trunk gone, or another Trunk asking) is never made.
    const refused = this.deps.graphs.whyNotError(runId);
    if (refused) throw refused;
    const copy = store.createRun(owner, `Flow: ${compiled.definition.name} (from step ${seq})`, undefined, false, "schedule");
    this.copyAcross(runId, copy.id, seq, point, state);
    const changed = Object.keys(changes);
    store.sqlite.prepare("INSERT INTO flow_graph_forks(run_id,owner,from_run,from_seq,changed,at) VALUES(?,?,?,?,?,?)")
      .run(copy.id, owner, runId, seq, JSON.stringify(changed), new Date().toISOString());
    store.event(copy.id, "flow.forked", { fromRun: runId, fromSeq: seq, changed });
    // A copy of a run a task started keeps that task's limit (mac7/lockdown-fix), even though the owner made it.
    const within = this.deps.graphs.limitOf(runId);
    // mac7/outside-resume: and a copy of a run set going from outside is held as that run was.
    this.deps.graphs.carryTrunk(runId, copy.id); // Q114: and a copy of a Trunk's run is still that Trunk's
    const work = this.deps.graphs.work(copy.id, compiled, { source: this.deps.graphs.sourceOf(runId), ...(within ? { within } : {}) })
      .catch(() => this.deps.graphs.view(copy.id));
    this.working.set(copy.id, work);
    void work.finally(() => this.working.delete(copy.id));
    return { runId: copy.id, fromRun: runId, fromSeq: seq, changed };
  }

  /** The new run's checkpoint, its boxes up to the chosen step, and those steps' states. */
  private copyAcross(from: string, to: string, seq: number, point: FlowStep, state: Record<string, unknown>): void {
    const { store, owner } = this.deps;
    const loops = store.sqlite.prepare("SELECT loops FROM flow_graph_steps WHERE run_id=? AND seq=?").get(from, seq);
    const now = new Date().toISOString();
    store.sqlite.prepare(`INSERT INTO flow_graph_runs(run_id,owner,flow_id,status,next_node,state,loops,depth,updated_at)
      SELECT ?, owner, flow_id, 'running', ?, ?, ?, 0, ? FROM flow_graph_runs WHERE run_id=? AND owner=?`)
      .run(to, point.nextNode, JSON.stringify(state), String(loops?.loops ?? "{}"), now, from, owner);
    store.sqlite.prepare(`INSERT INTO flow_graph_nodes(run_id,seq,node_id,name,status,output,updated_at)
      SELECT ?, seq, node_id, name, status, output, updated_at FROM flow_graph_nodes WHERE run_id=? AND seq<=? AND seq>0`)
      .run(to, from, seq);
    store.sqlite.prepare(`INSERT INTO flow_graph_steps(run_id,seq,owner,node_id,name,next_node,state,loops,at)
      SELECT ?, seq, owner, node_id, name, next_node, state, loops, at FROM flow_graph_steps WHERE run_id=? AND seq<?`)
      .run(to, from, seq);
    recordFlowStep(store, { runId: to, owner, seq, nodeId: point.nodeId, name: point.name, nextNode: point.nextNode }, state,
      JSON.parse(String(loops?.loops ?? "{}")) as Record<string, number>);
  }

  /** Waits for a copy to settle. The page never needs this; a test does. */
  async settled(runId: string): Promise<GraphRunView> {
    return (await this.working.get(runId)) ?? this.deps.graphs.view(runId);
  }
}
