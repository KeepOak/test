import { AsyncLocalStorage } from "node:async_hooks";

/**
 * dogfood-ux-2: the project a task works in, for as long as it works. A task reaches the folder and the saved secrets of
 * ITS conversation's project (src/store.ts createRun settles it once, when the task starts), never those of whichever
 * project the owner happens to have picked since. The runtime runs every task inside `underProject` (src/runtime.ts
 * execute), so everything it does — its tools, its helpers, the model calls it makes — reads the same project through
 * `Projects.active` (src/projects.ts), and choosing another project anywhere else changes nothing a running task reaches.
 */
const scope = new AsyncLocalStorage<string>();

/** Runs `work` as work of the project `projectId`. */
export function underProject<T>(projectId: string, work: () => T): T {
  return scope.run(projectId, work);
}
/** The project the current task works in, or undefined outside any task. */
export function currentProject(): string | undefined {
  return scope.getStore();
}
