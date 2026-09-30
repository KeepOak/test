import type { Completion, CompletionRequest, Message, ToolDescription, Usage } from "../contracts.js";
import { UsageSchema } from "../contracts.js";
import type { ModelPreset, ModelRouter, RunModelOverride } from "../models.js";
import type { Store } from "../store.js";
import { estimateCost, pricingSettings } from "../pricing.js";
import { routeByProfile } from "../model-profiles.js";
import { pickLocalPreset, routingSettings } from "../local-routing.js";
import { withAccountCall, type AccountCall } from "../accounts/context.js";
import { chooseByDifficulty, type DifficultyAsk } from "./difficulty.js";
import { KeepAlive } from "./keep-alive.js";
import { openRouterRouting } from "./openrouter.js";
import { noteReported } from "./reported.js";
import { readSavings } from "./settings.js";
import { lockedDown } from "../lockdown.js";
import { spendCapCheck } from "../knobs/apply.js";

/**
 * R17-E: what the runtime asks at each marked hook (search src/runtime.ts for "R17-E"). Each one
 * reads the owner's saved choice fresh and, when nothing was saved, hands back exactly what the
 * runtime did before.
 */
export { withReported } from "./reported.js";

export interface SavingsRuntime {
  readonly store: Store;
  readonly models: ModelRouter;
}

/**
 * R17-044: the connection that drafts plans, when the owner named one that exists. Only the
 * planning question (src/orchestration.ts `planInstructions`) goes to it; the reviewer of a
 * finished answer and every other side question keep the connection they had.
 */
export const planningQuestion = /^You are planning a task before any of it is done\./;
export function planPreset(runtime: SavingsRuntime, owner: string, fallback: ModelPreset, messages: readonly Message[]): ModelPreset {
  if (!planningQuestion.test(messages[0]?.content ?? "")) return fallback;
  const id = readSavings(runtime.store, owner, "phases").planModel;
  return (id && runtime.models.presets.get(id)) || fallback;
}

/** R17-045: true only for OpenAI's own address, the one service Branch knows offers the flex tier. */
export function offersFlex(preset: ModelPreset): boolean {
  try {
    const route = (preset.provider as { embeddings?: () => { endpoint: string } | null }).embeddings?.();
    return route ? new URL(route.endpoint).hostname.toLowerCase() === "api.openai.com" : false;
  } catch { return false; }
}

/**
 * What a request carries beyond the usual: OpenRouter's company preferences (R17-046), and the flex
 * tier for a side question to OpenAI when the owner asked for it (R17-045). Flex only ever lowers
 * the price, and it is never asked of a service that has not said it offers it.
 */
export function requestExtras(store: Pick<Store, "get">, owner: string, preset: ModelPreset, sideQuestion: boolean): Pick<CompletionRequest, "providerRouting" | "serviceTier"> {
  const routing = openRouterRouting(store, owner);
  const flex = sideQuestion && readSavings(store, owner, "phases").sideTier === "flex" && offersFlex(preset);
  return { ...(routing ? { providerRouting: routing } : {}), ...(flex ? { serviceTier: "flex" as const } : {}) };
}

/**
 * R17-047: the connection chosen by difficulty, as a one-run override. An explicit choice for the
 * run or the conversation, and a routing profile, all come first. A classifier that fails leaves
 * the ordinary choice and says why; it never fails the task.
 */
export async function byDifficulty(
  runtime: SavingsRuntime, run: { id: string; sessionId: string; prompt: string }, owner: string,
  override: RunModelOverride, ask: DifficultyAsk,
): Promise<RunModelOverride> {
  const { store, models } = runtime;
  if (readSavings(store, owner, "difficulty").mode === "off") return override;
  if (override.preset || models.session(owner, run.sessionId).preset) return override;
  if (routeByProfile(store, models, owner, "chat", store.projects.defaults(owner).profile).preset) return override;
  const toolCount = store.messages(run.sessionId).filter((message) => message.role === "tool").length;
  try {
    const localPreset = pickLocalPreset(models, routingSettings(store, owner).localPreset);
    const choice = await chooseByDifficulty(store, owner, { prompt: run.prompt, toolCount, known: (id) => models.presets.has(id), ask, localPreset });
    if (!choice) return override;
    store.event(run.id, "model.routed", { preset: choice.preset, kind: `difficulty-${choice.difficulty}`, by: choice.by, reason: choice.reason });
    return { ...override, preset: choice.preset };
  } catch (error) {
    store.event(run.id, "model.routed", { preset: null, kind: "difficulty", reason: `The easy-or-hard question failed, so the usual connection answers: ${(error as Error).message}` });
    return override;
  }
}

export interface AnsweredRound {
  run: { id: string; owner: string; sessionId: string };
  owner: string;
  preset: ModelPreset;
  /** What was sent (after the leak guard), kept as it was for the keep-alive ping. */
  messages: Message[];
  tools: ToolDescription[];
  estimatedInput: number;
  reported: Usage | undefined;
  /** True for the task's own rounds (not side questions or sub-tasks). */
  mainRound: boolean;
  /** The runtime's own checks, asked again before each ping (see `pingRefusal`). */
  guard?: Pick<PingGuard, "family" | "active" | "monthly">;
  /** mac7/lockdown-fix: a Trunk's round; its ping goes through the Trunk's own keys, never a sign-in. */
  trunk?: AccountCall["trunk"];
}

export interface PingGuard {
  sessionId: string;
  /** Every task whose spending counts against the same per-task limit. */
  family: readonly string[];
  model: string;
  /** True while a task of this conversation is working (its own rounds re-arm the pause). */
  active: () => boolean;
  /** The monthly budget's refusal, or null. */
  monthly: () => string | null;
}

/** Why a cache ping must not be sent now, or null. Each ping is money the owner did not ask for this minute. */
export function pingRefusal(store: Store, owner: string, guard: PingGuard): string | null {
  if (lockedDown(store, owner)) return "Lockdown is on";
  if (!store.ownsSession(owner, guard.sessionId)) return "the conversation is gone";
  if (guard.active()) return "the conversation is working again";
  return guard.monthly() ?? spendCapCheck(store, owner, guard.family, guard.model).refusal;
}

/** R17-048 and R17-050: after each answered round. */
export function afterRound(runtime: SavingsRuntime, keepAlive: KeepAlive, round: AnsweredRound): void {
  noteReported(runtime.store, round.run.id, round.estimatedInput, round.reported);
  if (!round.mainRound) return;
  const { store } = runtime;
  const { preset, run } = round;
  // Priced at the larger of Branch's estimate and the service's own count, so the cap is never kept on too low a figure.
  const size = Math.max(round.estimatedInput, round.reported?.input ?? 0);
  const priced = estimateCost(preset.model, { input: size, output: 1 }, pricingSettings(store, round.owner).overrides).amount;
  const guard = round.guard ?? { family: [run.id], active: () => false, monthly: () => null };
  const messages = round.messages.slice(), tools = round.tools.slice();
  keepAlive.arm(round.owner, run.sessionId, preset.provider.name, {
    runId: run.id, price: priced,
    refusal: () => pingRefusal(store, round.owner, { ...guard, sessionId: run.sessionId, model: preset.model }),
    send: async () => {
      // The same account wrapper as every other call, so a connection with several accounts bills the chosen one.
      const answer: Completion = await withAccountCall({ owner: run.owner, sessionId: run.sessionId, runId: run.id, note: (kind, data) => store.event(run.id, kind, data),
        ...(round.trunk ? { trunk: round.trunk } : {}) }, // mac7/lockdown-fix
        () => preset.provider.complete({ messages, tools, maxTokens: 1, signal: AbortSignal.timeout(60_000) }));
      const usage = UsageSchema.safeParse(answer.usage);
      store.addUsage(run.id, round.estimatedInput, 0, usage.success ? usage.data : undefined);
    },
  });
}
