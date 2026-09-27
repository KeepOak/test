/* Two things a task says about itself, drawn in the conversation:
   - Plan first: the plan a task waits on (run needs_input), 1:1 with the prototype's plan block (ul.plan in a card), read
     once per task from GET /api/runs/<id>/plan. The OK is given in the conversation, as the prototype's mode says
     ("waits for your OK"); the engine takes it from the next message.
   - A task that failed: the engine's own words for why (the run's output), under the conversation's last message. */

import { esc, render } from "../core/dom.js";
import { ic } from "../core/ui.js";
import { api } from "../core/api.js";

const PLANS = new Map();
const CLS = { done: "done", working: "now", failed: "bad", waiting: "" };

export function planBlock(run) {
  if (run?.status !== "needs_input") return "";
  const steps = PLANS.get(run.id)?.steps ?? [];
  if (!steps.length) return "";
  return `<div class="b"><div class="gut"></div><div><div class="card" data-css="padding:12px 14px"><ul class="plan">${steps.map((s) => `<li class="${CLS[s.status] ?? ""}"><span class="box">${s.status === "done" ? ic("check") : ""}</span><span>${esc(s.title)}</span></li>`).join("")}</ul></div></div></div>`;
}

/* After a draw: the plan of a task waiting on it, read once. */
export async function loadPlan(run) {
  if (run?.status !== "needs_input" || PLANS.has(run.id)) return;
  PLANS.set(run.id, null);
  const got = await api(`runs/${encodeURIComponent(run.id)}/plan`).catch(() => null);
  PLANS.set(run.id, got?.plan ?? null);
  if (got?.plan?.steps?.length) render();
}

/** The newest task of this conversation, when it failed, with the engine's words. */
export function failedLine(runs, sessionId, sending) {
  if (!sessionId || sending) return "";
  const last = (runs ?? []).filter((r) => r.sessionId === sessionId).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
  if (last?.status !== "failed" || !String(last.output ?? "").trim()) return "";
  return `<div class="b"><div class="gut"></div><div><div class="txt">${esc(last.output)}</div></div></div>`;
}
