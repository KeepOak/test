import { z } from "zod";
import { compileGraph, type Shape, type FlowGraphDefinition } from "./flow-graph.js";

/** Declarative registered-tool sequences; no script or expression interpreter. */
const Name = z.string().regex(/^[a-z][A-Za-z0-9_]{0,39}$/);
const Kind = z.enum(["text", "number", "yes/no", "list of text", "list of numbers"]);
const ShapeSchema = z.record(Name, Kind).refine((shape) => Object.keys(shape).length <= 20, "At most 20 values");
const Scalar = z.union([z.string().max(4000), z.number().finite(), z.boolean(), z.null()]);
const Literal = z.union([Scalar, z.array(Scalar).max(50)]);
const Reference = z.object({ $value: Name }).strict();
export const ToolMacroSchema = z.object({
  format: z.literal("branch-tool-macro/1"),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).default(""),
  input: ShapeSchema.default({}),
  steps: z.array(z.object({
    name: z.string().trim().min(1).max(80),
    tool: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.:-]{0,99}$/),
    args: z.record(Name, z.union([Literal, Reference])).default({})
      .refine((args) => Object.keys(args).length <= 30, "At most 30 arguments"),
    output: ShapeSchema.default({}),
  }).strict()).min(1).max(12),
}).strict();

/** No run here. Missing tools and unknown/forward references fail before saving. */
export function compileToolMacro(value: unknown, tools: readonly string[]): FlowGraphDefinition {
  if (Buffer.byteLength(JSON.stringify(value) ?? "") > 64_000) throw new Error("Macro exceeds 64 KB");
  const macro = ToolMacroSchema.parse(value), known = new Set(tools);
  const available: Shape = { ...macro.input };
  const nodes = macro.steps.map((step, index) => {
    if (!known.has(step.tool)) throw new Error(`Tool ${step.tool} is not registered`);
    const input: Shape = {};
    const args = Object.fromEntries(Object.entries(step.args).map(([name, arg]) => {
      if (arg && typeof arg === "object" && !Array.isArray(arg)) {
        if (!Object.hasOwn(available, arg.$value)) throw new Error(`Step ${index + 1} reads unknown value ${arg.$value}`);
        input[arg.$value] = available[arg.$value]!;
        return [name, arg];
      }
      return [name, { $literal: arg }];
    }));
    for (const name of Object.keys(step.output)) {
      if (Object.hasOwn(available, name)) throw new Error(`Step ${index + 1} overwrites value ${name}`);
      available[name] = step.output[name]!;
    }
    return { id: `s${index + 1}`, name: step.name, kind: "tool" as const, argumentMode: "typed-macro" as const, tool: step.tool, args,
      input, output: step.output, timeoutMs: 120_000 };
  });
  return compileGraph({ name: macro.name, description: macro.description, input: macro.input, state: available,
    entry: "s1", nodes, edges: nodes.slice(1).map((node, i) => ({ from: nodes[i]!.id, to: node.id })), loopLimit: 1 }).definition;
}

/** Structural references retain number/bool/list types; literal braces are never templates. */
export function macroArgument(value: unknown, state: Record<string, unknown>): { matched: boolean; value: unknown } {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1)
    return { matched: false, value };
  const ref = value as Record<string, unknown>;
  if (Object.hasOwn(ref, "$literal")) return { matched: true, value: Literal.parse(ref.$literal) };
  if (!Object.hasOwn(ref, "$value")) return { matched: false, value };
  const name = Name.parse(ref.$value);
  if (!Object.hasOwn(state, name)) throw new Error(`Macro value ${name} is unavailable`);
  return { matched: true, value: state[name] };
}
