import { TrunkSchema } from "./trunks/record.js";
import type { Run } from "./contracts.js";
import type { RunSource } from "./policy.js";
import type { Store } from "./store.js";

export interface ResumeAuthority {
  permissions: string[]; depth: number; delegates: boolean; dryRun: boolean; ownCopy: boolean;
  agent?: string; trunkId?: string; source: RunSource;
}
type AuthorityRecord = { run: Run; start: Record<string, unknown>; requiredCopy: boolean; borrowedCopy: boolean };
const sources = new Set(["owner", "trigger", "schedule", "mcp", "a2a", "acp", "channel"]);
function unavailable(): never { throw new Error("The task's complete saved authority is unavailable or conflicting. Reconcile its original permissions, helper identity and project before continuing."); }

/** Immutable records only: ancestors narrow permissions; only this task's continuation chain supplies identity. */
export function resumeAuthority(store: Pick<Store, "run" | "events" | "get">, runId: string, owner: string, registered: readonly string[]): ResumeAuthority {
  const root = store.run(runId);
  if (!root || !root.project) unavailable();
  const records = new Map<string, AuthorityRecord>();
  const visiting = new Set<string>();
  let permissions = new Set(registered);
  const visit = (id: string): void => {
    if (visiting.has(id)) unavailable();
    if (records.has(id)) return;
    if (records.size + visiting.size >= 100) unavailable();
    const run = store.run(id), events = store.events(id);
    if (!run || run.owner !== root.owner || run.project !== root.project || events.length >= 2000) unavailable();
    const starts = events.filter((event) => event.kind === "run.started");
    if (starts.length !== 1) unavailable();
    const start = starts[0]!.data;
    if (!Array.isArray(start.permissions) || start.permissions.some((permission) => typeof permission !== "string" || !permission)
      || typeof start.source !== "string" || !sources.has(start.source)) unavailable();
    for (const flag of ["delegates", "dryRun", "ownCopy"])
      if (flag in start && typeof start[flag] !== "boolean") unavailable();
    if ("agent" in start && (typeof start.agent !== "string" || !start.agent)) unavailable();
    if ("depth" in start && (!Number.isInteger(start.depth) || Number(start.depth) < 0 || Number(start.depth) > 3)) unavailable();
    permissions = new Set([...permissions].filter((permission) => (start.permissions as string[]).includes(permission)));
    visiting.add(id);
    for (const field of ["parentRunId", "resumedFrom", "originFrom"]) {
      const link = start[field];
      if (link == null) continue;
      if (typeof link !== "string" || !link) unavailable();
      visit(link);
    }
    visiting.delete(id);
    records.set(id, { run, start, borrowedCopy: events.some((event) => event.kind === "worktree.inherited"),
      requiredCopy: events.some((event) => event.kind === "worktree.used"
      && typeof event.data.branch === "string" && (event.data.branch.startsWith("branch/helper-") || event.data.branch.startsWith("branch/fork-"))) });
  };
  visit(runId);
  const initial: AuthorityRecord | undefined = records.get(runId);
  if (!initial) unavailable();
  if (root.owner !== owner && initial.start.lentTo !== owner) unavailable();
  const lineage: AuthorityRecord[] = [], seen = new Set<string>();
  let id: string | undefined = runId;
  while (id) {
    if (seen.has(id)) unavailable();
    seen.add(id);
    const record: AuthorityRecord | undefined = records.get(id);
    if (!record) unavailable();
    if (record.run.sessionId !== root.sessionId) unavailable();
    lineage.push(record);
    const links: string[] = [record.start.resumedFrom, record.start.originFrom].filter((link): link is string => typeof link === "string");
    const sameTask: string[] = [...new Set(links.filter((link: string): boolean => {
      const linked: AuthorityRecord | undefined = records.get(link);
      if (!linked) unavailable();
      return linked.run.sessionId === root.sessionId;
    }))];
    if (typeof record.start.resumedFrom === "string" && !sameTask.includes(record.start.resumedFrom)) unavailable();
    if (sameTask.length > 1) unavailable();
    id = sameTask[0];
  }
  const consistent = (field: string): unknown => {
    const values = lineage.filter((record) => field in record.start).map((record) => record.start[field]);
    if (values.some((value) => value !== values[0])) unavailable();
    return values[0];
  };
  const savedDepth = consistent("depth");
  const parentDepth = (record: AuthorityRecord, seen = new Set<string>()): number => {
    if (seen.has(record.run.id)) unavailable();
    seen.add(record.run.id);
    if (typeof record.start.depth === "number") return record.start.depth;
    const parent = record.start.parentRunId;
    return typeof parent === "string" ? parentDepth(records.get(parent)!, seen) + 1 : 0;
  };
  const depth = typeof savedDepth === "number" ? savedDepth : Math.max(...lineage.map((record) => parentDepth(record)));
  // Borrowing a lead's copy does not establish ownership or a safe replacement workspace.
  // Also hold legacy children whose parent had a copy but recorded no child placement.
  if (lineage.some((record) => record.borrowedCopy)
    || (depth > 0 && !lineage.some((record) => record.requiredCopy)
      && [...records.values()].some((record) => record.requiredCopy || record.borrowedCopy)))
    throw new Error("The task's borrowed project-copy placement needs reconciliation before continuation. The shared workspace was not used.");
  if (depth > 3 || lineage.some((record) => typeof record.start.parentRunId === "string"
    && parentDepth(records.get(record.start.parentRunId)!) >= depth)) unavailable();
  const agent = consistent("agent"), source = consistent("source");
  const trunkIds = new Set<string>();
  for (const record of records.values()) for (const event of store.events(record.run.id)) {
    if (event.kind !== "trunk.turn") continue;
    const id = event.data.trunkId;
    if (typeof id !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) unavailable();
    trunkIds.add(id);
  }
  if (trunkIds.size > 1) unavailable();
  const trunkId = [...trunkIds][0];
  if (trunkId) {
    const record = store.get("governance", root.owner, `trunk:${trunkId}`);
    if (!record || record.data.id !== trunkId || record.data.paused === true) unavailable();
    const core = Object.fromEntries(Object.keys(TrunkSchema.shape).map((key) => [key, record.data[key]]));
    if (!TrunkSchema.safeParse(core).success) unavailable();
  }

  if (typeof agent === "string" && agent.startsWith("trunk:")) {
    if (!trunkId || agent !== `trunk:${trunkId}`) unavailable();
  } else if (typeof agent === "string" && !agent.startsWith("mode:") && !store.get("specialists", root.owner, agent)) unavailable();
  // Explicit false never grants delegation. Practice mode and required isolation can only become stricter.
  return { permissions: [...permissions], depth, delegates: lineage.every((record) => record.start.delegates === true),
    dryRun: lineage.some((record) => record.start.dryRun === true),
    ownCopy: lineage.some((record) => record.start.ownCopy === true || record.requiredCopy),
    ...(typeof agent === "string" ? { agent } : {}), ...(trunkId ? { trunkId } : {}), source: source as RunSource };
}
