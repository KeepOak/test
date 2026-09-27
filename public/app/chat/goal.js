/* Goal mode in the conversation (design doc 4.3): the strip at the top of a conversation working toward a goal, from
   GET /api/sessions/<id>/goal (its objective, round, the judge's score and what is still missing, time spent), with
   Pause, Resume and Stop through POST /api/sessions/<id>/goal {action}. "Set a goal" in the + menu puts the engine's
   /goal command in the message box; nothing starts until it is sent.
   Undo (pass 17, the prototype's goalundob17) opens "Undo this goal" with what undoing it would put back, read from
   GET /api/sessions/<id>/goal/undo: its rounds (kept in the history), each file its rounds changed, each draft they wrote
   and each fact memory learned only from them. "Undo the goal" does it (POST /api/sessions/<id>/goal/undo): the engine
   stops the goal, puts the files back, deletes the drafts where they were written and forgets the facts, checkpoints
   included; anything it could not do is said in its own words. */

import { $, esc, renderNow } from "../core/dom.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { ic, toast, closePop, openDlg, closeDlg } from "../core/ui.js";
import { markLive } from "../core/features.js";
import { t } from "../../i18n.js";

const goals = new Map();
/* A conversation whose goal could not be read is said once, not on every redraw. */
const failed = new Set();

/* Only a goal that is working or paused has a strip; a finished one is said in the conversation itself. */
export function goalStrip(sessionId) {
  const g = sessionId ? goals.get(sessionId) : null;
  if (!g || (g.status !== "working" && g.status !== "paused")) return "";
  const score = typeof g.score === "number" ? g.score : null;
  const facts = [t("goal.rounds", { round: g.round, max: g.maxRounds }), score === null ? "" : t("window.chat.goal.score", { score: score.toFixed(1) }),
    g.missing?.length ? t("window.chat.goal.missing", { missing: g.missing.join("; ") }) : "", t("window.chat.goal.minutes", { n: Math.round((g.elapsedMs ?? 0) / 60000) })].filter(Boolean);
  const button = g.status === "working"
    ? `<button class="btn ghost sm" type="button" data-act="goal-st" data-v="pause" data-id="${esc(sessionId)}">${t("autonomy.pause")}</button>`
    : `<button class="btn ghost sm" type="button" data-act="goal-st" data-v="resume" data-id="${esc(sessionId)}">${t("autonomy.resume")}</button>`;
  return `<div class="goal6">${ic("target", "s")}<span class="grow"><b>${t("window.chat.goal.goal", { goal: esc(g.objective) })}</b><small>${esc(facts.join(" · "))}</small><span class="meter6"><u data-css="width:${(score ?? 0) * 100}%"></u></span></span>${button}<button class="btn ghost sm" type="button" data-act="goal-st" data-v="stop" data-id="${esc(sessionId)}">${t("dashboard.stop")}</button>${undoButton(g, sessionId)}</div>`;
}

/* Undo is live only for a goal whose rounds the engine recorded; otherwise it is greyed, with the engine's reason. */
function undoButton(g, sessionId) {
  if (Array.isArray(g.runIds) && g.runIds.length)
    return `<button class="btn ghost sm" type="button" data-act="goalundob17" data-id="${esc(sessionId)}">${t("window.chat.goal.undo")}</button>`;
  const why = t(Array.isArray(g.runIds) ? "window.chat.goal.undo-nothing" : "window.chat.goal.undo-older");
  return `<button class="btn ghost sm" type="button" disabled title="${esc(why)}" aria-label="${esc(`${t("window.chat.goal.undo")}: ${why}`)}">${t("window.chat.goal.undo")}</button>`;
}

const pill = (kind, words) => `<span class="pill ${kind}"><i></i>${esc(words)}</span>`;
const row = (name, small, kind, words) => `<div class="prow"><span class="grow"><b>${esc(name)}</b><small>${esc(small)}</small></span>${pill(kind, words)}</div>`;
/* The rows the engine gave: nothing is written in that it did not say. */
function undoRows(p) {
  const rows = [row(t("window.chat.goal.rounds"), t("window.chat.goal.so-far", { n: p.rounds }), "idle", t("window.chat.goal.kept-history"))];
  for (const f of p.files) rows.push(row(f.path, t("window.chat.goal.changed-round", { n: f.round }), "ok", f.existed ? t("window.chat.goal.put-back") : t("window.chat.goal.deleted")));
  for (const d of p.drafts) rows.push(row(t("window.chat.goal.message-to", { who: d.to.join(", ") || d.subject }), t("window.chat.goal.drafted"), "ok", t("window.chat.goal.deleted")));
  for (const f of p.facts) rows.push(row(t("window.chat.goal.fact"), `“${f.text}”`, "ok", t("window.chat.goal.forgotten")));
  return rows.join("");
}
async function openUndo(id) {
  let preview;
  try { preview = await api(`sessions/${encodeURIComponent(id)}/goal/undo`); } catch (error) { toast(error.message); return; }
  openDlg({ title: t("window.chat.goal.undo-title"),
    body: `<p class="lead-b17">${t("window.chat.goal.undo-lead")}</p><div class="rows demo-b17">${undoRows(preview)}</div>`,
    foot: `<button class="btn ghost" type="button" data-act="dlg-close">${t("window.core.keep-it")}</button><button class="btn pri" type="button" data-act="goalundogob17" data-id="${esc(id)}">${t("window.chat.goal.undo-go")}</button>` });
}
async function undoGoal(el) {
  const id = el.dataset.id;
  el.disabled = true;
  let done;
  try { done = await api(`sessions/${encodeURIComponent(id)}/goal/undo`, {}); } catch (error) { el.disabled = false; toast(error.message); return; }
  closeDlg();
  goals.delete(id);
  renderNow();
  /* What could not be done is said in the engine's words; otherwise the prototype's one line. */
  const missed = [...done.drafts, ...done.facts].filter((x) => x.outcome === "failed").map((x) => x.reason);
  if (missed.length) await loadGoal(id);
  toast(missed.length ? missed.join(" ") : t("window.chat.goal.undone"));
}

/* After a conversation is drawn: re-read its goal, and draw again only if it changed. */
export async function loadGoal(sessionId) {
  if (!sessionId || failed.has(sessionId)) return;
  let goal;
  try { goal = (await api(`sessions/${encodeURIComponent(sessionId)}/goal`)).goal; } catch (error) { failed.add(sessionId); toast(error.message); return; }
  if (JSON.stringify(goal) !== JSON.stringify(goals.get(sessionId) ?? null)) { goals.set(sessionId, goal); renderNow(); }
}

export function initGoal() {
  markLive(["goal-st", "goal-fill", "goalundob17", "goalundogob17"]);
  on("goalundob17", (el) => openUndo(el.dataset.id));
  on("goalundogob17", (el) => undoGoal(el));
  on("goal-st", async (el) => {
    const id = el.dataset.id;
    try { goals.set(id, (await api(`sessions/${encodeURIComponent(id)}/goal`, { action: el.dataset.v })).goal); } catch (error) { toast(error.message); }
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
