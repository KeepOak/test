/* The one recommendation bar (prototype recBar), drawn at the top of Inbox and Overview only (never over a conversation:
   the prototype's pass 7 took it out of the chat, and pass 18 keeps it to those two places), and only
   while the engine suggests it: GET /api/deployment/suggestion answers "background", "updates" or nothing, one at a time
   and only in the owner's window after the first run. Don't ask again is kept by the engine (POST
   /api/deployment/suggestion {id, answer: "never"}); Not now is this window's until it next opens. Yes for updates turns
   on installing updates when idle (POST /api/comfort, card notify). Yes for background saves the same gateway choice as
   Settings › General and › Gateway (POST /api/never-break { mode: "on" }); it never sets up a system service, and it says
   what is really so: running now, or saved to start with the next launch. */

import { render, esc } from "../core/dom.js";
import { E, ownerHere } from "../core/state.js";
import { api, goingAway } from "../core/api.js";
import { on } from "../core/actions.js";
import { ic, toast } from "../core/ui.js";
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
  return `<div class="recbar"><span class="ico-tile">${ic(id === "updates" ? "retry" : "plug", "s")}</span><span class="rec-t"><b>${t(words[0])}</b><span class="rec">${t("suggest.recommended")}</span><small>${t(words[1])}</small></span>
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

/* Keep Branch running: the saved gateway choice, then the actual state the engine reports (never "on" by assumption). */
async function keepRunning() {
  let view;
  try { view = await api("never-break", { mode: "on" }); } catch (error) { toast(error.message); return; }
  toast(t(view?.mode === "off" ? "gatewayChoice.off" : view?.underGateway === true ? "gatewayChoice.running" : "gatewayChoice.saved"));
  await readBar();
}

export function initRec() {
  markLive(["rec", "rec-install"]);
  on("rec", (el) => answer(el));
  on("rec-install", () => keepRunning());
  if (window.branchDesktop?.installUpdate) markLive(["install"]);
  // Remind me tomorrow puts the card below away for a day; only the desktop app draws that card (a browser has none).
  if (window.branchDesktop?.updateStatus) markLive(["upd-snooze"]);
  on("install", () => installNow());
}

/* Pass 18's update card, on Overview and Inbox only (never over a conversation): "Branch <new> is ready" while the
   desktop's updater has found a newer version (flows/whatsnew.js waiting, window.branchDesktop.updateStatus), with Read
   the release notes (its notes' second tab) and Install when nothing is running. Update by itself installs without
   anyone pressing it; this is only for installing early. Only the owner's window draws it (a household person's never
   does), nothing is drawn in a browser or while nothing newer was found, and no version is written in. The updater is
   asked at most once a minute, and a change redraws. */
const U = { next: null, at: 0, asking: false, failed: "" };
/* Remind me tomorrow (the version menu, shell/usage.js): the card stays away for a day for the version it offered; a newer
   one comes back at once. Update by itself still installs as set; this only puts the reminder off. Kept in this window's
   own storage, a convenience for this viewer. */
const SNOOZE = "branch-update-remind";
function snoozed(version) {
  try { const s = JSON.parse(localStorage.getItem(SNOOZE) ?? "null"); return !!s && s.version === version && Date.now() < s.until; } catch { return false; }
}
export function snoozeUpdate(version = U.next?.version) {
  if (!version) return;
  try { localStorage.setItem(SNOOZE, JSON.stringify({ version, until: Date.now() + 24 * 3600 * 1000 })); } catch { /* no storage: the card stays */ }
  toast(t("window.chat.rec.remind-tomorrow"));
  render();
}
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
  if (!window.branchDesktop?.updateStatus || !ownerHere()) return "";
  if (!U.asking && Date.now() - U.at > 60_000) readNext();
  if (!U.next || snoozed(U.next.version)) return "";
  return `<div class="upd18c" role="status">${ic("spark", "s")}<span class="grow"><b>${esc(t("window.flows.whatsnew.is-ready", { version: U.next.version }))}</b><small>${t("window.chat.rec.update-ready-hint")}</small></span><button class="btn ghost sm" type="button" data-act="relnotes17d" data-v="ready">${t("window.flows.whatsnew.read")}</button><button class="btn pri sm" type="button" data-act="install">${t("window.settings.updates.install-when-nothing-is-running")}</button></div>`;
}

/* Install: the owner's press, so the desktop's install call goes as Settings › Updates' Update now does (installUpdate(false):
   never a Beta change that leaves this copy's line, which only its own confirmation moves to). The desktop's updater
   still checks the download, waits until no task is working, keeps a safety copy, and quits into the new version; the
   window stays quiet meanwhile (goingAway). A wait or a refusal is said in the updater's own words, and the card stays. */
const ownWords = (error) => String(error?.message ?? error ?? "").replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, "").trim();
let installing = false;
async function installNow() {
  const desktop = window.branchDesktop;
  if (installing || !desktop?.installUpdate || !ownerHere()) return;
  installing = true;
  goingAway();
  try { await desktop.installUpdate(false); } catch (error) {
    goingAway(false);
    toast(ownWords(error));
    U.at = 0;
  } finally { installing = false; }
  render();
}
