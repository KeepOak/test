/* Branch, in person (pass 11), 1:1 with the prototype's splash11 and dress11: poses drawn from the Branch sprite.
   - The first-load moment: Branch's idle loop and a growing branch line while the window first reads the engine, once a
     session; it leaves as soon as the engine has answered (or the sign-in or lock screen is shown), never on a timer of
     its own. Not drawn when motion is reduced.
   - Above an empty list in a place or the side panel, a pose: the mail pose in the Inbox, reading everywhere else.
   Other poses live where they are drawn: setup, the walkthrough's card, the welcome card, the empty conversation, the
   search's "no results" (shell/search.js) and the cheer (shell/cheer.js). */

import { afterDraw } from "../core/dom.js";
import { S, E } from "../core/state.js";
import { app } from "../core/ui.js";
import { calm17 } from "../core/art17.js";
import { t } from "../../i18n.js";

export const pose = (name, cls = "") => `<img class="pose11 ${cls}" src="/art/branch-${name}.webp" alt="" loading="lazy" decoding="async" draggable="false">`;

const SEEN = "branch-splash";
function once() {
  try { if (sessionStorage.getItem(SEEN)) return false; sessionStorage.setItem(SEEN, "1"); return true; } catch (error) { console.warn(error.message); return false; }
}
/** Drawn before the first read of the engine; splashDone() takes it away. */
export function splash() {
  if (calm17() || !once()) return;
  app().insertAdjacentHTML("beforeend", `<div class="splash11" aria-hidden="true"><video class="pose11 vid11 splash-art11" src="/art/anim-idle.webm" poster="/art/branch-wave.webp" muted loop autoplay playsinline></video><svg class="grow11" viewBox="0 0 160 24"><path d="M4 20 C40 20 50 6 80 12 S130 4 156 8"/><path class="l1" d="M56 12 q6 -8 14 -6"/><path class="l2" d="M104 8 q4 8 12 8"/></svg><b>${t("window.shell.shell.waking")}</b></div>`);
}
export function splashDone() {
  const el = document.querySelector(".splash11");
  if (!el) return;
  el.classList.add("out11");
  setTimeout(() => el.remove(), 500);
}

/* Each empty line of a list in a place or the side panel gets its pose once, inside it, so the view's own parts stay
   as they were drawn. */
function dress() {
  if (!E.loaded) return;
  const name = S.view === "inbox" ? "mail" : "read";
  for (const p of document.querySelectorAll("#main p.empty:not([data-d11]), #pane p.empty:not([data-d11])")) {
    p.dataset.d11 = "1";
    p.insertAdjacentHTML("afterbegin", `<span class="empty11">${pose(p.closest("#pane") ? "read" : name)}</span>`);
  }
}

export function initInPerson() {
  afterDraw(dress);
}
