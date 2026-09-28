/* Live updates (hot-update): a Beta change to the window's own files reaches the open window without a restart
   (src/desktop/live-window-ipc.ts tells the window what changed).

   - Only stylesheets changed: the new ones are put in beside the old, and each old one goes once its new one has loaded,
     so nothing is reloaded and nothing blinks.
   - Modules changed: they cannot be swapped under a running page, so what the owner has open is kept first (the place,
     the conversation, every typed word and where the caret was, how far the conversation was scrolled), the app reloads
     the page under a picture of itself, and the page puts all of it back before it tells the app it is back.
   - The engine is being handed over: the window stays quiet while its requests wait and its streams reconnect. */

import { S } from "../core/state.js";
import { sendingWithoutSession } from "../chat/chat.js";
import { toast } from "../core/ui.js";
import { $, renderNow } from "../core/dom.js";
import { goingAway } from "../core/api.js";

const KEY = "branch-live-restore";
const bridge = () => window.branchDesktop ?? null;
/* What is open now, and putting it back: also what the desktop app keeps when it drops a window hidden a while
   (shell/keep.js). */
export const openNow = () => openState();
export const putBack = (kept, open) => putBackState(kept, open);
let waitingMessage = "";

/* Listens for live updates from the app (the desktop window only). */
export function initLive() {
  bridge()?.onWindowUpdated?.((update) => {
    if (update?.engine === true) { goingAway(true); return; }
    if (typeof update?.commit !== "string" || !/^[0-9a-f]{40}$/.test(update.commit)) return;
    if (update.reload) {
      void applyModules(update.commit);
      return;
    }
    void swapStyles(Array.isArray(update.styles) ? update.styles : [], update.commit)
      .then(() => bridge()?.windowUpdateResult?.({ commit: update.commit, ok: true }))
      .catch((error) => defer(update.commit, error));
  });
}

async function applyModules(commit) {
  try { await keepOpen(commit); waitingMessage = ""; await bridge()?.reloadLive?.(commit); }
  catch (error) { await defer(commit, error); }
}

async function defer(commit, error) {
  if (waitingMessage !== error.message) { waitingMessage = error.message; toast(error.message); }
  await bridge()?.windowUpdateResult?.({ commit, ok: false, deferred: true, message: error.message });
}

/* Each changed stylesheet is loaded beside the one in use, which goes once the new one is ready. */
async function swapStyles(names, commit) {
  const loaded = [], replacements = [];
  for (const name of names) {
    if (typeof name !== "string" || !/^[A-Za-z0-9_./-]+\.css$/.test(name)) continue;
    const path = `/${name}`;
    const old = [...document.querySelectorAll('link[rel="stylesheet"]')].find((link) => new URL(link.href).pathname === path);
    if (!old) continue;
    const next = old.cloneNode();
    next.href = `${path}?live=${commit}`;
    replacements.push({ old, next });
    loaded.push(new Promise((resolve, reject) => {
      next.addEventListener("load", resolve, { once: true });
      next.addEventListener("error", () => { next.remove(); reject(new Error("The new stylesheet could not load, so the update is waiting.")); }, { once: true });
    }));
    old.after(next);
  }
  try { await Promise.all(loaded); for (const { old } of replacements) old.remove(); }
  catch (error) { for (const { next } of replacements) next.remove(); throw error; }
}

/* What is open, kept for the page that replaces this one (this tab only, for a minute). */
async function keepOpen(commit) {
  if (sendingWithoutSession()) throw new Error("The window update is waiting for this task's conversation to be confirmed.");
  const kept = { commit, at: Date.now(), ...openState() };
  try { sessionStorage.setItem(KEY, JSON.stringify(kept)); }
  catch { throw new Error("The window could not keep your draft, so the update is waiting."); }
}

/* What is open now: the place, the conversation, every typed word and where the caret was, how far the conversation was
   scrolled. Also what the desktop app keeps when it drops a window hidden a while (shell/keep.js). */
function openState() {
  const chat = S.chat;
  const box = $("#prompt"), scroll = $("#scroll");
  if (box) S.drafts[chat ?? "new"] = box.value;
  return {
    view: S.view, chat, tabs: S.tabs, setPage: S.setPage, drafts: S.drafts,
    caret: box ? { start: box.selectionStart, end: box.selectionEnd, focused: document.activeElement === box } : null,
    scroll: scroll ? { top: scroll.scrollTop, atEnd: scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 40 } : null,
  };
}

const frames = () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));


/* After a live reload: everything kept is put back and drawn, then the app is told, and only then does its picture of the
   old page come away. `open` opens a conversation (chat/chat.js openConversation). Answers whether anything was kept. */
export async function restoreOpen(open) {
  const recovery = new URL(location.href).searchParams.get("_branch_live_restore");
  let kept = null;
  try { kept = JSON.parse(sessionStorage.getItem(KEY) || "null"); } catch { kept = null; }
  if (!kept || typeof kept !== "object" || (!recovery && !(Date.now() - Number(kept.at) < 60_000))) {
    // Nothing kept (an ordinary start): the app is told all the same, in case it reloaded this page.
    await frames();
    await bridge()?.windowRestored?.(recovery);
    return false;
  }
  await putBackState(kept, open);
  const accepted = await bridge()?.windowRestored?.(recovery ?? kept.commit);
  if (accepted === false) throw new Error("The restored page was not accepted; its draft is kept for recovery.");
  if (recovery) { const url = new URL(location.href); url.searchParams.delete("_branch_live_restore"); history.replaceState(null, "", url); }
  sessionStorage.removeItem(KEY);
  return true;
}

/* Puts back what openState() kept and draws it. `open` opens a conversation (chat/chat.js openConversation). */
async function putBackState(kept, open) {
  if (typeof kept.view === "string") S.view = kept.view;
  if (kept.tabs && typeof kept.tabs === "object") Object.assign(S.tabs, kept.tabs);
  if (typeof kept.setPage === "string") S.setPage = kept.setPage;
  if (kept.drafts && typeof kept.drafts === "object") Object.assign(S.drafts, kept.drafts);
  if (typeof kept.chat === "string") await open(kept.chat);
  renderNow();
  await frames();
  const box = $("#prompt");
  const words = S.drafts[S.chat ?? "new"];
  if (box && typeof words === "string") {
    box.value = words;
    if (kept.caret) {
      box.setSelectionRange(Number(kept.caret.start) || 0, Number(kept.caret.end) || 0);
      if (kept.caret.focused) box.focus();
    }
  }
  const scroll = $("#scroll");
  if (scroll && kept.scroll) scroll.scrollTop = kept.scroll.atEnd ? scroll.scrollHeight : Number(kept.scroll.top) || 0;
  await frames();
}
