/* Pausing a Trunk, or all of them (src/trunks/pause.ts): POST /api/trunks/{id}/pause|resume and
   POST /api/trunks/pause-all|resume-all. A paused Trunk starts nothing new; a task it is running finishes, unless the
   owner stops it too ({now: true}). The engine writes each pause in the activity log. Nothing here asks the browser
   dashboard: every read is GET /api/trunks (core/state.js), whose `running` counts the tasks running as each Trunk.
   Pass 17c, 1:1 with the prototype: while a Trunk is working, Pause asks first, "When the current task ends" or "Now",
   with Cancel and Pause at the foot (pausedo17c). A Trunk the engine holds paused while its task still runs is the
   prototype's "pauses after this task": its conversation ends with a note offering Keep going (resume) or Pause now
   (pause again with now, which stops the task), and a paused Trunk's note offers Resume. The status bar's "N paused" /
   "All Trunks paused" chip opens the Paused list (pzlist17c). The prototype's note also says messages wait; the engine
   turns them away instead, so only its first sentence is shown. */

import { $, esc } from "../core/dom.js";
import { E, refresh, ownTrunkOf } from "../core/state.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { openDlg, closeDlg, openPop, closePop, toast, ic, av, mi } from "../core/ui.js";
import { markLive } from "../core/features.js";
import { ACT } from "../shell/activity.js";
import { t, language } from "../../i18n.js";

const trunkById = (id) => E.trunks.find((tr) => tr.id === id);
export const allPaused = () => E.trunks.length > 0 && E.trunks.every((tr) => tr.paused);
/* Paused while a task of its own still runs: it stops once that task ends (the prototype's pauseAfter17c). */
const finishing = (tr) => Boolean(tr.paused && tr.running > 0);
const working = (tr) => !tr.paused && tr.running > 0;

/* What the Trunk is doing now, in the engine's words (GET /api/activity, shell/activity.js), for the dialog's first choice. */
function doing(tr) {
  const a = ACT.list.find((x) => x.sessionId && (x.sessionId === tr.chatSessionId || E.sessions.find((s) => (s.sessionId ?? s.id) === x.sessionId)?.trunkId === tr.id));
  return String(a?.current || a?.working || a?.prompt || "").split("\n")[0];
}

/* The prototype's pauseDlg17c: who is working, then the two choices, picked and confirmed with Pause. */
function pauseDialog(target, list) {
  const work = list.filter(working), names = new Intl.ListFormat(language(), { type: "conjunction" }).format(work.map((tr) => tr.name));
  const title = target === "all" ? t("window.flows.pause.q-all") : t("window.flows.pause.q-one", { name: list[0].name });
  const lede = t(work.length > 1 ? "window.flows.pause.are-working" : "window.flows.pause.is-working", { names });
  const opt = (id, checked, words, sub) => `<label class="opt"><input type="radio" name="pz17c" id="${id}"${checked ? " checked" : ""}><b>${words}</b><small>${esc(sub)}</small></label>`;
  openDlg({ title, body: `<p class="lede" data-css="margin:0 0 10px">${esc(lede)}</p><div class="opts">${opt("pz-after17c", true, t("window.flows.pause.when-ends"), (work[0] && doing(work[0])) || t("window.flows.pause.finishes-first"))}${opt("pz-now17c", false, t("dashboard.area.now"), t("window.flows.pause.now-sub"))}</div>`,
    foot: `<button class="btn ghost" type="button" data-act="dlg-close">${t("mode.cancel")}</button><button class="btn pri" type="button" data-act="pausedo17c" data-target="${esc(target)}">${t("autonomy.pause")}</button>` });
}

async function send(target, now) {
  closePop();
  closeDlg();
  const tr = trunkById(target), busy = target === "all" ? E.trunks.some(working) : tr && working(tr);
  try {
    if (target === "all") await api("trunks/pause-all", { now });
    else await api(`trunks/${encodeURIComponent(target)}/pause`, { now });
    await refresh();
    if (target === "all") toast(now || !busy ? t("window.flows.pause.all-paused") : t("window.flows.pause.working-end"));
    else toast(now || !busy ? t("window.flows.pause.now-paused", { name: tr?.name ?? "" }) : t("window.flows.pause.will-pause", { name: tr?.name ?? "" }));
  } catch (error) { toast(error.message); }
}

async function resume(id, words) {
  closePop();
  closeDlg();
  const tr = trunkById(id);
  try {
    await api(`trunks/${encodeURIComponent(id)}/resume`, {});
    await refresh();
    toast(t(words, { name: tr?.name ?? "" }));
  } catch (error) { toast(error.message); }
}

async function pauseTrunk(id) {
  closePop();
  const tr = trunkById(id);
  if (!tr) return;
  if (finishing(tr)) {
    return openDlg({ title: t("window.flows.pause.after-title", { name: tr.name }), body: `<p class="lede" data-css="margin:0">${t("window.flows.pause.after-q")}</p>`,
      foot: `<button class="btn ghost" type="button" data-act="pausekeep17c" data-id="${esc(id)}">${t("window.flows.pause.keep-going")}</button><button class="btn pri" type="button" data-act="pausenow17c" data-id="${esc(id)}">${t("window.flows.pause.pause-now")}</button>` });
  }
  if (working(tr)) return pauseDialog(id, [tr]);
  if (!tr.paused) return send(id, false);
  return resume(id, "strip.shown");
}

async function pauseAll() {
  closePop();
  if (allPaused()) {
    try {
      await api("trunks/resume-all", {});
      await refresh();
      toast(t("window.flows.pause.all-back"));
    } catch (error) { toast(error.message); }
    return;
  }
  const live = E.trunks.filter((tr) => !tr.paused);
  if (live.some(working)) return pauseDialog("all", live);
  return send("all", false);
}

/* ---------- the status bar's chip and the Paused list ---------- */
/** "N paused" or "All Trunks paused", drawn after the running count while any Trunk is paused. */
export function pausedChip() {
  const n = E.trunks.filter((tr) => tr.paused).length;
  if (!n) return "";
  return `<button class="sb pzsb17c" type="button" data-act="pzlist17c" data-tip="${t("window.flows.pause.chip-tip")}">${ic("pause", "s")}${allPaused() ? t("window.flows.pause.all-chip") : t("window.flows.pause.count-chip", { count: n })}</button>`;
}

function pausedList(el) {
  const rows = E.trunks.filter((tr) => tr.paused).map((tr) => `<div class="mi pzrow17c">${av(tr, 22)}<span class="grow"><span class="mi-t">${esc(tr.name)}</span><span class="mi-s">${finishing(tr) ? t("window.flows.pause.after-row") : t("window.flows.pause.nothing-new-row")}</span></span><button class="btn sm" type="button" data-act="${finishing(tr) ? "pausekeep17c" : "pausetrunk"}" data-id="${esc(tr.id)}">${finishing(tr) ? t("window.flows.pause.keep-going") : t("autonomy.resume")}</button></div>`).join("");
  openPop(el, `<div class="ph">${t("dashboard.standing.paused")}</div>${rows}<hr>${mi("pauseall17c", "play", allPaused() ? t("window.places.overview.resume-all-trunks") : t("window.places.overview.pause-all-trunks"))}`, { right: true });
}

/* ---------- the note at the end of a paused Trunk's own conversation ---------- */
/** The prototype's pz17c note for the Trunk whose own conversation this is, or "" while it is not paused. */
export function pauseNote(sessionId) {
  const tr = ownTrunkOf(sessionId);
  if (!tr?.paused) return "";
  const id = esc(tr.id), name = esc(tr.name);
  if (finishing(tr)) return `<div class="pz17c" role="note">${ic("pause", "s")}<span class="grow"><b>${t("window.flows.pause.will-pause-note", { name })}</b><small>${t("window.flows.pause.finishes-then-waits")}</small></span><button class="btn ghost sm" type="button" data-act="pausekeep17c" data-id="${id}">${t("window.flows.pause.keep-going")}</button><button class="btn sm" type="button" data-act="pausenow17c" data-id="${id}">${t("window.flows.pause.pause-now")}</button></div>`;
  return `<div class="pz17c" role="note">${ic("pause", "s")}<span class="grow"><b>${t("window.flows.pause.is-paused", { name })}</b><small>${t("window.flows.pause.nothing-new")}</small></span><button class="btn sm" type="button" data-act="pausetrunk" data-id="${id}">${t("autonomy.resume")}</button></div>`;
}

export function initPause() {
  markLive(["pausetrunk", "pauseall", "pauseall17c", "pausedo17c", "pausekeep17c", "pausenow17c", "pzlist17c", "sw:pz-after17c", "sw:pz-now17c"]);
  on("pausetrunk", (el) => pauseTrunk(el.dataset.id));
  on("pauseall", () => pauseAll());
  on("pauseall17c", () => pauseAll());
  on("pausedo17c", (el) => send(el.dataset.target, ["#pz-after17c", "#pz-now17c"].find((q) => $(q)?.checked) === "#pz-now17c"));
  on("pausekeep17c", (el) => resume(el.dataset.id, "window.flows.pause.keeps-going"));
  on("pausenow17c", (el) => send(el.dataset.id, true));
  on("pzlist17c", (el) => pausedList(el));
}
