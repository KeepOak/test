import { z } from "zod";
import { FeatureModeSchema, type FeatureMode } from "./feature-switches.js";
import { runtimeIds, type RuntimeId } from "./local-launch.js";
import type { Store } from "./store.js";
import { markChosen, shippedUnlessChosen, unsetRecord } from "./ship-on.js";

/**
 * Wave mac5 (local models): the switch, and the written-down record of each one-click setup, so a
 * download that was running when Branch closed carries on when it opens again.
 *
 *   off          nothing here does anything; the screen shows the switch only
 *   when-needed  (how it ships) one click works, and an interrupted setup resumes when Branch starts
 *   on           the same, and Branch also starts the runtime of your local connections when it starts
 *
 * The owner's rule (2026-09-27): a local model is heavy only while it is used, and "when needed" starts nothing by
 * itself, so it ships on. "On" keeps a runtime going from start-up (heavy, (e)) and is the owner's to pick.
 */
export const localModelsShipsAs: FeatureMode = "when-needed";
export const localModelsSetting = "local-models";
const SwitchRow = z.object({ mode: FeatureModeSchema.optional(), enabled: z.boolean().optional() }).loose();

export function localModelsMode(store: Pick<Store, "get">, owner: string): FeatureMode {
  const data = store.get("settings", owner, localModelsSetting)?.data;
  if (unsetRecord(data)) return localModelsShipsAs;
  const row = SwitchRow.safeParse(data);
  if (!row.success) return "off";
  const mode: FeatureMode = row.data.mode ?? (row.data.enabled ? "when-needed" : "off");
  return shippedUnlessChosen(store, owner, localModelsSetting, { mode }, { mode: localModelsShipsAs }).mode;
}
export function saveLocalModelsMode(store: Store, owner: string, input: unknown): { mode: FeatureMode } {
  const mode = z.object({ mode: FeatureModeSchema }).strict().parse(input).mode;
  const current = (store.get("settings", owner, localModelsSetting)?.data ?? {}) as Record<string, unknown>;
  store.save("settings", owner, localModelsSetting, { ...current, mode, enabled: mode !== "off" });
  markChosen(store, owner, localModelsSetting, ["mode"]);
  return { mode };
}
export const switchedOffNote = "Models on this computer are switched off. Turn them on at the top of this card first.";
export function assertLocalModelsOn(store: Pick<Store, "get">, owner: string): void {
  if (localModelsMode(store, owner) === "off") throw new Error(switchedOffNote);
}

const runtimeEnum = z.enum(runtimeIds as [RuntimeId, ...RuntimeId[]]);
export const SetupRequestSchema = z.union([
  z.object({ runtime: runtimeEnum.optional(), model: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,40}$/), quant: z.string().regex(/^[A-Za-z0-9_]{2,16}$/), force: z.boolean().default(false) }).strict(),
  // `found`: the model is already in Ollama or LM Studio on this computer, so it is used as it is and never fetched again.
  z.object({ runtime: runtimeEnum.optional(), name: z.string().trim().min(1).max(300), force: z.boolean().default(false), found: z.literal(true).optional(), backend: z.string().trim().min(1).max(300).optional(), context: z.number().int().min(512).max(8192).optional() }).strict(),
]);
export type SetupRequest = z.infer<typeof SetupRequestSchema>;

export const stages = ["checking", "installing", "starting", "downloading", "loading", "connecting", "done", "failed", "stopped"] as const;
export type Stage = (typeof stages)[number];
const JobSchema = z.object({
  id: z.string().max(80),
  runtime: runtimeEnum,
  request: z.record(z.string(), z.unknown()),
  label: z.string().max(120),
  stage: z.enum(stages),
  message: z.string().max(400),
  completed: z.number().nonnegative(),
  total: z.number().nonnegative(),
  percent: z.number().min(0).max(100),
  context: z.number().int().nonnegative(),
  connectionId: z.string().max(64).nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
}).strict();
export type SetupJob = z.infer<typeof JobSchema>;
export const jobsSetting = "local-model-setups";
const JobsRow = z.object({ jobs: z.array(JobSchema).max(40).default([]) }).strict();

/** The written-down setups, newest first. */
export class SetupJobs {
  constructor(private readonly store: Store, private readonly owner: string) {}
  all(): SetupJob[] {
    const row = JobsRow.safeParse(this.store.get("settings", this.owner, jobsSetting)?.data ?? {});
    return row.success ? [...row.data.jobs].sort((a, b) => b.startedAt.localeCompare(a.startedAt)) : [];
  }
  get(id: string): SetupJob | undefined { return this.all().find((job) => job.id === id); }
  put(job: SetupJob): SetupJob {
    const valid = JobSchema.parse(job);
    const others = this.all().filter((one) => one.id !== job.id);
    const kept = [valid, ...others].slice(0, 40);
    this.store.save("settings", this.owner, jobsSetting, { jobs: kept });
    return valid;
  }
  update(id: string, change: Partial<SetupJob>): SetupJob | undefined {
    const job = this.get(id);
    return job ? this.put({ ...job, ...change }) : undefined;
  }
  /** Setups that were still going when Branch last closed. */
  unfinished(): SetupJob[] { return this.all().filter((job) => job.finishedAt === null); }
  forget(id: string): void {
    this.store.save("settings", this.owner, jobsSetting, { jobs: this.all().filter((job) => job.id !== id) });
  }
}
