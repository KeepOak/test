/**
 * Execution counters sent to a collector the owner runs (A1751).
 *
 * Other agents emit "anonymous execution metrics" to their makers. Branch never does: there is no
 * telemetry, and there never will be (docs/configuration.md). What the owner *can* have is the same
 * measurements — tasks started, finished and failed, tokens, estimated money, tool calls and
 * failures — sent to the address they typed under Settings → Advanced → Traces, which is theirs.
 *
 * The switch has three positions and ships "when needed" (the owner's rule, 2026-09-27: nothing leaves without the
 * owner's press, and only to the address the owner typed, so it is none of (a)–(f)):
 *   off          nothing is ever sent
 *   when-needed  sent only when the owner presses "Send the counters now"
 *   on           sent after a task finishes, at most once every `minutesBetween` minutes
 * Nothing goes anywhere unless sending traces is also on, because that is where the address is.
 * The counters carry no names, no prompts, no files and no identifier of the person or computer.
 */
import { z } from "zod";
import type { MetricPoint } from "./tracing-shapes.js";
import { FeatureModeSchema, modeOf, optionalFields, settleSwitch, type FeatureMode } from "./feature-switches.js";
import type { Store } from "./store.js";
import { markChosen, shippedUnlessChosen, unsetRecord } from "./ship-on.js";
import { collectMetrics } from "./metrics.js";
import { pricingSettings } from "./pricing.js";

export const ExecutionMetricsSchema = z.object({
  mode: FeatureModeSchema.default("off"),
  enabled: z.boolean().default(false),
  /** The shortest gap between two sends after tasks, so a busy hour is not a flood. */
  minutesBetween: z.number().int().min(1).max(1440).default(15),
  /** When the counters last went out. Branch fills this in; it is not a setting. */
  lastSentAt: z.string().optional(),
}).strict();
export type ExecutionMetricsSettings = z.infer<typeof ExecutionMetricsSchema>;

const settingsKey = "execution-metrics";

export const executionMetricsShipsAs: FeatureMode = "when-needed";

export function executionMetricsSettings(store: Pick<Store, "get">, owner: string): ExecutionMetricsSettings {
  const data = store.get("settings", owner, settingsKey)?.data;
  if (unsetRecord(data)) return { ...ExecutionMetricsSchema.parse({}), mode: executionMetricsShipsAs, enabled: true };
  const saved = ExecutionMetricsSchema.safeParse(data);
  if (!saved.success) return ExecutionMetricsSchema.parse({});
  // The record also holds the gap between sends, so an "off" beside it may be the old default (src/ship-on.ts).
  const value = shippedUnlessChosen(store, owner, settingsKey, { ...saved.data, mode: modeOf(saved.data) }, { mode: executionMetricsShipsAs });
  const mode: FeatureMode = modeOf(value);
  return { ...value, mode, enabled: mode !== "off" };
}

export function saveExecutionMetricsSettings(store: Pick<Store, "get" | "save">, owner: string, input: unknown): ExecutionMetricsSettings {
  const current = executionMetricsSettings(store, owner);
  const wanted = optionalFields(ExecutionMetricsSchema.omit({ lastSentAt: true })).parse(input ?? {});
  const next = ExecutionMetricsSchema.parse({ ...current, ...wanted, ...settleSwitch(current, wanted) });
  store.save("settings", owner, settingsKey, next);
  markChosen(store, owner, settingsKey, switchSent(wanted));
  return next;
}

/** A change that names the switch or its older yes/no chose the switch. */
const switchSent = (wanted: { mode?: unknown; enabled?: unknown }): string[] => (wanted.mode !== undefined || wanted.enabled !== undefined ? ["mode"] : []);

/** What sending needs, handed in so a test can give fakes. */
export interface ExecutionMetricsDeps {
  store: Pick<Store, "get" | "save">;
  owner: string;
  /** Whether sending traces is on, which is where the owner's address lives. */
  sendingOn: () => boolean;
  /** The counters as they stand now (src/metrics.ts `collectMetrics`). */
  counters: () => MetricPoint[];
  /** The exporter's `sendMetrics`, which checks the address rules and writes the record. */
  send: (points: MetricPoint[], reason: string) => Promise<{ ok: boolean; error: string | null } | null>;
  now?: () => Date;
}

export type SendOutcome = { sent: boolean; reason: string };

async function sendNow(deps: ExecutionMetricsDeps, settings: ExecutionMetricsSettings, reason: string): Promise<SendOutcome> {
  if (!deps.sendingOn())
    return { sent: false, reason: "Sending traces is off, so there is no address of yours to send the counters to." };
  const result = await deps.send(deps.counters(), reason);
  if (!result) return { sent: false, reason: "Sending traces is off, so nothing was sent." };
  if (!result.ok) return { sent: false, reason: result.error ?? "The counters did not arrive." };
  const at = (deps.now?.() ?? new Date()).toISOString();
  deps.store.save("settings", deps.owner, settingsKey, { ...settings, lastSentAt: at });
  return { sent: true, reason: "The counters were sent to your address." };
}

/** "Send the counters now". Works in both "when needed" and "on"; refuses while off. */
export async function sendExecutionMetrics(deps: ExecutionMetricsDeps): Promise<SendOutcome> {
  const settings = executionMetricsSettings(deps.store, deps.owner);
  if (settings.mode === "off")
    return { sent: false, reason: "Sending the counters is switched off." };
  return sendNow(deps, settings, "You sent the task counters to the address you chose");
}

/** Called after a task finishes. Sends only in "on", and not again inside the quiet gap. */
export async function afterTaskMetrics(deps: ExecutionMetricsDeps): Promise<SendOutcome> {
  const settings = executionMetricsSettings(deps.store, deps.owner);
  if (settings.mode !== "on") return { sent: false, reason: "Counters go out after tasks only when the switch is on." };
  const now = (deps.now?.() ?? new Date()).getTime();
  const last = settings.lastSentAt ? Date.parse(settings.lastSentAt) : 0;
  if (now - last < settings.minutesBetween * 60_000) return { sent: false, reason: "Sent recently; waiting for the quiet gap to pass." };
  return sendNow(deps, settings, "The task counters were sent to the address you chose after a task finished");
}

/** The real wiring: this computer's counters, the owner's trace address, and the exporter. */
export function executionMetricsDeps(
  store: Store, owner: string,
  exporter: { settings(): { enabled: boolean }; sendMetrics(points: MetricPoint[], reason: string): Promise<{ ok: boolean; error: string | null } | null> },
): ExecutionMetricsDeps {
  return {
    store, owner,
    sendingOn: () => exporter.settings().enabled,
    counters: () => {
      const { overrides } = pricingSettings(store, owner);
      const monthly = store.usageStore().getMonthlyStats(undefined, overrides);
      return collectMetrics(store.sqlite, owner, monthly.estimatedCost).points;
    },
    send: (points, reason) => exporter.sendMetrics(points, reason),
  };
}
