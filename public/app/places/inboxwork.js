/* Long work in the Inbox: every task working now, and every task the owner paused, under "Running in the background",
   each with how long it has been going and its last step (GET /api/activity?waiting=1: the engine's own words for
   what it is doing or waiting on, `task.reason`, else its newest step's label). Pause stops a working task after the
   step it is on (POST /api/runs/<id>/pause); a paused one is carried on from there (POST /api/runs/<id>/resume) or
   stopped (POST /api/runs/<id>/cancel). The time is counted in the window from the engine's `startedAt`, once a second,
   into the rows' own spans, never by drawing the Inbox again. */

import { esc } from "../core/dom.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { toast } from "../core/ui.js";
import { faceOf } from "./inbox17.js"; // the task's own Trunk, never the mascot
import { refresh } from "../core/state.js";
import { t } from "../../i18n.js";

const W = { rows: [], key: "" };
export const isPaused = (a) => a.status === "interrupted" && a.task?.why === "run.paused";
const working = (a) => a.status === "running";

/* "1h 02m", "3m 04s", "12s": how long a task has been going, from when it started. */
export function elapsed(since, now = Date.now()) {
  const s = Math.max(0, Math.round((now - Date.parse(since)) / 1000));
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
  return s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}
const lastStep = (a) => a.task?.reason || a.steps?.at(-1)?.label || a.current || "";
const firstLine = (text) => String(text ?? "").split("\n")[0].slice(0, 60);

/* The paused tasks' ids, so the Inbox's own "cut off" cards leave them to this section. */
export const pausedIds = () => new Set(W.rows.filter(isPaused).map((a) => a.runId));

const resumeExplanation = () => `<small>${esc(t("window.chat.bg.resume-explanation"))}</small>`;

function row(a) {
  const buttons = isPaused(a)
    ? `<button class="btn ghost sm" type="button" data-act="lw-stop" data-id="${esc(a.runId)}">${t("dashboard.stop")}</button><button class="btn pri sm" type="button" data-act="lw-resume" data-id="${esc(a.runId)}" data-sid="${esc(a.sessionId)}">${t("autonomy.resume")}</button>`
    : `<button class="btn ghost sm" type="button" data-act="lw-stop" data-id="${esc(a.runId)}">${t("dashboard.stop")}</button><button class="btn sm" type="button" data-act="lw-pause" data-id="${esc(a.runId)}">${t("autonomy.pause")}</button>`;
  const time = working(a) ? `<span class="meta" data-lw-since="${esc(a.startedAt)}">${esc(elapsed(a.startedAt))}</span>` : "";
  return `<div class="prow lw-row">${faceOf(a.sessionId, 34)}<span class="grow"><b>${esc(firstLine(a.prompt))}</b><small>${esc(lastStep(a))}</small>${isPaused(a) ? resumeExplanation() : ""}</span>${time}${buttons}</div>`;
}

/* Drawn inside the Inbox's markup, above its tabs' bodies; nothing when nothing works or waits paused. */
export function workSection() {
  const rows = W.rows.filter((a) => (working(a) || isPaused(a)) && !a.parentRunId);
  if (!rows.length) return "";
  return `<div class="tile lw-tile"><div class="th"><b>${t("window.chat.bg.title")}</b></div><div class="rows">${rows.map(row).join("")}</div></div>`;
}

/* Re-read with the rest of the Inbox; true when what it shows changed. */
export async function readWork() {
  const list = await api("activity?waiting=1");
  const rows = (Array.isArray(list) ? list : []).filter((a) => a.runId);
  const key = JSON.stringify(rows.map((a) => [a.runId, a.status, a.task?.why, lastStep(a)]));
  W.rows = rows;
  if (key === W.key) return false;
  W.key = key;
  return true;
}

/* Every shown time moves on once a second, in place. */
function tick() {
  for (const span of document.querySelectorAll("[data-lw-since]")) span.textContent = elapsed(span.dataset.lwSince);
}

async function act(path, el) {
  el.disabled = true;
  try {
    const said = await api(path, {});
    if (said?.message) toast(said.message);
  } catch (error) { toast(error.message); }
  await refresh().catch((error) => toast(error.message));
}

/* The same three controls serve the Inbox and the chat (the chat hands in how it follows a resumed task). */
export function initWork({ onResume }) {
  markLive(["lw-pause", "lw-resume", "lw-stop"]);
  on("lw-pause", (el) => act(`runs/${encodeURIComponent(el.dataset.id)}/pause`, el));
  on("lw-stop", (el) => act(`runs/${encodeURIComponent(el.dataset.id)}/cancel`, el));
  /* Resume carries the task on in its own conversation, which opens to follow it. */
  on("lw-resume", (el) => { el.disabled = true; onResume(el.dataset.id, el.dataset.sid); });
  setInterval(tick, 1000);
}

/* The chat's card for its newest task when it was paused or cut off: the engine's own words, then Stop and Resume. */
export function pausedCard(runs, sessionId) {
  const newest = (runs ?? []).filter((r) => r.sessionId === sessionId).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
  if (!sessionId || newest?.status !== "interrupted") return "";
  return `<div class="prow lw-row lw-chat"><span class="grow"><small>${esc(firstLine(newest.output))}</small>${resumeExplanation()}</span><button class="btn ghost sm" type="button" data-act="lw-stop" data-id="${esc(newest.id)}">${t("dashboard.stop")}</button><button class="btn pri sm" type="button" data-act="lw-resume" data-id="${esc(newest.id)}" data-sid="${esc(newest.sessionId)}">${t("autonomy.resume")}</button></div>`;
}
/* Over the chat's live steps: how long the task has been going, and Pause. */
export function liveHead(runId, startedAt) {
  if (!runId || !startedAt) return "";
  return `<div class="lw-head"><span class="ls-time" data-lw-since="${esc(startedAt)}">${esc(elapsed(startedAt))}</span><button class="btn ghost sm" type="button" data-act="lw-pause" data-id="${esc(runId)}">${t("autonomy.pause")}</button></div>`;
}
