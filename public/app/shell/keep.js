/* The desktop app drops the window after it has been hidden a while (15 minutes; its page, drawing and graphics are
   memory nobody uses) and makes it again when it is opened (src/desktop/main.ts dropWindow). What the owner had open
   comes back, kept and put back exactly as a live update keeps it (shell/liveupdate.js openNow, putBack): the place or
   conversation, the tabs and Settings page, every unsent draft, where the caret was and how far it was scrolled; the
   panes' own layout is kept with the window's saved choices (core/state.js). The window is never dropped while
   something lives only here: a message still being sent, a dialog or a menu open, a call or dictation on, files
   attached and not sent, sound playing, or a field changed and not saved. */
import { dialog } from "../core/ui.js";
import { dictating } from "../chat/dictate.js";
import { hasFiles } from "../chat/attach.js";
import { talkingLive } from "../chat/talklive.js";
import { openConversation, sendingWithoutSession } from "../chat/chat.js";
import { openNow, putBack } from "./liveupdate.js";

/* A field the owner changed and has not saved (the composer's words are kept as a draft instead). */
function changed(el) {
  if (el.id === "prompt" || el.closest("[data-keep-free]")) return false;
  if (el.type === "checkbox" || el.type === "radio") return el.checked !== el.defaultChecked;
  if (el.tagName === "SELECT") return [...el.options].some((o) => o.selected !== o.defaultSelected);
  if (["button", "submit", "hidden", "file", "range", "color"].includes(el.type)) return false;
  return el.value !== el.defaultValue;
}

/** Why the window cannot be dropped now, or "" when it can. */
export function heldBy() {
  if (sendingWithoutSession()) return "a message is still being sent";
  if (dialog() || document.querySelector(".pop")) return "a dialog or menu is open";
  if (talkingLive()) return "a call is on";
  if (dictating()) return "dictation is on";
  if (hasFiles()) return "files are attached and not sent";
  if ([...document.querySelectorAll("audio, video")].some((m) => !m.paused && !m.muted)) return "sound is playing";
  if ([...document.querySelectorAll("input, textarea, select")].some(changed)) return "a change is not saved";
  return "";
}

/* Main asks with this (src/desktop/main.ts dropWindow): may it drop the window, and what to keep if so. */
globalThis.branchKeep = () => ({ held: heldBy(), kept: openNow() });

/** On start: what the dropped window had open, from the desktop app (nothing outside it, or after a normal start). */
export async function restoreKept() {
  const kept = await globalThis.branchDesktop?.keptPage?.().catch(() => null);
  if (!kept || typeof kept !== "object") return false;
  await putBack(kept, openConversation);
  return true;
}
