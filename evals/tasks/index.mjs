import { workTasks } from "./work.mjs";
import { memoryTasks } from "./memory.mjs";
import { smokeTasks as smokeSubset } from "./smoke.mjs";

/** The full nightly suite: real-work tasks and memory-quality tasks, run through a real engine with a real model. */
export function allTasks() { return [...workTasks, ...memoryTasks]; }

/** The smoke subset: scripted stand-in, machine checks only, under 30 seconds. */
export function smokeTasks() { return smokeSubset; }
