import type { Runtime } from "../runtime.js";
import { estimateTokens, textOnly } from "../contracts.js";
import { estimateCost, formatCost, pricingSettings } from "../pricing.js";

/**
 * `/tokens`: what fills the next request, the idea of Aider's `/tokens` (Apache-2.0) written for
 * Branch. It reuses the figures a task already writes before each round (the `context.budget`
 * event: instructions, the list of tools, the conversation, the room kept for the answer), so it
 * reports what Branch really measured rather than a second guess. A conversation with no task yet
 * is measured from its stored messages, and so is one folded since that measure (the measure was
 * taken before the fold). Otherwise the larger of the two counts: the stored messages also hold the
 * answer written after the last measure.
 */
export interface TokenReport {
  instructions: number;
  tools: number;
  conversation: number;
  answerRoom: number;
  limit: number;
  /** False until a task has measured this conversation against its model: `limit` is then only a stand-in. */
  limitKnown: boolean;
  left: number;
  summary: number;
  messages: number;
  measured: "last task" | "stored messages";
  model: string;
  cost: string;
}

type Budget = { limit?: number; system?: number; catalog?: number; messages?: number; reserve?: number };
const n = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** The last measure taken for this conversation, and whether it was folded after that measure. */
function lastBudget(runtime: Runtime, sessionId: string, owner: string): { budget: Budget; folded: boolean } | null {
  const runs = runtime.store.runs(owner).filter((run) => run.sessionId === sessionId);
  for (const run of runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    const events = runtime.store.events(run.id).filter((event) => event.kind === "context.budget" || event.kind === "context.compacted");
    const found = events.filter((event) => event.kind === "context.budget").at(-1);
    if (found) return { budget: found.data as Budget, folded: events.at(-1)?.kind === "context.compacted" };
  }
  return null;
}

/** `owner` is whoever the conversation is filed under: the owner, or a household profile. */
export function tokenReport(runtime: Runtime, sessionId: string, owner = runtime.owner): TokenReport {
  const { summary, rows } = runtime.store.workingMessages(sessionId);
  const stored = estimateTokens(rows.map((row) => textOnly(row.message)));
  const last = lastBudget(runtime, sessionId, owner);
  const budget = last?.budget ?? null;
  // The conversation's own model and prices: a household profile's choices, not the owner's.
  const choice = runtime.models.plan(owner, sessionId).choice;
  const conversation = !last || last.folded ? stored : Math.max(n(budget!.messages) - n(budget!.system), stored);
  const instructions = n(budget?.system), tools = n(budget?.catalog), limit = n(budget?.limit) || 20000;
  const input = instructions + tools + Math.max(0, conversation);
  const { overrides } = pricingSettings(runtime.store, owner);
  return {
    instructions, tools, conversation: Math.max(0, conversation), answerRoom: n(budget?.reserve), limit,
    limitKnown: n(budget?.limit) > 0, left: limit - input, summary: summary ? estimateTokens(summary) : 0, messages: rows.length,
    measured: last && !last.folded ? "last task" : "stored messages", model: choice.model,
    cost: formatCost(estimateCost(choice.model, { input, output: 0 }, overrides)),
  };
}

const k = (count: number): string => (Math.abs(count) >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count));
export function tokenLines(report: TokenReport): string[] {
  const lines = [
    `What the next request carries (measured from the ${report.measured}, about ${k(report.limit)} tokens of room):`,
    `  instructions      ${k(report.instructions)}`,
    `  list of tools     ${k(report.tools)}`,
    `  conversation      ${k(report.conversation)} (${report.messages} messages${report.summary ? `, of which a summary of ${k(report.summary)}` : ""})`,
  ];
  if (report.answerRoom) lines.push(`  kept for answer   ${k(report.answerRoom)}`);
  lines.push(`  room left         ${k(report.left)}`);
  lines.push(`Sending it to ${report.model} would cost ${report.cost} before the answer.`);
  if (report.left < report.limit * 0.2) lines.push("It is nearly full: /compact folds the earlier part into a summary.");
  return lines;
}
