/* App lock, the window's side (the engine's is src/session-lock.ts).
   While the engine is locked with a PIN set it answers nothing but GET /api/lock and POST /api/lock/unlock (423 for
   everything else), so the window draws only the prototype's lock screen: its mark, "Branch is locked", a PIN field
   and Unlock. The typed PIN is read from the field, the field is emptied, and the PIN goes only into that one request.
   Unlocking reloads the window, so nothing drawn before the lock comes back from memory.
   When the engine has locked (by the quiet period, or from another window), the window reloads into the lock screen:
   main.js watchPerson hears it from GET /api/profiles, which a locked Branch answers 423 (the event stream does not end
   when Branch locks).
   "Always" (lockOnOpen): a window opening fresh — not a reload in the same tab — locks Branch with POST /api/lock.
   "Lock Branch" in the menu is POST /api/lock. qa-fixes-3 (Q040): a lock only holds with a PIN (the engine refuses
   everything else while locked, across reloads, other windows and restarts), so without one the menu item first asks for
   one in App lock's own dialog (POST /api/lock/pin { pin }, the owner's alone), then locks and reloads into the lock
   screen. There is no lock screen without a PIN: one would open with a click and be gone after a reload. */
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { esc } from "../core/dom.js";
import { toast, openDlg, closeDlg, $ } from "../core/ui.js";
import { t } from "../../i18n.js";

const OPENED = "branch-opened";
const opened = {
  get: () => { try { return sessionStorage.getItem(OPENED) === "1"; } catch (error) { console.warn(error.message); return false; } },
  set: () => { try { sessionStorage.setItem(OPENED, "1"); } catch (error) { console.warn(error.message); } },
};

/* The prototype's lock screen (renderLockScreen), with the PIN field and Unlock: the engine locks only with a PIN. */
export function showLock() {
  document.querySelector(".lockscreen")?.remove();
  const app = document.getElementById("app");
  app.classList.add("locked-b17");
  const el = document.createElement("div");
  el.className = "lockscreen";
  const field = `<input class="inp" id="pin-unlock-b17" type="password" inputmode="numeric" maxlength="8" autocomplete="off" aria-label="${esc(t("household.pinFact"))}">`;
  el.innerHTML = `<div class="inner"><span class="mark mark-full lock-mark" aria-hidden="true"></span><h2>${esc(t("phone.lock.title"))}</h2>
    <form class="pinbox" id="unlock-b17" aria-label="${esc(t("window.applock.enter-your-pin"))}">${field}<button class="btn pri" type="submit">${esc(t("phone.lock.unlock"))}</button></form>
    <p class="hint">${esc(t("window.applock.five-wrong-tries"))}</p></div>`;
  app.appendChild(el);
  (el.querySelector("#pin-unlock-b17") ?? el.querySelector("button")).focus();
  el.querySelector("#unlock-b17").addEventListener("submit", (e) => { e.preventDefault(); unlock(el); });
}

async function unlock(el) {
  const box = el.querySelector("#pin-unlock-b17");
  const body = { pin: box.value };
  box.value = "";
  const button = el.querySelector("button");
  button.disabled = true;
  try {
    await api("lock/unlock", body);
  } catch (error) {
    button.disabled = false;
    toast(error.message);
    box.focus();
    return;
  }
  opened.set();
  location.reload();
}

/* After the window has connected: lock on a fresh open when "Always" is chosen, then watch for the engine locking.
   Answers true when the window has just locked itself (the caller stops there). */
export async function watchLock(lock) {
  if (lock?.pinSet && lock.lockOnOpen && !opened.get()) {
    opened.set();
    document.getElementById("app").classList.add("locked-b17");
    try { await api("lock", {}); } catch (error) { toast(error.message); return false; }
    location.reload();
    return true;
  }
  opened.set();
  /* Noticing a lock afterwards is main.js watchPerson's: a Branch locked with a PIN answers its GET /api/profiles 423. */
  return false;
}

/* Lock Branch: with a PIN, lock and reload into the lock screen; without one, ask for one first (App lock's dialog). */
async function lockNow() {
  let state;
  try { state = await api("lock"); } catch (error) { toast(error.message); return; }
  if (!state.pinSet) {
    openDlg({ title: t("window.settings.p17-permissions.app-lock"),
      body: `<div class="field"><label for="pin-lock-b17">${esc(t("household.pinFact"))}</label><input class="inp" id="pin-lock-b17" type="password" inputmode="numeric" maxlength="8" autocomplete="off"></div><p class="hint" data-css="margin:0">${esc(t("window.applock.four-to-eight"))}</p>`,
      foot: `<button class="btn ghost" type="button" data-act="dlg-close">${esc(t("mode.cancel"))}</button><button class="btn pri" type="button" data-act="lockpinb17">${esc(t("window.shell.shell.lock-branch"))}</button>` });
    return;
  }
  try { await api("lock", {}); } catch (error) { toast(error.message); return; }
  location.reload();
}
/* The PIN is read from its field, the field is emptied, and it goes only into the one request that sets it. A lock
   already on (the locker closed, or quiet minutes run out) becomes the PIN's the moment it is set, and the engine then
   answers the lock request 423: locked is what was asked for. */
async function pinThenLock() {
  const box = $("#pin-lock-b17"), pin = box?.value ?? "";
  if (box) box.value = "";
  try {
    await api("lock/pin", { pin });
    await api("lock", {}).catch((error) => { if (error.status !== 423) throw error; });
  } catch (error) { toast(error.message); return; }
  closeDlg();
  location.reload();
}

let started = false;
export function initLock() {
  if (started) return;
  started = true;
  on("lockscreen", () => lockNow());
  on("lockpinb17", () => pinThenLock());
  markLive(["lockscreen", "lockpinb17", "sw:pin-unlock-b17", "sw:pin-lock-b17"]);
}
