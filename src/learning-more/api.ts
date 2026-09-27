import { z, ZodError } from "zod";
import { errorText } from "../contracts.js";
import type { Runtime } from "../runtime.js";
import type { LearningMore } from "./index.js";
import { journey } from "./journey.js";
import { LearningOffError, LearningPartSchema, learningLabels, learningParts } from "./settings.js";
import { validationText } from "../request-errors.js";

/**
 * The web side of R17-F: the owner's routes under /api/learning-more/. They sit behind the same key
 * and host rules as everything else, the server lets only the owner's profile in, and every change
 * is refused to a short-lived key (src/short-lived-keys.ts), except the two searches, which only look.
 *
 * Every route is listed here so the route guard (tests/short-lived-key-routes.mjs) can see it.
 */
export const learningMoreRoutes = {
  view: "/api/learning-more", switch: "/api/learning-more/switch",
  blocks: "/api/learning-more/blocks", blockEdit: "/api/learning-more/blocks/edit", blockRemove: "/api/learning-more/blocks/remove",
  curator: "/api/learning-more/curator", dryRun: "/api/learning-more/curator/dry-run", merge: "/api/learning-more/curator/merge",
  journey: "/api/learning-more/journey", search: "/api/learning-more/search",
  lessons: "/api/learning-more/lessons", lessonsForget: "/api/learning-more/lessons/forget",
  lessonsDecide: "/api/learning-more/lessons/decide",
  sessions: "/api/learning-more/sessions", scan: "/api/learning-more/sessions/scan",
  keep: "/api/learning-more/sessions/keep", decline: "/api/learning-more/sessions/decline",
  tags: "/api/learning-more/memory/tags", find: "/api/learning-more/memory/find", label: "/api/learning-more/memory/label",
  readBack: "/api/learning-more/readback", tidy: "/api/learning-more/readback/tidy",
  providers: "/api/learning-more/providers",
} as const;
export const handlesLearningMorePath = (path: string): boolean => path === learningMoreRoutes.view || path.startsWith(`${learningMoreRoutes.view}/`);

export class LearningMoreHttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export interface LearningMoreHttpDeps {
  more: LearningMore; runtime: Runtime; method: string; query: URLSearchParams;
  readBody: () => Promise<unknown>;
  /** The memory scope of whoever is asking; the server lets only the owner in, so this is the owner's. */
  scope: string;
}
type Handler = (deps: LearningMoreHttpDeps) => Promise<unknown> | unknown;
const SwitchSchema = z.object({ part: LearningPartSchema, mode: z.enum(["off", "when-needed", "on"]) }).strict();
const LabelOnly = z.object({ label: z.string().min(1).max(40) }).strict();
const Confirm = z.object({ confirm: z.literal("forget") }).strict();
const R = learningMoreRoutes;
const who = (deps: LearningMoreHttpDeps) => ({ owner: deps.scope, agent: "" });

function overview(deps: LearningMoreHttpDeps) {
  const { more } = deps;
  return {
    parts: learningParts, labels: learningLabels, modes: more.modes(),
    blocks: more.blocks.list(who(deps)), meaningReady: more.meaning.ready(deps.runtime.owner),
    sessions: { settings: more.sessions.settings(deps.runtime.owner), folders: more.sessions.folders() },
    readBack: more.readBack.settings(deps.runtime.owner), providers: more.outside.settings(),
  };
}

const gets: Record<string, Handler> = {
  [R.view]: overview,
  [R.blocks]: (deps) => ({ blocks: deps.more.blocks.list(who(deps)) }),
  [R.curator]: (deps) => ({ ...deps.more.curator.usage(deps.runtime.owner), overlaps: deps.more.curator.overlaps(deps.runtime.owner) }),
  [R.journey]: (deps) => journey(deps.runtime.store, deps.scope, {
    ...(deps.query.get("kinds") ? { kinds: deps.query.get("kinds")!.split(",").filter(Boolean) } : {}),
    ...(deps.query.get("from") ? { from: deps.query.get("from") } : {}), ...(deps.query.get("to") ? { to: deps.query.get("to") } : {}),
    ...(deps.query.get("limit") ? { limit: Number(deps.query.get("limit")) } : {}),
  }),
  [R.lessons]: (deps) => ({ lessons: deps.more.lessons.list(deps.runtime.owner) }),
  [R.sessions]: (deps) => ({ settings: deps.more.sessions.settings(deps.runtime.owner), folders: deps.more.sessions.folders() }),
  [R.tags]: (deps) => ({ tags: deps.more.expiry.tags(deps.scope) }),
  [R.readBack]: (deps) => deps.more.readBack.settings(deps.runtime.owner),
  [R.providers]: (deps) => deps.more.outside.settings(),
};

const posts: Record<string, Handler> = {
  [R.switch]: async (deps) => {
    const { part, mode } = SwitchSchema.parse(await deps.readBody());
    return { part, mode: deps.more.setMode(part, { mode }) };
  },
  [R.blocks]: async (deps) => ({ block: deps.more.blocks.define(who(deps), await deps.readBody()) }),
  [R.blockEdit]: async (deps) => deps.more.blocks.edit(who(deps), await deps.readBody(), true),
  [R.blockRemove]: async (deps) => ({ removed: deps.more.blocks.remove(who(deps), LabelOnly.parse(await deps.readBody()).label) }),
  [R.dryRun]: async (deps) => deps.more.curator.dryRun(deps.runtime.owner, await deps.readBody()),
  [R.merge]: async (deps) => deps.more.curator.suggest(deps.runtime.owner, await deps.readBody()),
  [R.search]: async (deps) => deps.more.meaning.search(deps.runtime.owner, await deps.readBody()),
  [R.lessonsDecide]: async (deps) => ({ lesson: deps.more.lessons.decide(deps.runtime.owner, await deps.readBody()) }),
  [R.lessonsForget]: async (deps) => { Confirm.parse(await deps.readBody()); return { forgotten: deps.more.lessons.forget(deps.runtime.owner) }; },
  [R.sessions]: async (deps) => ({ settings: deps.more.sessions.configure(deps.runtime.owner, await deps.readBody()) }),
  [R.scan]: async (deps) => deps.more.sessions.scan(deps.runtime.owner),
  [R.keep]: async (deps) => deps.more.sessions.keep(deps.runtime.owner, await deps.readBody()),
  [R.decline]: async (deps) => deps.more.sessions.decline(deps.runtime.owner, await deps.readBody()),
  [R.find]: async (deps) => ({ facts: deps.more.expiry.find(deps.scope, await deps.readBody()) }),
  [R.label]: async (deps) => ({ fact: deps.more.expiry.label(deps.scope, await deps.readBody()) }),
  [R.readBack]: async (deps) => deps.more.readBack.configure(deps.runtime.owner, await deps.readBody()),
  [R.tidy]: async (deps) => deps.more.readBack.tidy(deps.scope, deps.more.provider()),
  [R.providers]: async (deps) => deps.more.outside.configure(await deps.readBody()),
};

/** Which part a route belongs to; its switch must not be off for anything but looking and switching. */
const partOf: Record<string, z.infer<typeof LearningPartSchema>> = {
  [R.blocks]: "blocks", [R.blockEdit]: "blocks", [R.blockRemove]: "blocks", [R.dryRun]: "curator", [R.merge]: "curator",
  [R.search]: "meaning-search", [R.scan]: "session-lessons", [R.keep]: "session-lessons", [R.find]: "expiry", [R.label]: "expiry",
  [R.tidy]: "readback", [R.lessonsDecide]: "lessons",
};

/** Answers one request under /api/learning-more/, or throws a LearningMoreHttpError. */
export async function learningMoreApi(deps: LearningMoreHttpDeps, path: string): Promise<unknown> {
  try {
    const handler = (deps.method === "POST" ? posts : deps.method === "GET" ? gets : {})[path];
    if (!handler) throw new LearningMoreHttpError(404, "Endpoint not found");
    const part = partOf[path];
    if (part && deps.method === "POST") deps.more.require(part);
    return deps.runtime.hideSecrets(await handler(deps));
  } catch (error) {
    if (error instanceof LearningMoreHttpError) throw error;
    const status = error instanceof LearningOffError ? 409 : error instanceof ZodError ? 400
      : /not found|no longer saved|there is no/i.test(errorText(error)) ? 404 : 400;
    const message = error instanceof ZodError ? validationText(error) : errorText(error);
    throw new LearningMoreHttpError(status, deps.runtime.hideSecrets(message));
  }
}
