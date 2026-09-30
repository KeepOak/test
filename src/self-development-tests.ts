import { z } from "zod";
import type { ToolContext } from "./contracts.js";
import type { ToolRegistry } from "./registry.js";
import type { ContractBook } from "./self-development-contract.js";
import type { SelfDevelopmentMerges } from "./self-development-merge.js";

const toolName = "branch.run_contract_tests";
/** How the command is run: in the app, through the task's own gate (src/coding/gated.ts `gatedCall`). */
export type HeldCall = (name: string, args: unknown, context: ToolContext) => Promise<unknown>;
const worktreePattern = /^branch-agent-source\/\.branch-worktrees\/self-[a-z0-9][a-z0-9-]{0,23}$/;

/**
 * SELF-014: the contract's exact test list, run in its worktree the one way that counts as evidence
 * (`node scripts/review.mjs --jobs 1 <expectedTests>` through the confined command tool), and how it went: passed with
 * its counts, or failed and why. The command goes through the same gate as the task's own shell.execute call would
 * (src/coding/gated.ts), so the wall, the rules and Lockdown hold exactly as they do there.
 */
export async function runContractTests(book: ContractBook, merges: SelfDevelopmentMerges, call: HeldCall, owner: string,
  worktree: string, context: ToolContext): Promise<Record<string, unknown>> {
  const contract = book.current(owner, worktree);
  if (!contract) throw new Error(`${worktree} has no self-development contract, so it has no tests to run.`);
  if (!contract.expectedTests.length) throw new Error("This contract lists no expected tests. Widen it with the tests that prove the change.");
  const args = ["scripts/review.mjs", "--jobs", "1", ...contract.expectedTests];
  const earlier = merges.evidence.lastRun(worktree);
  let result: { exitCode?: unknown; stdout?: unknown };
  try { result = await call("shell.execute", { executable: "node", cwd: worktree, args }, context) as typeof result; }
  catch (error) {
    // The command is held exactly as the task's own would be; when that means asking first, it is not asked here.
    throw new Error(`The tests did not run (${error instanceof Error ? error.message : String(error)}). Run node ${args.join(" ")} with shell.execute in ${worktree} instead.`);
  }
  // Only a record this very run wrote counts (every run writes a new one): an older one says nothing about this commit.
  const newest = merges.evidence.lastRun(worktree), run = newest && newest.id !== earlier?.id ? newest : null;
  const tail = typeof result.stdout === "string" ? result.stdout.split("\n").slice(-30).join("\n") : "";
  if (!run) return { worktree, command: ["node", ...args], recorded: false, exitCode: result.exitCode ?? null, output: tail,
    note: "No result was recorded: commit every change first, and keep scripts/review.mjs, scripts/build-ts.mjs and the package scripts as they are." };
  const evidence = merges.evidence.get(worktree);
  return { worktree, command: run.command, recorded: true, passed: run.passed, commit: run.sha, at: run.at,
    ...(run.passed ? { testsPassed: evidence?.passed ?? null } : { reason: run.reason, failing: run.failing ?? [] }), output: tail };
}

/**
 * Offered while commands are. The tool itself only looks (files.read): it starts no program of its own, so the
 * contract guard's rule that only shell.execute runs while Branch's source is checked out still holds, and the one
 * command it asks for is judged as a shell.execute of its own (permission, rules, Lockdown, the wall).
 */
export function offerContractTests(registry: ToolRegistry, book: ContractBook, merges: SelfDevelopmentMerges, call: HeldCall, owner: string): void {
  const sync = (): void => {
    const shell = registry.names().includes("shell.execute"), offered = registry.names().includes(toolName);
    if (shell && !offered) registry.register({ name: toolName, permission: "files.read", group: "code",
      description: "Run a Branch self-development worktree's contract tests exactly as its evidence needs them (node scripts/review.mjs --jobs 1 with the contract's expectedTests, confined to the worktree) and say whether they passed, with counts, or failed and why. Commit every change first.",
      parameters: z.object({ worktree: z.string().regex(worktreePattern) }).strict(),
      target: (input) => String(input.worktree),
      execute: (input, context) => runContractTests(book, merges, call, owner, input.worktree, context) });
    if (!shell && offered) registry.unregister(toolName);
  };
  sync();
  registry.onToolsChanged(sync);
}
