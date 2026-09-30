import { z } from "zod";

/**
 * A flow written as a real graph rather than a list: boxes that declare what they read and what
 * they write, arrows that carry values between them, and a check run before anything happens that
 * refuses a picture which could not work — two boxes that disagree about what a value is, a box
 * nothing leads to, or a circle with no way out. Every refusal names the box, in plain words.
 *
 * Nothing here runs a flow; this file is only the shape and the check. The engine is in
 * `src/flow-graph-run.ts` and the way in is `src/flows.ts`, the same door the older list-shaped
 * flows already use.
 */

/** The kinds of value a box may read or write. A trailing "?" means the value may be missing. */
export const fieldTypes = ["text", "number", "yes/no", "list of text", "list of numbers", "anything"] as const;
export type FieldType = (typeof fieldTypes)[number];
const FieldSchema = z.string().regex(/^(text|number|yes\/no|list of text|list of numbers|anything)\??$/,
  `A value's kind must be one of: ${fieldTypes.join(", ")} (add "?" when it may be missing)`);
/** What a box reads or writes: a name for each value and what kind of thing it is. */
export const ShapeSchema = z.record(z.string().regex(/^[a-z][A-Za-z0-9_]{0,39}$/), FieldSchema);
export type Shape = z.infer<typeof ShapeSchema>;

export const graphNodeKinds = ["prompt", "tool", "condition", "map", "gather", "subflow"] as const;
export const GraphNodeSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/, "A box's id is lower-case letters, digits and dashes"),
  name: z.string().trim().min(1).max(80),
  kind: z.enum(graphNodeKinds),
  /** Imported tool macros opt in; older graph argument objects keep their existing semantics. */
  argumentMode: z.literal("typed-macro").optional(),
  /** The values this box reads out of the flow's one state object. */
  input: ShapeSchema.default({}),
  /** The values this box writes back. Everything a box returns is a patch of just these. */
  output: ShapeSchema.default({}),
  prompt: z.string().trim().max(8000).optional(),
  tool: z.string().min(1).max(100).optional(),
  args: z.record(z.string(), z.unknown()).optional(),
  /** For a condition: the value to look at, and the words it must contain to take "matched". */
  field: z.string().max(40).optional(),
  contains: z.string().trim().min(1).max(200).optional(),
  /** For a map: the list to work through, and for a gather: the list to join back together. */
  overField: z.string().max(40).optional(),
  /** Where a map puts what it collected, or a gather puts the joined text. */
  intoField: z.string().max(40).optional(),
  /** For a subflow: another saved flow, run with a state of its own. */
  flowId: z.string().uuid().optional(),
  timeoutMs: z.number().int().min(1000).max(600000).default(120000),
}).strict();
export type GraphNode = z.infer<typeof GraphNodeSchema>;

export const GraphEdgeSchema = z.object({
  from: z.string().min(1).max(40),
  to: z.string().min(1).max(40),
  /** "matched" and "otherwise" are the two ways out of a condition; "always" is an ordinary arrow. */
  when: z.enum(["always", "matched", "otherwise"]).default("always"),
  /** An arrow that goes back to a box already done. Only these may close a circle. */
  loop: z.boolean().default(false),
}).strict();
export type GraphEdge = z.infer<typeof GraphEdgeSchema>;

export const FlowGraphSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).default(""),
  /** What the whole flow is given to start with. This is also its shape as a tool. */
  input: ShapeSchema.default({}),
  /** Everything the flow may keep as it works. Each box writes a patch of these and no more. */
  state: ShapeSchema.default({}),
  entry: z.string().min(1).max(40),
  nodes: z.array(GraphNodeSchema).min(1).max(40),
  edges: z.array(GraphEdgeSchema).max(80).default([]),
  /** How many times one circle may be gone round before the flow gives up. You set this. */
  loopLimit: z.number().int().min(1).max(100).default(10),
}).strict();
export type FlowGraphDefinition = z.infer<typeof FlowGraphSchema>;

/** A flow the owner saved as a graph, rather than as a list of steps. */
export const isGraphDefinition = (value: unknown): boolean =>
  !!value && typeof value === "object" && Array.isArray((value as { edges?: unknown }).edges)
  && typeof (value as { entry?: unknown }).entry === "string";

/** Everything wrong with a picture, said the way a person would say it. */
export class FlowGraphError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join(" "));
    this.name = "FlowGraphError";
  }
}

const required = (shape: Shape): string[] =>
  Object.entries(shape).filter(([, kind]) => !kind.endsWith("?")).map(([name]) => name);
const bare = (kind: string): string => (kind.endsWith("?") ? kind.slice(0, -1) : kind);

/** One declared value turned into something zod can check. "anything" really does mean anything. */
function zodForField(kind: string): z.ZodTypeAny {
  const base = { text: z.string(), number: z.number(), "yes/no": z.boolean(),
    "list of text": z.array(z.string()), "list of numbers": z.array(z.number()),
    anything: z.unknown() }[bare(kind)] ?? z.unknown();
  return kind.endsWith("?") ? base.optional() : base;
}
/** A declared shape as a zod object. A patch is strict: a name nobody declared is a mistake. */
export function zodForShape(shape: Shape, options: { partial?: boolean } = {}): z.ZodTypeAny {
  const fields: Record<string, z.ZodTypeAny> = {};
  for (const [name, kind] of Object.entries(shape))
    fields[name] = options.partial ? zodForField(kind).optional() : zodForField(kind);
  return z.object(fields).strict();
}

/** Where a value that both a box and the flow's state name disagree about what it is. */
function typeProblems(graph: FlowGraphDefinition): string[] {
  const found: string[] = [];
  const known = { ...graph.input, ...graph.state };
  for (const node of graph.nodes)
    for (const [where, shape] of [["reads", node.input], ["writes", node.output]] as const)
      for (const [name, kind] of Object.entries(shape)) {
        const declared = known[name];
        if (declared === undefined) {
          found.push(`The box "${node.name}" ${where} "${name}", which the flow's state never mentions.`);
        } else if (bare(declared) !== bare(kind)) {
          found.push(`The box "${node.name}" says "${name}" is ${bare(kind)}, but the flow's state says it is ${bare(declared)}.`);
        }
      }
  return found;
}

/** The boxes an arrow can be followed to, from each box. */
const outgoing = (graph: FlowGraphDefinition): Map<string, GraphEdge[]> => {
  const map = new Map<string, GraphEdge[]>();
  for (const node of graph.nodes) map.set(node.id, []);
  for (const edge of graph.edges) map.get(edge.from)?.push(edge);
  return map;
};

/** Everything reachable by following arrows from the way in. */
export function reachable(graph: FlowGraphDefinition): Set<string> {
  const next = outgoing(graph), seen = new Set<string>([graph.entry]), queue = [graph.entry];
  while (queue.length) {
    for (const edge of next.get(queue.shift()!) ?? [])
      if (!seen.has(edge.to)) { seen.add(edge.to); queue.push(edge.to); }
  }
  return seen;
}

/**
 * Which values are certainly set by the time each box runs. A value counts only when every way in
 * to that box sets it, so a box that reads something only one branch writes is caught here rather
 * than half way through a run.
 */
function availability(graph: FlowGraphDefinition, live: Set<string>): Map<string, Set<string>> {
  const all = new Set([...Object.keys(graph.input), ...Object.keys(graph.state)]);
  const into = new Map<string, GraphEdge[]>();
  for (const node of graph.nodes) into.set(node.id, []);
  for (const edge of graph.edges) if (live.has(edge.from)) into.get(edge.to)?.push(edge);
  const have = new Map(graph.nodes.map((node) =>
    [node.id, node.id === graph.entry ? new Set(Object.keys(graph.input)) : new Set(all)]));
  const outputOf = new Map(graph.nodes.map((node) => [node.id, Object.keys(node.output)]));
  for (let round = 0; round < graph.nodes.length + 1; round++) {
    let changed = false;
    for (const node of graph.nodes) {
      if (node.id === graph.entry) continue;
      const edges = into.get(node.id) ?? [];
      const merged = new Set<string>(edges.length ? undefined : []);
      for (const [at, edge] of edges.entries()) {
        const from = new Set([...(have.get(edge.from) ?? []), ...(outputOf.get(edge.from) ?? [])]);
        if (at === 0) for (const name of from) merged.add(name);
        else for (const name of [...merged]) if (!from.has(name)) merged.delete(name);
      }
      if (merged.size !== have.get(node.id)?.size) changed = true;
      have.set(node.id, merged);
    }
    if (!changed) break;
  }
  return have;
}

/** A box that reads something nothing before it ever sets. */
function missingValueProblems(graph: FlowGraphDefinition, live: Set<string>): string[] {
  const have = availability(graph, live);
  const found: string[] = [];
  for (const node of graph.nodes) {
    if (!live.has(node.id)) continue;
    for (const name of required(node.input))
      if (!have.get(node.id)?.has(name))
        found.push(`The box "${node.name}" needs "${name}", but nothing that runs before it sets "${name}".`);
  }
  return found;
}

/** Every circle of arrows, as lists of box ids. Found by walking from the way in and back again. */
export function circles(graph: FlowGraphDefinition): string[][] {
  const next = outgoing(graph), found: string[][] = [], onPath: string[] = [], done = new Set<string>();
  const walk = (id: string): void => {
    const at = onPath.indexOf(id);
    if (at >= 0) { found.push(onPath.slice(at)); return; }
    if (done.has(id)) return;
    onPath.push(id);
    for (const edge of next.get(id) ?? []) walk(edge.to);
    onPath.pop();
    done.add(id);
  };
  walk(graph.entry);
  return found;
}

/** A circle nothing leads out of, or one no arrow was marked as a loop with a bound. */
function circleProblems(graph: FlowGraphDefinition): string[] {
  const named = new Map(graph.nodes.map((node) => [node.id, node.name]));
  const found: string[] = [];
  for (const circle of circles(graph)) {
    const inside = new Set(circle);
    const words = circle.map((id) => `"${named.get(id) ?? id}"`).join(", ");
    const leaves = graph.edges.some((edge) => inside.has(edge.from) && !inside.has(edge.to));
    const bounded = graph.edges.some((edge) => edge.loop && inside.has(edge.from) && inside.has(edge.to));
    if (!leaves) found.push(`The boxes ${words} lead round in a circle that nothing leads out of, so the flow would never end.`);
    else if (!bounded) found.push(`The boxes ${words} lead round in a circle, but no arrow in it is marked as a loop, so nothing would ever stop it.`);
  }
  return found;
}

/** What each kind of box cannot do without. */
function kindProblems(node: GraphNode): string[] {
  const needs: Partial<Record<GraphNode["kind"], [keyof GraphNode, string]>> = {
    prompt: ["prompt", "something to ask"], tool: ["tool", "a tool to use"],
    condition: ["field", "a value to look at"], map: ["overField", "a list to work through"],
    gather: ["overField", "a list to join back together"], subflow: ["flowId", "another flow to run"],
  };
  const need = needs[node.kind];
  if (need && node[need[0]] === undefined) return [`The box "${node.name}" is a ${node.kind} box with no ${need[1]}.`];
  if (node.kind === "condition" && node.contains === undefined)
    return [`The box "${node.name}" is a condition with no words to look for.`];
  if ((node.kind === "map" || node.kind === "gather") && node.intoField === undefined)
    return [`The box "${node.name}" has nowhere to put what it collects.`];
  return [];
}

/** A flow checked all the way through, ready to run. */
export interface CompiledGraph {
  definition: FlowGraphDefinition;
  nodes: Map<string, GraphNode>;
  next: Map<string, GraphEdge[]>;
  /** The whole state as zod, and the patch shape each box's answer is held to. */
  stateSchema: z.ZodTypeAny;
  patchSchema: Map<string, z.ZodTypeAny>;
  inputSchema: z.ZodTypeAny;
}

/**
 * Checks a picture and gets it ready to run. Everything wrong is reported at once, each problem
 * naming the box it is about, so the owner fixes the whole picture rather than one thing per try.
 */
export function compileGraph(input: unknown): CompiledGraph {
  const graph = FlowGraphSchema.parse(input);
  const ids = new Set(graph.nodes.map((node) => node.id));
  const problems: string[] = [];
  if (ids.size !== graph.nodes.length) problems.push("Two boxes have been given the same id.");
  if (!ids.has(graph.entry)) problems.push(`The flow starts at "${graph.entry}", which is not one of its boxes.`);
  for (const edge of graph.edges) {
    if (!ids.has(edge.from)) problems.push(`An arrow comes from "${edge.from}", which is not one of the boxes.`);
    if (!ids.has(edge.to)) problems.push(`An arrow goes to "${edge.to}", which is not one of the boxes.`);
  }
  if (problems.length) throw new FlowGraphError(problems);
  for (const node of graph.nodes) problems.push(...kindProblems(node));
  problems.push(...typeProblems(graph));
  const live = reachable(graph);
  for (const node of graph.nodes)
    if (!live.has(node.id)) problems.push(`The box "${node.name}" can never be reached: no arrow leads to it.`);
  problems.push(...circleProblems(graph));
  if (!problems.length) problems.push(...missingValueProblems(graph, live));
  if (problems.length) throw new FlowGraphError(problems);
  return {
    definition: graph, nodes: new Map(graph.nodes.map((node) => [node.id, node])),
    next: outgoing(graph), stateSchema: zodForShape({ ...graph.input, ...graph.state }, { partial: true }),
    patchSchema: new Map(graph.nodes.map((node) => [node.id, zodForShape(node.output, { partial: true })])),
    inputSchema: zodForShape(graph.input),
  };
}
