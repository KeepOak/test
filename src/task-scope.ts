import { AsyncLocalStorage } from "node:async_hooks";

/**
 * household-followups: the task a tool is running for. The registry marks every tool call with its
 * task's id (src/registry.ts), so an owner-only guard inside a tool (src/profiles.ts `requireOwner`
 * and `isOwner`) judges by the person the task was started for, not by whoever the app window is
 * switched to at that moment.
 */
const scope = new AsyncLocalStorage<string>();
/** mac7/walk-rules: the tool running, so a folder walk inside it is judged as that tool (src/walk-rules.ts). */
const tools = new AsyncLocalStorage<string>();
/** Q250: the task whose model's own tool call this work is part of, however deep (a recipe or workflow it runs). */
const modelCalls = new AsyncLocalStorage<string>();

/** Runs `work` as part of the task `runId` (and, when named, as the tool `tool`). */
export function underTask<T>(runId: string, work: () => T, tool?: string): T {
  return scope.run(runId, tool === undefined ? work : () => tools.run(tool, work));
}
/** The task the current tool call is running for, if any. */
export function currentTaskRun(): string | undefined {
  return scope.getStore();
}
/** mac7/walk-rules: the tool the current call is, if any. */
export function currentTool(): string | undefined {
  return tools.getStore();
}
/** Q250: runs `work` as the model's own tool call in the task `runId`. */
export function underModelCall<T>(runId: string, work: () => T): T {
  return modelCalls.run(runId, work);
}
/** Q250: whether this work was started by a model's own tool call (read-before-edit then holds its steps too). */
export function insideModelCall(): boolean {
  return modelCalls.getStore() !== undefined;
}
