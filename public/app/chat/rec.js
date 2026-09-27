/* The one recommendation bar (prototype recBar), drawn at the top of Inbox and Overview only (never over a conversation:
   the prototype's pass 7 took it out of the chat, and pass 18 keeps it to those two places), and only
   while the engine suggests it: GET /api/deployment/suggestion answers "background", "updates" or nothing, one at a time
   and only in the owner's window after the first run. Don't ask again is kept by the engine (POST
   /api/deployment/suggestion {id, answer: "never"}); Not now is this window's until it next opens. Yes for updates turns
   on installing updates when idle (POST /api/comfort, card notify). Yes for background installs a system service, so it
   stays greyed (its act has no handler) until that can be proved safe. */

import { render, esc } from "../core/dom.js";
import { E } from "../core/state.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { toast, ic } from "../core/ui.js";
import { markLive } from "../core/features.js";
import { waiting } from "../flows/whatsnew.js";
import { t } from "../../i18n.js";

const R = { bar: null, seen: null, asking: false, failed: "", later: new Set() };
const WORDS = {
  background: ["window.chat.rec.background", "window.chat.rec.background-hint"],
  updates: ["suggest.updates", "suggest.updatesWhy"],
};

/* Draws again only when the answer changes what is shown; one question at a time, and a refusal is told once. */
async function readBar() {
  if (R.asking) return;
  R.asking = true;
  const before = R.bar;
  try { R.bar = (await api("deployment/suggestion")).bar ?? null; R.failed = ""; } catch (error) {
    if (error.message !== R.failed) toast(error.message);
    R.failed = error.message;
    R.bar = null;
  }
  R.asking = false;
  if (R.bar !== before) render();
}

/* Asked when the window opens and again whenever a refresh of the engine's state (refresh()) shows first run done or
   undone (GET /api/state onboarding.done), so the bar follows first run finishing without a reload. Not on every
   refresh: in the installed app each answer asks the system whether Branch runs in the background, a process each time. */
export function recBar() {
  const key = String(E.state?.onboarding?.done);
  if (E.loaded && !R.asking && R.seen !== key) { R.seen = key; readBar(); }
  const id = R.bar, words = WORDS[id];
  if (!words || R.later.has(id)) return "";
  const yes = id === "updates" ? "rec" : "rec-install";
  return `<div class="recbar"><span class="mark mark-face rec-mark" aria-hidden="true"></span><span class="rec-t"><b>${t(words[0])}</b><span class="rec">${t("suggest.recommended")}</span><small>${t(words[1])}</small></span>
    <button class="btn pri sm" type="button" data-act="${yes}" data-k="${id}" data-v="yes">${t("autonomy.needs.yes")}</button><button class="btn sm" type="button" data-act="rec" data-k="${id}" data-v="later">${t("updates.busy.cancel")}</button><button class="btn ghost sm" type="button" data-act="rec" data-k="${id}" data-v="never">${t("window.chat.rec.never")}</button></div>`;
}

async function answer(el) {
  const id = el.dataset.k, v = el.dataset.v;
  if (v === "later") { R.later.add(id); render(); return; }
  try {
    if (v === "never") await api("deployment/suggestion", { id, answer: "never" });
    else if (v === "yes" && id === "updates") { await api("comfort", { card: "notify", values: { autoUpdate: "install" } }); toast(t("window.chat.rec.updated")); }
    else return;
  } catch (error) { toast(error.message); return; }
  await readBar();
}

export function initRec() {
  markLive(["rec"]);
  on("rec", (el) => answer(el));
}

/* Pass 18's update card, on Overview and Inbox only (never over a conversation): "Branch <new> is ready" while the
   desktop's updater has found a newer version (flows/whatsnew.js waiting, window.branchDesktop.updateStatus), with Read
   the release notes (its notes' second tab) and Install when nothing is running, the same control as Settings › Updates
   and the version menu, greyed like those until installing has a handler. No version is written in: nothing is drawn
   in a browser or while nothing newer was found. The updater is asked at most once a minute, and a change redraws. */
const U = { next: null, at: 0, asking: false, failed: "" };
async function readNext() {
  U.asking = true;
  const before = U.next?.version ?? null;
  try { U.next = await waiting(); U.failed = ""; } catch (error) {
    if (error.message !== U.failed) toast(error.message);
    U.failed = error.message;
    U.next = null;
  }
  U.at = Date.now();
  U.asking = false;
  if ((U.next?.version ?? null) !== before) render();
}
export function updateCard() {
  if (!window.branchDesktop?.updateStatus) return "";
  if (!U.asking && Date.now() - U.at > 60_000) readNext();
  if (!U.next) return "";
  return `<div class="upd18c" role="status">${ic("spark", "s")}<span class="grow"><b>${esc(t("window.flows.whatsnew.is-ready", { version: U.next.version }))}</b><small>${t("window.chat.rec.update-ready-hint")}</small></span><button class="btn ghost sm" type="button" data-act="relnotes17d" data-v="ready">${t("window.flows.whatsnew.read")}</button><button class="btn pri sm" type="button" data-act="install">${t("window.settings.updates.install-when-nothing-is-running")}</button></div>`;
}
