/**
 * The usage report (A0367): what the assistant did and what it probably cost over a week, a month or
 * a quarter, set beside the same stretch before it, written out as a page a person can read or hand
 * on. It is the readable half of the usage figures — the spreadsheet on a schedule is `metering.ts`,
 * the live numbers are the Usage screen — and it uses the one report writer (`reports.ts`), so the
 * same redaction pass runs over it.
 *
 * Everything is counted from this computer's own database. Nothing is sent anywhere. It ships off.
 */
import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import { buildReport, reportFormats, type Report } from "./reports.js";
import { FeatureModeSchema, modeOf, optionalFields, settleSwitch, type FeatureMode } from "./feature-switches.js";
import type { ModelPrice } from "./pricing.js";
import type { Store } from "./store.js";
import { markChosen, sentKeys, shippedUnlessChosen } from "./ship-on.js";
import type { UsageAggregate } from "./usage.js";
import { countedUsageTask } from "./conversation-bootstrap.js";

export const usageReportRanges = ["7d", "30d", "90d"] as const;
export type UsageReportRange = (typeof usageReportRanges)[number];

export const UsageReportSettingsSchema = z.object({
  /** Off until the owner turns it on. There is no tool behind it, so "when needed" and "on" both mean "available". */
  mode: FeatureModeSchema.default("off"),
  enabled: z.boolean().default(false),
  /** The stretch the report covers when nothing else is asked for. */
  range: z.enum(usageReportRanges).default("30d"),
}).strict();
export type UsageReportSettings = z.infer<typeof UsageReportSettingsSchema>;

export const UsageReportRequestSchema = z.object({
  range: z.enum(usageReportRanges).optional(),
  format: z.enum(reportFormats).default("html"),
}).strict();

const settingsKey = "usage-report";
// The owner's rule (ships on, 2026-09-26): the report is made on this computer and sent nowhere; none of (a)–(f).
export const usageReportShipsAs: FeatureMode = "when-needed";
const dayMs = 24 * 60 * 60 * 1000;
const lengthOf: Record<UsageReportRange, number> = { "7d": 7, "30d": 30, "90d": 90 };

export function usageReportSettings(store: Pick<Store, "get">, owner: string): UsageReportSettings {
  const saved = UsageReportSettingsSchema.safeParse(store.get("settings", owner, settingsKey)?.data ?? {});
  const value = saved.success
    ? shippedUnlessChosen(store, owner, settingsKey, saved.data, { mode: usageReportShipsAs })
    : UsageReportSettingsSchema.parse({});
  const mode: FeatureMode = modeOf(value);
  return { ...value, mode, enabled: mode !== "off" };
}

export function saveUsageReportSettings(store: Pick<Store, "get" | "save">, owner: string, input: unknown): UsageReportSettings {
  const current = usageReportSettings(store, owner);
  const wanted = optionalFields(UsageReportSettingsSchema).parse(input ?? {});
  const next = UsageReportSettingsSchema.parse({ ...current, ...wanted, ...settleSwitch(current, wanted) });
  store.save("settings", owner, settingsKey, next);
  if (wanted.mode !== undefined || wanted.enabled !== undefined) markChosen(store, owner, settingsKey, ["mode"]);
  markChosen(store, owner, settingsKey, sentKeys(wanted).filter((field) => field !== "mode" && field !== "enabled"));
  return next;
}

/** The two stretches the report compares: this one, and the same number of days just before it. */
export interface ReportWindow { range: UsageReportRange; from: string; until: string; previousFrom: string }

export function reportWindow(range: UsageReportRange, now: Date = new Date()): ReportWindow {
  const days = lengthOf[range];
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const from = new Date(today - (days - 1) * dayMs).toISOString();
  const previousFrom = new Date(today - (2 * days - 1) * dayMs).toISOString();
  return { range, from, until: now.toISOString(), previousFrom };
}

/** Several days rolled into one stretch, keeping "no price on file" apart from "cost nothing". */
export interface Stretch {
  tasks: number; toolCalls: number; failures: number; tokens: number;
  cost: number; pricedTasks: number; unpricedTasks: number;
  models: { name: string; tasks: number; tokens: number; cost: number | null }[];
  channels: { name: string; tasks: number; cost: number | null }[];
  days: { date: string; tasks: number; tokens: number; cost: number | null }[];
}

type Named = { name: string; tasks: number; cost: number | null; tokens?: number };
function addTo<T extends Named>(list: T[], name: string, make: () => T, tasks: number, cost: number | null, tokens = 0): void {
  let row = list.find((item) => item.name === name);
  if (!row) { row = make(); list.push(row); }
  row.tasks += tasks;
  if (row.tokens !== undefined) row.tokens += tokens;
  if (cost !== null) row.cost = (row.cost ?? 0) + cost;
}

export function rollUp(days: UsageAggregate[]): Stretch {
  const out: Stretch = { tasks: 0, toolCalls: 0, failures: 0, tokens: 0, cost: 0, pricedTasks: 0, unpricedTasks: 0, models: [], channels: [], days: [] };
  for (const day of days) {
    const tokens = day.tokens.input + day.tokens.output;
    out.tasks += day.runs; out.toolCalls += day.toolCalls; out.failures += day.failures; out.tokens += tokens;
    out.pricedTasks += day.pricedRuns; out.unpricedTasks += day.unpricedRuns;
    if (day.pricedRuns) out.cost += day.estimatedCost;
    out.days.push({ date: day.date, tasks: day.runs, tokens, cost: day.pricedRuns ? day.estimatedCost : null });
    for (const p of day.presets)
      addTo(out.models, p.id, () => ({ name: p.id, tasks: 0, tokens: 0, cost: null }), p.runs, p.cost, p.tokens.input + p.tokens.output);
    for (const c of day.byChannel)
      addTo(out.channels, c.source, () => ({ name: c.source, tasks: 0, cost: null }), c.runs, c.cost);
  }
  out.days.sort((a, b) => a.date.localeCompare(b.date));
  out.models.sort((a, b) => (b.cost ?? -1) - (a.cost ?? -1) || b.tasks - a.tasks);
  out.channels.sort((a, b) => b.tasks - a.tasks);
  return out;
}

/** Money a person can read; null means nobody knows, and the report says so. */
export function money(value: number | null): string {
  if (value === null) return "no price on file";
  if (value > 0 && value < 0.01) return "less than $0.01";
  return "$" + value.toFixed(2);
}

/** "up 25%", "down 10%", "the same", or a plain sentence when there is nothing to compare with. */
export function change(now: number, before: number): string {
  if (before === 0) return now === 0 ? "the same as" : "new compared with";
  const percent = Math.round(((now - before) / before) * 100);
  if (percent === 0) return "the same as";
  return percent > 0 ? `up ${percent}% on` : `down ${-percent}% on`;
}

export interface ToolRow { name: string; calls: number; failed: number }
export interface PersonRow { name: string; tasks: number; tokens: number }

/** The tools used most in the stretch, with how often each failed. Names only, never arguments. */
export function toolsUsed(db: DatabaseSync, from: string, until: string, limit = 10): ToolRow[] {
  const rows = db.prepare(
    `SELECT kind, data FROM events WHERE created_at >= ? AND created_at <= ?
     AND kind IN ('tool.completed','tool.failed','tool.stalled')`,
  ).all(from, until) as Array<{ kind: string; data: string }>;
  const found = new Map<string, ToolRow>();
  for (const row of rows) {
    let name = "";
    try { name = String((JSON.parse(row.data) as { name?: unknown }).name ?? ""); } catch { /* an unreadable row names nothing */ }
    if (!name) continue;
    const entry = found.get(name) ?? { name, calls: 0, failed: 0 };
    entry.calls += 1;
    if (row.kind !== "tool.completed") entry.failed += 1;
    found.set(name, entry);
  }
  return [...found.values()].sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name)).slice(0, limit);
}

/** Tasks and tokens for each person who used this computer, by the name they chose. */
export function peopleUsing(db: DatabaseSync, from: string, until: string, names: Map<string, string>): PersonRow[] {
  const rows = db.prepare(
    `SELECT t.owner AS owner, COUNT(*) AS n,
       COALESCE(SUM(MAX(u.reported_input, u.estimated_input) + MAX(u.reported_output, u.estimated_output)), 0) AS tokens
     FROM tasks t LEFT JOIN usage u ON u.run_id = t.id
     WHERE t.created_at >= ? AND t.created_at <= ? AND t.status NOT IN ('running','needs_input') AND ${countedUsageTask(db, "t")}
     GROUP BY t.owner ORDER BY n DESC, t.owner`,
  ).all(from, until) as Array<{ owner: string; n: number; tokens: number | null }>;
  return rows.map((row) => ({ name: names.get(row.owner) ?? "Someone no longer on this computer", tasks: Number(row.n), tokens: Number(row.tokens ?? 0) }))
    .sort((a, b) => b.tasks - a.tasks || a.name.localeCompare(b.name));
}

export interface UsageReportInput {
  window: ReportWindow;
  current: Stretch;
  previous: Stretch;
  tools: ToolRow[];
  people: PersonRow[];
  records: { label: string; count: number }[];
}

function summary({ window, current, previous }: UsageReportInput): string {
  const days = lengthOf[window.range];
  const lines = [
    `In the last ${days} days your assistant finished ${current.tasks} task(s), ${change(current.tasks, previous.tasks)} the ${days} days before (${previous.tasks}).`,
    `It used ${current.tokens.toLocaleString("en-US")} tokens and made ${current.toolCalls} tool call(s); ${current.failures} thing(s) went wrong.`,
  ];
  if (current.pricedTasks === 0) lines.push("No task in this stretch used a model with a price on file, so there is no money to add up.");
  else lines.push(`Estimated cost: ${money(current.cost)} for the ${current.pricedTasks} task(s) with a price on file, ${previous.pricedTasks ? `${change(current.cost, previous.cost)} ${money(previous.cost)} before` : "with nothing priced to compare it with before"}.`);
  if (current.unpricedTasks) lines.push(`${current.unpricedTasks} task(s) used a model with no price on file, so they are not in that figure. Add a price under Settings → Data to count them.`);
  lines.push("These are estimates from the prices on file, not a bill.");
  return lines.join("\n");
}

const listOr = (rows: string[], empty: string): string => (rows.length ? rows.join("\n") : empty);

/** The report's sections, in the order a person reads them: the sentence first, the detail after. */
export function usageReportSections(input: UsageReportInput): { heading: string; body: string }[] {
  const { current, tools, people, records } = input;
  const sections = [
    { heading: "In short", body: summary(input) },
    { heading: "Day by day", body: listOr(current.days.map((d) => `- ${d.date}: ${d.tasks} task(s), ${d.tokens.toLocaleString("en-US")} tokens, ${money(d.cost)}`), "No finished task in this stretch.") },
    { heading: "By model", body: listOr(current.models.map((m) => `- ${m.name}: ${m.tasks} task(s), ${m.tokens.toLocaleString("en-US")} tokens, ${money(m.cost)}`), "No model answered in this stretch.") },
    { heading: "By where tasks came from", body: listOr(current.channels.map((c) => `- ${c.name}: ${c.tasks} task(s), ${money(c.cost)}`), "Nothing came in during this stretch.") },
    { heading: "Tools used most", body: listOr(tools.map((t) => `- ${t.name}: ${t.calls} call(s)${t.failed ? `, ${t.failed} failed` : ""}`), "No tool was used in this stretch.") },
  ];
  if (people.length > 1) sections.push({ heading: "By person on this computer", body: people.map((p) => `- ${p.name}: ${p.tasks} task(s), ${p.tokens.toLocaleString("en-US")} tokens`).join("\n") });
  const written = records.filter((r) => r.count > 0);
  sections.push({ heading: "What was written in the record", body: listOr(written.map((r) => `- ${r.label}: ${r.count}`), "Nothing was written in the record of what the assistant was allowed to do.") });
  return sections;
}

export interface UsageReportDeps {
  store: Store;
  owner: string;
  aggregate: (range: "30d" | "90d" | "all", overrides: Record<string, ModelPrice>) => UsageAggregate[];
  overrides: Record<string, ModelPrice>;
  now?: Date;
}

const widerRange: Record<UsageReportRange, "30d" | "90d" | "all"> = { "7d": "30d", "30d": "90d", "90d": "all" };

/** Gathers the figures for one report. The caller has already checked the switch. */
export function gatherUsageReport(deps: UsageReportDeps, range: UsageReportRange): UsageReportInput {
  const window = reportWindow(range, deps.now);
  const days = deps.aggregate(widerRange[range], deps.overrides);
  const fromDay = window.from.slice(0, 10), previousDay = window.previousFrom.slice(0, 10);
  const current = rollUp(days.filter((d) => d.date >= fromDay));
  const previous = rollUp(days.filter((d) => d.date >= previousDay && d.date < fromDay));
  const db = deps.store.sqlite;
  const names = new Map<string, string>([[deps.owner, "You (the owner)"]]);
  for (const profile of deps.store.profiles.list()) names.set(`profile:${profile.id}`, profile.name);
  const records = deps.store.audit.list(deps.owner, { from: window.from, to: window.until, limit: 1000 });
  const counted = new Map<string, number>();
  for (const entry of records) counted.set(entry.action, (counted.get(entry.action) ?? 0) + 1);
  const labels = deps.store.audit.counts(deps.owner).map((row) => ({ label: row.label, count: counted.get(row.action) ?? 0 }));
  return {
    window, current, previous,
    tools: toolsUsed(db, window.from, window.until),
    people: peopleUsing(db, window.from, window.until, names),
    records: labels,
  };
}

/** The whole report, in the form asked for. Refuses in one sentence while the switch is off. */
export function usageReport(deps: UsageReportDeps, input: unknown): Report {
  const settings = usageReportSettings(deps.store, deps.owner);
  if (settings.mode === "off")
    throw new Error("The usage report is switched off. Turn it on under Settings → Data → Usage report.");
  const wanted = UsageReportRequestSchema.parse(input ?? {});
  const range = wanted.range ?? settings.range;
  const gathered = gatherUsageReport(deps, range);
  const title = `Usage report, last ${lengthOf[range]} days`;
  const subtitle = `${gathered.window.from.slice(0, 10)} to ${gathered.window.until.slice(0, 10)}, compared with the ${lengthOf[range]} days before`;
  return buildReport({ title, subtitle, sections: usageReportSections(gathered), format: wanted.format });
}
