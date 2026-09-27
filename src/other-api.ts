import type { IncomingMessage } from "node:http";
import { z } from "zod";
import { openApiDocument } from "./api-openapi.js";
import { lockdownState, setLockdown } from "./lockdown.js";
import { cacheSettings, saveCacheSettings } from "./request-cache.js";
import { batchSettings, saveBatchSettings, runBatch, supportsBatch, type BatchQuestion } from "./batch-inference.js";
import { costByProject } from "./project-ledger.js";
import { chatEngineSettings, saveChatEngineSettings } from "./chat-engine.js"; // w911 (A0847)
import type { createBranch } from "./index.js";
import { lockdownOffHereOnly, throughADoor } from "./remote/window-key.js";

/**
 * The routes for the long tail of this wave: the app's own description of its web API, the one
 * Lockdown switch, the two settings behind keeping answers and handing whole sets over at once, and
 * what each project has cost. They live here so the main route file stays readable.
 */
type Branch = Awaited<ReturnType<typeof createBranch>>;
export class OtherApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
const notFound = (): never => { throw new OtherApiError(404, "Endpoint not found"); };

/** Every path this file answers, so the main route file can hand them over in one line. */
export function handlesOtherPath(path: string): boolean {
  return /^\/api\/(openapi\.json|lockdown|request-cache|batch|chat-engine)(\/|$)/.test(path)
    || path === "/api/projects/costs";
}

export async function otherApi(
  app: Branch, request: IncomingMessage, path: string,
  readBody: (request: IncomingMessage, maximumBytes?: number) => Promise<unknown>,
): Promise<unknown> {
  const owner = app.runtime.owner;
  // The description of the app's own API is the only thing here anybody may simply read; the rest
  // change what the assistant may do, or say what it has spent, and both belong to the owner.
  if (path === "/api/openapi.json")
    return request.method === "GET" ? openApiDocument(app.version) : notFound();
  app.store.profiles.requireOwner("Lockdown, kept answers and what each project has cost");
  if (path === "/api/lockdown") return lockdownApi(app, request, owner, readBody);
  if (path === "/api/request-cache") return cacheApi(app, request, owner, readBody);
  if (path === "/api/request-cache/clear")
    return request.method === "POST" ? app.runtime.requestCache.clear() : notFound();
  if (path === "/api/batch") return batchApi(app, request, owner, readBody);
  if (path === "/api/batch/run") return batchRunApi(app, request, owner, readBody);
  if (path === "/api/projects/costs") return costsApi(app, request, owner);
  // w911 (A0847) hook: making a follow-up whole before the documents are searched.
  if (path === "/api/chat-engine")
    return request.method === "POST" ? saveChatEngineSettings(app.store, owner, await readBody(request)) : chatEngineSettings(app.store, owner);
  return notFound();
}

/**
 * Turning Lockdown on also ends every "yes, just for this conversation" given earlier. Without that,
 * a tool already said yes to would keep going without asking, because an answer given earlier stands
 * in for the question — and the whole point of the switch is that nothing goes ahead unasked.
 */
async function lockdownApi(
  app: Branch, request: IncomingMessage, owner: string,
  readBody: (request: IncomingMessage) => Promise<unknown>,
): Promise<unknown> {
  if (request.method !== "POST") return lockdownState(app.store, owner);
  const body = await readBody(request);
  // Switching Lockdown off is this computer's window's alone: a phone (its own key, or the paired door) and any
  // caller beyond this computer may switch it on and never off (src/remote/window-key.ts).
  if (throughADoor(request) && lockdownState(app.store, owner).on && (body as { on?: unknown } | null)?.on === false)
    throw new OtherApiError(403, lockdownOffHereOnly);
  const state = setLockdown(app.store, owner, body);
  if (state.on) app.runtime.approvals.forgetAll();
  app.wake.refresh(); // mac7/wake-mic: Lockdown coming on stops the listener and lets go of the microphone
  return state;
}

async function cacheApi(
  app: Branch, request: IncomingMessage, owner: string,
  readBody: (request: IncomingMessage) => Promise<unknown>,
): Promise<unknown> {
  if (request.method === "POST") {
    const settings = saveCacheSettings(app.store, owner, await readBody(request));
    return { settings, ...app.runtime.requestCache.summary() };
  }
  return { settings: cacheSettings(app.store, owner), ...app.runtime.requestCache.summary() };
}

async function batchApi(
  app: Branch, request: IncomingMessage, owner: string,
  readBody: (request: IncomingMessage) => Promise<unknown>,
): Promise<unknown> {
  const settings = request.method === "POST"
    ? saveBatchSettings(app.store, owner, await readBody(request)) : batchSettings(app.store, owner);
  return {
    settings,
    connections: [...app.runtime.models.presets.values()].map((preset) => ({
      id: preset.id, name: preset.name, takesWholeSets: supportsBatch(preset.provider),
    })),
  };
}

const BatchRunSchema = z.object({
  /** Which connection to ask; left out, whichever one would normally answer. */
  preset: z.string().min(1).max(64).optional(),
  questions: z.array(z.object({
    id: z.string().min(1).max(120),
    prompt: z.string().trim().min(1).max(16000),
    maxTokens: z.number().int().min(1).max(8192).optional(),
  }).strict()).min(1).max(200),
}).strict();

/** Hands a whole set of questions over at once, or asks them one at a time when it cannot. */
async function batchRunApi(
  app: Branch, request: IncomingMessage, owner: string,
  readBody: (request: IncomingMessage) => Promise<unknown>,
): Promise<unknown> {
  if (request.method !== "POST") return notFound();
  const input = BatchRunSchema.parse(await readBody(request));
  const preset = input.preset ? app.runtime.models.presets.get(input.preset) : app.runtime.models.default;
  if (!preset) throw new OtherApiError(400, "There is no connection with that name.");
  const questions: BatchQuestion[] = input.questions.map((question) => ({
    id: question.id, messages: [{ role: "user", content: question.prompt }],
    ...(question.maxTokens === undefined ? {} : { maxTokens: question.maxTokens }),
  }));
  return runBatch(app.store, owner, preset, questions, AbortSignal.timeout(150000));
}

function costsApi(app: Branch, request: IncomingMessage, owner: string): unknown {
  if (request.method !== "GET") return notFound();
  const days = Number(new URL(request.url ?? "/", "http://local").searchParams.get("days") ?? 30);
  return { projects: costByProject(app.store, owner, Number.isFinite(days) && days > 0 ? Math.min(days, 365) : 30) };
}
