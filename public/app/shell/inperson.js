/* The Branch logo at first load.
   - The first-load moment: the logo and a growing branch line while the window first reads the engine, once a
     session; it leaves as soon as the engine has answered (or the sign-in or lock screen is shown), never on a timer of
     its own. Not drawn when motion is reduced.
   The owner's faces rule keeps Branch's mascot to the logo; Trunks have their own characters. */

import { app } from "../core/ui.js";
import { calm17 } from "../core/art17.js";
import { t } from "../../i18n.js";

const SEEN = "branch-splash";
function once() {
  try { if (sessionStorage.getItem(SEEN)) return false; sessionStorage.setItem(SEEN, "1"); return true; } catch (error) { console.warn(error.message); return false; }
}
/** Drawn before the first read of the engine; splashDone() takes it away. */
export function splash() {
  if (calm17() || !once()) return;
  app().insertAdjacentHTML("beforeend", `<div class="splash11" aria-hidden="true"><span class="mark mark-face splash-art11" aria-hidden="true"></span><svg class="grow11" viewBox="0 0 160 24"><path d="M4 20 C40 20 50 6 80 12 S130 4 156 8"/><path class="l1" d="M56 12 q6 -8 14 -6"/><path class="l2" d="M104 8 q4 8 12 8"/></svg><b>${t("window.shell.shell.waking")}</b></div>`);
}
/* A new browser draws the splash in English before the engine says which language is the owner's: when that arrives,
   the splash says it again in that language. */
document.addEventListener("branch-language", () => { const b = document.querySelector(".splash11 b"); if (b) b.textContent = t("window.shell.shell.waking"); });
export function splashDone() {
  const el = document.querySelector(".splash11");
  if (!el) return;
  el.classList.add("out11");
  setTimeout(() => el.remove(), 500);
}
