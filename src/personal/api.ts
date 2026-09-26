import { z, ZodError } from "zod";
import { errorText } from "../contracts.js";
import { argumentFingerprint, type Runtime } from "../runtime.js";
import { gateRefusal } from "../tool-gate.js";
import type { Personal } from "./index.js";
import { PersonalOffError, PersonalPartSchema, personalLabels, personalParts, requirePersonal, type PersonalPart } from "./settings.js";

/**
 * The web side of R17-C: the owner's routes under /api/personal/. They sit behind the same key and
 * host rules as everything else, and are the owner's alone: a short-lived key is refused every
 * change by the fail-closed rule in src/short-lived-keys.ts, and every read by its owner-only list,
 * because what they return is the owner's mail, calendar and public webhook address. A route that
 * runs one of these parts' tools runs it through `Runtime.executeTool`, so the one tool gate
 * (src/tool-gate.ts) decides it. Playing the briefing needs the sound itself, which a tool answer
 * cannot carry, so that route asks the same gate about `brief.spoken` first (integration review).
 */
export const handlesPersonalPath = (path: string): boolean => path === "/api/personal" || path.startsWith("/api/personal/");

export class PersonalHttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export interface PersonalHttpDeps {
  personal: Personal;
  runtime: Runtime;
  method: string;
  readBody: () => Promise<unknown>;
}

const SwitchSchema = z.object({ part: PersonalPartSchema, mode: z.enum(["off", "when-needed", "on"]) }).strict();

/** A tool of one of these parts, pressed by the owner: the part must be on, and the gate decides. */
async function runPartTool(deps: PersonalHttpDeps, part: PersonalPart, tool: string): Promise<unknown> {
  requirePersonal(deps.runtime.store, deps.runtime.owner, part);
  return deps.runtime.executeTool(tool, await deps.readBody(), { mode: "owner" });
}

/** Settings a part keeps, read with GET and changed with POST. */
async function settingsRoute(deps: PersonalHttpDeps, part: { settings(): unknown; save(input: unknown): unknown }): Promise<unknown> {
  return { settings: deps.method === "POST" ? part.save(await deps.readBody()) : part.settings() };
}

const signInPath = /^\/api\/personal\/signin\/(google|microsoft|spotify)(\/start)?$/;
async function signInRoute(deps: PersonalHttpDeps, path: string): Promise<unknown> {
  const match = signInPath.exec(path);
  if (!match) return undefined;
  const service = match[1] as "google" | "microsoft" | "spotify";
  const signIn = deps.personal.signIns[service];
  if (match[2]) {
    if (deps.method !== "POST") return undefined;
    requirePersonal(deps.runtime.store, deps.runtime.owner, signIn.part);
    return signIn.start();
  }
  const settings = deps.method === "POST" ? signIn.save(await deps.readBody()) : signIn.settings();
  return { settings, status: await signIn.status() };
}

const toolRoutes: Record<string, [PersonalPart, string]> = {
  "/api/personal/x/search": ["x-search", "x.search"],
  "/api/personal/home/states": ["home-control", "home.states"],
  "/api/personal/chat-files/send": ["chat-files", "chat.send_file"],
  "/api/personal/mail/search": ["mail-search", "mail.search"],
  "/api/personal/spotify/now": ["spotify", "spotify.now"],
  "/api/personal/google/events": ["google", "gcal.events"],
  "/api/personal/microsoft/events": ["microsoft", "outlook.events"],
};

async function tunnelRoute(deps: PersonalHttpDeps, path: string): Promise<unknown> {
  const { tunnel } = deps.personal, post = deps.method === "POST";
  if (path === "/api/personal/tunnel") return { ...(await settingsRoute(deps, tunnel) as object), status: tunnel.status() };
  if (path === "/api/personal/tunnel/start" && post) return tunnel.start();
  if (path === "/api/personal/tunnel/stop" && post) return tunnel.stop();
  return undefined;
}

/** The briefing, spoken, once the tool gate has said yes to `brief.spoken` for the owner at the window. */
async function playBrief(deps: PersonalHttpDeps): Promise<unknown> {
  const { personal, runtime } = deps;
  requirePersonal(runtime.store, runtime.owner, "spoken-brief");
  const refused = gateRefusal(runtime, "brief.spoken", {}, runtime.context({}), argumentFingerprint("brief.spoken", "{}"), "owner");
  if (refused) throw new PersonalHttpError(403, refused);
  const { text, audio } = await personal.brief.run({});
  return { text, mediaType: audio.mediaType, audio: Buffer.from(audio.bytes).toString("base64") };
}

async function voiceRoute(deps: PersonalHttpDeps, path: string): Promise<unknown> {
  const { personal } = deps;
  if (deps.method !== "POST") return undefined;
  if (path === "/api/personal/voice/offer") return personal.voiceApprovals.offer(await deps.readBody());
  if (path === "/api/personal/voice/answer") return personal.voiceApprovals.answer(await deps.readBody());
  if (path === "/api/personal/voice/confirm") return personal.voiceApprovals.confirm(await deps.readBody());
  if (path === "/api/personal/brief/play") return playBrief(deps);
  return undefined;
}

async function route(deps: PersonalHttpDeps, path: string): Promise<unknown> {
  const { personal, method } = deps, post = method === "POST";
  if (path === "/api/personal") return { modes: personal.modes(), labels: personalLabels, parts: personalParts };
  if (path === "/api/personal/switch" && post) {
    const { part, mode } = SwitchSchema.parse(await deps.readBody());
    return { part, mode: await personal.setMode(part, { mode }) };
  }
  const tool = toolRoutes[path];
  if (tool && post) return runPartTool(deps, tool[0], tool[1]);
  if (path.startsWith("/api/personal/signin/")) return signInRoute(deps, path);
  const parts: Record<string, { settings(): unknown; save(input: unknown): unknown }> = {
    "/api/personal/x": personal.x, "/api/personal/home": personal.home, "/api/personal/chat-files": personal.chatFiles,
    "/api/personal/mail": personal.mail, "/api/personal/brief": personal.brief,
  };
  if (parts[path]) return settingsRoute(deps, parts[path]);
  if (path.startsWith("/api/personal/tunnel")) return tunnelRoute(deps, path);
  return voiceRoute(deps, path);
}

/** Answers one request under /api/personal/, or throws a PersonalHttpError with a status and a sentence. */
export async function personalApi(deps: PersonalHttpDeps, path: string): Promise<unknown> {
  try {
    const answer = await route(deps, path);
    if (answer === undefined) throw new PersonalHttpError(404, "Endpoint not found");
    return answer;
  } catch (error) {
    if (error instanceof PersonalHttpError) throw error;
    const status = error instanceof PersonalOffError ? 409 : error instanceof ZodError ? 400
      : /not found|no .* with that/i.test(errorText(error)) ? 404 : 400;
    const message = error instanceof ZodError ? (error.issues[0]?.message ?? "The request was not in the expected shape") : errorText(error);
    throw new PersonalHttpError(status, deps.runtime.hideSecrets(message));
  }
}
