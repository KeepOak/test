import type { IncomingMessage } from "node:http";
import { z } from "zod";
import type { Store } from "../store.js";
import type { ModelRouter } from "../models.js";
import { currentPerson } from "../people/context.js";
import { startedWithShortLivedKey } from "../key-context.js";
import { allSavings, MixtureSettingsSchema, readSavings, resetSavings, saveSavings, savingsCardNames, type SavingsCard } from "./settings.js";
import { hardMixtureId, mixturePrefix, mixtureProblem, syncMixtures, wantedMixtures } from "./mixture.js";
import { keptWarmProviders } from "./keep-alive.js";
import { roundsOf } from "./rounds.js";
import { openRouterAddress, openRouterCompanies } from "./openrouter.js";
import { lockedDown } from "../lockdown.js";
import { errorText, validationText } from "../request-errors.js";
import { checkCostThresholds, thresholdProvider } from "./cost-thresholds.js";

/**
 * R17-E: the screen's way in.
 *
 *   GET  /api/model-savings          every card, the connections to choose from, and live mixtures
 *   POST /api/model-savings          { card, values } saves one card; { card, reset: true } puts it back
 *   GET  /api/model-savings/rounds   ?session=<id>: one conversation round by round (R17-049)
 *
 * Changing a card is the owner's, in the app window: a short-lived key is refused before this is
 * reached (src/short-lived-keys.ts), and a household profile is refused here, because several of
 * these cards change what is spent.
 */
export class SavingsApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export interface SavingsApp {
  store: Store;
  runtime: { owner: string; models: ModelRouter };
  /** How OpenRouter's list of companies is fetched (tests hand one in). */
  companiesFetch?: typeof fetch;
}
export const savingsRoutes: readonly string[] = ["/api/model-savings", "/api/model-savings/rounds", "/api/model-savings/companies"];
export const handlesSavingsPath = (path: string): boolean => savingsRoutes.includes(path);

const SaveSchema = z.object({
  card: z.enum(savingsCardNames as [SavingsCard, ...SavingsCard[]]),
  values: z.record(z.string(), z.unknown()).optional(),
  reset: z.boolean().optional(),
}).strict();

function requireOwnerHere(store: Store): void {
  if (startedWithShortLivedKey() || currentPerson())
    throw new SavingsApiError(403, "Only the owner can change how models are chosen and what they may spend, in the app window.");
  try { store.profiles.requireOwner("How models are chosen"); } catch (error) { throw new SavingsApiError(400, errorText(error)); }
}

function view(app: SavingsApp) {
  const { store, runtime } = app;
  requireOwnerHere(store);
  const presets = [...runtime.models.presets.values()];
  const mixtureIds = new Set(wantedMixtures(store, runtime.owner, runtime.models).map((mixture) => `${mixturePrefix}${mixture.id}`));
  return {
    values: allSavings(store, runtime.owner),
    connections: presets.filter((preset) => !mixtureIds.has(preset.id)).map((preset) => ({ id: preset.id, name: preset.name, provider: preset.provider.name,
      thresholdProvider: thresholdProvider(preset), model: preset.model })),
    liveMixtures: presets.filter((preset) => mixtureIds.has(preset.id)).map((preset) => preset.id),
    keptWarmProviders,
    /** True when an OpenRouter connection is set up, so its list of companies can be asked for. */
    openRouter: openRouterAddress(presets) !== null,
  };
}

/** What plain field ranges cannot check: that every named connection exists. */
function checkValues(app: SavingsApp, card: SavingsCard, values: Record<string, unknown>): void {
  const known = (id: unknown) => id === null || id === undefined || (typeof id === "string" && app.runtime.models.presets.has(id));
  const notSetUp = () => new SavingsApiError(400, "That connection is not set up. Pick one from the list.");
  if (card === "phases" && !known(values.planModel)) throw notSetUp();
  if (card === "costThresholds") checkCostThresholds(app.store, app.runtime.owner, app.runtime.models, values);
  if (card === "difficulty" && ![values.classifierModel, values.easyModel, values.hardModel].every(known)) throw notSetUp();
  if (card === "mixtures") {
    const parsed = MixtureSettingsSchema.parse({ ...readSavings(app.store, app.runtime.owner, "mixtures"), ...values });
    const ids = new Set<string>();
    for (const mixture of parsed.mixtures) {
      if (ids.has(mixture.id)) throw new SavingsApiError(400, "Two mixtures have the same short name.");
      if (mixture.id === hardMixtureId) throw new SavingsApiError(400, "That short name is Branch's own, for mixing models on hard questions. Pick another.");
      ids.add(mixture.id);
      const problem = mixtureProblem(mixture, app.runtime.models);
      if (problem) throw new SavingsApiError(400, problem);
    }
  }
}

function save(app: SavingsApp, body: unknown) {
  const input = SaveSchema.parse(body);
  const { store, runtime: { owner } } = app;
  requireOwnerHere(store);
  if (input.reset) resetSavings(store, owner, input.card);
  else if (input.values) {
    checkValues(app, input.card, input.values);
    saveSavings(store, owner, input.card, input.values);
  }
  if (input.card === "mixtures" || input.card === "difficulty") syncMixtures(store, owner, app.runtime.models); // difficulty: Mix models on hard questions
  return view(app);
}

export async function savingsApi(app: SavingsApp, request: IncomingMessage, path: string, url: URL,
  readBody: (request: IncomingMessage) => Promise<unknown>): Promise<unknown> {
  const method = request.method ?? "GET";
  try {
    if (path === "/api/model-savings/rounds") {
      if (method !== "GET") throw new SavingsApiError(405, "Use GET");
      // A household person's key reads nothing of the owner's conversations (integration review).
      if (currentPerson()) throw new SavingsApiError(403, "Only the owner can see a conversation's rounds.");
      const session = url.searchParams.get("session") ?? "";
      if (!session) throw new SavingsApiError(400, "Say which conversation.");
      return roundsOf(app.store, app.runtime.owner, session);
    }
    // OpenRouter picks › Only ones I list: the companies to choose from. POST: it asks OpenRouter, so it is the owner's.
    if (path === "/api/model-savings/companies") {
      if (method !== "POST") throw new SavingsApiError(405, "Use POST");
      requireOwnerHere(app.store);
      if (lockedDown(app.store, app.runtime.owner)) throw new SavingsApiError(409, "Lockdown is on, so Branch asks OpenRouter nothing. Turn Lockdown off first.");
      const address = openRouterAddress(app.runtime.models.presets.values());
      if (!address) throw new SavingsApiError(409, "No OpenRouter connection is set up, so there is no list of its companies.");
      return { companies: await openRouterCompanies(address, app.companiesFetch) };
    }
    if (method === "GET") return view(app);
    if (method === "POST") return save(app, await readBody(request));
    throw new SavingsApiError(405, "Use GET or POST");
  } catch (error) {
    if (error instanceof SavingsApiError) throw error;
    if (error instanceof z.ZodError) throw new SavingsApiError(400, validationText(error));
    const message = errorText(error);
    throw new SavingsApiError(message === "Conversation not found" ? 404 : 400, message);
  }
}
