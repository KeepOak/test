import { z } from "zod";
import type { Store } from "./store.js";
import type { ModelRouter } from "./models.js";
import { estimateCost } from "./pricing.js";

/**
 * Per-task routing: which model answers which kind of task. A private note can stay on this
 * computer; a long, tool-heavy task can go to the cloud model that handles it best; and when the
 * cloud answer would cost more than the owner is happy with for something simple, the free model
 * on this computer is used instead. Nothing here changes what the owner explicitly chose for a
 * conversation — an explicit choice always wins.
 */
const presetId = z.string().min(1).max(64).regex(/^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/i).nullable();
export const RoutingSettingsSchema = z.object({
  /** Off by default: nothing is routed automatically until the owner turns it on. */
  enabled: z.boolean().default(false),
  /** Keep tasks that mention personal details on this computer. */
  localForPrivate: z.boolean().default(true),
  /** Send long or tool-heavy tasks to the cloud model. */
  cloudForHard: z.boolean().default(true),
  /** Use the free local model when a simple task would cost more than this in the cloud. */
  costCeilingDollars: z.number().min(0).max(100).default(0.02),
  /** Which connection counts as "on this computer"; empty means the first local one found. */
  localPreset: presetId.default(null),
  /** Which connection counts as "the cloud one"; empty means the current default. */
  cloudPreset: presetId.default(null),
}).strict();
export type RoutingSettings = z.infer<typeof RoutingSettingsSchema>;

export function routingSettings(store: Store, owner: string): RoutingSettings {
  const saved = RoutingSettingsSchema.safeParse(store.get("settings", owner, "routing")?.data ?? {});
  return saved.success ? saved.data : RoutingSettingsSchema.parse({});
}
export function saveRoutingSettings(store: Store, owner: string, input: unknown): RoutingSettings {
  const value = RoutingSettingsSchema.parse({ ...routingSettings(store, owner), ...(input as object) });
  store.save("settings", owner, "routing", value);
  return value;
}

export interface TaskShape {
  /** Rough token count: a quarter of the characters. */
  tokens: number;
  long: boolean;
  toolHeavy: boolean;
  /** True when the words look like they carry personal details. */
  personal: boolean;
  simple: boolean;
}
/**
 * Personal-details heuristic. Branch has no PII guard yet (see docs/audit/todo.md A0875), so this
 * looks for the shapes people actually paste: an email address, a phone number, a long run of card
 * digits, a national insurance or social security number, and the words around money and health.
 */
const personalPatterns: RegExp[] = [
  /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i,
  /\b(?:\+?\d[\s-]?){9,14}\d\b/,
  /\b(?:\d[ -]?){13,19}\b/,
  /\b\d{3}-\d{2}-\d{4}\b/,
  /\b(my|our)\s+(password|passport|salary|bank|account number|address|diagnosis|medical|prescription|tax)\b/i,
  /\b(sort code|iban|national insurance|social security|date of birth)\b/i,
];
export function looksPersonal(text: string): boolean {
  return personalPatterns.some((pattern) => pattern.test(text));
}
/** What kind of task this is, from its length, the tools it may need and whether it looks private. */
export function classifyTask(prompt: string, toolCount = 0): TaskShape {
  const tokens = Math.ceil(prompt.length / 4);
  const long = tokens > 1500;
  const toolHeavy = toolCount > 8 || /\b(search the web|browse|run|open the browser|across (the )?(files|repo)|refactor|debug)\b/i.test(prompt);
  const personal = looksPersonal(prompt);
  return { tokens, long, toolHeavy, personal, simple: !long && !toolHeavy };
}

export type RouteKind = "local" | "cloud" | "unchanged" | "refused";
export interface RouteChoice {
  /** The preset to use, or null to leave the ordinary choice alone. */
  preset: string | null;
  kind: RouteKind;
  /** Plain-language reason, shown in the task's record. */
  reason: string;
  /**
   * True when the task must stay on this computer (personal details, with "keep personal tasks here" on). Such a task
   * never falls back to a model elsewhere: with the model here down it fails with that model's own error, and with no
   * model here it is refused (kind "refused"), rather than being sent to the cloud.
   */
  private?: boolean;
}
export interface RouteInputs {
  /** A connection that runs on this computer, when there is one. */
  localPreset: string | null;
  /** The cloud connection to prefer for hard work, when there is one. */
  cloudPreset: string | null;
  /** False when the local server is not answering: a cheap local choice falls back to the cloud, a private one never does. */
  localUp: boolean;
  /** What the cloud model would probably cost for this task, or null when no price is on file. */
  cloudCost: number | null;
}

/** The routing decision itself: pure, so the rules can be read and tested on their own. */
export function chooseRoute(settings: RoutingSettings, shape: TaskShape, inputs: RouteInputs): RouteChoice {
  if (!settings.enabled) return { preset: null, kind: "unchanged", reason: "Task routing is switched off" };
  const local = inputs.localPreset, cloud = inputs.cloudPreset;
  if (settings.localForPrivate && shape.personal) return privateRoute(local, inputs.localUp);
  const wantsLocal = shape.simple && inputs.cloudCost !== null && inputs.cloudCost > settings.costCeilingDollars;
  if (settings.cloudForHard && (shape.long || shape.toolHeavy) && !shape.personal && cloud)
    return { preset: cloud, kind: "cloud", reason: "This is a long or tool-heavy task, so the cloud model takes it" };
  if (wantsLocal && local && inputs.localUp)
    return { preset: local, kind: "local", reason: reasonForLocal(inputs) };
  if (wantsLocal && local && !inputs.localUp && cloud)
    return { preset: cloud, kind: "cloud", reason: "The model on this computer is not answering, so the cloud model takes it" };
  if (wantsLocal && !local)
    return { preset: null, kind: "unchanged", reason: "No model is set up on this computer yet" };
  return { preset: null, kind: "unchanged", reason: "Nothing about this task asks for a different model" };
}
/**
 * The route for a later turn of a conversation that already held personal details: its history goes with every turn,
 * so it stays on this computer too, whatever the new words say. Null while routing or the rule is off.
 */
export function privateConversationRoute(store: Store, models: ModelRouter, owner: string): RouteChoice | null {
  const settings = routingSettings(store, owner);
  if (!settings.enabled || !settings.localForPrivate) return null;
  const choice = privateRoute(pickLocalPreset(models, settings.localPreset), true);
  return { ...choice, reason: choice.preset ? "Earlier in this conversation there were personal details, so it stays on this computer" : choice.reason };
}
/** A task with personal details, while the owner keeps those on this computer: here, or nowhere. */
function privateRoute(local: string | null, localUp: boolean): RouteChoice {
  if (!local) return { preset: null, kind: "refused", private: true,
    reason: "This task mentions personal details, so it has to stay on this computer, and no model is set up here. Set one up, or switch off keeping personal tasks on this computer." };
  return { preset: local, kind: "local", private: true, reason: localUp
    ? "This task mentions personal details, so it stays on this computer"
    : "This task mentions personal details, so it stays on this computer. The model here is not answering, and the task is not sent anywhere else." };
}
function reasonForLocal(inputs: RouteInputs): string {
  return `A simple task, and the cloud model would cost about $${(inputs.cloudCost ?? 0).toFixed(4)}, so the free model on this computer takes it`;
}

/** A preset id that runs on this computer, preferring the owner's choice (only when it really runs here). */
export function pickLocalPreset(models: ModelRouter, chosen: string | null): string | null {
  if (chosen && models.presets.has(chosen) && models.runsLocally(chosen)) return chosen;
  for (const preset of models.presets.values()) if (models.runsLocally(preset.id)) return preset.id;
  return null;
}
/** A preset id that does not run on this computer, preferring the owner's choice. */
export function pickCloudPreset(models: ModelRouter, chosen: string | null): string | null {
  if (chosen && models.presets.has(chosen)) return chosen;
  for (const preset of models.presets.values()) if (!models.runsLocally(preset.id)) return preset.id;
  return null;
}

/** Roughly what the cloud model would cost for a task of this size, or null with no price on file. */
export function estimateTaskCost(models: ModelRouter, preset: string | null, shape: TaskShape): number | null {
  const chosen = preset ? models.presets.get(preset) : undefined;
  if (!chosen) return null;
  return estimateCost(chosen.model, { input: shape.tokens, output: Math.min(shape.tokens, 800) }).amount;
}

/** The whole decision for one task, ready for the runtime: reads settings, resolves both presets. */
export function routeForTask(
  store: Store, models: ModelRouter, owner: string,
  task: { prompt: string; toolCount?: number; localUp?: boolean },
): RouteChoice {
  const settings = routingSettings(store, owner);
  if (!settings.enabled) return { preset: null, kind: "unchanged", reason: "Task routing is switched off" };
  const shape = classifyTask(task.prompt, task.toolCount ?? 0);
  const cloudPreset = pickCloudPreset(models, settings.cloudPreset);
  return chooseRoute(settings, shape, {
    localPreset: pickLocalPreset(models, settings.localPreset),
    cloudPreset,
    localUp: task.localUp ?? true,
    cloudCost: estimateTaskCost(models, cloudPreset, shape),
  });
}
