import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Store } from "./store.js";
import type { ToolRegistry } from "./registry.js";

/**
 * Some things do not finish inside a tool call: a long upload, a person who has to do something by
 * hand, a service that will call back later. A tool may answer `{ deferred: true, id }` instead of a
 * result. The task carries on without it, the job is written down, and when the answer arrives it
 * comes back into the conversation as an ordinary follow-up message, so nothing is left hanging.
 */
export type DeferredKind = "service" | "manual" | "signing" | "later";
export type DeferredAction = "stop" | "done" | "signed" | "finish";
export interface Deferral {
  id: string; runId: string; sessionId: string; tool: string; description: string;
  kind: DeferredKind;
  createdAt: string; settledAt: string | null; outcome: string | null;
}
/** What the runtime looks for in a tool's answer: `{ deferred: true }`, with an optional id. */
export function deferredCall(result: unknown): { id: string; description: string; kind?: DeferredKind } | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const value = result as { deferred?: unknown; id?: unknown; description?: unknown; kind?: unknown };
  if (value.deferred !== true) return null;
  const id = typeof value.id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value.id) ? value.id : randomUUID();
  const kind = value.kind === undefined ? undefined : z.enum(["service", "manual", "signing", "later"]).parse(value.kind);
  return { id, description: String(value.description ?? "").slice(0, 500), ...(kind ? { kind } : {}) };
}

/** Old saved jobs keep their existing action; new producers declare a kind explicitly. */
export function deferredKind(entry: { tool: string; kind?: DeferredKind }): DeferredKind {
  return entry.kind ?? (["user.task", "web.page", "web.crawl"].includes(entry.tool) ? "manual" : "service");
}

/** The UI sends an action, never a translated outcome or a claim that a service completed. */
export function deferredOutcome(entry: Deferral, outcome: string | undefined, action?: DeferredAction): string {
  if (!action) {
    if (!outcome?.trim()) throw new Error("Say what came of the handed-over step");
    return outcome.trim().slice(0, 4000);
  }
  const expected: Record<DeferredKind, DeferredAction> = { service: "stop", manual: "done", signing: "signed", later: "finish" };
  if (expected[entry.kind] !== action) throw new Error("That action does not match this handed-over step");
  const words: Record<DeferredAction, string> = {
    stop: "The person stopped waiting. No completion was confirmed.",
    done: "The person reports that they did the manual step.",
    signed: "The person reports that they signed it. Branch did not perform or verify the signing.",
    finish: "The person asked to continue the work set aside for later now. It is still unfinished.",
  };
  return words[action];
}

export function deferredFollowUp(entry: Deferral, action?: DeferredAction): string {
  const description = entry.description ? ` (${entry.description})` : "";
  const status = action === "finish" ? "is ready to continue now" : action === "stop" ? "is no longer being waited on" : "has an answer";
  return `The "${entry.tool}" step you handed over earlier${description} ${status}. What came of it: ${entry.outcome}`;
}

export class Deferrals {
  constructor(private readonly store: Store, private readonly owner: string) {}
  private key(id: string): string { return `deferred:${id}`; }
  open(entry: Omit<Deferral, "createdAt" | "settledAt" | "outcome" | "kind"> & { kind?: DeferredKind }): Deferral {
    const full: Deferral = { ...entry, kind: deferredKind(entry), createdAt: new Date().toISOString(), settledAt: null, outcome: null };
    this.store.save("settings", this.owner, this.key(full.id), { ...full });
    return full;
  }
  get(id: string): Deferral | undefined {
    const entry = this.store.get("settings", this.owner, this.key(id))?.data as unknown as Deferral | undefined;
    return entry ? { ...entry, kind: deferredKind(entry) } : undefined;
  }
  /** Everything handed over, newest first; `waiting` leaves out the ones already answered. */
  list(options: { waiting?: boolean } = {}): Deferral[] {
    return this.store.list("settings", this.owner).filter((row) => row.id.startsWith("deferred:"))
      .map((row) => { const entry = row.data as unknown as Deferral; return { ...entry, kind: deferredKind(entry) }; })
      .filter((entry) => !options.waiting || entry.settledAt === null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  /** Marks one as answered and gives back what it was, so the runtime can carry the answer in. */
  settle(id: string, outcome: string): Deferral {
    const entry = this.get(id);
    if (!entry) throw new Error("There is no handed-over job with that number");
    if (entry.settledAt) throw new Error("That job has already been answered");
    const settled: Deferral = { ...entry, settledAt: new Date().toISOString(), outcome: outcome.slice(0, 4000) };
    this.store.save("settings", this.owner, this.key(id), { ...settled });
    return settled;
  }
}

export const SettleDeferredSchema = z.union([
  z.object({ id: z.string().min(1).max(64), outcome: z.string().trim().min(1).max(4000), action: z.undefined().optional() }).strict(),
  z.object({ id: z.string().min(1).max(64), action: z.enum(["stop", "done", "signed", "finish"]), outcome: z.undefined().optional() }).strict(),
]);

/**
 * A job for a person: the assistant hands it over and carries on, and the owner says what came of
 * it in the app. It is the plainest example of a deferred call, and what it does is what any other
 * deferring tool does.
 */
export function registerHumanTasks(registry: ToolRegistry): void {
  const manualTask = z.object({ description: z.string().trim().min(1).max(500) }).strict();
  registry.register({
    name: "user.task", permission: "user.ask", group: "core",
    description: "Hand something to the person to do themselves (sign in somewhere, post a letter, check a machine). You are not made to wait: the task carries on without it, and their answer arrives as a new message in this conversation when they have done it.",
    // Keep the original core API size. Earlier recorded calls may still supply kind;
    // new typed handoffs are discovered through the non-core deferred tool below.
    inputSchema: z.toJSONSchema(manualTask),
    parameters: z.object({ description: z.string().trim().min(1).max(500), kind: z.enum(["manual", "signing"]).default("manual") }).strict(),
    execute: async ({ description, kind }) => ({ deferred: true as const, description, kind }),
  });
  registry.register({
    name: "user.later", permission: "user.ask", group: "agents",
    description: "Record a signing handoff or unfinished work for later. Branch never signs or verifies a signature. Later work stays pending until Finish now; do not do it now. This schedules no time or permissions.",
    parameters: z.object({ description: z.string().trim().min(1).max(500), kind: z.enum(["signing", "later"]).default("later") }).strict(),
    execute: async ({ description, kind }) => ({ deferred: true as const, description, kind }),
  });
}
