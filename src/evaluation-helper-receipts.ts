import type { Store } from "./store.js";

/** The most of a helper's answer a receipt keeps; `truncated` says a longer one was cut, so it cannot be compared exactly. */
export const helperOutputLimit = 2000;
export interface EvaluationHelperReceipt { runId: string; status: string; output: string; truncated: boolean }

/** Engine-authored direct-child provenance; a model's tool arguments are never a receipt. */
export function evaluationHelpers(store: Store, parentId: string): EvaluationHelperReceipt[] {
  const parent = store.run(parentId);
  if (!parent) return [];
  const rows = store.sqlite.prepare(`SELECT DISTINCT t.id FROM tasks t JOIN events e ON e.run_id=t.id
    WHERE t.owner=? AND e.kind='run.started' AND json_extract(e.data,'$.parentRunId')=?
    ORDER BY t.id LIMIT 101`).all(parent.owner, parentId);
  return rows.flatMap((row) => {
    const child = store.run(String(row.id));
    if (!child || child.owner !== parent.owner || child.id === parentId) return [];
    const start = store.events(child.id).find((event) => event.kind === "run.started")?.data;
    if (start?.parentRunId !== parentId) return [];
    return [{ runId: child.id, status: child.status, output: child.output.slice(0, helperOutputLimit),
      truncated: child.output.length > helperOutputLimit }];
  });
}
