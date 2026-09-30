/* Goal mode in the conversation (design doc 4.3): the strip at the top of a conversation working toward a goal, from
   GET /api/sessions/<id>/goal (its objective, round, the judge's score and what is still missing, time spent), with
   Pause, Resume and Stop through POST /api/sessions/<id>/goal {action}. "Set a goal" in the + menu puts the engine's
   /goal command in the message box; nothing starts until it is sent. */

import { $, esc, renderNow } from "../core/dom.js";
import { api, token } from "../core/api.js";
import { activeId } from "../core/state.js";
import { on } from "../core/actions.js";
import { ic, toast, closePop } from "../core/ui.js";
import { markLive } from "../core/features.js";
import { t } from "../../i18n.js";
import { initGoalTimeline } from "./goal-timeline.js";

const goals = new Map();
/* A conversation whose goal could not be read is said once, not on every redraw. */
const failed = new Set();
let cachedActor = "";
const actor = () => JSON.stringify([activeId(), token.get()]);
function scopeCache() {
  const who = actor();
  if (who !== cachedActor) { cachedActor = who; goals.clear(); failed.clear(); }
  return who;
}

/* Only a goal that is working or paused has a strip; a finished one is said in the conversation itself. */
export function goalStrip(sessionId) {
  scopeCache();
  const g = sessionId ? goals.get(sessionId) : null;
  if (!g) return "";
  if (g.status !== "working" && g.status !== "paused") return `<div class="goal6"><b>${esc(g.objective)}</b><span>${esc(g.status)}</span><button class="btn ghost sm" type="button" data-act="goal-timeline" data-id="${esc(sessionId)}">Timeline</button></div>`;
  const score = typeof g.score === "number" ? g.score : null;
  const facts = [t("goal.rounds", { round: g.round, max: g.maxRounds }), score === null ? "" : t("window.chat.goal.score", { score: score.toFixed(1) }),
    g.missing?.length ? t("window.chat.goal.missing", { missing: g.missing.join("; ") }) : "", t("window.chat.goal.minutes", { n: Math.round((g.elapsedMs ?? 0) / 60000) })].filter(Boolean);
  const button = g.status === "working"
    ? `<button class="btn ghost sm" type="button" data-act="goal-st" data-v="pause" data-id="${esc(sessionId)}">${t("autonomy.pause")}</button>`
    : `<button class="btn ghost sm" type="button" data-act="goal-st" data-v="resume" data-id="${esc(sessionId)}">${t("autonomy.resume")}</button>`;
  return `<div class="goal6">${ic("target", "s")}<span class="grow"><b>${t("window.chat.goal.goal", { goal: esc(g.objective) })}</b><small>${esc(facts.join(" · "))}</small></span><button class="btn ghost sm" type="button" data-act="goal-timeline" data-id="${esc(sessionId)}">Timeline</button>${button}<button class="btn ghost sm" type="button" data-act="goal-st" data-v="stop" data-id="${esc(sessionId)}">${t("dashboard.stop")}</button></div>`;
}

/* After a conversation is drawn: re-read its goal, and draw again only if it changed. */
export async function loadGoal(sessionId) {
  const who = scopeCache();
  if (!sessionId || failed.has(sessionId)) return;
  let goal;
  try { goal = (await api(`sessions/${encodeURIComponent(sessionId)}/goal`)).goal; } catch (error) { if (actor() === who) { failed.add(sessionId); toast(error.message); } return; }
  if (actor() !== who) return;
  if (JSON.stringify(goal) !== JSON.stringify(goals.get(sessionId) ?? null)) { goals.set(sessionId, goal); renderNow(); }
}

export function initGoal() {
  initGoalTimeline();
  markLive(["goal-st", "goal-fill"]);
  on("goal-st", async (el) => {
    const who = scopeCache();
    const id = el.dataset.id;
    try { const reply = await api(`sessions/${encodeURIComponent(id)}/goal`, { action: el.dataset.v }); if (actor() === who) goals.set(id, reply.goal); } catch (error) { if (actor() === who) toast(error.message); }
    if (actor() !== who) return;
    renderNow();
  });
  on("goal-fill", () => {
    closePop();
    const box = $("#prompt");
    if (!box) return;
    box.value = "/goal ";
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
