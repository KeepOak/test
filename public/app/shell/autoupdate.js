/* Update by itself, in the desktop app. The owner's choice is kept by the engine (GET /api/comfort notify.autoUpdate:
   off, check or install, and notify.releaseChannel), set from Settings › Updates, Notifications or Branch itself. While
   it is not off, the window asks the desktop's updater what to do on the engine's plan (POST /api/comfort/update-plan):
   install looks every 30 s, so a ready update waits for no busy task; check looks every five minutes on Beta and Dev and
   every hour on Stable. Each next look is timed from when the last one finished, never on a fixed tick, and a look still
   going stops a second from starting. An install goes the way the Update button does (the desktop's checksum, a try on a
   copy of your work, a safety copy). Nothing is looked for before the owner's choice has been read, nor outside the
   desktop app. The choice is read again after each refresh of the window, as shell/celebrate.js does for achievements,
   and a changed choice starts the schedule again from now. Ported from the old window's public/comfort.js. */

import { api } from "../core/api.js";
import { toast } from "../core/ui.js";
import { E } from "../core/state.js";
import { onRender } from "../core/dom.js";
import { t } from "../../i18n.js";

let notify = null; // the owner's choice, once read
let updateTimer = null, updateAttempt = false;
const off = () => (notify?.autoUpdate ?? "off") === "off";

function scheduleUpdate() {
  clearTimeout(updateTimer);
  if (off() || !window.branchDesktop) return;
  const interval = notify.autoUpdate === "install" ? 30_000 : notify.releaseChannel !== "stable" ? 5 * 60 * 1000 : 60 * 60 * 1000;
  updateTimer = setTimeout(() => void autoUpdate(), interval);
}

/* Which release the updater means, and the one whose install just failed (its status then carries the outcome), so the
   plan does not try that release again by itself and says so once. */
const about = (now) => ({ updaterPhase: now?.phase, ...(now?.release?.tag ? { updaterTag: now.release.tag } : {}),
  ...(now?.phase === "error" && now?.outcome && now?.release?.tag ? { failedTag: now.release.tag } : {}) });

export async function autoUpdate() {
  const desktop = window.branchDesktop;
  if (updateAttempt || !desktop || off()) return;
  clearTimeout(updateTimer);
  updateAttempt = true;
  try {
    let status = await desktop.updateStatus();
    let plan = await api("comfort/update-plan", about(status));
    if (plan.failed) toast(plan.failed);
    if (plan.step === "check") {
      status = await desktop.checkForUpdates();
      plan = await api("comfort/update-plan", { ...about(status), checked: true });
    }
    if (plan.step === "install") await desktop.installUpdate(true);
    else if (plan.mode === "check" && status?.phase === "available") toast(t("comfort.update.ready"));
  } catch (error) {
    console.warn(error.message); // offline or refused: the next look tries again, without a toast every few minutes
  } finally {
    updateAttempt = false;
    // The engine records when a check finished, so the next delay starts after its answer. The latest choice is read:
    // a change while this look was going must not revive an old channel or a schedule that was turned off.
    scheduleUpdate();
  }
}

/* The owner's choice as the engine has it (GET /api/comfort values); a look starts now unless the choice is off. */
export function applyComfort(values) {
  notify = values?.notify ?? null;
  clearTimeout(updateTimer);
  if (!off() && window.branchDesktop) void autoUpdate();
}

let seenState = null, reading = null, asked = false;
const choiceOf = (n) => JSON.stringify([n?.autoUpdate ?? "off", n?.releaseChannel ?? null]);
function followComfort() {
  if (!window.branchDesktop || !E.state || E.state === seenState || reading) return;
  seenState = E.state;
  reading = api("comfort")
    .then((view) => {
      const next = view?.values ?? null;
      if (!asked || choiceOf(next?.notify) !== choiceOf(notify)) applyComfort(next);
      asked = true;
    }, (error) => console.warn(error.message))
    .finally(() => { reading = null; });
}

export function initAutoUpdate() {
  onRender(followComfort);
}
