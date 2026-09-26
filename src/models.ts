import { z } from "zod";
import type { Provider } from "./contracts.js";
import type { Store } from "./store.js";
import { type Capability, catalogEntry } from "./provider-catalog.js";
import { ProviderHealth, fallbackReason } from "./provider-health.js";
import { RequestCounter } from "./dashboards.js";
import { fallbackEligible } from "./provider-retry.js";
import { effortFor } from "./knobs/apply.js"; // R17-S12
import { thinkingLevels } from "./thinking-levels.js"; // phase2/accounts
import { noModelPreset } from "./no-model.js";

export const reasoningEfforts = ["low", "medium", "high"] as const;
export type ReasoningEffort = (typeof reasoningEfforts)[number];
export interface ModelPreset {
  id: string;
  name: string;
  provider: Provider;
  model: string;
  reasoning?: ReasoningEffort;
  /** Which line of the provider catalog this connection came from, when it came from one. */
  catalogId?: string;
}
export interface ModelChoice {
  presetId: string;
  presetName: string;
  provider: string;
  model: string;
  reasoning: ReasoningEffort | null;
  source: "session" | "project" | "owner" | "default" | "cooldown";
  /** True when this model runs on this computer, so nothing leaves it and nothing is charged. */
  local: boolean;
  /** When another connection was asked first and passed over, the sentence saying why. */
  fallbackReason?: string | null;
}
const onThisComputer = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
/**
 * Whether a connection's address is on this computer. Providers already hand out their own address
 * for the routes they share (embeddings, audio), so no new provider method is needed.
 */
export function presetRunsLocally(preset: ModelPreset): boolean {
  // A connection Branch did not write may throw from either accessor; that only means "not local".
  try {
    const sharing = preset.provider as { embeddings?: () => { endpoint: string } | null; audio?: () => { endpoint: string } | null };
    const route = sharing.embeddings?.() ?? sharing.audio?.() ?? null;
    if (!route) return false;
    return onThisComputer.has(new URL(route.endpoint).hostname.toLowerCase());
  } catch { return false; }
}
const presetId = z.string().min(1).max(64).regex(/^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/i);
const reasoning = z.enum(reasoningEfforts).nullable();
export const ModelSettingsSchema = z.object({
  activePreset: presetId.nullable().default(null),
  fallbackOrder: z.array(presetId).max(16).default([]),
  cooldownMs: z.number().int().min(0).max(3_600_000).default(60_000),
  reasoning: reasoning.default(null),
}).strict();
export const SessionModelSchema = z.object({
  preset: presetId.nullable().default(null),
  reasoning: reasoning.default(null),
}).strict();
export type ModelSettings = z.infer<typeof ModelSettingsSchema>;
/** A one-run choice, for example from the terminal's /model and /think commands. */
export interface RunModelOverride { preset?: string | null; reasoning?: ReasoningEffort | null }
export type SessionModel = z.infer<typeof SessionModelSchema>;

/** Which connection answers, and which others are tried after it if it fails. */
export interface ModelPlan {
  choice: ModelChoice;
  candidates: ModelPreset[];
}
/** What a plan says when the chosen connection cannot do the kind of work that was asked for. */
export interface CapabilityPlan extends ModelPlan {
  /** Null when the choice can do the work; otherwise one sentence naming a connection that can. */
  refusal: string | null;
}

/** mac5/providers: true for a saved connection whose service has ended the route it used. */
function isRetiredConnection(preset: ModelPreset | undefined): boolean {
  return (preset?.provider as { retired?: unknown } | undefined)?.retired === true;
}

export class ModelRouter {
  private readonly registry = new Map<string, ModelPreset>();
  private readonly cooldowns = new Map<string, number>();
  /** What each connection has actually been doing: latency, last error, the service's allowance. */
  readonly health = new ProviderHealth();
  /**
   * Wave 8: how many calls have gone to each connection lately, so the Usage screen can say how
   * busy one is beside the allowance that service reports. In memory only: this is "right now",
   * and the usage ledger already keeps the lasting record.
   */
  readonly requests = new RequestCounter();
  /** Answers while no connection is set up: never listed, it refuses every request in plain words (src/no-model.ts). */
  private readonly none = noModelPreset();
  constructor(
    private readonly store: Store,
    /** The connections set up so far; none at all is allowed, and then every request is refused until one is added. */
    presets: ModelPreset[],
    /** Clock used for cooldowns; tests may replace it. */
    public now: () => number = Date.now,
  ) {
    for (const preset of presets) this.register(preset);
  }
  get presets(): ReadonlyMap<string, ModelPreset> {
    return this.registry;
  }
  /** Whether any model has been set up. Without one, `default` is the stand-in that refuses. */
  get configured(): boolean {
    return this.registry.size > 0;
  }
  get default(): ModelPreset {
    return (this.registry.values().next().value as ModelPreset | undefined) ?? this.none;
  }
  /** The preset with this id, or the stand-in when it is the one answering, so a status line names "No model yet". */
  find(id: string): ModelPreset | undefined {
    return this.registry.get(id) ?? (id === this.default.id ? this.default : undefined);
  }
  /**
   * mac6/accounts: set by src/accounts/service.ts. Every connection registered passes through it, so
   * one that has several accounts answers through its pool; with that switch off it changes nothing.
   */
  presetHook: ((preset: ModelPreset) => ModelPreset) | null = null;
  /** Adds a preset at runtime, for example after a ChatGPT sign-in. Existing ids are replaced in place. */
  register(preset: ModelPreset): void {
    presetId.parse(preset.id);
    if (this.registry.size >= 32 && !this.registry.has(preset.id)) throw new Error("At most 32 model presets");
    this.registry.set(preset.id, this.presetHook ? this.presetHook(preset) : preset);
  }
  /** Removes exactly one preset by name. Removing the last one leaves no model set up, which is said plainly. */
  remove(id: string): boolean {
    if (!this.registry.has(id)) return false;
    this.cooldowns.delete(id);
    return this.registry.delete(id);
  }
  /** Removes presets whose id starts with the prefix; the first remaining preset becomes the default. */
  unregister(prefix: string): string[] {
    const removed = [...this.registry.keys()].filter(id => id.startsWith(prefix));
    for (const id of removed) { this.registry.delete(id); this.cooldowns.delete(id); }
    return removed;
  }
  settings(owner: string): ModelSettings {
    const saved = ModelSettingsSchema.safeParse(this.store.get("settings", owner, "models")?.data ?? {});
    const value = saved.success ? saved.data : ModelSettingsSchema.parse({});
    if (value.activePreset && !this.presets.has(value.activePreset)) value.activePreset = null;
    value.fallbackOrder = value.fallbackOrder.filter(id => this.presets.has(id));
    return value;
  }
  configure(owner: string, input: unknown): ModelSettings {
    const value = ModelSettingsSchema.parse({ ...this.settings(owner), ...(input as object) });
    for (const id of [value.activePreset, ...value.fallbackOrder])
      if (id && !this.presets.has(id)) throw new Error(`Unknown model preset ${id}`);
    if (new Set(value.fallbackOrder).size !== value.fallbackOrder.length)
      throw new Error("Fallback order lists a preset twice");
    this.store.save("settings", owner, "models", value);
    return value;
  }
  session(owner: string, sessionId: string): SessionModel {
    const saved = SessionModelSchema.safeParse(this.store.get("settings", owner, `session-model:${sessionId}`)?.data ?? {});
    const value = saved.success ? saved.data : SessionModelSchema.parse({});
    if (value.preset && !this.presets.has(value.preset)) value.preset = null;
    return value;
  }
  /**
   * Q261: `holder` is whose records file the conversation now, when that is not `owner`: a household person's own
   * conversation, whose tasks run in the owner's name and so read the choice kept under the owner.
   */
  configureSession(owner: string, sessionId: string, input: unknown, holder = owner): SessionModel {
    if (!this.store.ownsSession(holder, sessionId)) throw new Error("Session not found");
    const value = SessionModelSchema.parse({ ...this.session(owner, sessionId), ...(input as object) });
    if (value.preset && !this.presets.has(value.preset)) throw new Error(`Unknown model preset ${value.preset}`);
    this.store.save("settings", owner, `session-model:${sessionId}`, value);
    return value;
  }
  /** Ordered candidates: the chosen preset first, then configured fallbacks that are not cooling down. */
  plan(owner: string, sessionId: string, override: RunModelOverride = {}): ModelPlan {
    if (override.preset && !this.presets.has(override.preset)) throw new Error(`Unknown model preset ${override.preset}`);
    const owned = this.settings(owner), scoped = this.session(owner, sessionId);
    const chosen = override.preset ?? scoped.preset;
    const project = this.store.projects.active(owner).modelPreset;
    const projectPreset = project && this.presets.has(project) ? project : null;
    const source = chosen ? "session" : projectPreset ? "project" : owned.activePreset ? "owner" : "default";
    const first = this.presets.get(chosen ?? projectPreset ?? owned.activePreset ?? this.default.id) ?? this.default;
    // R17-S12: a default the owner set for this one connection comes before the general default.
    const effort = override.reasoning !== undefined ? override.reasoning : (scoped.reasoning ?? effortFor(this.store, owner, first.id) ?? owned.reasoning ?? first.reasoning ?? null);
    const fallbacks = owned.fallbackOrder
      // mac5/providers: a connection whose service ended its route is never a fallback.
      .filter(id => id !== first.id && !this.coolingDown(id) && !isRetiredConnection(this.presets.get(id)))
      .map(id => this.presets.get(id)!);
    if (this.coolingDown(first.id) && fallbacks.length) {
      const why = fallbackReason(this.health, [first.id], fallbacks[0]!.id);
      return { choice: { ...this.describe(fallbacks[0]!, effort, "cooldown"), fallbackReason: why }, candidates: fallbacks };
    }
    return { choice: this.describe(first, effort, source), candidates: [first, ...fallbacks] };
  }
  /**
   * The same plan, but for work that needs something specific of the model — a picture, tools, a
   * fixed reply format. A connection that cannot do it is not used silently: the plan says so and
   * names one that can, so the person is told rather than left with a worse answer.
   */
  planFor(owner: string, sessionId: string, need: Capability, override: RunModelOverride = {}): CapabilityPlan {
    const plan = this.plan(owner, sessionId, override);
    const able = plan.candidates.filter((preset) => this.canDo(preset, need));
    if (able.length && able[0]!.id === plan.candidates[0]!.id) return { ...plan, refusal: null };
    const others = [...this.presets.values()].filter((preset) => this.canDo(preset, need) && preset.id !== plan.choice.presetId);
    // Only a connection whose catalog line says so is offered as an answer. One Branch knows
    // nothing about is mentioned as worth a try, never promised, because nothing has been checked.
    const sure = others.filter((preset) => preset.catalogId);
    const untested = others.filter((preset) => !preset.catalogId);
    const first = plan.candidates[0]!;
    const refusal = sure.length
      ? `${first.name} cannot do that. ${sure.map((preset) => preset.name).join(" or ")} can, so pick one of those.`
      : untested.length
        ? `${first.name} cannot do that. Branch has nothing on file about ${untested.map((preset) => preset.name).join(" or ")}, so one of those may be worth trying.`
        : `${first.name} cannot do that, and no other connection you have set up can either.`;
    if (!able.length) return { ...plan, refusal };
    return {
      choice: {
        ...this.describe(able[0]!, plan.choice.reasoning, plan.choice.source),
        fallbackReason: `${first.name} cannot do that, so ${able[0]!.name} took it`,
      },
      candidates: able, refusal: null,
    };
  }
  /** Whether one connection can do a kind of work, according to the catalog line it came from. */
  canDo(preset: ModelPreset, need: Capability): boolean {
    const entry = preset.catalogId ? catalogEntry(preset.catalogId) : undefined;
    // A connection Branch did not set up from the catalog is not assumed to be worse than it is.
    if (!entry) return true;
    return entry.capabilities.includes(need);
  }
  describe(preset: ModelPreset, effort: ReasoningEffort | null, source: ModelChoice["source"]): ModelChoice {
    return { presetId: preset.id, presetName: preset.name, provider: preset.provider.name,
      model: preset.model, reasoning: effort, source, local: presetRunsLocally(preset) };
  }
  /** Whether the named connection runs on this computer. Unknown names are not local. */
  runsLocally(id: string): boolean {
    const preset = this.registry.get(id);
    return preset ? presetRunsLocally(preset) : false;
  }
  /** Records a cooldown for an eligible provider failure; returns the cooldown end or null when not eligible. */
  markFailure(owner: string, id: string, error: unknown): string | null {
    // A connection built from the catalog writes down every refused request as it happens, so
    // counting this one again would make a single bad call look like two. A failure with no status
    // — a reply that would not parse, a stream that stopped — was never seen there, so it is
    // recorded here or it is recorded nowhere.
    const seenAlready = this.health.reportsForItself(id) && typeof (error as { status?: unknown }).status === "number";
    if (!seenAlready) this.health.recordFailure(id, error);
    if (!fallbackEligible(error)) return null;
    const until = this.now() + this.settings(owner).cooldownMs;
    this.cooldowns.set(id, until);
    return new Date(until).toISOString();
  }
  coolingDown(id: string): boolean {
    const until = this.cooldowns.get(id);
    if (until === undefined) return false;
    if (until > this.now()) return true;
    this.cooldowns.delete(id);
    return false;
  }
  summary(owner: string) {
    const settings = this.settings(owner);
    return {
      ...settings,
      defaultPreset: this.default.id,
      presets: [...this.presets.values()].map(preset => ({
        id: preset.id, name: preset.name, provider: preset.provider.name, model: preset.model,
        reasoning: preset.reasoning ?? null,
        // phase2/accounts (#22): the thinking levels this model really takes (src/thinking-levels.ts).
        thinking: thinkingLevels(preset.provider.name, preset.model),
        local: presetRunsLocally(preset),
        coolingDownUntil: this.coolingDown(preset.id) ? new Date(this.cooldowns.get(preset.id)!).toISOString() : null,
        // Batch 19 (wave 7): what this connection has actually been doing, from real calls.
        health: this.health.get(preset.id),
      })),
    };
  }
}
