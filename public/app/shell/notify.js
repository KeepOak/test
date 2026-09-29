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

const STAY_MS = 9000;
const LONG_MS = 120000;
const ENDED = new Set(["completed", "failed", "cancelled", "budget_exceeded", "interrupted"]);
let seen = null, timer = null, runs = null, lastShown = { id: null, at: 0 };

const sessionTitle = (id) => { const s = E.sessions.find((x) => (x.sessionId ?? x.id) === id); return s?.title || s?.opening || ""; };
const quiet = () => E.state?.onboarding?.popups === false || !!document.querySelector(".tour-layer, .ob9, .first, .lockscreen");
const onScreen = (id) => S.view === "chat" && S.chat === id && !document.hidden;

/* The face of the conversation that asks: its Trunk's or its room's; Branch's mark stays on the logo, so a question from
   Branch's own conversation carries the bell. */
const faceHere = (id) => { const face = chatFace(id); return face.kind === "main" ? `<span class="ico-tile">${ic("bell", "s")}</span>` : av(face, 30, id); };

/* The owner's quiet hours or whole day off, in the quiet hours' own time zone (src/calendar.ts inQuietHours). */
export function quietNow(quiet = CF.quiet, at = new Date()) {
  if (!quiet) return false;
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: quiet.timezone || "UTC", hourCycle: "h23", hour: "2-digit", minute: "2-digit", weekday: "short" })
    .formatToParts(at).map((p) => [p.type, p.value]));
  const weekday = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(parts.weekday) + 1;
  if ((quiet.days ?? []).includes(weekday)) return true;
  if (!quiet.enabled) return false;
  const now = Number(parts.hour) * 60 + Number(parts.minute), mins = (hm) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3));
  const from = mins(quiet.from), to = mins(quiet.to);
  return from === to || (from < to ? now >= from && now < to : now >= from || now < to);
}

/* A chime (two rising notes) or a knock (two short low taps), made on the spot. */
let audio = null;
export function playSound(kind) {
  if (kind !== "chime" && kind !== "knock") return false;
  try {
    audio ??= new AudioContext();
    const at = audio.currentTime;
    const notes = kind === "chime" ? [[880, 0, 0.35], [1320, 0.16, 0.45]] : [[150, 0, 0.09], [150, 0.16, 0.09]];
    for (const [freq, start, length] of notes) {
      const osc = audio.createOscillator(), gain = audio.createGain();
      osc.type = kind === "chime" ? "sine" : "triangle";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, at + start);
      gain.gain.exponentialRampToValueAtTime(0.25, at + start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + start + length);
      osc.connect(gain).connect(audio.destination);
      osc.start(at + start); osc.stop(at + start + length + 0.02);
    }
    return true;
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

/** The card for `w` ({ open or sessionId, who, question }) as a finished task's: a background conversation's
    (chat/bgsend.js) is announced through it, under the same rules as a long task that finishes ("A long task finishes",
    pop-ups, quiet hours for the sound). Once only: a card already showing for that conversation is not shown again.
    Answers whether the person was told. */
export function announce(w) {
  const id = w.open || w.sessionId;
  if (quiet() || onScreen(id) || CF.notify?.taskDone === false) return false;
  if (lastShown.id === id && Date.now() - lastShown.at < STAY_MS) return true;
  show(w);
  alertOwner(w.who || ownName(id) || sessionTitle(id), w.question ?? "");
  return true;
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
  lastShown = { id, at: Date.now() };
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
  if (!w || quiet() || CF.notify?.needsYes === false) return;
  show(w);
  alertOwner(w.who || ownName(w.open || w.sessionId) || sessionTitle(w.open || w.sessionId), w.question ?? "");
}

/* A task of the owner's that ran two minutes or more and has just ended, told once, only for one not on screen. */
function watchDone() {
  const list = Array.isArray(E.state?.runs) ? E.state.runs : null;
  if (!list) return;
  const before = runs;
  runs = new Map(list.map((r) => [r.id, r.status]));
  if (before === null || CF.notify?.taskDone === false || quiet()) return; // what had ended before the window opened is not news
  const done = list.filter((r) => ENDED.has(r.status) && ["running", "needs_input"].includes(before.get(r.id)) && !r.aside
    && Date.parse(r.updatedAt) - Date.parse(r.createdAt) >= LONG_MS && !onScreen(r.sessionId)).at(-1);
  if (!done || (lastShown.id === done.sessionId && Date.now() - lastShown.at < STAY_MS)) return; // already told (announce)
  const words = t(done.status === "completed" ? "window.shell.notify.done" : "window.shell.notify.stopped");
  const who = ownName(done.sessionId) || sessionTitle(done.sessionId) || done.title || "";
  show({ sessionId: done.sessionId, who, question: words });
  alertOwner(who, words);
}

/* models-ui: a Trunk's work moved to another account at a limit (GET /api/state trunkMoves): the owner is told which one,
   and why, even when that conversation is on screen (it spends another account). Each move is told once; what had moved
   before the window opened is not news. */
let movesSeen = null;
const moveKey = (m) => `${m.sessionId}|${m.at}|${m.to}`;
function watchMoves() {
  const list = Array.isArray(E.state?.trunkMoves) ? E.state.trunkMoves : null;
  if (!list) return;
  const keys = list.map(moveKey);
  if (movesSeen === null) { movesSeen = new Set(keys); return; }
  const fresh = list.filter((m) => !movesSeen.has(moveKey(m)));
  for (const key of keys) movesSeen.add(key);
  const m = fresh[0];
  if (!m || quiet()) return;
  const who = m.who || ownName(m.open || m.sessionId) || sessionTitle(m.sessionId);
  const words = t("window.shell.notify.moved", { name: m.name, to: m.to, from: m.from }) + (m.why ? ` ${m.why}` : "");
  show({ sessionId: m.sessionId, open: m.open, who, question: words });
  alertOwner(who, words);
}

export function initNotify() {
  markLive(["notif-x"]);
  on("notif-x", () => { clearTimeout(timer); $(".notif")?.remove(); });
  document.addEventListener("click", (e) => { if (e.target.closest?.('.notif [data-act="chat"]')) $(".notif")?.remove(); });
  onRender(watch);
  onRender(watchDone);
  onRender(watchMoves);
}
