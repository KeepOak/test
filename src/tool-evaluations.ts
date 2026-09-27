/**
 * Tool evaluations: one tool, one input, and what should come back. No model is involved — the
 * tool is called directly — so these run in a moment, cost nothing, and can sit in a build script.
 * They answer the question the ordinary tests do not: does each tool still behave the way the
 * assistant has been told it behaves.
 *
 * The cases are plain JSON in `data/tool-evaluations/`, so a person can read one and add another.
 */
import { readdirSync, readFileSync } from "node:fs";
import { underProject } from "./project-scope.js"; // dogfood-ux-2
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { z } from "zod";
import { checkResult } from "./delegation.js";
import type { ToolContext } from "./contracts.js";
import type { ToolRegistry } from "./registry.js";

export const ToolCaseSchema = z.object({
  name: z.string().trim().min(1).max(80),
  input: z.record(z.string(), z.unknown()).default({}),
  /** The shape the answer must have, as a small JSON schema. */
  shape: z.record(z.string(), z.unknown()).optional(),
  /** Words that must appear somewhere in the answer once it is written out. */
  contains: z.array(z.string().min(1).max(200)).max(10).default([]),
  /** This case is meant to be refused, and the refusal must mention this. */
  refuses: z.string().min(1).max(200).optional(),
}).strict();
export const ToolSuiteSchema = z.object({
  tool: z.string().min(1).max(100),
  description: z.string().trim().max(400).default(""),
  cases: z.array(ToolCaseSchema).min(1).max(20),
}).strict();
export type ToolSuite = z.infer<typeof ToolSuiteSchema>;

export interface ToolCaseOutcome { tool: string; name: string; passed: boolean; problem: string | null; ms: number }
export interface ToolEvaluationResult {
  startedAt: string; finishedAt: string; cases: ToolCaseOutcome[];
  summary: { passed: number; total: number; missing: string[] };
}

/** Where the case files are: next to the built program when packaged, else the project's folder. */
function caseDirectories(): string[] {
  const here = fileURLToPath(new URL(".", import.meta.url));
  return [join(here, "data", "tool-evaluations"), join(here, "..", "data", "tool-evaluations")];
}

/** The tool evaluations that ship. A folder that is missing yields nothing; a damaged file says so. */
export function builtInToolSuites(): ToolSuite[] {
  const found = new Map<string, ToolSuite>();
  for (const directory of caseDirectories()) {
    let names: string[];
    try { names = readdirSync(directory).filter((name) => name.endsWith(".json")); } catch { continue; }
    for (const name of names.sort()) {
      let contents: unknown;
      try { contents = JSON.parse(readFileSync(join(directory, name), "utf8")); }
      catch { throw new Error(`The tool evaluation ${name} is not readable JSON`); }
      const parsed = ToolSuiteSchema.safeParse(contents);
      if (!parsed.success) throw new Error(`The tool evaluation ${name} is not valid: ${parsed.error.issues[0]?.message ?? "unknown problem"}`);
      if (!found.has(parsed.data.tool)) found.set(parsed.data.tool, parsed.data);
    }
  }
  return [...found.values()];
}

/** Checks one answer against what the case said it should be. The first problem is the verdict. */
function verdict(one: z.infer<typeof ToolCaseSchema>, answer: unknown, refusal: string | null): string | null {
  if (one.refuses)
    return refusal === null ? "It was supposed to be refused and it was not"
      : refusal.toLowerCase().includes(one.refuses.toLowerCase()) ? null
        : `It was refused with "${refusal.slice(0, 120)}", and "${one.refuses}" was expected`;
  if (refusal !== null) return `It was refused: ${refusal.slice(0, 160)}`;
  const written = typeof answer === "string" ? answer : JSON.stringify(answer ?? null);
  if (one.shape) {
    const result = checkResult(written, one.shape);
    if (result.status === "unresolved") return result.reason;
  }
  for (const phrase of one.contains)
    if (!written.toLowerCase().includes(phrase.toLowerCase())) return `The answer does not mention "${phrase}"`;
  return null;
}

/**
 * Runs every case of every suite against the tools that are actually installed. A suite for a tool
 * that is not installed is reported as missing rather than counted as a failure.
 */
export async function runToolEvaluations(
  registry: ToolRegistry, context: ToolContext, suites: readonly ToolSuite[] = builtInToolSuites(),
): Promise<ToolEvaluationResult> {
  const startedAt = new Date().toISOString();
  const cases: ToolCaseOutcome[] = [];
  const missing: string[] = [];
  for (const suite of suites) {
    if (!registry.names().includes(suite.tool)) { missing.push(suite.tool); continue; }
    for (const one of suite.cases) cases.push(await runOneCase(registry, context, suite.tool, one));
  }
  return {
    startedAt, finishedAt: new Date().toISOString(), cases,
    summary: { passed: cases.filter((entry) => entry.passed).length, total: cases.length, missing },
  };
}

async function runOneCase(
  registry: ToolRegistry, context: ToolContext, tool: string, one: z.infer<typeof ToolCaseSchema>,
): Promise<ToolCaseOutcome> {
  const began = Date.now();
  let answer: unknown = null, refusal: string | null = null;
  try { answer = await registry.execute(tool, one.input, context); }
  catch (error) { refusal = error instanceof Error ? error.message : String(error); }
  const problem = verdict(one, answer, refusal);
  return { tool, name: one.name, passed: problem === null, problem, ms: Date.now() - began };
}

/**
 * The tool checks really call the tools, so they really write files and really save facts. They do
 * neither of those to anything of the owner's: the checks run in a project of their own — a folder
 * beside the practice workspace, inside the workspace but nothing else's — and under a made-up owner
 * name, so a fact a check saves lands in that name's memory and never in the owner's. The active
 * project is put back afterwards whatever happened, including when a check throws.
 */
export const toolCheckProject = "tool-checks";
export const toolCheckFolder = "tool-checks";
/** The made-up name the checks act under; not a profile, and nothing else ever reads it. */
export const toolCheckOwner = "tool-checks";

/** What the checks need from the app, so the command line and the web route ask for it the same way. */
export interface ToolCheckHost {
  store: {
    projects: {
      active(owner: string): { id: string };
      save(owner: string, project: Record<string, unknown>): unknown;
      setActive(owner: string, input: { active: string }): unknown;
    };
  };
  registry: ToolRegistry;
  runtime: { owner: string; context(options: { signal: AbortSignal }): ToolContext };
}

/** Runs the tool checks where nothing they do can reach the owner's own files or memory. */
export async function runToolChecksSafely(
  app: ToolCheckHost, signal: AbortSignal, suites?: readonly ToolSuite[],
): Promise<ToolEvaluationResult> {
  const projects = app.store.projects, owner = app.runtime.owner;
  projects.save(owner, { id: toolCheckProject, name: "Tool checks", folder: toolCheckFolder,
    instructions: "A folder the tool checks write into. Nothing here is yours and all of it is safe to delete.",
    modelPreset: null, repository: "" });
  // dogfood-ux-2: the checks work in their own project without moving the owner's pick, so a task running meanwhile is
  // never moved into the checks' folder (src/project-scope.ts).
  const context: ToolContext = { ...app.runtime.context({ signal }), owner: toolCheckOwner };
  return await underProject(toolCheckProject, () => runToolEvaluations(app.registry, context, suites));
}

/** One line for a build log. */
export function toolEvaluationLine(result: ToolEvaluationResult): string {
  const missing = result.summary.missing.length ? ` ${result.summary.missing.length} tool(s) are not installed: ${result.summary.missing.join(", ")}.` : "";
  return `Tool checks: ${result.summary.passed} of ${result.summary.total} behaved as documented.${missing}`;
}
