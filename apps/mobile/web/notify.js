/**
 * "Tell me when a task needs me", while the app is open (rules.js pollPlan): one look as soon as the app opens or
 * comes back to the front, then every 60 seconds at When needed and every 30 at On (On also adds the platform's
 * background check, natively). Each question is told once: the ids already told are kept on this phone, so a
 * relaunch does not tell them again, and the native notification id is the task's, so a second telling replaces
 * the first. Which kinds are told follows Settings › Notifications.
 */
import { newAttention, newFinished, pollPlan } from "/rules.js";
import { phone, plugin, say } from "/phone-common.js";

const KEPT = "branch-told";
let timer = 0;
let plan = pollPlan("off");
let kinds = { notifyNeeds: "on", notifyDone: "on" };
let firstLook = true;
let onState = () => undefined;

function told() {
  try { return new Set(JSON.parse(localStorage.getItem(KEPT) ?? "[]")); } catch { return new Set(); }
}
function remember(set) {
  try { localStorage.setItem(KEPT, JSON.stringify([...set].slice(-300))); return true; } catch { return false; } // refused: a relaunch may tell once more
}

/** One look at the paired Branch. Answers the state it read, for the screens. */
export async function checkNow() {
  if (!phone.vault || !plan.foreground) return null;
  const state = await phone.vault.request("GET", "/api/state").catch(() => null);
  if (!state) return null;
  const seen = told();
  if (kinds.notifyNeeds === "on") for (const item of newAttention(state, seen)) {
    await plugin.notify({ id: item.id, title: say("phone.notify.title", "Branch needs you"), body: item.question });
    seen.add(item.id);
  }
  for (const run of newFinished(state, seen)) {
    // The first look only learns what already finished, so opening the app never brings a pile of old news.
    if (!firstLook && kinds.notifyDone === "on") await plugin.notify({ id: run.id, title: say("phone8.notif.done", "A task finished"), body: run.words });
    seen.add(run.id);
  }
  firstLook = false;
  remember(seen);
  onState(state);
  return state;
}

/** Starts (or stops) the checks to match the switches; looks once at once whenever it is on. */
export function restartChecks(switches) {
  clearInterval(timer);
  plan = pollPlan(switches?.notifications);
  kinds = { notifyNeeds: switches?.notifyNeeds ?? "on", notifyDone: switches?.notifyDone ?? "on" };
  if (!plan.foreground) return;
  void checkNow();
  timer = setInterval(() => void checkNow(), plan.everySeconds * 1000);
}

/** The app came back to the front: look now, whatever the interval says. */
export function watchFront(stateSeen) {
  onState = stateSeen;
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") void checkNow(); });
  document.addEventListener("resume", () => void checkNow()); // Capacitor's own event when the app returns
}
export const planNow = () => plan;
