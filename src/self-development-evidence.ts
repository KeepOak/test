import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import type { ToolContext } from "./contracts.js";
import { runOrigin, startedWithShortLivedKey } from "./key-context.js";
import { contractHash, remoteBroken, type SelfDevelopmentContract } from "./self-development-contract.js";
import type { SelfDevelopmentDeps } from "./self-development.js";

export type TestEvidence = { id: string; sha: string; contractHash: string; worktree: string; runId: string; command: string[]; passed: number; at: string };
/** SELF-014: the newest run of the contract's exact tests in a worktree, passed or not, and why not. */
export type TestRun = { id: string; worktree: string; sha: string; runId: string; command: string[]; passed: boolean; at: string; reason?: string; failing?: string[] };
type Pending = { contract: SelfDevelopmentContract; sha: string; command: string[] };
type ReviewInput = { executable?: unknown; cwd?: unknown; args?: unknown };
type ReviewResult = { status?: unknown; exitCode?: unknown; truncated?: unknown; stdout?: unknown };
export async function sourceGit(deps: SelfDevelopmentDeps, worktree: string, args: string[], signal: AbortSignal): Promise<string> {
  const answer = await deps.git({ cwd: resolve(deps.workspace, worktree), args, timeoutMs: 60_000, maxOutputBytes: 262_144 }, signal);
  if (answer.status !== "completed" || answer.truncated) throw new Error("Branch could not completely verify the source worktree.");
  return answer.stdout.trim();
}
export async function cleanHead(deps: SelfDevelopmentDeps, contract: SelfDevelopmentContract, signal: AbortSignal): Promise<string> {
  const head = await sourceGit(deps, contract.worktreePath, ["rev-parse", "HEAD"], signal);
  if (!/^[a-f0-9]{40}$/.test(head)) throw new Error("The worktree's exact commit is unavailable.");
  const refusal = await remoteBroken(deps, contract, signal, head);
  if (refusal) throw new Error(refusal);
  if (await sourceGit(deps, contract.worktreePath, ["status", "--porcelain=v1", "--untracked-files=all"], signal))
    throw new Error("Commit all changes before testing the exact version for owner review.");
  return head;
}

async function originalRunner(deps: SelfDevelopmentDeps, contract: SelfDevelopmentContract, head: string, signal: AbortSignal): Promise<void> {
  for (const path of ["scripts/review.mjs", "scripts/build-ts.mjs"]) {
    const original = await sourceGit(deps, contract.worktreePath, ["rev-parse", `${contract.sourceSha}:${path}`], signal);
    const tested = await sourceGit(deps, contract.worktreePath, ["rev-parse", `${head}:${path}`], signal);
    if (original !== tested) throw new Error(`The change edits ${path}; its runner evidence needs independent review on GitHub.`);
  }
  const scriptsAt = async (sha: string) => {
    const body = await sourceGit(deps, contract.worktreePath, ["show", `${sha}:package.json`], signal);
    return (JSON.parse(body) as { scripts?: unknown }).scripts;
  };
  if (JSON.stringify(await scriptsAt(contract.sourceSha)) !== JSON.stringify(await scriptsAt(head)))
    throw new Error("The change edits package scripts; its runner evidence needs independent review on GitHub.");
}

/**
 * Kept in Branch's own database, so a restart (a hot update, a crash) does not lose tests that passed and send the
 * owner's review back to "run the tests first". It is only ever used for the exact commit and contract it names.
 */
class Kept<T> {
  constructor(private readonly db: DatabaseSync, private readonly owner: string, private readonly kind: "passed" | "run") {
    db.exec(`CREATE TABLE IF NOT EXISTS self_development_evidence(owner TEXT NOT NULL, worktree TEXT NOT NULL, kind TEXT NOT NULL,
      data TEXT NOT NULL, PRIMARY KEY(owner, worktree, kind))`);
  }
  get(worktree: string): T | undefined {
    const row = this.db.prepare("SELECT data FROM self_development_evidence WHERE owner=? AND worktree=? AND kind=?").get(this.owner, worktree, this.kind) as { data?: string } | undefined;
    try { return row?.data ? JSON.parse(row.data) as T : undefined; } catch { return undefined; }
  }
  set(worktree: string, value: T): void {
    this.db.prepare(`INSERT INTO self_development_evidence(owner, worktree, kind, data) VALUES(?,?,?,?)
      ON CONFLICT(owner, worktree, kind) DO UPDATE SET data=excluded.data`).run(this.owner, worktree, this.kind, JSON.stringify(value));
  }
  delete(worktree: string): void {
    this.db.prepare("DELETE FROM self_development_evidence WHERE owner=? AND worktree=? AND kind=?").run(this.owner, worktree, this.kind);
  }
}

/** Evidence exists only for a real, guarded review command with clean identical heads before and after. */
export class SelfDevelopmentEvidence {
  private readonly passed: Kept<TestEvidence>;
  private readonly runs: Kept<TestRun>;
  private readonly pending = new WeakMap<ToolContext, Pending>();
  constructor(private readonly deps: SelfDevelopmentDeps) {
    this.passed = new Kept(deps.store.sqlite, deps.owner, "passed");
    this.runs = new Kept(deps.store.sqlite, deps.owner, "run");
  }
  install(): void {
    const registry = this.deps.registry, before = registry.beforeTool, after = registry.afterTool;
    registry.beforeTool = async (name, args, context) => {
      const held = await before?.(name, args, context);
      await this.before(name, args, context, held?.writesConfinedTo);
      return held;
    };
    registry.afterTool = async (name, args, result, context) => {
      await this.after(name, result, context);
      return after ? after(name, args, result, context) : result;
    };
  }
  /**
   * The owner's own task. A task the owner starts in the app carries no source at all (only a chat, a schedule, a
   * door or a key names one), so an absent source is the owner's, and the task's own record must say so too, as
   * `ownerOnly` (src/self-development.ts) judges it. Found by the WSL-held proof: evidence was never recorded for a
   * real task, only for a test that set source "owner" by hand.
   */
  private ownersOwnTask(context: ToolContext): boolean {
    if ((context.source ?? "owner") !== "owner") return false;
    if (!context.runId) return true;
    const origin = runOrigin(this.deps.store, context.runId);
    return origin.source === "owner" && !origin.shortLivedKey && origin.keyIds.length === 0 && !origin.personProfileId && !origin.lentTo;
  }
  get(worktree: string): TestEvidence | null { return this.passed.get(worktree) ?? null; }
  /** SELF-014: how the newest run of the contract's tests went in this worktree (a failure is kept too, never as evidence). */
  lastRun(worktree: string): TestRun | null { return this.runs.get(worktree) ?? null; }
  private async before(name: string, input: unknown, context: ToolContext, confined?: string): Promise<void> {
    this.pending.delete(context);
    if (name !== "shell.execute" || startedWithShortLivedKey() || context.owner !== this.deps.owner || !this.ownersOwnTask(context) || context.dryRun) return;
    const args = input as ReviewInput;
    if (args.executable !== "node" || typeof args.cwd !== "string" || !Array.isArray(args.args) || !confined) return;
    const contract = this.deps.contracts.current(this.deps.owner, args.cwd);
    if (!contract || resolve(confined) !== resolve(this.deps.workspace, contract.worktreePath)) return;
    const expected = ["scripts/review.mjs", "--jobs", "1", ...contract.expectedTests];
    if (!contract.expectedTests.every((file) => /^tests\/[A-Za-z0-9._/-]+\.test\.mjs$/.test(file))
      || JSON.stringify(args.args) !== JSON.stringify(expected)) return;
    this.passed.delete(contract.worktreePath);
    const sha = await cleanHead(this.deps, contract, context.signal);
    await originalRunner(this.deps, contract, sha, context.signal);
    this.pending.set(context, { contract, sha, command: ["node", ...expected] });
  }
  private async after(name: string, input: unknown, context: ToolContext): Promise<void> {
    const pending = this.pending.get(context);
    this.pending.delete(context);
    if (name !== "shell.execute" || !pending) return;
    const result = input as ReviewResult;
    const stdout = typeof result.stdout === "string" ? result.stdout : "";
    const failed = (reason: string): void => {
      const failing = stdout.split("\n").filter((line) => /^(FAIL|✖) /.test(line)).map((line) => line.slice(0, 200)).slice(0, 20);
      this.runs.set(pending.contract.worktreePath, { id: randomUUID(), worktree: pending.contract.worktreePath, sha: pending.sha, runId: context.runId,
        command: pending.command, passed: false, at: new Date().toISOString(), reason, ...(failing.length ? { failing } : {}) });
    };
    if (result.status !== "completed" || result.exitCode !== 0) return failed(`The command did not finish cleanly (exit code ${String(result.exitCode ?? result.status)}).`);
    if (result.truncated || !stdout) return failed("Its output was cut off, so its counts cannot be read.");
    if (!/all steps passed in/.test(stdout) || /skipped|FAIL /i.test(stdout)) return failed("Not every step passed, or a test was skipped.");
    let passed = 0;
    for (const file of pending.contract.expectedTests) {
      const line = stdout.split("\n").find((line) => line.startsWith("PASS ") && line.includes(` ${file} `));
      const counts = line ? /\b([0-9]+)\/([0-9]+) passed\b/.exec(line) : null;
      if (!counts || counts[1] !== counts[2] || Number(counts[1]) < 1) return failed(`${file} did not report every one of its tests passed.`);
      passed += Number(counts[1]);
    }
    const current = this.deps.contracts.current(this.deps.owner, pending.contract.worktreePath);
    if (!current || contractHash(current) !== contractHash(pending.contract)
      || await cleanHead(this.deps, current, context.signal) !== pending.sha) return failed("The contract or the commit changed while the tests ran.");
    const at = new Date().toISOString();
    this.passed.set(current.worktreePath, { id: randomUUID(), sha: pending.sha, contractHash: contractHash(current), worktree: current.worktreePath,
      runId: context.runId, command: pending.command, passed, at });
    this.runs.set(current.worktreePath, { id: randomUUID(), worktree: current.worktreePath, sha: pending.sha, runId: context.runId, command: pending.command, passed: true, at });
  }
}
