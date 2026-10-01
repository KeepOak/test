/* Read-only retained goals. Navigation never resumes a goal or sends a message. */
import { esc, afterDraw } from "../core/dom.js";
import { api, token } from "../core/api.js";
import { activeId, S } from "../core/state.js";
import { on, run } from "../core/actions.js";
import { openDlg, closeDlg, dialog, toast } from "../core/ui.js";
import { markLive } from "../core/features.js";

let request = 0;
let ownedDialog = null;
let actor = null;
const identity = () => JSON.stringify([activeId(), token.get()]);
const when = (value) => { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleString() : "Time unavailable"; };
const facts = (goal) => `${goal.status} · round ${goal.round} of ${goal.maxRounds}`;
const entry = (goal) => `<li><button class="btn ghost" type="button" data-act="goal-timeline" data-id="${esc(goal.sessionId)}"><b>${esc(goal.objective)}</b><br><small>${esc(facts(goal))} · ${esc(when(goal.startedAt))}</small></button></li>`;

async function read(path, title, draw) {
  const ticket = ++request, who = identity();
  actor = who;
  ownedDialog = openDlg({ title, body: '<p role="status">Reading recorded goals…</p>' });
  const waiting = ownedDialog;
  try {
    const data = await api(path);
    if (ticket !== request || identity() !== who || dialog() !== waiting) return;
    ownedDialog = openDlg({ title, body: draw(data), wide: true });
  } catch (error) {
    if (ticket === request && identity() === who && dialog() === waiting)
      ownedDialog = openDlg({ title, body: `<p role="alert">${esc(error.message)}</p>` });
  }
}

function eventRow(event) {
  const state = event.data;
  const score = typeof state.score === "number" ? `<p>Judge score: ${esc(state.score.toFixed(1))} / 1</p>` : "";
  return `<li><time datetime="${esc(event.createdAt)}">${esc(when(event.createdAt))}</time><p>${esc(facts(state))}</p>${score}
    ${state.reason ? `<p>${esc(state.reason)}</p>` : ""}${state.missing?.length ? `<p>Still missing: ${esc(state.missing.join("; "))}</p>` : ""}
    ${state.subgoals?.length ? `<p>Subgoals recorded here: ${esc(state.subgoals.join("; "))}</p>` : ""}
    <small>Recorded run: <code>${esc(event.runId)}</code></small></li>`;
}

function timeline(data) {
  const g = data.goal;
  return `<h3>${esc(g.objective)}</h3><p>${esc(facts(g))}</p><p>Started ${esc(when(g.startedAt))}; latest saved state ${esc(when(data.updatedAt))}.</p>
    ${g.reason ? `<p>${esc(g.reason)}</p>` : ""}<p>Working time: ${esc(Math.round(g.elapsedMs / 60000))} minutes. Scores are a judge's assessment, not measured completion.</p>
    <div class="row"><button class="btn" type="button" data-act="goal-conversation" data-id="${esc(g.sessionId)}">Open goal conversation</button>
    <button class="btn ghost" type="button" data-act="goal-conversation" data-id="${esc(g.sessionId)}" data-v="beside"${!S.chat || S.chat === g.sessionId ? ' disabled title="Open a different main conversation first"' : ""}>Open beside current conversation</button></div>
    ${data.subgoals.length ? `<h3>Current configured subgoals</h3><ul>${data.subgoals.map((s) => `<li>${esc(s)}</li>`).join("")}</ul><p>Subgoal completion is not recorded.</p>` : ""}
    <h3>Recorded timeline</h3>${data.historyRecorded ? `<ol>${data.events.map(eventRow).join("")}</ol>` : "<p>Only the latest goal snapshot was retained. Earlier lifecycle events were not recorded.</p>"}
    ${data.more ? "<p>Showing the newest 200 lifecycle events.</p>" : ""}<button class="btn ghost" type="button" data-act="goals-index">All retained goals</button>`;
}

export function initGoalTimeline() {
  markLive(["goals-index", "goal-timeline", "goal-conversation"]);
  on("goals-index", () => read("goals", "Goals", (data) => `<p>Goals stay in their original conversation. Opening one does not run it.</p>
    ${data.goals.length ? `<ul>${data.goals.map(entry).join("")}</ul>` : "<p>No retained goals for this person.</p>"}${data.more ? "<p>Showing the newest 100 goals.</p>" : ""}`));
  on("goal-timeline", (el) => read(`sessions/${encodeURIComponent(el.dataset.id)}/goal-timeline`, "Goal timeline", timeline));
  on("goal-conversation", async (el) => {
    const who = identity(), waiting = dialog(), ticket = ++request;
    if (el.dataset.v === "beside" && (!S.chat || S.chat === el.dataset.id)) return;
    try {
      await api(`sessions/${encodeURIComponent(el.dataset.id)}/goal-timeline`);
      if (who !== identity() || waiting !== dialog() || ticket !== request) return;
      closeDlg(); ownedDialog = null;
      if (el.dataset.v === "beside") { el.dataset.v = el.dataset.id; run("beside15", el); }
      else run("chat", el);
    } catch (error) { if (who === identity() && waiting === dialog()) toast(error.message); }
  });
  afterDraw(() => { if (ownedDialog && dialog() === ownedDialog && actor !== identity()) { ++request; closeDlg(); ownedDialog = null; } });
}
