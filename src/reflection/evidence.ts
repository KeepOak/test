import type { Message, Run } from "../contracts.js";
import type { Store } from "../store.js";
import type { TrialTask } from "../skill-revisions.js";
import { learningTaskPrefix } from "../skill-authoring.js";

/**
 * What the learning passes read: a conversation's turns as plain lines, and past tasks that look
 * like a given one. Nothing here calls a model.
 */

/** The conversation's messages the owner and assistant exchanged, leaving out system text. */
export function turnsOf(store: Store, sessionId: string): Message[] {
  return store.messages(sessionId).filter((message) => message.role !== "system");
}

/**
 * Messages as lines a model can read, each cut short. When they are still longer than `limit`
 * characters, the first and last lines are kept and the middle is left out and said to be, because
 * the oldest new turns are the ones a shortened conversation is about to fold away.
 */
export function asLines(messages: Message[], limit = 12000): string {
  const lines = messages.map((message) => {
    const tools = message.toolCalls?.length ? ` [used: ${message.toolCalls.map((call) => call.name).join(", ")}]` : "";
    return `${message.role}: ${message.content.replace(/\s+/g, " ").slice(0, 800)}${tools}`;
  });
  if (lines.join("\n").length <= limit) return lines.join("\n");
  const head: string[] = [], tail: string[] = [];
  let room = limit - 60, front = 0, back = lines.length - 1, fromFront = true;
  while (front <= back) {
    const next = fromFront ? lines[front]! : lines[back]!;
    if (next.length + 1 > room) break;
    room -= next.length + 1;
    if (fromFront) head.push(lines[front++]!); else tail.unshift(lines[back--]!);
    fromFront = !fromFront;
  }
  return [...head, `(${back - front + 1} message(s) in the middle left out)`, ...tail].join("\n");
}

/** How many of a conversation's messages are the owner's own turns. */
export const ownerTurns = (messages: Message[]): number => messages.filter((message) => message.role === "user" && message.from !== "branch").length;

/**
 * A finished task the owner asked for: not one the learning passes made to hold their own calls,
 * and not a sub-task some other task handed off (the drafting calls themselves are those).
 */
export function ownersTask(store: Store, run: Run): boolean {
  if (run.status !== "completed" || !run.prompt.trim() || run.prompt.startsWith(learningTaskPrefix)) return false;
  const started = store.events(run.id).find((event) => event.kind === "run.started");
  return !(started?.data as { parentRunId?: string | null } | undefined)?.parentRunId;
}

const words = (text: string): Set<string> =>
  new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 4));

/**
 * Up to `limit` finished tasks whose request shares at least two longer words with `about`,
 * best match first, never the task the draft came from. Only the last 100 tasks are looked at.
 */
export function similarTasks(store: Store, owner: string, about: string, excludeRunId: string, limit = 2): TrialTask[] {
  const wanted = words(about);
  return store.runs(owner)
    .filter((run) => run.id !== excludeRunId && !run.prompt.startsWith("/") && ownersTask(store, run))
    .map((run) => ({ run, shared: [...words(run.prompt)].filter((word) => wanted.has(word)).length }))
    .filter((entry) => entry.shared >= 2)
    .sort((a, b) => b.shared - a.shared)
    .slice(0, limit)
    .map(({ run }) => ({ prompt: run.prompt.slice(0, 4000), runId: run.id }));
}
