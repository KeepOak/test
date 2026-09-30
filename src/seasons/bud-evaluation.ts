import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ToolContext } from "../contracts.js";
import type { ToolScripts } from "../safety-extras/tool-scripts.js";

export interface BudCase {
  input: Record<string, unknown>; expected: unknown;
  replies?: { tool: string; args: Record<string, unknown>; result: unknown }[] | undefined;
}
export interface BudCode { source: string; tools: string[] }
export interface BudScore { sha256: string; passed: number; total: number; error?: string }
export interface BudEvaluation { at: string; suiteSha256: string; baseline: BudScore | null; candidate: BudScore; promoted: boolean }
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Compare results in Branch, outside the generated code. Expected answers never enter its process. */
async function score(scripts: Pick<ToolScripts, "run">, code: BudCode, tests: BudCase[], context: ToolContext): Promise<BudScore> {
  const fixtures = tests.map(({ input, replies }) => ({ input, replies: replies ?? [] }));
  const source = `${code.source}
export default async function() {
  const output = [];
  for (const fixture of ${JSON.stringify(fixtures)}) {
    let next = 0;
    const simulated = Object.freeze({ call: async (tool, args = {}) => {
      if (!${JSON.stringify(code.tools)}.includes(tool)) throw new Error("Tool was not declared by this capability");
      const reply = fixture.replies[next++];
      if (!reply || reply.tool !== tool || JSON.stringify(reply.args) !== JSON.stringify(args)) throw new Error("No matching evaluation reply");
      return structuredClone(reply.result);
    } });
    try { const value = await build(fixture.input, simulated); output.push({ value, complete: next === fixture.replies.length }); }
    catch { output.push({ complete: false }); }
  }
  return output;
}`;
  let passed = 0, error: string | undefined;
  try {
    // The global branch.call cannot reach any live tool, even if generated code ignores simulated.
    const { osSandbox: _outerWall, ...isolated } = context;
    const answer = await scripts.run({ source, tools: [], timeoutMs: 60000 }, isolated);
    const results = answer.result;
    if (answer.ok && Array.isArray(results) && results.length === tests.length)
      passed = tests.filter((test, index) => results[index]?.complete === true && isDeepStrictEqual(results[index]?.value, test.expected)).length;
    else error = answer.error ?? "Evaluation did not return every case";
  } catch (failure) { error = failure instanceof Error ? failure.message : String(failure); }
  return { sha256: hash(code), passed, total: tests.length, ...(error ? { error } : {}) };
}

export async function evaluateBud(scripts: Pick<ToolScripts, "run">, candidate: BudCode, baseline: BudCode | undefined,
  tests: BudCase[], context: ToolContext): Promise<BudEvaluation> {
  const before = baseline ? await score(scripts, baseline, tests, context) : null;
  context.signal.throwIfAborted();
  const after = await score(scripts, candidate, tests, context);
  return { at: new Date().toISOString(), suiteSha256: hash(tests), baseline: before, candidate: after,
    promoted: !after.error && after.passed === after.total };
}

/** Retain old answers: a revision cannot rewrite its regression suite to make itself pass. */
export function regressionCases(before: BudCase[], after: BudCase[]): BudCase[] {
  const tests = [...before];
  for (const test of after) {
    const previous = tests.find((one) => isDeepStrictEqual(one.input, test.input) && isDeepStrictEqual(one.replies ?? [], test.replies ?? []));
    if (previous && !isDeepStrictEqual(previous.expected, test.expected)) throw new Error("A revision cannot change an existing evaluation's expected answer");
    if (!previous) tests.push(test);
  }
  if (tests.length > 10) throw new Error("A capability keeps at most ten regression cases");
  return tests;
}
