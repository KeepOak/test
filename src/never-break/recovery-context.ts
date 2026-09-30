import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { ToolContext } from "../contracts.js";
import type { Runtime } from "../runtime.js";
import type { Store } from "../store.js";
import { runOrigin } from "../key-context.js";
import { outsideSourceOf } from "../outside-origin.js";
import { underProject } from "../project-scope.js";
import { defaultProjectId } from "../projects.js";
import { inWorktree } from "../coding/worktrees.js";
import { GitRunner, type GitRunOptions, type GitOutcome } from "../integrations/git-run.js";

type Deps = { store: Store; runtime: Runtime; git?: (input: GitRunOptions, signal: AbortSignal) => Promise<GitOutcome> };
const identityGit = new GitRunner({ timeoutMs: 10_000 });
const refused = (why: string): never => { throw new Error(`This interrupted step was not retried: ${why}. Its original context must be reconciled before continuing.`); };
const samePath = (a: string, b: string) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;

/** Restore only recorded constraints. A missing or ambiguous context never becomes the owner's current workspace. */
export async function withRecoveryContext<T>(deps: Deps, runId: string, work: (context: ToolContext) => Promise<T>): Promise<T> {
  const run = deps.store.run(runId);
  if (!run || run.owner !== deps.runtime.owner) refused("the original task is unavailable");
  const project = run.project ?? defaultProjectId;
  if (!deps.store.projects.list(run.owner).some((one) => one.id === project)) refused("the original project is unavailable");
  const ownEvents = deps.store.events(runId);
  const own = ownEvents.find((event) => event.kind === "run.started")?.data;
  if (!own) refused("the task's starting constraints were not recorded");
  const depth = own.depth === undefined ? 0 : own.depth;
  if (typeof depth !== "number" || !Number.isSafeInteger(depth) || Number(depth) < 0 || Number(depth) > 3) refused("the recorded helper depth is invalid");
  if (own.dryRun === true) refused("a simulated task cannot execute a real recovery call");
  if (own.agent !== undefined && (typeof own.agent !== "string" || !own.agent)) refused("the recorded helper identity is invalid");
  if (own.delegates !== undefined && typeof own.delegates !== "boolean") refused("the recorded delegation ceiling is invalid");
  if (typeof own.parentRunId === "string" && Number(depth) === 0) refused("the helper's original depth is unknown");

  let permissions = new Set(deps.runtime.registry.permissions());
  const seen = new Set<string>(), queue = [runId], links = new Map<string, string[]>();
  while (queue.length) {
    if (seen.size >= 20) refused("the task lineage is too long to establish completely");
    const id = queue.shift()!;
    if (seen.has(id)) refused("the recorded task lineage is ambiguous");
    seen.add(id);
    const ancestor = deps.store.run(id), events = deps.store.events(id);
    if (!ancestor || ancestor.owner !== run.owner || events.length >= 2000) refused("the complete task lineage is unavailable");
    const start = events.find((event) => event.kind === "run.started")?.data;
    if (!start || !Array.isArray(start.permissions) || start.permissions.some((p) => typeof p !== "string" || !p))
      refused("the original tool ceiling is unavailable");
    if ((typeof start.depth === "number" && start.depth > Number(depth))
      || (typeof start.agent === "string" && own.agent === undefined)
      || (start.dryRun === true && own.dryRun !== true)) refused("the original helper or simulation context is incomplete");
    const ceiling = start.permissions as string[];
    permissions = new Set([...permissions].filter((p) => ceiling.includes(p)));
    // The original Trunk account/key scope is not recoverable from Runtime.context alone. Never impersonate it.
    if (events.some((event) => event.kind === "trunk.turn")) refused("the original Trunk context cannot be restored for this retry");
    const parents: string[] = [];
    for (const key of ["resumedFrom", "parentRunId", "originFrom"]) {
      const next = start[key];
      if (next === undefined || next === null) continue;
      if (typeof next !== "string" || !next || next === id) refused("the recorded task lineage is invalid");
      parents.push(next);
      if (!queue.includes(next) && !seen.has(next)) queue.push(next);
    }
    links.set(id, parents);
  }
  const walking = new Set<string>(), walked = new Set<string>();
  const visit = (id: string): void => {
    if (walking.has(id)) refused("the recorded task lineage contains a cycle");
    if (walked.has(id)) return;
    walking.add(id);
    for (const parent of links.get(id) ?? []) visit(parent);
    walking.delete(id); walked.add(id);
  };
  visit(runId);
  // Parent links constrain authority, but do not prove this task was assigned its parent's copy.
  // Only same-conversation/project continuations may carry a recorded copy identity forward.
  let copy: string | null = null, branch: string | null = null, base: string | null = null;
  const copySeen = new Set<string>();
  let id: string | null = runId, requiresCopy = Number(depth) > 0;
  while (id !== null) {
    if (copySeen.has(id) || copySeen.size >= 20) refused("the task's copy lineage is incomplete or cyclic");
    copySeen.add(id);
    const current = deps.store.run(id), events = deps.store.events(id);
    if (!current || current.owner !== run.owner || current.sessionId !== run.sessionId || current.project !== run.project
      || events.length >= 2000) refused("the task's copy lineage changed scope");
    const start = events.find((event) => event.kind === "run.started")?.data;
    if (!start) refused("the task's copy assignment was not recorded");
    requiresCopy ||= start.ownCopy === true;
    if (events.some((event) => ["worktree.removed", "worktree.missing", "worktree.skipped"].includes(event.kind)))
      refused("the task's original working copy is unavailable or was not established");
    for (const event of events.filter((event) => event.kind === "worktree.used")) {
      const path = event.data.path, assignedBranch = event.data.branch, assignedBase = event.data.base;
      if (typeof path !== "string" || !path || typeof assignedBranch !== "string" || !assignedBranch
        || typeof assignedBase !== "string" || !/^[a-f0-9]{40}([a-f0-9]{24})?$/.test(assignedBase))
        refused("the task's complete working-copy identity is unavailable");
      if ((copy !== null && copy !== path) || (branch !== null && branch !== assignedBranch) || (base !== null && base !== assignedBase))
        refused("the task's recorded working-copy assignments disagree");
      copy = path; branch = assignedBranch; base = assignedBase;
    }
    const previous = new Set<string>();
    for (const key of ["resumedFrom", "originFrom"]) {
      const from = start[key];
      if (from === undefined || from === null) continue;
      if (typeof from !== "string" || !from) refused("the task's recorded continuation is invalid");
      const prior = deps.store.run(from);
      if (prior && prior.owner === run.owner && prior.sessionId === run.sessionId && prior.project === run.project) previous.add(from);
      else if (key === "resumedFrom") refused("the task's continuation changed scope");
      // originFrom can name a different helper that woke the lead; it is provenance, not copy assignment.
    }
    if (previous.size > 1) refused("the task's working-copy continuation is ambiguous");
    id = previous.size ? [...previous][0]! : null;
  }
  if (requiresCopy && copy === null) refused("the helper's own retained working-copy assignment is unknown");
  const originalContext = deps.runtime.context({ permissions: [] });
  const root = originalContext.workspace;
  const taskSignal = deps.runtime.activeRunSignal(runId) ?? originalContext.signal;
  let workspace = root;
  if (copy !== null) {
    if (isAbsolute(copy) || /[\\:\0]/.test(copy) || copy.split("/").some((part) => !part || part === "." || part === ".."))
      refused("the recorded working-copy path is invalid");
    const requested = resolve(root, copy), rootReal = await realpath(root).catch(() => refused("the original workspace is unavailable"));
    const copyReal = await realpath(requested).catch(() => null);
    const from = copyReal ? relative(rootReal, copyReal) : "";
    // Source preparation publishes its clone through this logical directory link. Resolve only
    // that recorded source prefix; descendants must still match exactly, without nested redirects.
    let expected = resolve(rootReal, copy);
    if (copy.startsWith("branch-agent-source/")) {
      const sourceReal = await realpath(resolve(root, "branch-agent-source")).catch(() => null);
      const sourceFrom = sourceReal ? relative(rootReal, sourceReal) : "";
      if (!sourceReal || !sourceFrom || isAbsolute(sourceFrom) || sourceFrom === ".."
        || sourceFrom.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`))
        refused("the recorded source checkout is not contained in the workspace");
      expected = resolve(sourceReal, copy.slice("branch-agent-source/".length));
    }
    if (!copyReal || !from || isAbsolute(from) || from === ".." || from.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
      || !samePath(copyReal, expected) || !(await stat(copyReal).catch(() => null))?.isDirectory())
      refused("the retained working copy could not be verified inside the workspace");
    if (!branch || !base) refused("the retained copy's branch and baseline are unknown");
    // These are bounded local identity reads through the established hook-disabled Git seam, never a fetch or write.
    const signal = AbortSignal.any([taskSignal, AbortSignal.timeout(15_000)]);
    const git = deps.git ?? ((input: GitRunOptions, stop: AbortSignal) => identityGit.run(input, stop));
    const read = async (args: string[]) => {
      try { return await git({ cwd: copyReal, args, timeoutMs: 10_000, maxOutputBytes: 8192 }, signal); }
      catch { return refused("the retained copy's local identity could not be read"); }
    };
    const top = await read(["rev-parse", "--show-toplevel"]);
    const actualTop = top.status === "completed" && top.exitCode === 0 && !top.truncated
      ? await realpath(top.stdout.trim()).catch(() => null) : null;
    const line = await read(["symbolic-ref", "--quiet", "--short", "HEAD"]);
    const ancestor = await read(["merge-base", "--is-ancestor", base, "HEAD"]);
    if (!actualTop || !samePath(actualTop, copyReal) || line.status !== "completed" || line.exitCode !== 0
      || line.truncated || line.stdout.trim() !== branch || ancestor.status !== "completed" || ancestor.exitCode !== 0 || ancestor.truncated)
      refused("the retained working copy no longer proves its recorded branch and baseline");
    signal.throwIfAborted();
    workspace = copyReal;
  }
  const origin = runOrigin(deps.store, runId), outside = outsideSourceOf(deps.store, runId);
  const scope = copy;
  return underProject(project, () => {
    const context = { ...deps.runtime.context({ runId, signal: taskSignal, permissions: [...permissions], depth: Number(depth),
      ...(outside ? { source: outside } : {}), ...(typeof own.agent === "string" ? { agent: own.agent } : {}),
      ...(own.delegates === true ? { delegates: true } : {}), ...(own.dryRun === true ? { dryRun: true } : {}) }), workspace };
    // Temporary conversations keep their original inability to write durable memory.
    if (deps.store.sessionTemporary(run.sessionId)) context.permissions.delete("memory.write");
    // Origin is still checked by the runtime from the task record; no key/person/approval grant is invented here.
    if (origin.permissions) context.permissions = new Set([...context.permissions].filter((p) => origin.permissions!.includes(p)));
    return scope === null ? work(context) : inWorktree(scope, () => work(context));
  });
}
