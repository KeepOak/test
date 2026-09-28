/* The in-window notification card, 1:1 with the prototype's notify(): a face, "Branch · now", a title and a line, Open
   and a dismiss button, gone after 9 seconds. It follows the engine only: a task that has just started waiting for an
   answer (GET /api/state attention, a run id not seen before) in a conversation other than the one on screen, named by
   its Trunk (attention who) or its conversation, with the task's own question. A helper's question (answered inside its
   task) and a task Branch closed on (continued from the Inbox) are not announced. Nothing is shown during the
   walkthrough, setup or the first run, nor while "Show tips and pop-ups" is off (GET /api/state onboarding.popups).
   wire-greyed: Settings › Notifications is followed here (the comfort card "notify", chat/comfort.js CF.notify).
   - "A Trunk needs a yes" (needsYes) off: nothing is announced for a waiting task.
   - "A long task finishes" (taskDone): a task of the owner's that ran two minutes or more and has just ended, in a
     conversation not on screen, gets the same card, saying it is done (or stopped).
   - "Play a sound" (sound): a chime or a knock, made here with the Web Audio API (no sound file).
   - "And on the computer" (method "system"): while the window is hidden or not focused, the computer's own notification
     too (the Notification API; a browser asks for permission the first time).
   - Quiet hours and whole days off (CF.quiet): the card still shows, but no sound and no computer notification. */

import { $, esc, onRender, applyCss } from "../core/dom.js";
import { S, E, ownName, chatFace } from "../core/state.js";
import { app, av, ic } from "../core/ui.js";
import { on } from "../core/actions.js";
import { markLive, greyOut } from "../core/features.js";
import { CF } from "../chat/comfort.js";
import { t } from "../../i18n.js";
import { quietNow as quietAt, playOn, waitingNews, doneNews } from "./notify-rules.js";

const STAY_MS = 9000;
let seen = null, timer = null, runs = null;

const sessionTitle = (id) => { const s = E.sessions.find((x) => (x.sessionId ?? x.id) === id); return s?.title || s?.opening || ""; };
const quiet = () => E.state?.onboarding?.popups === false || !!document.querySelector(".tour-layer, .ob9, .first, .lockscreen");
const onScreen = (id) => S.view === "chat" && S.chat === id && !document.hidden;

/* The face of the conversation that asks: its Trunk's or its room's; Branch's mark stays on the logo, so a question from
   Branch's own conversation carries the bell. */
const faceHere = (id) => { const face = chatFace(id); return face.kind === "main" ? `<span class="ico-tile">${ic("bell", "s")}</span>` : av(face, 30, id); };

/* The owner's quiet hours or whole day off, in the quiet hours' own time zone (src/calendar.ts inQuietHours). */
export const quietNow = (quiet = CF.quiet, at = new Date()) => quietAt(quiet, at);

/* A chime (two rising notes) or a knock (two short low taps), made on the spot. */
let audio = null;
export function playSound(kind) {
  if (kind !== "chime" && kind !== "knock") return false;
  try {
    audio ??= new AudioContext();
    return playOn(audio, kind);
  } catch { return false; }
}

/* The computer's own notification, only while the window is out of sight. */
function systemNote(title, body) {
  if (typeof Notification !== "function" || (!document.hidden && document.hasFocus())) return;
  const send = () => { try { new Notification(title, { body, silent: true }); } catch { /* the system refused */ } };
  if (Notification.permission === "granted") send();
  else if (Notification.permission === "default") Notification.requestPermission().then((p) => { if (p === "granted") send(); }, () => {});
}

/* Everything past the card: the sound and the computer's notification, unless it is quiet now. */
function alertOwner(title, body) {
  if (quietNow()) return;
  playSound(CF.notify?.sound);
  if (CF.notify?.method === "system") systemNote(title, body);
}

function show(w) {
  const id = w.open || w.sessionId;
  $(".notif")?.remove();
  const el = document.createElement("div");
  el.className = "notif";
  el.setAttribute("role", "status");
  el.innerHTML = `${faceHere(id)}<div><small>${t("window.shell.shell.branch-now")}</small><b>${esc(w.who || ownName(id) || sessionTitle(id))}</b><p>${esc(w.question ?? "")}</p></div><button class="icon-btn" type="button" aria-label="${t("window.flows.first.dismiss")}" data-act="notif-x" data-css="width:26px;height:26px">${ic("x", "s")}</button><div class="acts"><button class="btn pri sm" type="button" data-act="chat" data-id="${esc(id)}">${t("ov.open")}</button></div>`;
  applyCss(el);
  greyOut(el);
  app().appendChild(el);
  clearTimeout(timer);
  timer = setTimeout(() => el.remove(), STAY_MS);
}

function watch() {
  const told = waitingNews(E.state?.attention, seen, onScreen);
  seen = told.seen;
  const w = told.news;
  if (!w || quiet() || CF.notify?.needsYes === false) return;
  show(w);
  alertOwner(w.who || ownName(w.open || w.sessionId) || sessionTitle(w.open || w.sessionId), w.question ?? "");
}

/* A task of the owner's that ran two minutes or more and has just ended, told once, only for one not on screen. */
function watchDone() {
  const told = doneNews(E.state?.runs, runs, onScreen);
  const first = runs === null;
  runs = told.before;
  const done = told.news;
  if (first || !done || CF.notify?.taskDone === false || quiet()) return; // what had ended before the window opened is not news
  const words = t(done.status === "completed" ? "window.shell.notify.done" : "window.shell.notify.stopped");
  const who = ownName(done.sessionId) || sessionTitle(done.sessionId) || done.title || "";
  show({ sessionId: done.sessionId, who, question: words });
  alertOwner(who, words);
}

export function initNotify() {
  markLive(["notif-x"]);
  on("notif-x", () => { clearTimeout(timer); $(".notif")?.remove(); });
  document.addEventListener("click", (e) => { if (e.target.closest?.('.notif [data-act="chat"]')) $(".notif")?.remove(); });
  onRender(watch);
  onRender(watchDone);
}
