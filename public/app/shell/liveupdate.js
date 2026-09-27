/* Live updates (hot-update): a Beta change to the window's own files reaches the open window without a restart
   (src/desktop/live-window-ipc.ts tells the window what changed).

   - Only stylesheets changed: the new ones are put in beside the old, and each old one goes once its new one has loaded,
     so nothing is reloaded and nothing blinks.
   - Modules changed: they cannot be swapped under a running page, so what the owner has open is kept first (the place,
     the conversation, every typed word and where the caret was, how far the conversation was scrolled), the app reloads
     the page under a picture of itself, and the page puts all of it back before it tells the app it is back.
   - The engine is being handed over: the window stays quiet while its requests wait and its streams reconnect. */

import { S } from "../core/state.js";
import { $, renderNow } from "../core/dom.js";
import { goingAway } from "../core/api.js";

const KEY = "branch-live-restore";
const bridge = () => window.branchDesktop ?? null;

/* Listens for live updates from the app (the desktop window only). */
export function initLive() {
  bridge()?.onWindowUpdated?.((update) => {
    if (update?.engine === true) { goingAway(true); return; }
    if (typeof update?.commit !== "string" || !/^[0-9a-f]{40}$/.test(update.commit)) return;
    if (update.reload) { keepOpen(); void bridge()?.reloadLive?.(); return; }
    swapStyles(Array.isArray(update.styles) ? update.styles : [], update.commit);
  });
}

/* Each changed stylesheet is loaded beside the one in use, which goes once the new one is ready. */
function swapStyles(names, commit) {
  for (const name of names) {
    if (typeof name !== "string" || !/^[A-Za-z0-9_./-]+\.css$/.test(name)) continue;
    const path = `/${name}`;
    const old = [...document.querySelectorAll('link[rel="stylesheet"]')].find((link) => new URL(link.href).pathname === path);
    if (!old) continue;
    const next = old.cloneNode();
    next.href = `${path}?live=${commit}`;
    next.addEventListener("load", () => old.remove(), { once: true });
    next.addEventListener("error", () => next.remove(), { once: true });
    old.after(next);
  }
}

/* What is open, kept for the page that replaces this one (this tab only, for a minute). */
function keepOpen() {
  const box = $("#prompt"), scroll = $("#scroll");
  if (box) S.drafts[S.chat ?? "new"] = box.value;
  const kept = {
    at: Date.now(), view: S.view, chat: S.chat, tabs: S.tabs, setPage: S.setPage, drafts: S.drafts,
    caret: box ? { start: box.selectionStart, end: box.selectionEnd, focused: document.activeElement === box } : null,
    scroll: scroll ? { top: scroll.scrollTop, atEnd: scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 40 } : null,
  };
  try { sessionStorage.setItem(KEY, JSON.stringify(kept)); } catch { /* storage refused: the page opens as it would */ }
}

const frames = () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));

/* After a live reload: everything kept is put back and drawn, then the app is told, and only then does its picture of the
   old page come away. `open` opens a conversation (chat/chat.js openConversation). Answers whether anything was kept. */
export async function restoreOpen(open) {
  let kept = null;
  try { kept = JSON.parse(sessionStorage.getItem(KEY) || "null"); sessionStorage.removeItem(KEY); } catch { kept = null; }
  if (!kept || typeof kept !== "object" || !(Date.now() - Number(kept.at) < 60_000)) {
    // Nothing kept (an ordinary start): the app is told all the same, in case it reloaded this page.
    await frames();
    await bridge()?.windowRestored?.();
    return false;
  }
  if (typeof kept.view === "string") S.view = kept.view;
  if (kept.tabs && typeof kept.tabs === "object") Object.assign(S.tabs, kept.tabs);
  if (typeof kept.setPage === "string") S.setPage = kept.setPage;
  if (kept.drafts && typeof kept.drafts === "object") Object.assign(S.drafts, kept.drafts);
  if (typeof kept.chat === "string") await open(kept.chat).catch(() => undefined);
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
  await bridge()?.windowRestored?.();
  return true;
}
