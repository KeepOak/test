import { z } from "zod";
import type { Autonomy } from "./index.js";
import type { EntryKind } from "./ledger.js";
import { catalogue } from "./blueprints.js";
import {
  AutonomyModeSchema, AutonomyOffError, AutonomyPartSchema, autonomyLabels, autonomyLimits, autonomyParts, requirePart,
  saveAutonomyLimits, type AutonomyPart,
} from "./settings.js";

/**
 * The web side of R17-B: the owner's routes under /api/autonomy/. The server checks the owner's own
 * profile before any of them, and a short-lived key is refused every change here by the fail-closed
 * rule in src/short-lived-keys.ts. Reads answer whatever the switches say; every change needs its
 * part switched on, except the switches themselves, the limits, and answering what already waits.
 */
export const handlesAutonomyPath = (path: string): boolean => path === "/api/autonomy" || path.startsWith("/api/autonomy/");

export class AutonomyHttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export interface AutonomyHttpDeps {
  autonomy: Autonomy;
  method: string;
  query: URLSearchParams;
  readBody: () => Promise<unknown>;
}

const SwitchBody = z.object({ part: AutonomyPartSchema, mode: AutonomyModeSchema }).strict();
const AnswerBody = z.object({ fingerprint: z.string().regex(/^[a-f0-9]{24}$/), yes: z.boolean() }).strict();
const DecideBody = z.object({ id: z.string().uuid(), yes: z.boolean() }).strict();
const chat = z.object({ channel: z.string().min(1).max(64), chatId: z.string().min(1).max(64) }).strict();
const BlueprintBody = z.object({
  blueprint: z.string().min(1).max(60), values: z.record(z.string().max(20), z.string().max(300)).default({}),
  timezone: z.string().min(1).max(64).optional(), deliverTo: chat.optional(),
}).strict();
const LoopStop = z.object({ kind: z.enum(["loop", "heartbeat"]), sessionId: z.string().uuid() }).strict();
const IdBody = z.object({ id: z.string().uuid() }).strict();
const itemRoute = /^\/api\/autonomy\/(orders|procedures)\/([a-f0-9-]{36})\/(pause|resume|remove|run|update)$/;
/** The owner's changed steps (and start) for a kept procedure, as a question that waits for the same yes a new one does. */
const changeRoute = /^\/api\/autonomy\/procedures\/([a-f0-9-]{36})\/propose$/;

/** Which switch an answer belongs to, so a part switched off since cannot be fed by an old question. */
const partOf: Record<EntryKind, AutonomyPart> = {
  schedule: "suggestions", order: "orders", procedure: "procedures", instruction: "instructions",
  start: "procedures", step: "procedures", escalation: "orders",
};

function overview(autonomy: Autonomy) {
  return {
    modes: autonomy.modes(), labels: autonomyLabels, parts: autonomyParts,
    limits: autonomyLimits(autonomy.store, autonomy.owner), waiting: autonomy.ledger.list("pending"),
  };
}

async function top(deps: AutonomyHttpDeps, path: string): Promise<unknown> {
  const { autonomy } = deps, post = deps.method === "POST";
  const need = (part: AutonomyPart): void => requirePart(autonomy.store, autonomy.owner, part);
  if (path === "/api/autonomy") return overview(autonomy);
  if (path === "/api/autonomy/switch" && post) {
    const { part, mode } = SwitchBody.parse(await deps.readBody());
    return { part, mode: autonomy.setMode(part, { mode }) };
  }
  if (path === "/api/autonomy/limits" && post) return { limits: saveAutonomyLimits(autonomy.store, autonomy.owner, await deps.readBody()) };
  if (path === "/api/autonomy/ledger")
    return { entries: autonomy.ledger.list(z.enum(["pending", "accepted", "dismissed", "all"]).parse(deps.query.get("status") ?? "pending")) };
  if (path === "/api/autonomy/decide" && post) {
    const { id, yes } = DecideBody.parse(await deps.readBody());
    const entry = autonomy.ledger.get(id);
    if (entry && yes) need(partOf[entry.kind]);
    return autonomy.decide(id, yes);
  }
  if (path === "/api/autonomy/suggestions") {
    if (!post) return { suggestions: autonomy.mode("suggestions") === "off" ? [] : autonomy.suggestions(deps.query.get("starters") === "1"), catalogue: catalogue() };
    need("suggestions");
    const { fingerprint, yes } = AnswerBody.parse(await deps.readBody());
    return autonomy.answerSuggestion(fingerprint, yes);
  }
  if (path === "/api/autonomy/blueprints" && post) {
    need("suggestions");
    return { schedule: autonomy.fromBlueprint(BlueprintBody.parse(await deps.readBody())) };
  }
  return undefined;
}

async function kept(deps: AutonomyHttpDeps, path: string): Promise<unknown> {
  const { autonomy } = deps, post = deps.method === "POST";
  const need = (part: AutonomyPart): void => requirePart(autonomy.store, autonomy.owner, part);
  if (path === "/api/autonomy/orders") {
    if (!post) return { orders: autonomy.orders.list() };
    need("orders");
    return { order: autonomy.orders.create(await deps.readBody()) };
  }
  if (path === "/api/autonomy/procedures") {
    if (!post) return { procedures: autonomy.procedures.list() };
    need("procedures");
    return { procedure: autonomy.procedures.create(await deps.readBody()) };
  }
  if (path === "/api/autonomy/loops") return { loops: autonomy.loops.list() };
  if (path === "/api/autonomy/loops/stop" && post) {
    const { kind, sessionId } = LoopStop.parse(await deps.readBody());
    return { loop: autonomy.loops.change(kind, sessionId, "stop") };
  }
  if (path === "/api/autonomy/instructions") {
    if (!post) return { instructions: autonomy.instructions.list() };
    need("instructions");
    return { instruction: autonomy.instructions.add(await deps.readBody()) };
  }
  if (path === "/api/autonomy/instructions/remove" && post) return autonomy.instructions.remove(IdBody.parse(await deps.readBody()).id);
  if (path === "/api/autonomy/readiness") return { skills: autonomy.mode("readiness") === "off" ? [] : autonomy.readiness() };
  return undefined;
}

async function item(deps: AutonomyHttpDeps, path: string): Promise<unknown> {
  const change = changeRoute.exec(path);
  if (change && deps.method === "POST") {
    requirePart(deps.autonomy.store, deps.autonomy.owner, "procedures");
    return deps.autonomy.procedures.proposeChange(change[1]!, await deps.readBody());
  }
  const match = itemRoute.exec(path);
  if (!match || deps.method !== "POST") return undefined;
  const { autonomy } = deps;
  const [, kind, id, action] = match as unknown as [string, "orders" | "procedures", string, string];
  if (action === "remove") return kind === "orders" ? autonomy.orders.remove(id) : autonomy.procedures.remove(id);
  requirePart(autonomy.store, autonomy.owner, kind);
  if (kind === "orders") {
    if (action === "run") return autonomy.orders.fire(id);
    if (action === "pause" || action === "resume") return { order: autonomy.orders.setPaused(id, action === "pause") };
    return undefined;
  }
  if (action === "run") return autonomy.procedures.trigger(id, "you started it");
  if (action === "pause" || action === "resume") return { procedure: autonomy.procedures.update(id, { paused: action === "pause" }) };
  return { procedure: autonomy.procedures.update(id, await deps.readBody()) };
}

export async function autonomyApi(deps: AutonomyHttpDeps, path: string): Promise<unknown> {
  try {
    const answer = (await top(deps, path)) ?? (await kept(deps, path)) ?? (await item(deps, path));
    if (answer === undefined) throw new AutonomyHttpError(404, "Not found");
    return answer;
  } catch (error) {
    if (error instanceof AutonomyHttpError) throw error;
    if (error instanceof AutonomyOffError) throw new AutonomyHttpError(409, error.message);
    if (error instanceof z.ZodError) throw new AutonomyHttpError(400, error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; "));
    throw new AutonomyHttpError(400, error instanceof Error ? error.message : String(error));
  }
}
