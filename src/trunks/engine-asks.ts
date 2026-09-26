/**
 * The engine's own tasks in a Trunk's or a room's conversation, which nobody asked for in words: the task that opens the
 * conversation (finished at once with `openedNote`) and the ask that has a new Trunk introduce itself. GET /api/state
 * marks both `aside` so the Overview's recent activity shows only what a person asked for.
 */
export const openedNote = "Opened";
export const introPrompt = "Introduce yourself to the owner in two or three short sentences: your name, your role, and what you can help with. This is the first message of your own conversation.";
export const engineAsk = (run: { prompt: string; output: string; status: string }): boolean =>
  run.prompt === introPrompt || (run.status === "completed" && run.output === openedNote);
