/* Settings › Permissions › App lock (prototype patch17b: Off, After 15 min, Always), from the engine:
   GET /api/lock says whether a PIN is set (never the PIN), the quiet minutes and lock-on-open.
   Off removes the PIN: POST /api/lock/pin { pin: null, current }, which the engine refuses without the PIN set now, and
   saves lock-on-open off (the quiet minutes stay: without a PIN they only close the locker, as before App lock).
   After 15 min and Always first set a PIN when none is set (POST /api/lock/pin { pin }), then save the lock's settings
   whole (POST /api/lock/settings replaces them: idleMinutes, secretsWhileLocked, lockOnOpen).
   Change asks for the PIN set now and a new one (POST /api/lock/pin { pin, current }).
   A typed PIN is read from its field, the field is emptied, and it goes only into that one request; nothing keeps it.
   The engine counts wrong PINs here exactly as on the lock screen: every fifth wrong one waits. */
import { esc, render } from "../core/dom.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { toast, openDlg, closeDlg, $ } from "../core/ui.js";
import { t } from "../../i18n.js";

const L = { lock: null };

export async function load() { // your-profile: Your profile reads it before drawing applockRow()
  try { L.lock = await api("lock"); } catch (error) { toast(error.message); }
  render();
}

/* Which of the three the engine is on; none pressed when it has a PIN and neither quiet minutes nor lock-on-open. */
function current(lock) {
  if (!lock) return null;
  if (!lock.pinSet) return "off";
  if (lock.lockOnOpen) return "pin";
  return lock.idleMinutes > 0 ? "quiet" : null;
}
const quietMinutes = (lock) => (lock?.idleMinutes > 0 ? lock.idleMinutes : 15);

export function applockRow() {
  const lock = L.lock, cur = current(lock), n = quietMinutes(lock);
  const sub = cur === "off" ? t("window.applock.anyone-can-open") : cur === "quiet" ? t("window.applock.locks-after", { count: n })
    : cur === "pin" ? t("window.applock.asks-every-open") : "";
  const opts = [["off", t("accounts.switch.off")], ["quiet", t("window.applock.after-min", { count: n })], ["pin", t("window.places.automations.always")]];
  const seg = `<span class="seg" role="group" aria-label="${esc(t("window.settings.p17-permissions.app-lock"))}">${opts.map(([v, l]) => `<button type="button" aria-pressed="${cur === v}" data-act="applockb17" data-v="${esc(v)}">${esc(l)}</button>`).join("")}</span>`;
  const change = lock?.pinSet ? `<button class="btn sm" type="button" data-act="applockchgb17">${esc(t("window.settings.voice.change"))}</button>` : "";
  return `<div class="ctl"><b>${esc(t("window.settings.p17-permissions.app-lock"))}</b><span class="right applock-b17">${seg}${change}</span><small>${esc(sub)}</small></div>`;
}

const field = (id, label, hint = "") => `<div class="field"><label for="${id}">${esc(label)}</label><input class="inp" id="${id}" type="password" inputmode="numeric" maxlength="8" autocomplete="off"></div>${hint ? `<p class="hint" data-css="margin:0">${esc(hint)}</p>` : ""}`;
const foot = (act, label, v = "") => `<button class="btn ghost" type="button" data-act="dlg-close">${esc(t("mode.cancel"))}</button><button class="btn pri" type="button" data-act="${act}" data-v="${esc(v)}">${esc(label)}</button>`;
/* Reads a field and empties it at once, so the PIN lives only as long as the request that carries it. */
function take(box) {
  const value = box?.value ?? "";
  if (box) box.value = "";
  return value;
}

function choose(el) {
  const want = el.dataset.v, lock = L.lock;
  if (!lock || want === current(lock)) return;
  if (want === "off") return openDlg({ title: t("window.settings.p17-permissions.app-lock"), body: field("pin-cur-b17", t("household.pinFact"), t("window.applock.five-wrong-tries")), foot: foot("applockoffb17", t("accounts.action.remove")) });
  if (!lock.pinSet) return openDlg({ title: t("window.settings.p17-permissions.app-lock"), body: field("pin-new-b17", t("household.pinFact"), t("window.applock.four-to-eight")), foot: foot("applocksetb17", t("action.save"), want) });
  saveMode(want);
}

async function saveMode(want) {
  const lock = L.lock;
  const next = { idleMinutes: want === "quiet" ? quietMinutes(lock) : lock.idleMinutes, secretsWhileLocked: lock.secretsWhileLocked, lockOnOpen: want === "pin" };
  try { await api("lock/settings", next); } catch (error) { toast(error.message); return; }
  await load();
  toast(want === "pin" ? t("window.applock.toast-always") : t("window.applock.toast-quiet", { count: next.idleMinutes }));
}

async function setPin(el) {
  const pin = take($("#pin-new-b17"));
  try { await api("lock/pin", { pin }); } catch (error) { toast(error.message); return; }
  closeDlg();
  await load();
  await saveMode(el.dataset.v);
}

async function removePin() {
  const current = take($("#pin-cur-b17"));
  const lock = L.lock;
  try {
    await api("lock/pin", { pin: null, current });
    /* "Always" goes with the PIN. The quiet minutes stay: without a PIN they only close the locker, as before App lock. */
    await api("lock/settings", { idleMinutes: lock.idleMinutes, secretsWhileLocked: lock.secretsWhileLocked, lockOnOpen: false });
  } catch (error) { toast(error.message); return; }
  closeDlg();
  await load();
  toast(t("window.applock.toast-off"));
}

function openChange() {
  openDlg({ title: t("window.settings.p17-permissions.app-lock"), body: field("pin-cur-b17", t("window.applock.owners-pin"), t("window.applock.five-wrong-tries")) + field("pin-new-b17", t("household.pinFact"), t("window.applock.four-to-eight")),
    foot: foot("applockchgokb17", t("action.save")) });
}
async function changePin() {
  const current = take($("#pin-cur-b17")), pin = take($("#pin-new-b17"));
  try { await api("lock/pin", { pin, current }); } catch (error) { toast(error.message); return; }
  closeDlg();
  await load();
}

let started = false;
export function initApplock() {
  if (started) return;
  started = true;
  on("applockb17", (el) => choose(el));
  on("applocksetb17", (el) => setPin(el));
  on("applockoffb17", () => removePin());
  on("applockchgb17", () => openChange());
  on("applockchgokb17", () => changePin());
  markLive(["applockb17", "applocksetb17", "applockoffb17", "applockchgb17", "applockchgokb17", "sw:pin-cur-b17", "sw:pin-new-b17"]);
  load();
}
