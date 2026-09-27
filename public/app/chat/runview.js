/* Two things a task says about itself, drawn in the conversation:
   - Plan first: the task's plan, 1:1 with the prototype's plan block (ul.plan in a card), from GET /api/runs/<id>/plan.
     It is drawn while the task waits on it (run needs_input; the OK is given in the conversation, as the prototype's
     mode says, "waits for your OK", and the engine takes it from the next message) and stays while the task works
     through it (parity B2, chat-005): done steps ticked, the step it is on in copper. While the task works the plan is
     read again at most every two seconds; once the task stops working it is not read again. A plan the conversation
     kept from an earlier task (the route answers per conversation) is never drawn for this one, and a task a newer one
     of the conversation took over (the OK starts the next task, which works through the plan) draws none.
   - A task that failed: the engine's own words for why (the run's output), under the conversation's last message. */

import { esc, render } from "../core/dom.js";
import { ic, toast } from "../core/ui.js";
import { api } from "../core/api.js";
import { E } from "../core/state.js";

const PLANS = new Map(); // run id → { plan, at, busy, said }
const CLS = { done: "done", working: "now", failed: "bad", waiting: "" };
const SHOWN = new Set(["needs_input", "running"]);

/* A newer task of the same conversation has taken over from this one. */
const overtaken = (run) => (E.state?.runs ?? []).some((r) => r.sessionId === run.sessionId && String(r.createdAt) > String(run.createdAt));

export function planBlock(run) {
  if (!SHOWN.has(run?.status) || overtaken(run)) return "";
  const steps = PLANS.get(run.id)?.plan?.steps ?? [];
  if (!steps.length) return "";
  return `<div class="b"><div class="gut"></div><div><div class="card" data-css="padding:12px 14px"><ul class="plan">${steps.map((s) => `<li class="${CLS[s.status] ?? ""}"><span class="box">${s.status === "done" ? ic("check") : ""}</span><span>${esc(s.title)}</span></li>`).join("")}</ul></div></div></div>`;
}

/* After a draw: the plan of a task waiting on it, read once, or of a task working through it, read again every two
   seconds. The conversation is drawn again only when the plan changed. */
export async function loadPlan(run) {
  if (!SHOWN.has(run?.status)) return;
  const kept = PLANS.get(run.id);
  if (kept && (kept.busy || run.status !== "running" || Date.now() - kept.at < 2000)) return;
  const entry = { plan: kept?.plan ?? null, at: Date.now(), busy: true, said: kept?.said ?? "" };
  PLANS.set(run.id, entry);
  try {
    const got = await api(`runs/${encodeURIComponent(run.id)}/plan`);
    const plan = got?.plan?.runId === run.id ? got.plan : null;
    const changed = JSON.stringify(plan) !== JSON.stringify(entry.plan);
    Object.assign(entry, { plan, said: "" });
    if (changed) render();
  } catch (error) {
    // Said once, not again every two seconds while the engine keeps refusing for the same reason.
    if (error.message !== entry.said) toast(error.message);
    entry.said = error.message;
  } finally {
    entry.at = Date.now();
    entry.busy = false;
  }
}

/** The newest task of this conversation, when it failed, with the engine's words. */
export function failedLine(runs, sessionId, sending) {
  if (!sessionId || sending) return "";
  const last = (runs ?? []).filter((r) => r.sessionId === sessionId).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
  if (last?.status !== "failed" || !String(last.output ?? "").trim()) return "";
  return `<div class="b"><div class="gut"></div><div><div class="txt">${esc(last.output)}</div></div></div>`;
}
