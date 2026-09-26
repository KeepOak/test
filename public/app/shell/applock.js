/* App lock, the window's side (the engine's is src/session-lock.ts).
   While the engine is locked with a PIN set it answers nothing but GET /api/lock and POST /api/lock/unlock (423 for
   everything else), so the window draws only the prototype's lock screen: its mark, "Branch is locked", a PIN field
   and Unlock. The typed PIN is read from the field, the field is emptied, and the PIN goes only into that one request.
   Unlocking reloads the window, so nothing drawn before the lock comes back from memory.
   When the engine has locked (by the quiet period, or from another window), the window reloads into the lock screen:
   main.js watchPerson hears it from the event stream's end and from GET /api/profiles, which a locked Branch answers 423.
   "Always" (lockOnOpen): a window opening fresh — not a reload in the same tab — locks Branch with POST /api/lock.
   "Lock Branch" in the menu is POST /api/lock. Without a PIN set that is today's lock: the locker closes, the window
   shows the lock screen with Unlock alone, and unlocking (POST /api/lock/unlock {}) asks nothing. */
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { esc } from "../core/dom.js";
import { toast } from "../core/ui.js";
import { t } from "../../i18n.js";

const OPENED = "branch-opened";
const opened = {
  get: () => { try { return sessionStorage.getItem(OPENED) === "1"; } catch (error) { console.warn(error.message); return false; } },
  set: () => { try { sessionStorage.setItem(OPENED, "1"); } catch (error) { console.warn(error.message); } },
};

/* The prototype's lock screen (renderLockScreen), with a PIN field and Unlock when a PIN is set. */
export function showLock(pinSet = true) {
  document.querySelector(".lockscreen")?.remove();
  const app = document.getElementById("app");
  app.classList.add("locked-b17");
  const el = document.createElement("div");
  el.className = "lockscreen";
  const field = pinSet ? `<input class="inp" id="pin-unlock-b17" type="password" inputmode="numeric" maxlength="8" autocomplete="off" aria-label="${esc(t("household.pinFact"))}">` : "";
  el.innerHTML = `<div class="inner"><span class="mark mark-full lock-mark" aria-hidden="true"></span><h2>${esc(t("phone.lock.title"))}</h2>
    <form class="pinbox" id="unlock-b17" aria-label="${esc(t("window.applock.enter-your-pin"))}">${field}<button class="btn pri" type="submit">${esc(t("phone.lock.unlock"))}</button></form>
    ${pinSet ? `<p class="hint">${esc(t("window.applock.five-wrong-tries"))}</p>` : ""}</div>`;
  app.appendChild(el);
  (el.querySelector("#pin-unlock-b17") ?? el.querySelector("button")).focus();
  el.querySelector("#unlock-b17").addEventListener("submit", (e) => { e.preventDefault(); unlock(el); });
}

async function unlock(el) {
  const box = el.querySelector("#pin-unlock-b17");
  const body = box ? { pin: box.value } : {};
  if (box) box.value = "";
  const button = el.querySelector("button");
  button.disabled = true;
  try {
    await api("lock/unlock", body);
  } catch (error) {
    button.disabled = false;
    toast(error.message);
    box?.focus();
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

let started = false;
export function initLock() {
  if (started) return;
  started = true;
  on("lockscreen", async () => {
    let state;
    try { state = await api("lock", {}); } catch (error) { toast(error.message); return; }
    if (state.pinSet) location.reload();
    else showLock(false);
  });
  markLive(["lockscreen", "sw:pin-unlock-b17"]);
}
