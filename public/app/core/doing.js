/* What a Trunk, a room member or Branch is visibly doing (the prototype's agentState), from its own conversation's runs
   and questions in GET /api/state; drawn by the agent beside the conversation (chat/agent17.js) and every character face
   (core/ui.js av). Moved here from chat/agent17.js unchanged, but for the first-to-end wake-up and a face with no
   conversation of its own, which only rests or sleeps. */

import { render } from "./dom.js";
import { E } from "./state.js";

const YAY_MS = 7000;
let again = null, againAt = 0;
/* One redraw when a celebration ends, so the figure goes back to what it is doing; with several celebrating (the
   list's rows), the first to end. */
function wakeAfter(ms) {
  const at = Date.now() + ms + 50;
  if (again && againAt > Date.now() && againAt <= at) return;
  clearTimeout(again);
  againAt = at;
  again = setTimeout(() => { again = null; render(); }, ms + 50);
}

/* What a Trunk is visibly doing, from its own conversation's runs. */
export function agentState(trunk, sending = false) {
  if (!trunk) return "idle";
  if (!trunk.chatSessionId) return trunk.paused ? "sleep" : "idle";
  const sid = trunk.chatSessionId, runs = (E.state?.runs ?? []).filter((r) => r.sessionId === sid);
  const last = runs.reduce((a, r) => (!a || String(r.updatedAt ?? r.createdAt) > String(a.updatedAt ?? a.createdAt) ? r : a), null);
  if ((E.state?.attention ?? []).some((a) => a.sessionId === sid && !a.canContinue) || runs.some((r) => r.status === "needs_input")) return "wait";
  if (trunk.paused) return "sleep";
  const running = runs.filter((r) => r.status === "running").reduce((a, r) =>
    (!a || String(r.updatedAt ?? r.createdAt) > String(a.updatedAt ?? a.createdAt) ? r : a), null);
  if (running) return ["work", "think", "search", "read", "talk"].includes(running.activityState) ? running.activityState : "work";
  if (sending) return "think";
  if (last?.status === "completed") {
    const left = YAY_MS - (Date.now() - Date.parse(last.updatedAt ?? last.createdAt));
    if (left > 0) { wakeAfter(left); return "yay"; }
  }
  if (last && ["failed", "budget_exceeded"].includes(last.status)) return "oops";
  return "idle";
}
