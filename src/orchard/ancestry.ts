import type { Store } from "../store.js";

/** True only for a task itself or a descendant in its recorded helper tree. Imported cycles fail closed. */
export function taskInTree(store: Store, rootId: string, taskId: string): boolean {
  const root = store.run(rootId);
  if (!root) return false;
  const visited = new Set<string>();
  let next: string | null = taskId;
  while (next && !visited.has(next)) {
    const task = store.run(next);
    if (!task || task.owner !== root.owner) return false;
    if (next === rootId) return true;
    visited.add(next);
    const parent: unknown = store.events(next).find((event) => event.kind === "run.started")?.data.parentRunId;
    next = typeof parent === "string" ? parent : null;
  }
  return false;
}
