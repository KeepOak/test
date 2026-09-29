import { z } from "zod";
import { forgetChosen, markChosen, sentKeys, shippedUnlessChosen } from "../ship-on.js";
import type { Store } from "../store.js";

/**
 * R17-E: models, cheaper and smarter. Each card has its own record, and every default below is
 * exactly what Branch did before the card existed: nothing extra is sent, nothing is routed, no
 * connection is added and nothing is spent. The sub-task and side-job models, thinking effort and
 * service tier are R17-S-B's (src/knobs/) and are not repeated here.
 */
const presetId = z.string().min(1).max(64).regex(/^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/i);
const switchMode = z.enum(["off", "on"]);
/** The owner's three-way switch: "when needed" asks only when the cheap signals cannot tell. */
const threeWay = z.enum(["off", "on", "when-needed"]);
const slug = z.string().trim().min(1).max(80).regex(/^[a-z0-9][a-z0-9._/-]*$/i);

/**
 * R17-044: which connection drafts a plan before the work starts; null uses the conversation's own.
 * R17-045: the questions asked on the side (plans, reviews, summaries, the easy-or-hard question)
 * may ask OpenAI for its slower, cheaper flex tier. The main answer keeps R17-S-B's service tier.
 */
export const PhaseModelSettingsSchema = z.object({
  planModel: presetId.nullable().default(null),
  sideTier: z.enum(["same", "flex"]).default("same"),
}).strict();

/** R17-046: OpenRouter's own choice of which company serves a model. Sent only to openrouter.ai. */
export const OpenRouterSettingsSchema = z.object({
  mode: switchMode.default("off"),
  /** What OpenRouter should prefer; null leaves its own balance. */
  sort: z.enum(["price", "throughput", "latency"]).nullable().default(null),
  /** Companies to try first, in this order. */
  order: z.array(slug).max(16).default([]),
  /** Only ever these companies (empty: any). */
  only: z.array(slug).max(16).default([]),
  /** Never these companies. */
  ignore: z.array(slug).max(16).default([]),
  /** Whether OpenRouter may try another company when the preferred ones fail. */
  allowFallbacks: z.boolean().default(true),
  /** "deny" keeps the request away from companies that may keep or train on it. */
  dataCollection: z.enum(["allow", "deny"]).default("allow"),
}).strict();

/** R17-047: a small model says whether a task is easy or hard, and the answer picks the connection. */
export const DifficultySettingsSchema = z.object({
  mode: threeWay.default("off"),
  /** Which connection answers the easy-or-hard question; null uses a model on this computer when there is one, else the easy connection. */
  classifierModel: presetId.nullable().default(null),
  easyModel: presetId.nullable().default(null),
  hardModel: presetId.nullable().default(null),
  /**
   * Settings › Models › Mix models on hard questions: a hard task is asked of the hard connection and the easy one, and
   * the hard connection writes the one answer from both (a mixture, src/model-savings/mixture.ts `hardMixture`). Off until
   * the owner chooses: it asks two models, so it costs more.
   */
  mixHard: z.boolean().default(false),
}).strict();

/** R17-048: also count what the service says a request held when deciding to fold a conversation. */
export const ReportedTokensSettingsSchema = z.object({
  mode: switchMode.default("off"),
}).strict();

/** R17-049: the per-round chart under the composer's meter. */
export const RoundChartSettingsSchema = z.object({
  mode: switchMode.default("off"),
}).strict();

/**
 * R17-050: keep the service's prompt cache warm during a pause. Needs its own "on" and a spending
 * cap, and stops after a set number of pings, whichever comes first.
 */
export const KeepAliveSettingsSchema = z.object({
  mode: switchMode.default("off"),
  everyMinutes: z.number().int().min(1).max(55).default(4),
  maxPings: z.number().int().min(1).max(12).default(3),
  /** Most the pings after one task may cost, in dollars. Always set; there is no "no cap". */
  spendCapDollars: z.number().min(0.001).max(5).default(0.05),
}).strict();

/**
 * Settings › Models › Slow down near a rate limit: spreads a connection's requests out once the service says less than
 * a tenth of its allowance is left (src/model-savings/pacing.ts). On as shipped: it spends nothing and sends nothing;
 * it only waits, at most 15 seconds a request.
 */
export const PacingSettingsSchema = z.object({
  mode: switchMode.default("on"),
}).strict();

/** R17-051: one mixture: several connections answer, and one of them writes the final answer. */
export const MixtureSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).min(1).max(40),
  name: z.string().trim().min(1).max(60),
  references: z.array(presetId).min(2).max(4),
  aggregator: presetId,
  /** Most tokens each reference answer may use. */
  referenceMaxTokens: z.number().int().min(64).max(4096).default(1024),
}).strict();
export const MixtureSettingsSchema = z.object({
  mixtures: z.array(MixtureSchema).max(4).default([]),
}).strict();
export type Mixture = z.infer<typeof MixtureSchema>;

export const savingsCards = {
  phases: PhaseModelSettingsSchema,
  openrouter: OpenRouterSettingsSchema,
  difficulty: DifficultySettingsSchema,
  reportedTokens: ReportedTokensSettingsSchema,
  roundChart: RoundChartSettingsSchema,
  keepAlive: KeepAliveSettingsSchema,
  mixtures: MixtureSettingsSchema,
  pacing: PacingSettingsSchema,
} as const;
export type SavingsCard = keyof typeof savingsCards;
export type SavingsValues = { [K in SavingsCard]: z.infer<(typeof savingsCards)[K]> };
export const savingsCardNames = Object.keys(savingsCards) as SavingsCard[];

const keyOf = (card: SavingsCard): string => `model-savings-${card}`;
type Reader = Pick<Store, "get">;

/**
 * The owner's rule (ships on, 2026-09-26): counting the tokens a service reports and the per-round chart only read what
 * already came back; none of (a)–(f). The rest stay off: a classifier call per task, cache pings and mixtures spend on
 * their own (a), and OpenRouter's routing and the plan model are the owner's pick of where to send work.
 */
const savingsShipOn: Partial<Record<SavingsCard, Record<string, unknown>>> = { reportedTokens: { mode: "on" }, roundChart: { mode: "on" } };

/** One card, with today's behaviour for anything never saved or saved wrongly. */
export function readSavings<K extends SavingsCard>(store: Reader, owner: string, card: K): SavingsValues[K] {
  const schema = savingsCards[card] as unknown as z.ZodType<SavingsValues[K]>;
  const saved = schema.safeParse(store.get("settings", owner, keyOf(card))?.data ?? {});
  if (!saved.success) return schema.parse({});
  const ships = savingsShipOn[card];
  return ships ? shippedUnlessChosen(store, owner, keyOf(card), saved.data as Record<string, unknown>, ships) as SavingsValues[K] : saved.data;
}

/** Saves one card; fields left out keep what was there. */
export function saveSavings<K extends SavingsCard>(store: Store, owner: string, card: K, input: unknown): SavingsValues[K] {
  const schema = savingsCards[card] as unknown as z.ZodType<SavingsValues[K]>;
  const next = schema.parse({ ...readSavings(store, owner, card), ...(input && typeof input === "object" ? input : {}) });
  store.save("settings", owner, keyOf(card), next as Record<string, unknown>);
  markChosen(store, owner, keyOf(card), sentKeys(input));
  return next;
}

export function allSavings(store: Reader, owner: string): SavingsValues {
  return Object.fromEntries(savingsCardNames.map((card) => [card, readSavings(store, owner, card)])) as SavingsValues;
}

export function resetSavings(store: Store, owner: string, card: SavingsCard): void {
  store.save("settings", owner, keyOf(card), {});
  forgetChosen(store, owner, keyOf(card));
}
