import { z } from "zod";
import { passageVisible } from "../walk-rules.js"; // mac7/walk-rules
import type { Provider } from "../contracts.js";
import type { ProjectMap } from "../code-map.js";
import type { KnowledgeBases } from "../knowledge-bases.js";
import type { ModelRouter } from "../models.js";
import type { ToolRegistry } from "../registry.js";
import type { Store } from "../store.js";
import { mapCost, tourCost, type LearnCost } from "./cost.js";
import { codeMap, documentMap } from "./map.js";
import { learnSettings, requireLearn, saveLearnSettings, type LearnSettings } from "./settings.js";
import { applyNarration, narrationRequest, planTour, plainTour } from "./tour.js";
import type { LearnMap, LearnTour } from "./types.js";

/**
 * mac7/learn: "Understanding something". Point Branch at a folder of code, a knowledge base or a
 * folder of notes and get two things -- a map of what is in there and how the parts connect, and a
 * guided walk through it in plain words.
 *
 * The map is built without a model call, so it costs nothing and nothing leaves this computer. The
 * only model call in the whole feature writes the paragraph on each stop of the tour, it is priced
 * before it is made, and the tour exists without it.
 *
 * Every claim either carries the passage or the line it came from, or says on itself that it has
 * nothing behind it. See src/learn/types.ts.
 *
 * Ships off, like every feature. See docs/configuration.md, "Understanding something".
 */

export const MapSchema = z.object({
  /** "code" reads the project folder; "documents" reads a knowledge base already indexed. */
  subject: z.enum(["code", "documents"]).default("code"),
  /** The folder for code (relative to the workspace), or the knowledge base for documents. */
  of: z.string().trim().max(200).default(""),
}).strict();
export const TourSchema = MapSchema.extend({
  /** Whether a model may write the words. Off means the tour keeps the map's own plain sentences. */
  useModel: z.boolean().default(false),
  /** "en", "fr", or empty to follow the workspace. */
  language: z.string().trim().max(12).default(""),
}).strict();

export interface LearnDeps {
  store: Store;
  registry: ToolRegistry;
  owner: string;
  models?: ModelRouter | undefined;
  bases?: KnowledgeBases | undefined;
  project?: ProjectMap | undefined;
  /** The workspace's language, so a French tour is written in French and not only framed in it. */
  language: () => string;
}

export class Learn {
  constructor(private readonly deps: LearnDeps) {}

  settings(owner = this.deps.owner): LearnSettings { return learnSettings(this.deps.store, owner); }
  save(input: unknown, owner = this.deps.owner): LearnSettings { return saveLearnSettings(this.deps.store, owner, input); }
  /** Throws the one plain sentence when the feature is switched off. */
  require(owner = this.deps.owner): void { requireLearn(this.deps.store, owner); }

  /** The map. No model is called here, whatever the owner's settings say. */
  async map(owner: string, input: unknown): Promise<LearnMap> {
    this.require(owner);
    const { subject, of } = MapSchema.parse(input);
    if (subject === "code") {
      if (!this.deps.project) throw new Error("There is no project folder to read on this launch.");
      return codeMap(this.deps.project, of || ".");
    }
    const collection = this.collection(owner, of);
    const rules = this.deps.bases?.readRules(); // mac7/walk-rules
    return documentMap(this.deps.store.sqlite, owner, collection, (docId) => !rules || passageVisible(rules, docId));
  }

  /**
   * What the work would cost, before any of it is done. A map is no model call at all and says so;
   * a tour's words are one call, priced through the one function allowed to price anything, which
   * never reports a made-up zero.
   */
  async cost(owner: string, input: unknown): Promise<{ map: LearnCost; tour: LearnCost }> {
    this.require(owner);
    const value = TourSchema.parse(input);
    const built = await this.map(owner, { subject: value.subject, of: value.of });
    const characters = built.things.reduce((sum, thing) => sum + thing.name.length, 0)
      + built.links.reduce((sum, link) => sum + link.relation.length, 0);
    const steps = planTour(built, this.settings(owner).steps);
    const language = value.language || this.deps.language();
    const request = narrationRequest(built, steps, language);
    const model = value.useModel ? this.modelName(owner) : "";
    return {
      map: mapCost(built.subject === "code" ? "the map of this folder" : "the map of this collection", built.things.length, characters),
      tour: tourCost(this.deps.store, owner, model, steps.length, request.characters + request.instructions.length),
    };
  }

  /** The tour. The stops, their order and their citations are worked out before any model is asked. */
  async tour(owner: string, input: unknown, signal?: AbortSignal): Promise<LearnTour> {
    this.require(owner);
    const value = TourSchema.parse(input);
    const built = await this.map(owner, { subject: value.subject, of: value.of });
    const steps = planTour(built, this.settings(owner).steps);
    const language = value.language || this.deps.language();
    if (!steps.length)
      return plainTour(built, steps, language, "There is nothing in it to walk through yet.");
    if (!value.useModel)
      return plainTour(built, steps, language, "Nobody asked for a model, so each stop keeps the plain sentence the map gave it.");
    const provider = this.provider(owner);
    if (!provider)
      return plainTour(built, steps, language, "No model is connected, so each stop keeps the plain sentence the map gave it.");
    const request = narrationRequest(built, steps, language);
    const answer = await provider.complete({
      messages: [{ role: "system", content: request.instructions }, { role: "user", content: request.prompt }],
      tools: [], maxTokens: 220 * steps.length, signal: signal ?? AbortSignal.timeout(120000),
    }).then((done) => done.content).catch(() => null);
    if (answer === null)
      return plainTour(built, steps, language, "The model could not be reached, so each stop keeps the plain sentence the map gave it.");
    const narrated = applyNarration(steps, answer);
    return {
      subject: built.subject, of: built.of, steps: narrated.steps, language,
      how: `${steps.length} stop(s), worked out from the map on this computer; one model call wrote the words in ${language === "fr" ? "French" : language === "es" ? "Spanish" : "English"}.`,
      limits: [...built.limits, ...narrated.limits], modelCalls: narrated.modelCalls,
    };
  }

  /**
   * With nothing named, a map belongs to the project that is open, the way a search already does.
   * The code root needs no work: the workspace itself already follows the active project's folder,
   * so "." is that project's folder. The collection is the first of the ones the project looks in
   * (`Project.knowledgeBases`, the same list search narrows by), falling back to the first there is.
   */
  private collection(owner: string, named: string): string {
    if (!this.deps.bases) throw new Error("There are no knowledge bases on this launch.");
    if (named) return this.deps.bases.one(owner, named).id;
    const here = this.deps.bases.list(owner);
    if (!here.length) throw new Error("There are no knowledge bases yet. Make one in Documents first.");
    const wanted = this.deps.store.projects.defaults(owner).knowledgeBases;
    const scoped = here.find((base) => wanted.includes(base.id) || wanted.includes(base.name));
    return (scoped ?? here[0]!).id;
  }
  private modelName(owner: string): string {
    return this.deps.models?.plan(owner, "").choice.model ?? "";
  }
  private provider(owner: string): Provider | undefined {
    return this.deps.models?.plan(owner, "").candidates[0]?.provider;
  }
}

/**
 * The three tools. Reading code is under the permission for reading files; reading a knowledge base
 * is under the one for reading documents, so nothing new has to be granted. Each description says
 * what the tool cannot do as well as what it can, the way `code.map` already does.
 */
export function registerLearn(registry: ToolRegistry, learn: Learn): void {
  registry.register({
    name: "learn.map", group: "documents", permission: "documents.read",
    description: "A map of what is in a folder of code or a knowledge base and how the parts connect, with the line or passage behind every link. Built on this computer with no model call, so it costs nothing. The names in code come from a light reader, not a real parser; over documents a link often only means two names turned up in the same passage.",
    parameters: MapSchema,
    execute: async (input, context) => learn.map(context.owner, input),
  });
  registry.register({
    name: "learn.tour", group: "documents", permission: "documents.read",
    description: "A guided walk through a folder of code or a knowledge base: a handful of stops in reading order, each naming the passage or line it came from. The stops are worked out without a model; useModel asks a model to write the paragraph on each one, in the workspace's language. A stop with nothing behind it says so rather than hiding it.",
    parameters: TourSchema,
    execute: async (input, context) => learn.tour(context.owner, input, context.signal),
  });
  registry.register({
    name: "learn.cost", group: "documents", permission: "documents.read",
    description: "What building the map and writing the tour would cost, before either is done. The map is no model call at all; the tour's words are one, priced from the table or reported as having no price on file, never as zero.",
    parameters: TourSchema,
    execute: async (input, context) => learn.cost(context.owner, input),
  });
}

export { LearnOffError, learnKey, learnLabel, learnTools } from "./settings.js";
export type { LearnMap, LearnTour, TourStep, LearnCitation } from "./types.js";
