import type { UsageAggregate } from "../usage.js";
import { pricingSettings } from "../pricing.js";
import type { Call, Reply } from "./handlers.js";

type Group = { runs: number; input: number; output: number; cost: number | null };
const count = (value: number): string => value.toLocaleString("en-US");
const label = (value: string): string => value.replace(/[\r\n\x00-\x1f\x7f]/g, " ").slice(0, 100) || "unknown";
const money = (value: number | null): string => value === null ? "price unknown" : `about $${value.toFixed(2)}`;

function add(groups: Map<string, Group>, key: string, runs: number, input: number, output: number, cost: number | null): void {
  const group = groups.get(key) ?? { runs: 0, input: 0, output: 0, cost: null };
  group.runs += runs; group.input += input; group.output += output;
  if (cost !== null) group.cost = (group.cost ?? 0) + cost;
  groups.set(key, group);
}

/** The existing usage collector counts each completed task once and retains unknown prices. */
export function insightLines(days: readonly UsageAggregate[], scope: string): string[] {
  const totals = { runs: 0, calls: 0, input: 0, output: 0, cost: 0, priced: 0, unknown: 0, failures: 0 };
  const models = new Map<string, Group>(), sources = new Map<string, Group>();
  for (const day of days) {
    totals.runs += day.runs; totals.calls += day.toolCalls; totals.input += day.tokens.input; totals.output += day.tokens.output;
    totals.cost += day.estimatedCost; totals.priced += day.pricedRuns; totals.unknown += day.unpricedRuns; totals.failures += day.failures;
    for (const model of day.presets) add(models, model.model || model.id, model.runs, model.tokens.input, model.tokens.output, model.cost);
    for (const source of day.byChannel) add(sources, source.source, source.runs, 0, 0, source.cost);
  }
  const lines = [`Last 30 days · ${scope} · completed tasks only`,
    `${count(totals.runs)} tasks · ${count(totals.calls)} tool calls · ${days.length} active days`,
    `${count(totals.input)} tokens in · ${count(totals.output)} out`,
    `${totals.priced ? money(totals.cost) : "No priced tasks"} · ${count(totals.unknown)} tasks have unknown prices`,
    `${count(totals.failures)} recorded failures (tool and task failures can both count)`];
  if (!totals.runs) return [...lines, "No completed tasks were recorded in this period."];
  const topModels = [...models].sort((a, b) => (b[1].input + b[1].output) - (a[1].input + a[1].output)).slice(0, 5);
  if (topModels.length) lines.push("Models by tokens:", ...topModels.map(([name, m]) =>
    `${label(name)}: ${count(m.runs)} tasks · ${count(m.input + m.output)} tokens · ${money(m.cost)}`));
  const topSources = [...sources].sort((a, b) => b[1].runs - a[1].runs).slice(0, 5);
  if (topSources.length) lines.push("Sources by tasks:", ...topSources.map(([name, s]) => `${label(name)}: ${count(s.runs)} tasks · ${money(s.cost)}`));
  lines.push("Recent active days:", ...days.slice(0, 5).map((d) => `${d.date}: ${count(d.runs)} tasks · ${count(d.tokens.input + d.tokens.output)} tokens`),
    "Costs are estimates for tasks with known prices, not a provider bill. Running tasks and older unretained records are excluded.");
  return lines;
}

/** Chat and restricted keys see this conversation; aggregate owner usage stays in owner surfaces. */
export function insightsCommand(call: Call): Reply {
  const { runtime } = call.host, argument = call.argument.trim().toLowerCase();
  if (argument && !["all", "conversation"].includes(argument)) return { text: "Use /insights, /insights conversation, or /insights all." };
  const global = call.surface !== "chat" && call.access === "full" && argument !== "conversation";
  if (argument === "all" && !global) return { text: "All-conversation insights are available in Branch with this computer's owner key. Here, use /insights for this conversation." };
  if (global) call.host.requireOwner("All-conversation usage insights");
  else if (!call.sessionId || !runtime.store.ownsSession(runtime.owner, call.sessionId))
    return { text: "Open your conversation first to see its last 30 days of usage." };
  const { overrides } = pricingSettings(runtime.store, runtime.owner);
  const days = runtime.store.usageStore().aggregateUsage("30d", "day", overrides,
    (id) => runtime.store.ownsSession(runtime.owner, id) && (global || id === call.sessionId));
  return { text: runtime.hideSecrets(insightLines(days, global ? "your conversations" : "this conversation").join("\n")) };
}
