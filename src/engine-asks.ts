import { learningTaskPrefix } from "./skill-authoring.js";

/**
 * The engine's own tasks, which nobody asked for in words: the task that opens a Trunk's or a room's conversation
 * (finished at once with `openedNote`), the ask that has a new Trunk introduce itself, reading a schedule from the
 * owner's words, and the learning passes. GET /api/state marks them `aside` (with setup's tasks, helpers and tasks in a
 * temporary conversation), so the Overview's recent activity shows only what a person asked for.
 */
export const openedNote = "Opened";
export const introPrompt = "Introduce yourself to the owner in two or three short sentences: your name, your role, and what you can help with. This is the first message of your own conversation.";
export const scheduleReading = "Reading a schedule from your words";
export const engineAsk = (run: { prompt: string; output: string; status: string }): boolean =>
  run.prompt === introPrompt || run.prompt === scheduleReading || run.prompt.startsWith(learningTaskPrefix)
  || (run.status === "completed" && run.output === openedNote);
