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

type Deps = { store: Store; runtime: Runtime };
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
  let copy: string | null = null;
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
    if (copy === null) {
      const kept = [...events].reverse().find((event) => ["worktree.used", "worktree.removed", "worktree.missing", "worktree.skipped"].includes(event.kind));
      if (kept && kept.kind !== "worktree.used") refused("the original working copy is unavailable or was not established");
      if (kept) {
        if (typeof kept.data.path !== "string" || !kept.data.path) refused("the original working-copy path is unavailable");
        copy = kept.data.path;
      }
    }
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
  const root = deps.runtime.context({ permissions: [] }).workspace;
  let workspace = root;
  if (copy !== null) {
    if (isAbsolute(copy) || /[\\:\0]/.test(copy) || copy.split("/").some((part) => !part || part === "." || part === ".."))
      refused("the recorded working-copy path is invalid");
    const requested = resolve(root, copy), rootReal = await realpath(root);
    const copyReal = await realpath(requested).catch(() => null);
    const from = copyReal ? relative(rootReal, copyReal) : "";
    if (!copyReal || !from || isAbsolute(from) || from === ".." || from.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
      || !samePath(copyReal, resolve(rootReal, copy)) || !(await stat(copyReal)).isDirectory())
      refused("the retained working copy could not be verified inside the workspace");
    workspace = copyReal;
  }
  const origin = runOrigin(deps.store, runId), outside = outsideSourceOf(deps.store, runId);
  const scope = copy;
  return underProject(project, () => {
    const context = { ...deps.runtime.context({ runId, permissions: [...permissions], depth: Number(depth),
      ...(outside ? { source: outside } : {}), ...(typeof own.agent === "string" ? { agent: own.agent } : {}),
      ...(own.delegates === true ? { delegates: true } : {}), ...(own.dryRun === true ? { dryRun: true } : {}) }), workspace };
    // Temporary conversations keep their original inability to write durable memory.
    if (deps.store.sessionTemporary(run.sessionId)) context.permissions.delete("memory.write");
    // Origin is still checked by the runtime from the task record; no key/person/approval grant is invented here.
    if (origin.permissions) context.permissions = new Set([...context.permissions].filter((p) => origin.permissions!.includes(p)));
    return scope === null ? work(context) : inWorktree(scope, () => work(context));
  });
}
