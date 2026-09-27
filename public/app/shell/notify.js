/* The in-window notification card, 1:1 with the prototype's notify(): a face, "Branch · now", a title and a line, Open
   and a dismiss button, gone after 9 seconds. It follows the engine only: a task that has just started waiting for an
   answer (GET /api/state attention, a run id not seen before) in a conversation other than the one on screen, named by
   its Trunk (attention who) or its conversation, with the task's own question. A helper's question (answered inside its
   task) and a task Branch closed on (continued from the Inbox) are not announced. Nothing is shown during the
   walkthrough, setup or the first run, nor while "Show tips and pop-ups" is off (GET /api/state onboarding.popups). */

import { $, esc, onRender, applyCss } from "../core/dom.js";
import { S, E, ownName, chatFace } from "../core/state.js";
import { app, av, ic } from "../core/ui.js";
import { on } from "../core/actions.js";
import { markLive, greyOut } from "../core/features.js";
import { t } from "../../i18n.js";

const STAY_MS = 9000;
let seen = null, timer = null;

const sessionTitle = (id) => { const s = E.sessions.find((x) => (x.sessionId ?? x.id) === id); return s?.title || s?.opening || ""; };
const quiet = () => E.state?.onboarding?.popups === false || !!document.querySelector(".tour-layer, .ob9, .first, .lockscreen");
const onScreen = (id) => S.view === "chat" && S.chat === id && !document.hidden;

function show(w) {
  const id = w.open || w.sessionId;
  $(".notif")?.remove();
  const el = document.createElement("div");
  el.className = "notif";
  el.setAttribute("role", "status");
  el.innerHTML = `${av(chatFace(id), 30, id)}<div><small>${t("window.shell.shell.branch-now")}</small><b>${esc(w.who || ownName(id) || sessionTitle(id))}</b><p>${esc(w.question ?? "")}</p></div><button class="icon-btn" type="button" aria-label="${t("window.flows.first.dismiss")}" data-act="notif-x" data-css="width:26px;height:26px">${ic("x", "s")}</button><div class="acts"><button class="btn pri sm" type="button" data-act="chat" data-id="${esc(id)}">${t("ov.open")}</button></div>`;
  applyCss(el);
  greyOut(el);
  app().appendChild(el);
  clearTimeout(timer);
  timer = setTimeout(() => el.remove(), STAY_MS);
}

function watch() {
  const list = Array.isArray(E.state?.attention) ? E.state.attention : null;
  if (!list) return;
  const ids = list.map((w) => w.runId);
  if (seen === null) { seen = new Set(ids); return; } // what already waited when the window opened is the Inbox's, not news
  const fresh = list.filter((w) => !seen.has(w.runId) && !w.parentRunId && !w.canContinue);
  for (const id of ids) seen.add(id);
  const w = fresh.filter((x) => !onScreen(x.open || x.sessionId)).at(-1);
  if (w && !quiet()) show(w);
}

export function initNotify() {
  markLive(["notif-x"]);
  on("notif-x", () => { clearTimeout(timer); $(".notif")?.remove(); });
  document.addEventListener("click", (e) => { if (e.target.closest?.('.notif [data-act="chat"]')) $(".notif")?.remove(); });
  onRender(watch);
}
