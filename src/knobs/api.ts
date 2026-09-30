import { thinkingLevels } from "../thinking-levels.js"; // phase2/accounts
import type { IncomingMessage } from "node:http";
import { z } from "zod";
import type { Store } from "../store.js";
import { leakKinds } from "../leak-guard.js";
import { currentPerson } from "../people/context.js";
import { startedWithShortLivedKey } from "../key-context.js";
import { allKnobs, knobCardNames, resetKnobs, saveKnobs, type KnobCard } from "./settings.js";
import { memoryProvider, saveMemoryProvider } from "./apply.js";
import { refusedEnvironmentName } from "./environment.js";
import { launchFileView, saveLaunchFile } from "./launch-file.js";
import { contextLimit } from "../runtime.js";
import { lockdownActive } from "../lockdown.js";
import { looseningRefusal, withoutConfirm } from "../policy-change-guard.js";
import { byCard, recordedWrite } from "../settings-kit/recorded-write.js";
import { errorText, validationText } from "../request-errors.js";

/**
 * R17-S-B: the screen's way in.
 *
 *   GET  /api/knobs              every card's values, what "as launched" means, and the choices offered
 *   POST /api/knobs              { card, values } saves one card; { card, reset: true } puts it back
 *   GET  /api/knobs/launch-file  what the launch settings file (BRANCH_INTEGRATIONS) says, in plain words
 *   POST /api/knobs/launch-file  changes the few fields the card offers; used from the next start
 *
 * Every change is the owner's: a short-lived key is refused before this is reached (src/server.ts,
 * src/short-lived-keys.ts), and a household profile is refused here, since every card is the owner's
 * own setting. The owner's "about you" note is shown to the owner only.
 */
export class KnobsApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export interface KnobsApp {
  store: Store;
  runtime: {
    owner: string;
    models: { presets: ReadonlyMap<string, { id: string; name: string; model: string; provider: { name: string } }> };
    reliability: { toolResultChars: number; toolTimeoutMs: number; localFirstReplyMs: number; maxModelRounds: number };
    retryPolicy: { maxRetries: number };
  };
  /** The sections of the launch settings file this start left out (src/integrations/bootstrap.ts). */
  launchFile?: { leftOut: readonly string[] };
}
/** Both routes; a short-lived key is refused every change to them (knobsRefusal in src/short-lived-keys.ts). */
export const knobsRoutes: readonly string[] = ["/api/knobs", "/api/knobs/launch-file"];
export const handlesKnobsPath = (path: string): boolean => knobsRoutes.includes(path);

const SaveSchema = z.object({
  card: z.enum(knobCardNames as [KnobCard, ...KnobCard[]]),
  values: z.record(z.string(), z.unknown()).optional(),
  reset: z.boolean().optional(),
  memoryProvider: z.enum(["branch", "branch-and-hindsight"]).optional(),
}).strict();

/** Only the owner, in the owner's own profile and with the computer's own key, may loosen these. */
function requireOwnerHere(store: Store, what: string): void {
  if (startedWithShortLivedKey() || currentPerson())
    throw new KnobsApiError(403, `${what} can only be changed by the owner, in the app window.`);
  try { store.profiles.requireOwner(what); } catch (error) { throw new KnobsApiError(400, errorText(error)); }
}

/** Whether the one asking is the owner, in the owner's own profile and with the computer's own key. */
const ownerHere = (store: Store): boolean => !startedWithShortLivedKey() && !currentPerson() && store.profiles.isOwner();

/** What anyone but the owner sees of the launch settings file: nothing it sets up. */
const launchFileHidden = { path: null, ownerOnly: true, problem: "Only the owner can see what the launch settings file sets up.", facts: null, editable: null };

function view(app: KnobsApp) {
  const { store, runtime } = app;
  const values = allKnobs(store, runtime.owner);
  if (!ownerHere(store)) values.memory = { ...values.memory, aboutYou: "" };
  return {
    values,
    aboutYouHidden: !ownerHere(store),
    memoryProvider: memoryProvider(store, runtime.owner),
    // phase2/accounts (#22): which thinking levels each model really takes (src/thinking-levels.ts).
    connections: [...runtime.models.presets.values()].map((preset) =>
      ({ id: preset.id, name: preset.name, thinking: thinkingLevels(preset.provider.name, preset.model) })),
    leakKinds: leakKinds.filter((kind) => kind !== "private key"),
    launched: {
      contextWindowTokens: contextLimit,
      toolAnswerChars: runtime.reliability.toolResultChars,
      toolTimeoutSeconds: Math.round(runtime.reliability.toolTimeoutMs / 1000),
      apiRetries: runtime.retryPolicy.maxRetries,
      localFirstReplySeconds: Math.round(runtime.reliability.localFirstReplyMs / 1000), // mac7/coding-next
      maxModelRounds: runtime.reliability.maxModelRounds, // mac7/speed
    },
  };
}

/** Checks what a save would change that plain field ranges cannot. */
function checkValues(app: KnobsApp, card: KnobCard, values: Record<string, unknown>): void {
  const known = (id: unknown) => typeof id !== "string" || app.runtime.models.presets.has(id);
  if (card === "subtasks" && (!known(values.subtaskModel) || !known(values.sideJobModel)))
    throw new KnobsApiError(400, "That connection is not set up. Pick one from the list.");
  if (card === "reasoning" && values.effortByModel && typeof values.effortByModel === "object"
    && !Object.keys(values.effortByModel).every(known))
    throw new KnobsApiError(400, "That connection is not set up. Pick one from the list.");
  if (card === "commands" && "passEnvironment" in values) {
    for (const name of Array.isArray(values.passEnvironment) ? values.passEnvironment : []) {
      const refused = refusedEnvironmentName(String(name));
      if (refused) throw new KnobsApiError(400, refused);
    }
  }
  if (card === "leakGuard") {
    const allowed = new Set(leakKinds.filter((kind) => kind !== "private key"));
    for (const kind of Array.isArray(values.exceptions) ? values.exceptions : [])
      if (!allowed.has(String(kind))) throw new KnobsApiError(400, `"${String(kind).slice(0, 40)}" is not a kind of value that can be let through.`);
  }
}

/** What a save does to the task spend cap that lets a task spend more, in words, or null when it does not. */
function spendCapLooser(store: Store, owner: string, input: z.infer<typeof SaveSchema>): string | null {
  if (input.card !== "limits") return null;
  const was = allKnobs(store, owner).limits.spendCapDollars;
  if (was === null) return null;
  const asked = input.reset ? null : input.values && "spendCapDollars" in input.values ? input.values.spendCapDollars : was;
  if (asked === null) return "a task would have no spend cap";
  return typeof asked === "number" && asked > was ? `a task's spend cap would go up from $${was} to $${asked}` : null;
}

function save(app: KnobsApp, body: unknown) {
  const { confirmLoosening, input: asked } = withoutConfirm(body);
  const input = SaveSchema.parse(asked);
  const { store, runtime: { owner } } = app;
  requireOwnerHere(store, "These settings");
  // A task's spend cap raised or taken away needs the owner's yes, and never under Lockdown (src/policy-change-guard.ts).
  const refusal = looseningRefusal(spendCapLooser(store, owner, input), confirmLoosening, lockdownActive(store, owner));
  if (refusal) throw new KnobsApiError(409, refusal);
  const write = (): void => {
    if (input.reset) {
      resetKnobs(store, owner, input.card);
    } else if (input.values) {
      checkValues(app, input.card, input.values);
      saveKnobs(store, owner, input.card, input.values);
    }
  };
  // The round limit and a task's token allowance are also Settings settings (src/settings-kit/catalogue.ts), so what
  // this card moves of them is recorded.
  if (input.card === "limits") recordedWrite(store, owner, byCard("round-limit"), ["round-limit", "step-limit", "task-tokens"], write);
  else write();
  if (input.memoryProvider) saveMemoryProvider(store, owner, input.memoryProvider);
  return view(app);
}

export async function knobsApi(app: KnobsApp, request: IncomingMessage, path: string,
  readBody: (request: IncomingMessage) => Promise<unknown>, integrationsPath: () => string | null): Promise<unknown> {
  const method = request.method ?? "GET";
  if (method !== "GET" && method !== "POST") throw new KnobsApiError(405, "Use GET or POST");
  try {
    if (path === "/api/knobs/launch-file") {
      const leftOut = app.launchFile?.leftOut ?? [];
      if (method === "GET") return ownerHere(app.store) ? await launchFileView(integrationsPath(), leftOut) : launchFileHidden;
      requireOwnerHere(app.store, "The launch settings file");
      return await saveLaunchFile(integrationsPath(), await readBody(request), leftOut);
    }
    return method === "GET" ? view(app) : save(app, await readBody(request));
  } catch (error) {
    if (error instanceof KnobsApiError) throw error;
    if (error instanceof z.ZodError) throw new KnobsApiError(400, validationText(error));
    throw new KnobsApiError(400, errorText(error));
  }
}
