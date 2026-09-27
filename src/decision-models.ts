import { z } from "zod";
import { declareShape, type AnswerShape, type ShapedAnswer } from "./answer-shape.js";
import type { ModelPreset, ModelRouter } from "./models.js";
import { presetRunsLocally } from "./models.js";
import type { Store } from "./store.js";

/**
 * P17-D §4: decision models. Small, bounded judgments (yes or no, pick one, a score from 1 to 10, keep or drop each
 * line of a list) asked of a model the owner chooses, with no tools and no conversation. Unlike JEV
 * (src/jev-decisions.ts, an outside program that ships off) this uses the connections Branch already has, so a model
 * on this computer decides for free and nothing leaves it.
 *
 * Every answer is checked, never trusted: a pick must be one of the choices offered, a filter may keep only lines it
 * was given, and a score must be 1 to 10; anything else is refused in words and no decision is made. When the
 * decision model is less sure than the owner's threshold, the task's own model is asked instead. A list longer than
 * the owner's limit is split. Each decision's time is kept (not its words) for the "last 24 hours" line.
 */
export const DecisionSettingsSchema = z.object({
  /** The connection that decides, by preset id; empty means the same model as the task. */
  model: z.string().trim().max(64).default(""),
  /** Below this, the task's own model decides instead. */
  minConfidence: z.number().min(0.5).max(0.99).default(0.75),
  /** The longest list it filters at once; longer lists are split. */
  maxList: z.number().int().min(10).max(2000).default(400),
}).strict();
export type DecisionSettings = z.infer<typeof DecisionSettingsSchema>;

const question = z.string().trim().min(1).max(1000);
const line = z.string().trim().min(1).max(500);
export const DecisionInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("yes"), question }).strict(),
  z.object({ kind: z.literal("pick"), question, options: z.array(z.string().trim().min(1).max(80)).min(2).max(20)
    .refine((all) => new Set(all.map((o) => o.toLowerCase())).size === all.length, "Name each choice once") }).strict(),
  z.object({ kind: z.literal("score"), question }).strict(),
  z.object({ kind: z.literal("filter"), question, items: z.array(line).min(1).max(2000) }).strict(),
]);
export type DecisionInput = z.infer<typeof DecisionInputSchema>;

const sure = z.number().min(0).max(1);
const why = z.string().max(300);
const SHAPES = {
  yes: declareShape("decision_yes", z.object({ answer: z.boolean(), confidence: sure, why }).strict()),
  pick: declareShape("decision_pick", z.object({ choice: z.string().max(80), confidence: sure, why }).strict()),
  score: declareShape("decision_score", z.object({ score: z.number().int().min(1).max(10), confidence: sure, why }).strict()),
  filter: declareShape("decision_filter", z.object({ keep: z.array(z.number().int().min(1)).max(2000), confidence: sure }).strict()),
};
type Raw = { answer?: boolean; choice?: string; score?: number; keep?: number[]; confidence: number; why?: string };

/** Asks one shaped question of one connection (src/runtime.ts `shaped`, with no tools). */
export type DecisionAsk = (text: string, shape: AnswerShape, preset: ModelPreset) => Promise<ShapedAnswer>;

export interface DecisionResult {
  kind: DecisionInput["kind"];
  verdict?: "yes" | "no"; choice?: string; score?: number; kept?: string[]; dropped?: string[];
  why: string; confidence: number; ms: number;
  model: { name: string; local: boolean };
  /** True when the decision model was less sure than the threshold and the task's own model decided. */
  escalated: boolean;
}

// One declaration each, so tests/settings-history-writers.test.mjs can read both keys (neither is a Settings setting).
const settingsKey = "decision-models";
const logKey = "decision-log";
const LogSchema = z.object({ entries: z.array(z.object({ at: z.number(), ms: z.number() })).default([]) }).strict();

function prompt(input: DecisionInput): string {
  if (input.kind === "yes") return `Answer yes or no. Question: ${input.question}`;
  if (input.kind === "pick") return `Pick exactly one of these choices, written as given: ${input.options.join(" | ")}.\nQuestion: ${input.question}`;
  if (input.kind === "score") return `Give a score from 1 to 10. Question: ${input.question}`;
  return `Decide which numbered lines to keep, and give their numbers in "keep". Rule: ${input.question}\n`
    + input.items.map((item, index) => `${index + 1}. ${item}`).join("\n");
}

/** The model's answer, checked against what it was offered. Throws in words when it does not fit. */
export function checkDecision(input: DecisionInput, raw: Raw): Omit<DecisionResult, "ms" | "model" | "escalated"> {
  const base = { kind: input.kind, confidence: raw.confidence, why: raw.why ?? "" };
  if (input.kind === "yes") return { ...base, verdict: raw.answer ? "yes" : "no" };
  if (input.kind === "score") return { ...base, score: raw.score! };
  if (input.kind === "pick") {
    const choice = input.options.find((option) => option.toLowerCase() === String(raw.choice ?? "").trim().toLowerCase());
    if (!choice) throw new Error("The model picked something that was not one of the choices, so no decision was made.");
    return { ...base, choice };
  }
  const keep = new Set(raw.keep ?? []);
  if ([...keep].some((n) => n < 1 || n > input.items.length))
    throw new Error("The model kept a line it was not given, so no decision was made.");
  return { ...base, kept: input.items.filter((_, i) => keep.has(i + 1)), dropped: input.items.filter((_, i) => !keep.has(i + 1)) };
}

export class DecisionModels {
  constructor(private readonly store: Store, private readonly owner: string, private readonly models: ModelRouter,
    private readonly ask: DecisionAsk) {}

  settings(): DecisionSettings {
    const parsed = DecisionSettingsSchema.safeParse(this.store.get("settings", this.owner, settingsKey)?.data ?? {});
    return parsed.success ? parsed.data : DecisionSettingsSchema.parse({});
  }
  configure(input: unknown): DecisionSettings {
    const next = DecisionSettingsSchema.parse({ ...this.settings(), ...(input as object ?? {}) });
    if (next.model && !this.models.presets.has(next.model)) throw Object.assign(new Error("That model is not one of your connections."), { status: 400 });
    this.store.save("settings", this.owner, settingsKey, next);
    return next;
  }
  /** The settings, the connections that can decide, and the last 24 hours in numbers. */
  overview() {
    const day = Date.now() - 86_400_000;
    const recent = this.log().filter((entry) => entry.at >= day);
    return { settings: this.settings(), taskModel: this.models.default.id,
      models: [...this.models.presets.values()].map((preset) => ({ id: preset.id, name: preset.name, local: presetRunsLocally(preset) })),
      lastDay: { decisions: recent.length, averageMs: recent.length ? Math.round(recent.reduce((sum, e) => sum + e.ms, 0) / recent.length) : null } };
  }

  async decide(raw: unknown): Promise<DecisionResult> {
    const input = DecisionInputSchema.parse(raw), settings = this.settings(), started = Date.now();
    const taskModel = this.models.default;
    const chosen = (settings.model && this.models.presets.get(settings.model)) || taskModel;
    let result = await this.once(input, chosen, settings.maxList);
    let escalated = false, used = chosen;
    if (result.confidence < settings.minConfidence && chosen.id !== taskModel.id) {
      result = await this.once(input, taskModel, settings.maxList);
      escalated = true; used = taskModel;
    }
    const ms = Date.now() - started;
    this.remember(ms);
    return { ...result, ms, escalated, model: { name: used.name, local: presetRunsLocally(used) } };
  }

  /** One decision on one connection; a long list is split and its parts decided one after another. */
  private async once(input: DecisionInput, preset: ModelPreset, maxList: number) {
    if (input.kind !== "filter" || input.items.length <= maxList) return this.single(input, preset);
    const parts: ReturnType<typeof checkDecision>[] = [];
    for (let start = 0; start < input.items.length; start += maxList)
      parts.push(await this.single({ ...input, items: input.items.slice(start, start + maxList) }, preset));
    return { kind: input.kind, why: "", confidence: Math.min(...parts.map((p) => p.confidence)),
      kept: parts.flatMap((p) => p.kept ?? []), dropped: parts.flatMap((p) => p.dropped ?? []) };
  }
  private async single(input: DecisionInput, preset: ModelPreset) {
    const answer = await this.ask(prompt(input), SHAPES[input.kind], preset);
    if (answer.status === "refused") throw new Error(answer.reason);
    return checkDecision(input, answer.value as Raw);
  }

  private log() {
    const parsed = LogSchema.safeParse(this.store.get("settings", this.owner, logKey)?.data ?? {});
    return parsed.success ? parsed.data.entries : [];
  }
  private remember(ms: number): void {
    this.store.save("settings", this.owner, logKey, { entries: [...this.log(), { at: Date.now(), ms }].slice(-1000) });
  }
}
