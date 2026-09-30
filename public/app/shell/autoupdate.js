/* Update by itself, in the desktop app. The owner's choice is kept by the engine (GET /api/comfort notify.autoUpdate:
   off, check or install, and notify.releaseChannel), set from Settings › Updates, Notifications or Branch itself. While
   it is not off, the window asks the desktop's updater what to do on the engine's plan (POST /api/comfort/update-plan):
   install looks every 30 s, so a ready update waits for no busy task; check looks every minute on Beta and every
   hour on Stable. Each next look is timed from when the last one finished, never on a fixed tick, and a look still
   going stops a second from starting. An install goes the way the Update button does (the desktop's checksum, a try on a
   copy of your work, the copy of the data folder Beta needs, a safety copy). Nothing is looked for before the owner's
   choice has been read, nor outside the desktop app, nor in a household person's window.
   The loop starts with the window, whatever page shows: the choice is read after the first refresh (and again after
   each one), a read that fails is tried again soon with a growing wait, and a choice saved from any page (core/api.js
   comfortSaved) applies at once.
   Never silent: whatever goes wrong (asking the engine, a look, a build, an install) is said once in a toast, in the
   updater's or engine's own words, and kept by the engine (the plan's `problem`) for Settings › Updates; the normal
   schedule then tries again. What a ready update waits for (the plan's `until`, the owner's tasks holding it, or the
   updater's own reason for deferring) is kept in `lastLook` for Settings › Updates and the status bar. */

import { api, comfortSaved, goingAway } from "../core/api.js";
import { toast } from "../core/ui.js";
import { E } from "../core/state.js";
import { onRender, render } from "../core/dom.js";
import { t } from "../../i18n.js";

let notify = null; // the owner's choice, once read
let updateTimer = null, updateAttempt = false;
const off = () => (notify?.autoUpdate ?? "off") === "off";

/* What the last look found: the engine's plan (reason, `until`, `holding`, `problem`), the updater's status, and the
   updater's own words when it deferred an install. */
export const lastLook = { plan: null, status: null, wait: null, problem: null };

function scheduleUpdate() {
  clearTimeout(updateTimer);
  if (off() || !window.branchDesktop) return;
  const interval = notify.autoUpdate === "install" ? 30_000 : notify.releaseChannel !== "stable" ? 60_000 : 60 * 60 * 1000;
  updateTimer = setTimeout(() => void autoUpdate(), interval);
}

/* Which release the updater means, and the one whose install just failed (its status then carries the outcome), so the
   plan does not try that release again by itself and says so once. */
const about = (now) => ({ updaterPhase: now?.phase, ...(now?.release?.tag ? { updaterTag: now.release.tag } : {}),
  ...(now?.phase === "error" && now?.outcome && now?.release?.tag ? { failedTag: now.release.tag } : {}) });

/* The updater's own words: Electron puts "Error invoking remote method '…': Error: " before what the desktop threw. */
const ownWords = (error) => String(error?.message ?? error ?? "").replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, "").trim();

let told = null; // the failure last said, so one that repeats every look is said once
function tell(words) {
  if (!words || words === told) return;
  told = words;
  toast(words);
}
/* What was said while the engine could not be asked. Once it answers again that outage is over, so the next one is
   said too, even in the same words. */
let outage = null;
function engineDown(words) { tell(words); outage = words; }
function engineUp() {
  if (outage !== null && told === outage) told = null;
  outage = null;
}

async function ask(facts) {
  const plan = await api("comfort/update-plan", facts);
  engineUp();
  lastLook.plan = plan;
  lastLook.problem = plan.problem ?? null;
  return plan;
}

/* A failure: kept by the engine and said once. When the engine cannot be asked, it is said here all the same. */
async function report(words, facts = {}) {
  const said = words || String(t("window.updates.failed"));
  lastLook.problem = { message: said, at: new Date().toISOString() };
  let plan;
  try { plan = await ask({ ...facts, problem: said.slice(0, 600) }); } catch (error) { console.warn(error.message); engineDown(said); return; }
  lastLook.problem = plan.problem ?? lastLook.problem;
  if (plan.tellProblem || plan.failed) { told = null; tell([said, plan.failed].filter(Boolean).join(" ")); }
}

/* An install the updater refused: a deferral leaves a newer version available (its words say why it waits, and the next
   look tries again); anything else failed, and the updater's status (or what it threw) says why. */
async function install(desktop) {
  lastLook.wait = null;
  goingAway(); // the engine restarts into the new version: the swap screen covers it, nothing is said meanwhile
  try {
    lastLook.status = await desktop.installUpdate(true);
  } catch (error) {
    goingAway(false);
    const status = await desktop.updateStatus().catch(() => null);
    lastLook.status = status ?? lastLook.status;
    // The desktop names a wait (src/desktop/updater.ts UpdateDeferredError): the channel just changed, tasks at work.
    if (/\bUpdateDeferredError: /.test(String(error?.message))) { lastLook.wait = ownWords(error); return; }
    await report(status?.phase === "error" && status.message ? status.message : ownWords(error), about(status));
  }
}

/* The app runs update by itself (src/desktop/update-loop.ts), so the page only reads what it is doing. */
let saidHooked = false;
async function follow(desktop) {
  if (!saidHooked) { saidHooked = true; desktop.onUpdateSaid?.((words) => tell(words)); }
  lastLook.status = await desktop.updateStatus();
  const loop = await desktop.updateLoop();
  lastLook.plan = loop.plan ?? lastLook.plan;
  lastLook.wait = loop.wait ?? null;
}

async function look(desktop) {
  if ((await desktop.updateLoop?.().catch(() => null))?.inMain) return follow(desktop);
  let status = lastLook.status = await desktop.updateStatus();
  let plan = await ask(about(status));
  if (plan.failed) tell(plan.failed);
  if (plan.step === "check") {
    status = lastLook.status = await desktop.checkForUpdates();
    // The updater answers a failed look with its status, not a throw: that is a failure too.
    if (status?.phase === "error") return report(status.message, { ...about(status), checked: true });
    plan = await ask({ ...about(status), checked: true });
  }
  if (plan.step === "install") return install(desktop);
  /* A Beta change that does not contain this copy's (a line that diverged or was force-pushed) is never installed by
     itself: only the owner's confirmation in Settings › Updates moves to it. So it is said, once, in the updater's words,
     and stays as the waiting line: never a silent stall. A newer change on the same line needs no click at all, and a
     copy already ahead of Beta's newest change is not invited to go back. */
  lastLook.wait = status?.release?.otherLine === true && status.release.standing === "apart" && status.message ? status.message : null;
  if (lastLook.wait) tell(lastLook.wait);
  if (plan.mode === "check" && status?.phase === "available") toast(t("comfort.update.ready"));
}

export async function autoUpdate() {
  const desktop = window.branchDesktop;
  if (updateAttempt || !desktop || off()) return;
  clearTimeout(updateTimer);
  updateAttempt = true;
  try {
    await look(desktop);
  } catch (error) {
    await report(ownWords(error)); // the engine or the desktop could not be asked: said once, and the next look tries again
  } finally {
    updateAttempt = false;
    render();
    // The engine records when a check finished, so the next delay starts after its answer. The latest choice is read:
    // a change while this look was going must not revive an old channel or a schedule that was turned off.
    scheduleUpdate();
  }
}

/* The owner's choice as the engine has it (GET /api/comfort values); a look starts now unless the choice is off. */
export function applyComfort(values) {
  notify = values?.notify ?? null;
  clearTimeout(updateTimer);
  if (off()) { lastLook.plan = null; lastLook.wait = null; } // switched off: nothing is said to be waiting any more
  if (!off() && window.branchDesktop) void autoUpdate();
}

let seenState = null, reading = null, asked = false, retryTimer = null, retries = 0;
const choiceOf = (n) => JSON.stringify([n?.autoUpdate ?? "off", n?.releaseChannel ?? null]);
function heard(values) {
  if (!asked || choiceOf(values?.notify) !== choiceOf(notify)) applyComfort(values);
  asked = true;
}
/* A read that failed is tried again after 2 s, 4 s, 8 s … at most a minute apart, without waiting for a refresh. */
function readAgainSoon() {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => { seenState = null; followComfort(); }, Math.min(60_000, 2_000 * 2 ** retries++));
}
function followComfort() {
  if (!window.branchDesktop || !E.state || E.state === seenState || reading || E.profiles?.isOwner === false) return;
  seenState = E.state;
  reading = api("comfort")
    .then((view) => { retries = 0; engineUp(); heard(view?.values ?? null); }, (error) => { engineDown(ownWords(error)); readAgainSoon(); })
    .finally(() => { reading = null; });
}

export function initAutoUpdate() {
  onRender(followComfort);
  comfortSaved.add((values) => { if (window.branchDesktop) heard(values); });
  followComfort();
}

/* ---------- what the window says about it (Settings › Updates and the status bar) ---------- */

/* The owner's tasks holding a ready update, named as the running list names them, each opening its conversation. */
export function holdingTasks() {
  return (lastLook.plan?.holding ?? []).map((task) => {
    const s = E.sessions?.find((x) => (x.sessionId ?? x.id) === task.sessionId);
    const trunk = E.trunks?.find((x) => x.id === s?.trunkId || (x.chatSessionId && x.chatSessionId === task.sessionId));
    return { sessionId: task.sessionId, state: task.state, name: trunk?.name || s?.opening || s?.title || "" };
  });
}

/* "Update ready, installs when …" in the engine's words, or the updater's reason for deferring; null when nothing waits. */
export function waitingLine() {
  const until = lastLook.plan?.until;
  if (until) return t("window.updates.ready-installs-when", { until });
  return lastLook.wait || null;
}
