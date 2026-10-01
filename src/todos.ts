import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { ToolContext } from "./contracts.js";
import type { ToolRegistry } from "./registry.js";
import type { Scheduler } from "./scheduler.js";
import { accessAgent } from "./trunks/memory-scope.js";

/**
 * A plain list of things still to do. The assistant writes its plan down here as it works, so a
 * long piece of work has one place that says what is left rather than the owner reading back
 * through a conversation; and the owner can put something on the list themselves.
 *
 * Nothing clever: a line of words, who put it there, whether it is done, and an optional day it is
 * wanted by. A due day can be handed to the schedules, which is where anything that has to happen
 * at a time already lives — the to-do list does not grow a clock of its own.
 */
export const todoSources = ["owner", "assistant"] as const;
export const TodoSchema = z.object({
  /** What is to be done, in the owner's own words. */
  text: z.string().trim().min(1).max(300),
  /** When it is wanted by. A moment, so the schedules can use it unchanged. */
  dueAt: z.iso.datetime().optional(),
  /** Which task or conversation this came out of, so a finished plan can be found again. */
  runId: z.string().uuid().optional(),
}).strict();
export type TodoInput = z.infer<typeof TodoSchema>;
export interface Todo {
  id: string; text: string; done: boolean; source: "owner" | "assistant";
  dueAt: string | null; runId: string | null; createdAt: string; doneAt: string | null;
}
/** How many open items the list holds. Past this it is a project, not a to-do list. */
export const maximumOpenTodos = 200;

const row = (record: Record<string, unknown>): Todo => ({
  id: String(record.id), text: String(record.text), done: Number(record.done) === 1,
  source: record.source === "assistant" ? "assistant" : "owner",
  dueAt: (record.due_at as string | null) ?? null, runId: (record.run_id as string | null) ?? null,
  createdAt: String(record.created_at), doneAt: (record.done_at as string | null) ?? null,
});

export class Todos {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS todos(id TEXT PRIMARY KEY, owner TEXT NOT NULL,
      text TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL,
      due_at TEXT, run_id TEXT, created_at TEXT NOT NULL, done_at TEXT);
      CREATE INDEX IF NOT EXISTS todos_owner ON todos(owner, done);`);
  }
  /** Everything on the list, what is still open first, then by when it is wanted. */
  list(owner: string, options: { includeDone?: boolean } = {}): Todo[] {
    const sql = "SELECT * FROM todos WHERE owner=?" + (options.includeDone ? "" : " AND done=0")
      + " ORDER BY done ASC, COALESCE(due_at,'9999') ASC, created_at ASC LIMIT 400";
    return this.db.prepare(sql).all(owner).map(row);
  }
  add(owner: string, input: unknown, source: "owner" | "assistant" = "owner"): Todo {
    const value = TodoSchema.parse(input);
    if (this.list(owner).length >= maximumOpenTodos)
      throw new Error(`The list already holds ${maximumOpenTodos} things to do. Tick some off first.`);
    const entry: Todo = { id: randomUUID(), text: value.text, done: false, source,
      dueAt: value.dueAt ?? null, runId: value.runId ?? null,
      createdAt: new Date().toISOString(), doneAt: null };
    this.db.prepare("INSERT INTO todos(id,owner,text,done,source,due_at,run_id,created_at,done_at) VALUES(?,?,?,0,?,?,?,?,NULL)")
      .run(entry.id, owner, entry.text, source, entry.dueAt, entry.runId, entry.createdAt);
    return entry;
  }
  /** Ticks one off, or puts it back. Asking twice for the same answer changes nothing. */
  done(owner: string, id: string, done = true): Todo {
    const at = done ? new Date().toISOString() : null;
    const changed = this.db.prepare("UPDATE todos SET done=?, done_at=? WHERE owner=? AND id=?")
      .run(done ? 1 : 0, at, owner, id).changes;
    if (!changed) throw new Error("There is nothing on the list with that number");
    return row(this.db.prepare("SELECT * FROM todos WHERE owner=? AND id=?").get(owner, id) as Record<string, unknown>);
  }
  remove(owner: string, id: string): { removed: string } {
    if (!this.db.prepare("DELETE FROM todos WHERE owner=? AND id=?").run(owner, id).changes)
      throw new Error("There is nothing on the list with that number");
    return { removed: id };
  }
  /**
   * Replaces whatever the assistant put on the list for one task with the plan it has now. The
   * owner's own items are never touched: this is the assistant tidying up after itself.
   */
  setPlan(owner: string, runId: string, steps: string[]): Todo[] {
    this.db.prepare("DELETE FROM todos WHERE owner=? AND run_id=? AND source='assistant' AND done=0").run(owner, runId);
    return steps.slice(0, 20).map((text) => this.add(owner, { text: text.slice(0, 300), runId }, "assistant"));
  }
}

/**
 * A to-do with a day on it becomes a reminder in the schedules, which is where everything that
 * happens at a time already lives. The words travel unchanged, so the reminder reads as the item.
 */
export function remindAbout(scheduler: Scheduler, context: ToolContext, todo: Todo): { scheduleId: string } {
  if (!todo.dueAt) throw new Error("That item has no day on it, so there is nothing to remind you about");
  const saved = scheduler.create(context, { prompt: todo.text, dueAt: todo.dueAt, kind: "reminder" });
  return { scheduleId: saved.id };
}

/**
 * FQ-routing.isolated-agents: the to-do list is the owner's one list, with no scope of its own, so a
 * Trunk or delegated specialist (any turn with an agent) is refused before it reads or changes it.
 */
const ownersListOnly = "The to-do list belongs to the owner, so only the owner's own tasks can read or change it. Keep your own notes with memory.put instead.";
function ownerOnly(context: ToolContext): void {
  if (accessAgent(context)) throw new Error(ownersListOnly); // Q123: a Trunk's workflow step too
}

export function registerTodos(registry: ToolRegistry, todos: Todos, owner: string): void {
  registry.register({
    name: "todos.list", permission: "memory.read",
    description: "The things still to be done, with the day each is wanted by.",
    parameters: z.object({ includeDone: z.boolean().default(false) }).strict(),
    execute: async (input, context: ToolContext) => {
      ownerOnly(context);
      return { todos: todos.list(owner, { includeDone: input.includeDone }) };
    },
  });
  registry.register({
    name: "todos.add", permission: "memory.write",
    description: "Write one thing on the to-do list, so a plan stays where the owner can see it.",
    parameters: TodoSchema,
    execute: async (input, context: ToolContext) => {
      ownerOnly(context);
      return todos.add(owner, { ...input, ...(context.runId ? { runId: context.runId } : {}) }, "assistant");
    },
  });
  registry.register({
    name: "todos.done", permission: "memory.write",
    description: "Tick one thing off the to-do list, or put it back on.",
    parameters: z.object({ id: z.string().uuid(), done: z.boolean().default(true) }).strict(),
    execute: async (input, context: ToolContext) => {
      ownerOnly(context);
      return todos.done(owner, input.id, input.done);
    },
  });
}

/** The routes behind the to-do card. Returns null for any path that is not one of them. */
export async function todosApi(
  todos: Todos, owner: string, request: { method?: string | undefined }, path: string,
  body: () => Promise<unknown>,
  remind: (todo: Todo) => { scheduleId: string },
  current: () => void = () => undefined,
): Promise<unknown | null> {
  current();
  const method = request.method ?? "GET";
  if (path === "/api/todos") {
    if (method === "GET") return { todos: todos.list(owner, { includeDone: true }) };
    if (method === "POST") {
      const input = await body();
      current();
      return todos.add(owner, input, "owner");
    }
    return null;
  }
  const match = /^\/api\/todos\/([a-f0-9-]{36})(?:\/(done|remind))?$/.exec(path);
  if (!match) return null;
  const id = match[1]!;
  if (method === "DELETE" && !match[2]) return todos.remove(owner, id);
  if (method === "POST" && match[2] === "done") {
    const wanted = z.object({ done: z.boolean().default(true) }).strict().parse(await body().catch(() => ({})));
    current();
    return todos.done(owner, id, wanted.done);
  }
  if (method === "POST" && match[2] === "remind") {
    const found = todos.list(owner, { includeDone: true }).find((entry) => entry.id === id);
    if (!found) throw new Error("There is nothing on the list with that number");
    return remind(found);
  }
  return null;
}
