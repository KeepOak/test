/* The desktop app drops the window after it has been hidden a while (15 minutes; its page, drawing and graphics are
   memory nobody uses) and makes it again when it is opened (src/desktop/main.ts). What the owner had open comes back:
   the place or conversation, the tabs and Settings page, every unsent draft and where each list was scrolled; the panes'
   own layout is kept with the window's saved choices (core/state.js). The window is never dropped while something lives
   only here: a dialog or a menu open, a call or dictation on, files attached and not sent, sound playing, or a field
   changed and not saved. */
import { S, E } from "../core/state.js";
import { renderNow } from "../core/dom.js";
import { dialog } from "../core/ui.js";
import { dictating } from "../chat/dictate.js";
import { hasFiles } from "../chat/attach.js";
import { talkingLive } from "../chat/talklive.js";
import { openConversation } from "../chat/chat.js";

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
  if (dialog() || document.querySelector(".pop")) return "a dialog or menu is open";
  if (talkingLive()) return "a call is on";
  if (dictating()) return "dictation is on";
  if (hasFiles()) return "files are attached and not sent";
  if ([...document.querySelectorAll("audio, video")].some((m) => !m.paused && !m.muted)) return "sound is playing";
  if ([...document.querySelectorAll("input, textarea, select")].some(changed)) return "a change is not saved";
  return "";
}

/** What comes back when the window is made again. */
export function keptNow() {
  const box = document.querySelector("#prompt");
  const drafts = { ...S.drafts };
  if (box) drafts[S.chat ?? "new"] = box.value; // the words in the box now, typed since the last draw
  const scroll = {};
  for (const el of document.querySelectorAll("[id]")) if (el.scrollTop > 0) scroll[el.id] = el.scrollTop;
  return { view: S.view, chat: S.chat, tabs: { ...S.tabs }, setPage: S.setPage,
    drafts: Object.fromEntries(Object.entries(drafts).filter(([, words]) => words)), scroll };
}

/* Main asks with this (src/desktop/main.ts dropWhenIdle): may it drop the window, and what to keep if so. */
globalThis.branchKeep = () => ({ held: heldBy(), kept: keptNow() });

/** On start: what the dropped window had open, from the desktop app (nothing outside it, or after a normal start). */
export async function restoreKept() {
  const kept = await globalThis.branchDesktop?.keptPage?.().catch(() => null);
  if (!kept) return false;
  if (kept.tabs) Object.assign(S.tabs, kept.tabs);
  if (kept.setPage) S.setPage = kept.setPage;
  Object.assign(S.drafts, kept.drafts ?? {});
  if (kept.view === "chat" && kept.chat && E.sessions.some((s) => (s.sessionId ?? s.id) === kept.chat)) await openConversation(kept.chat);
  else if (kept.view) { S.view = kept.view; if (kept.view === "chat") S.chat = kept.chat ?? null; }
  renderNow();
  await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  for (const [id, top] of Object.entries(kept.scroll ?? {})) { const el = document.getElementById(id); if (el) el.scrollTop = top; }
  return true;
}
