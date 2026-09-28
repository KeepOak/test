import type { FlowsBoards } from "./index.js";

/**
 * The part of Branch the typed commands reach, for a runtime (src/flows-boards/commands.ts). PLAT-191: kept as a way
 * to reach it, so the part is built the first time a command needs it rather than with the engine.
 */
const byRuntime = new WeakMap<object, () => FlowsBoards>();
export const flowsBoardsFor = (runtime: object): FlowsBoards | undefined => byRuntime.get(runtime)?.();
export const reachFlowsBoards = (runtime: object, get: () => FlowsBoards): void => { byRuntime.set(runtime, get); };
