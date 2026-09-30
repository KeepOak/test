import { randomUUID } from "node:crypto";
import { z } from "zod";
import { errorText } from "./contracts.js";
import type { Store } from "./store.js";
import type { Runtime } from "./runtime.js";
import type { ToolRegistry } from "./registry.js";
import type { WebhookNotifier } from "./webhooks.js";
import { WorkflowSchema, type StepState, type Workflows, type WorkflowStep, type WorkflowView } from "./workflows.js";
import { FlowGraphSchema, FlowGraphError, compileGraph, isGraphDefinition, zodForShape,
  type FlowGraphDefinition } from "./flow-graph.js";
import { FlowGraphRunner, type GraphRunView } from "./flow-graph-run.js";
import type { RunSource } from "./policy.js";
import { heldSource } from "./outside-origin.js"; // mac7/outside-resume
import { compileToolMacro } from "./tool-macro.js";

/**
 * A flow is a saved workflow seen as a picture: the steps are boxes and the arrows say what happens
 * after each one — carry straight on, or skip ahead because the last answer did not say what was
 * expected. The same thing runs it; this only gives it a shape other programs can read and draw,
 * a way in over HTTP, and a note sent out to whoever asked as each box finishes.
 */
export interface FlowNode {
  id: string; index: number; name: string; kind: string;
  /** What this box actually does, in one line, for anybody reading the picture. */
  detail: string;
  status: string; attempts: number; output: string; startedAt: string | null;
}
export interface FlowEdge { from: string; to: string; when: "next" | "matched" | "skipped" }
export interface FlowGraph { nodes: FlowNode[]; edges: FlowEdge[] }
export interface FlowView extends Omit<WorkflowView, "state"> { graph: FlowGraph }

const nodeId = (index: number): string => `n${index + 1}`;
const detailOf = (step: WorkflowStep): string => {
  if (step.kind === "prompt") return (step.prompt ?? "").slice(0, 120);
  if (step.kind === "tool") return step.tool ?? "";
  if (step.kind === "recipe") return `saved procedure ${step.recipeId ?? ""}`;
  if (step.kind === "flow") return `works through the flow ${step.flowId ?? ""} first`;
  if (step.kind === "approval") return step.question ?? "waits for the owner to say yes";
  if (step.kind === "wait") return `waits ${step.waitMinutes ?? 0} minute(s)`;
  return `carries on when the last answer mentions "${step.contains ?? ""}"`;
};

/** The boxes and arrows of one workflow, with where each box has got to written on it. */
export function flowGraph(steps: WorkflowStep[], state: StepState[]): FlowGraph {
  const byIndex = new Map(state.map((entry) => [entry.index, entry]));
  const nodes: FlowNode[] = steps.map((step, index) => {
    const known = byIndex.get(index);
    return { id: nodeId(index), index, name: step.name, kind: step.kind, detail: detailOf(step),
      status: known?.status ?? "waiting", attempts: known?.attempts ?? 0,
      output: (known?.output ?? "").slice(0, 500), startedAt: known?.startedAt ?? null };
  });
  const edges: FlowEdge[] = [];
  for (const [index, step] of steps.entries()) {
    const next = index + 1;
    if (step.kind === "branch") {
      if (next < steps.length) edges.push({ from: nodeId(index), to: nodeId(next), when: "matched" });
      const skipped = next + (step.skipAhead ?? 1);
      if (skipped < steps.length) edges.push({ from: nodeId(index), to: nodeId(skipped), when: "skipped" });
      continue;
    }
    if (next < steps.length) edges.push({ from: nodeId(index), to: nodeId(next), when: "next" });
  }
  return { nodes, edges };
}

/** A flow given as a graph instead of a list; the nodes are the steps, in the order they are given. */
export const FlowGraphInputSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).default(""),
  nodes: z.array(z.record(z.string(), z.unknown())).min(1).max(20),
}).strict();

/** Either shape the API accepts, turned into what the workflow runner understands. */
export function flowDefinition(input: unknown): unknown {
  // A real graph — boxes with arrows between them — is not a list of steps and is never flattened
  // into one. It goes to the graph engine instead; this only handles the older list-shaped flows.
  if (isGraphDefinition(input)) return input;
  const asGraph = FlowGraphInputSchema.safeParse(input);
  if (!asGraph.success) return input;
  const { nodes, ...rest } = asGraph.data;
  return { ...rest, steps: nodes };
}

/** A saved flow that is a real graph, seen the same way a list-shaped one is. */
export interface GraphFlowView extends FlowView { kind: "graph"; definition: FlowGraphDefinition }
const graphView = (definition: FlowGraphDefinition, id: string): GraphFlowView => ({
  id, name: definition.name, description: definition.description, steps: [], status: "idle",
  cursor: 0, waitingUntil: null, question: null, error: null, pausedFrom: null, kind: "graph", definition,
  graph: {
    nodes: definition.nodes.map((node, index) => ({ id: node.id, index, name: node.name, kind: node.kind,
      detail: node.prompt ?? node.tool ?? node.contains ?? node.overField ?? node.flowId ?? node.kind,
      status: "waiting", attempts: 0, output: "", startedAt: null })),
    edges: definition.edges.map((edge) => ({ from: edge.from, to: edge.to,
      when: edge.when === "matched" ? "matched" : edge.when === "otherwise" ? "skipped" : "next" })),
  },
});
/** What starting a graph flow hands back at once: the task to watch, before any box has run. */
export interface GraphRunStart { runId: string; flowId: string; status: "running"; name: string }
/** The flow tools that are always there; every other "flows." tool is one saved flow. */
export const builtInFlowTools = new Set(["flows.list"]);

/** A name a tool can be called by, worked out from what the owner called the flow. */
export const flowToolName = (name: string): string =>
  `flows.${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "saved"}`;

export class Flows {
  /** Set by the launch so each finished box can be announced to whoever asked to hear about it. */
  notifyEvent: WebhookNotifier = () => undefined;
  /** The engine for flows that are real graphs, beside the older list-shaped ones. */
  readonly graphs: FlowGraphRunner;
  private registry: ToolRegistry | undefined;
  /** The tool names this put into the catalog, so only those are taken out again. */
  private publishedTools: string[] = [];
  /** Graph runs still being worked through in the background, so a run can be waited on. */
  private readonly working = new Map<string, Promise<GraphRunView>>();
  constructor(private readonly store: Store, private readonly owner: string,
    private readonly workflows: Workflows, private readonly runtime: Runtime) {
    this.graphs = new FlowGraphRunner(store, owner, runtime, (flowId) => this.definitionOf(flowId));
  }
  /**
   * A flow is a saved workflow, and a workflow's steps use tools with the owner's whole run of the
   * app. Every way in — the HTTP routes and the flows.list tool — goes through the same guard the
   * workflow tools do, so a second person's profile reaches none of them.
   */
  private get mine(): string { return this.workflows.forOwner(this.owner); }
  private view(workflow: WorkflowView): FlowView {
    const { state, ...rest } = workflow;
    return { ...rest, graph: flowGraph(workflow.steps, state) };
  }
  list(): FlowView[] {
    // Q119 (NAS d830e7a): a flow drawn as a graph is the owner's, boxes, tools and values in them, so a Trunk's list
    // holds only its own saved workflows, as workflows.list does.
    const graphs = this.runtime.trunkAtWork() ? [] : this.graphFlows();
    return [...graphs, ...this.workflows.list(this.mine).map((flow) => this.view(flow))];
  }
  get(id: string): FlowView {
    const graph = this.store.get("flow_graphs", this.mine, id);
    if (graph) return graphView(FlowGraphSchema.parse(graph.data), id);
    return this.view(this.workflows.view(this.mine, id));
  }
  /** Every flow saved as a graph, with its boxes and arrows ready to draw. */
  private graphFlows(): GraphFlowView[] {
    return this.store.list("flow_graphs", this.mine)
      .map((record) => graphView(FlowGraphSchema.parse(record.data), record.id));
  }
  /** One saved graph's definition, for a box whose body is another flow. */
  private definitionOf(flowId: string): FlowGraphDefinition {
    const record = this.store.get("flow_graphs", this.mine, flowId);
    if (!record) throw new Error("that flow is not on file");
    return FlowGraphSchema.parse(record.data);
  }
  save(input: unknown): FlowView {
    const shaped = flowDefinition(input);
    if (isGraphDefinition(shaped)) return this.saveGraph(shaped);
    const parsed = WorkflowSchema.parse(shaped);
    return this.view(this.workflows.create(this.mine, parsed));
  }
  checkMacro(input: unknown): { definition: FlowGraphDefinition; tools: string[] } {
    void this.mine;
    const definition = compileToolMacro(input, this.runtime.registry.names());
    return { definition, tools: definition.nodes.map((node) => node.tool!) };
  }
  saveMacro(input: unknown): GraphFlowView {
    if (this.macros().length >= 20) throw new Error("At most 20 imported tool macros; remove one first");
    const flow = this.saveGraph(this.checkMacro(input).definition);
    try { this.store.save("settings", this.mine, `tool-macro:${flow.id}`, { flowId: flow.id }); }
    catch (error) { this.remove(flow.id); throw error; }
    return flow;
  }
  macros(): GraphFlowView[] {
    return this.graphFlows().filter((flow) => this.store.get("settings", this.mine, `tool-macro:${flow.id}`));
  }
  cancelRun(runId: string): GraphRunView {
    void this.mine;
    return this.graphs.cancel(runId);
  }
  resumeRun(runId: string, input: unknown): GraphRunStart {
    void this.mine;
    const said = z.object({ interrupted: z.enum(["again", "past"]).optional(), expectedNode: z.string().max(40).nullable(),
      expectedQuestion: z.string().max(2000).nullable(), expectedSeq: z.number().int().min(0) }).strict().parse(input);
    const run = this.graphs.view(runId);
    if (run.status !== "waiting_approval" && run.status !== "interrupted") throw new Error("This run is not waiting for your answer");
    if (run.nextNode !== said.expectedNode || run.question !== said.expectedQuestion || (run.nodes.at(-1)?.seq ?? 0) !== said.expectedSeq)
      throw new Error("The waiting step changed; refresh and review its question again");
    return this.resumeGraph(run.flowId, { runId, approve: true, ...(said.interrupted ? { interrupted: said.interrupted } : {}) });
  }
  /**
   * Saves a flow drawn as a graph. It is checked first, all the way through: a box that disagrees
   * with the state about what a value is, a box nothing leads to, or a circle with no way out is
   * refused here, naming the box, rather than failing half way through a run.
   */
  saveGraph(input: unknown): GraphFlowView {
    const owner = this.mine;
    const compiled = compileGraph(input);
    if (compiled.definition.id && this.store.get("settings", owner, `tool-macro:${compiled.definition.id}`))
      throw new Error("Imported tool macros are immutable; import a new package instead");
    const id = compiled.definition.id ?? randomUUID();
    this.store.save("flow_graphs", owner, id, { ...compiled.definition, id });
    this.publishTools();
    return graphView({ ...compiled.definition, id }, id);
  }
  /** Checks a picture without saving it, so the editor can say what is wrong before Save. */
  check(input: unknown): { ok: boolean; problems: string[] } {
    try { compileGraph(input); return { ok: true, problems: [] }; }
    catch (error) {
      if (error instanceof FlowGraphError) return { ok: false, problems: error.problems };
      return { ok: false, problems: [errorText(error)] };
    }
  }
  remove(id: string): { removed: boolean } {
    if (this.store.get("flow_graphs", this.mine, id)) {
      if (this.store.get("settings", this.mine, `tool-macro:${id}`) && this.store.sqlite.prepare(
        "SELECT run_id FROM flow_graph_runs WHERE owner=? AND flow_id=? AND status IN ('running','waiting_approval','interrupted') LIMIT 1").get(this.mine, id))
        throw new Error("Cancel this macro's unfinished runs before removing it");
      // mac7/lockdown-fix (integration review): the kept task limits of its runs go with it.
      for (const row of this.store.sqlite.prepare("SELECT run_id FROM flow_graph_runs WHERE owner=? AND flow_id=?").all(this.mine, id))
        this.graphs.forgetLimit(String((row as { run_id: unknown }).run_id));
      const removed = this.store.delete("flow_graphs", this.mine, id);
      this.store.delete("settings", this.mine, `tool-macro:${id}`);
      this.publishTools();
      return { removed };
    }
    return this.workflows.remove(this.mine, id);
  }
  /** Starts a flow, telling whoever asked about each box as it finishes. */
  async run(id: string,
    options: { resume?: boolean; input?: Record<string, unknown>; interrupted?: "again" | "past" } = {}):
    Promise<FlowView | GraphRunStart> {
    const owner = this.mine;
    if (this.store.get("flow_graphs", owner, id))
      return options.resume
        ? this.resumeGraph(id, { approve: true,
            ...(options.interrupted === undefined ? {} : { interrupted: options.interrupted }) })
        : this.startGraph(id, options.input ?? {});
    const before = this.workflows.stepStates(owner, id);
    const finished = await (options.resume ? this.workflows.resume(owner, id) : this.workflows.run(owner, id));
    this.announce(id, before, this.workflows.stepStates(owner, id));
    return this.view(finished);
  }
  /**
   * Starts a graph flow and hands back the task id straight away, before a single box has run, so
   * the page can open the run socket and watch the boxes happen rather than asking over and over.
   */
  startGraph(id: string, input: Record<string, unknown> = {}, within?: readonly string[], source: RunSource = "owner", signal?: AbortSignal): GraphRunStart {
    const definition = this.definitionOf(id);
    const started = this.graphs.begin(definition, input, { source });
    // mac7/lockdown-fix: a flow a task sets going through its own tool keeps to that task's tools.
    // mac7/outside-resume: and is held as that task is, when it came from outside.
    this.follow(started.runId, this.graphs.work(started.runId, started.compiled, { source, ...(within ? { within } : {}), ...(signal ? { signal } : {}) }));
    return { runId: started.runId, flowId: id, status: "running", name: definition.name };
  }
  /** Whether a saved flow is drawn as a graph rather than kept as a list of steps. */
  isGraph(id: string): boolean { return !!this.store.get("flow_graphs", this.mine, id); }
  /**
   * Carries a checkpointed graph run on from the box after the last one that finished. `approve`
   * is the owner saying yes on their own screen to whatever a box stopped to ask about; the
   * assistant never sets it, so a flow waiting on the owner stays waiting until they answer.
   */
  resumeGraph(id: string,
    options: { runId?: string; approve?: boolean; interrupted?: "again" | "past"; within?: readonly string[]; source?: RunSource } = {}): GraphRunStart {
    const definition = this.definitionOf(id);
    const pick = options.runId ?? this.graphs.resumable(id)?.runId;
    // Q119: a Trunk carries on only its own run; another's, or the owner's, reads as nothing to carry on.
    const caller = this.runtime.trunkAtWork();
    if (!pick || (caller && this.graphs.trunkOf(pick) !== caller))
      throw new Error("There is nothing to carry on: no run of that flow stopped part way through.");
    const waiting = this.graphs.view(pick);
    if (!options.approve && !options.interrupted && waiting.question)
      throw new Error("That flow is waiting for you to say yes on your own screen. Approve it there, then carry it on.");
    // mac7/outside-resume: a run set going from outside stays held as that (FlowGraphRunner.work reads it).
    // Q144 (NAS ebeccfa): a carry-on that is refused says why, rather than answering "running" while nothing runs. The
    // resume is still started first, so a run whose Trunk is gone is ended saying so (Q122), as before.
    const whose = this.graphs.trunkOf(pick);
    const refused = whose ? this.runtime.trunkWorkError(whose) : null;
    const work = this.graphs.resume(pick, definition, { source: options.source ?? "owner", approve: options.approve === true,
      ...(options.interrupted === undefined ? {} : { interrupted: options.interrupted }),
      ...(options.within ? { within: options.within } : {}) }); // mac7/lockdown-fix: a task carrying it on keeps to its tools
    if (refused) { void work.catch(() => undefined); throw refused; }
    this.follow(pick, work);
    return { runId: pick, flowId: id, status: "running", name: definition.name };
  }
  /** Keeps hold of a run happening in the background, so a caller can wait for it if it wants to. */
  private follow(runId: string, work: Promise<GraphRunView>): void {
    const kept = work.catch(() => this.graphs.view(runId));
    this.working.set(runId, kept);
    void kept.then(() => { this.working.delete(runId); });
  }
  /** Waits for a background run to settle. The page never needs this; a test and a tool do. */
  async settled(runId: string): Promise<GraphRunView> {
    return (await this.working.get(runId)) ?? this.graphs.view(runId);
  }
  /** Where one run of a graph flow has got to, box by box. */
  runState(runId: string): GraphRunView { return this.graphs.view(runId); }
  /**
   * Runs that were left working when the app closed. Each is picked up from the box after the last
   * one that finished, with the state exactly as that box left it.
   */
  resumeInterrupted(): string[] {
    this.graphs.markInterrupted();
    const carried: string[] = [];
    for (const run of this.graphs.unfinished()) {
      const record = this.store.get("flow_graphs", this.mine, run.flowId);
      if (!record || !run.nextNode) continue;
      this.follow(run.runId, this.graphs.resume(run.runId, FlowGraphSchema.parse(record.data), { source: "owner" }));
      carried.push(run.runId);
    }
    return carried;
  }
  /**
   * One tool per saved graph flow, so the assistant can set a whole flow going by name, with the
   * flow own declared input as the tool arguments. Rebuilt whenever a flow is saved or removed.
   */
  publishTools(): string[] {
    const registry = this.registry;
    if (!registry) return [];
    // Only the names this put there are taken away again, so a flow tool from somewhere else stays.
    for (const name of this.publishedTools) registry.unregister(name);
    this.publishedTools = [];
    const published: string[] = [];
    for (const flow of this.graphFlows()) {
      const name = flowToolName(flow.name);
      if (published.includes(name) || builtInFlowTools.has(name)) continue;
      registry.register({
        name, permission: "workflows.manage",
        description: `Runs the saved flow "${flow.name}".`.slice(0, 200),
        parameters: zodForShape(flow.definition.input) as z.ZodType<Record<string, unknown>>,
        execute: async (value, context) => this.settled(this.startGraph(flow.id, value, this.workflows.taskLimit(context), // mac7/lockdown-fix
          heldSource(context, this.store), context.signal).runId), // mac7/outside-resume
      });
      published.push(name);
    }
    this.publishedTools = published;
    return published;
  }
  /** Set once at launch, so saving a flow can put it into the catalog as a tool of its own. */
  useRegistry(registry: ToolRegistry): void { this.registry = registry; this.publishTools(); }
  pause(id: string): FlowView { return this.view(this.workflows.pause(this.mine, id)); }
  /** Sends one note per box that reached a settled state while the flow was running. */
  private announce(id: string, before: StepState[], after: StepState[]): void {
    const was = new Map(before.map((entry) => [entry.index, entry.status]));
    for (const entry of after) {
      if (was.get(entry.index) === entry.status || entry.status === "running" || entry.status === "retrying") continue;
      this.notifyEvent("flow.node", { flowId: id, node: nodeId(entry.index), index: entry.index,
        name: entry.name, kind: entry.kind, status: entry.status });
    }
  }
}

export function registerFlows(registry: ToolRegistry, flows: Flows): void {
  registry.register({
    // No explicit group: the name decides it, exactly as `workflows.*` does, so the one table in
    // src/catalog.ts really is where a tool's box comes from and the "flows." prefix there is used.
    name: "flows.list", permission: "workflows.read",
    description: "Saved flows as boxes and arrows: every step, what it does, where it has got to, and which step follows which.",
    parameters: z.object({}).strict(),
    execute: async () => ({ flows: flows.list() }),
  });
  // Each saved graph flow becomes a tool of its own, with its declared input as the arguments.
  flows.useRegistry(registry);
}

/** The routes for flows: the whole list, one flow, and starting one. Returns null for other paths. */
export async function flowsApi(
  flows: Flows,
  request: { method?: string | undefined },
  path: string,
  body: () => Promise<unknown>,
): Promise<unknown | null> {
  const method = request.method ?? "GET";
  if (method === "GET" && path === "/api/flows/macros") return { macros: flows.macros() };
  if (method === "POST" && path === "/api/flows/macros/check") return flows.checkMacro(await body());
  if (method === "POST" && path === "/api/flows/macros") return flows.saveMacro(await body());
  const cancel = /^\/api\/flows\/runs\/([a-f0-9-]{36})\/cancel$/.exec(path);
  if (cancel && method === "POST") return flows.cancelRun(cancel[1]!);
  const resume = /^\/api\/flows\/runs\/([a-f0-9-]{36})\/resume$/.exec(path);
  if (resume && method === "POST") return flows.resumeRun(resume[1]!, await body());
  if (path === "/api/flows") {
    if (method === "GET") return { flows: flows.list() };
    if (method === "POST") return flows.save(await body());
    return null;
  }
  // Checking a picture without saving it, so the editor can say what is wrong before Save.
  if (path === "/api/flows/check" && method === "POST") return flows.check(await body());
  const watching = /^\/api\/flows\/runs\/([a-f0-9-]{36})$/.exec(path);
  if (watching && method === "GET") return flows.runState(watching[1]!);
  const match = /^\/api\/flows\/([a-f0-9-]{36})(?:\/(run|resume|pause))?$/.exec(path);
  if (!match) return null;
  const id = match[1]!;
  if (method === "GET" && !match[2]) return flows.get(id);
  if (method === "PUT" && !match[2]) return flows.save({ ...(await body() as Record<string, unknown>), id });
  if (method === "DELETE" && !match[2]) return flows.remove(id);
  if (method === "POST" && match[2] === "run")
    return flows.run(id, { input: (await body()) as Record<string, unknown> ?? {} });
  if (method === "POST" && match[2] === "resume") {
    // A box that was still running when Branch stopped is asked about rather than repeated; the
    // owner's answer ("again" or "past") rides on the same request that carries the flow on.
    const said = (await body()) as { interrupted?: unknown } | null;
    const answer = said?.interrupted === "again" || said?.interrupted === "past" ? said.interrupted : undefined;
    return flows.run(id, { resume: true, ...(answer === undefined ? {} : { interrupted: answer }) });
  }
  if (method === "POST" && match[2] === "pause") return flows.pause(id);
  return null;
}
