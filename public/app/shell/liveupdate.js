/* Live updates (hot-update): a Beta change to the window's own files reaches the open window without a restart
   (src/desktop/live-window-ipc.ts tells the window what changed).

   - Only stylesheets changed: the new ones are put in beside the old, and each old one goes once its new one has loaded,
     so nothing is reloaded and nothing blinks.
   - Modules changed: they cannot be swapped under a running page, so what the owner has open is kept first (the place,
     the conversation, every typed word and where the caret was, how far the conversation was scrolled), the app reloads
     the page under a picture of itself, and the page puts all of it back before it tells the app it is back.
   - The engine is being handed over: the window stays quiet while its requests wait and its streams reconnect. */

import { S, E } from "../core/state.js";
import { sessionPrincipal, sessionAuthority } from "../core/session-pages.js";
import { hasPage } from "../settings/settings.js";
import { extraTabs } from "../chat/pane.js";
import { sendingWithoutSession } from "../chat/chat.js";
import { toast } from "../core/ui.js";
import { $, renderNow } from "../core/dom.js";
import { goingAway } from "../core/api.js";

const KEY = "branch-live-restore";
const bridge = () => window.branchDesktop ?? null;
let waitingMessage = "";
// Only presentation choices travel with the existing short-lived handover. No grants, dialogs or credentials.
const VIEWS = new Set(["chat", "inbox", "automations", "library", "customize", "team", "overview", "project", "settings"]);
const PANES = new Set(["activity", "tl17c", "plan", "files", "memory", "terminal"]);
const sessionId = value => typeof value === "string" && /^[a-f0-9-]{36}$/i.test(value);
function restoreLayout(layout) {
  if (!layout || typeof layout !== "object" || Array.isArray(layout)) return;
  if (layout.pane === null || PANES.has(layout.pane) || extraTabs.some(([id, , , shown]) => id === layout.pane && shown())) S.pane = layout.pane;
  for (const key of ["sideW", "paneW", "dockW"]) {
    if (layout[key] === null || (Number.isFinite(layout[key]) && layout[key] >= 0 && layout[key] <= 4096)) S[key] = layout[key];
  }
  for (const key of ["rail", "sideHidden", "placesShut"]) if (typeof layout[key] === "boolean") S[key] = layout[key];
  if (layout.home19 && typeof layout.home19.open === "boolean" && (layout.home19.sid === null || sessionId(layout.home19.sid))) {
    S.home19 = { open: layout.home19.open, sid: layout.home19.sid };
  }
}
const LAYOUT = ["pane", "sideW", "paneW", "dockW", "rail", "sideHidden", "placesShut", "home19"];
function scrollBoxes() {
  const counts = new Map(), boxes = new Map();
  for (const el of document.querySelectorAll("#app, #app *")) {
    if (["INPUT", "TEXTAREA"].includes(el.tagName)) continue;
    const classes = [...el.classList].filter(c => c !== "sb-on14").join(".");
    const name = el.id ? `#${el.id}` : `${el.tagName}.${classes}`;
    const index = counts.get(name) ?? 0;
    counts.set(name, index + 1);
    boxes.set(`${name}\n${index}`, el);
  }
  return boxes;
}
function workspaceScroll() {
  return [...scrollBoxes()].filter(([, el]) => el.scrollTop > 0 || el.scrollLeft > 0)
    .slice(0, 80).map(([key, el]) => ({ key, top: el.scrollTop, left: el.scrollLeft }));
}
function restoreWorkspaceScroll(positions) {
  if (!Array.isArray(positions)) return;
  const boxes = scrollBoxes();
  for (const position of positions.slice(0, 80)) {
    const el = position && typeof position.key === "string" ? boxes.get(position.key) : null;
    if (!el) continue;
    if (Number.isFinite(position.top)) el.scrollTop = Math.max(0, position.top);
    if (Number.isFinite(position.left)) el.scrollLeft = Math.max(0, position.left);
  }
}

/* The composer's words and caret, the focused prompt and every scroll position, once the restored page is drawn. */
function restoreComposer(kept) {
  const box = $("#prompt");
  const words = S.drafts[S.chat ?? "new"];
  if (box && typeof words === "string") {
    box.value = words;
    if (kept.caret) {
      box.setSelectionRange(Number(kept.caret.start) || 0, Number(kept.caret.end) || 0);
      if (kept.caret.focused) box.focus();
    }
  }
  restoreWorkspaceScroll(kept.positions);
  const focused = kept.focus && ["prompt", "home19-prompt"].includes(kept.focus.id) ? document.getElementById(kept.focus.id) : null;
  if (focused) {
    focused.setSelectionRange(Number(kept.focus.start) || 0, Number(kept.focus.end) || 0);
    focused.focus({ preventScroll: true });
  }
  const scroll = $("#scroll");
  if (scroll && kept.scroll) scroll.scrollTop = kept.scroll.atEnd ? scroll.scrollHeight : Number(kept.scroll.top) || 0;
}

/* Listens for live updates from the app (the desktop window only). */
export function initLive() {
  // A shell update (src/desktop/shell-switch.ts) asks for the same record, to hand to the new version's window.
  window.branchKeepForShell = keepForShell;
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

/* What is open: the place, the conversation, every typed word and where the caret was, how far it was scrolled. */
function openNow(commit) {
  const chat = S.chat;
  const box = $("#prompt"), scroll = $("#scroll");
  if (box) S.drafts[chat ?? "new"] = box.value;
  const home = $("#home19-prompt");
  if (home) S.drafts.home19 = home.value;
  const focused = [box, home].find(input => input && document.activeElement === input);
  return {
    commit, at: Date.now(), principal: sessionPrincipal(E.profiles), view: S.view, chat,
    tabs: S.tabs, setPage: S.setPage, drafts: S.drafts,
    layout: Object.fromEntries(LAYOUT.map(key => [key, S[key]])), positions: workspaceScroll(),
    focus: focused ? { id: focused.id, start: focused.selectionStart, end: focused.selectionEnd } : null,
    caret: box ? { start: box.selectionStart, end: box.selectionEnd, focused: document.activeElement === box } : null,
    scroll: scroll ? { top: scroll.scrollTop, atEnd: scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 40 } : null,
  };
}

/* A shell update: what is open, as text for the new version's window, or null while a first message waits for its
   conversation (the switch then waits, as a live reload does). */
function keepForShell() {
  return sendingWithoutSession() ? null : JSON.stringify(openNow("shell"));
}

/* What is open, kept for the page that replaces this one (this tab only, for a minute). */
async function keepOpen(commit) {
  if (sendingWithoutSession()) throw new Error("The window update is waiting for this task's conversation to be confirmed.");
  const kept = openNow(commit);
  try { sessionStorage.setItem(KEY, JSON.stringify(kept)); }
  catch { throw new Error("The window could not keep your draft, so the update is waiting."); }
}

/* Two painted frames, so what was put back is drawn before the app is told. A page that is not drawn (a start in the
   tray keeps the window unpainted until it is first shown, main.ts paintWhenInitiallyHidden) has no frames to wait
   for: waiting would hold the first load, and a version switch's "up", until the owner opened the window. */
const frames = () => document.visibilityState === "hidden" ? Promise.resolve()
  : new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));

/* After a live reload: everything kept is put back and drawn, then the app is told, and only then does its picture of the
   old page come away. `open` opens a conversation (chat/chat.js openConversation). Answers whether anything was kept. */
export async function restoreOpen(open) {
  const recovery = new URL(location.href).searchParams.get("_branch_live_restore");
  let raw = null, kept = null;
  try { raw = sessionStorage.getItem(KEY); kept = JSON.parse(raw || "null"); } catch { kept = null; }
  if (!kept || typeof kept !== "object" || (!recovery && !(Date.now() - Number(kept.at) < 60_000))) {
    // Nothing kept (an ordinary start): the app is told all the same, in case it reloaded this page.
    await frames();
    await bridge()?.windowRestored?.(recovery);
    return false;
  }
  /* This restoration belongs to the person signed in now and to this one handover's snapshot. A person switch (even one
     switched back), the app lock (even one lifted again) or a newer handover's snapshot during any wait below ends it:
     nothing more is put back, only this snapshot is dropped (never a newer one), and the app is told once. */
  const who = sessionPrincipal(E.profiles);
  const forget = () => {
    if (recovery) { const url = new URL(location.href); url.searchParams.delete("_branch_live_restore"); history.replaceState(null, "", url); }
    if (sessionStorage.getItem(KEY) === raw) sessionStorage.removeItem(KEY);
  };
  const drop = async () => { forget(); await frames(); await bridge()?.windowRestored?.(recovery ?? kept.commit); return false; };
  // A profile change must never bring back the previous person's private workspace or draft.
  if (typeof kept.principal === "string" && kept.principal !== who) return drop();
  const authority = sessionAuthority(E.profiles, $("#app"));
  const current = () => authority.current(E.profiles) && sessionStorage.getItem(KEY) === raw;
  try {
    const view = VIEWS.has(kept.view) ? kept.view : S.view;
    if (kept.tabs && typeof kept.tabs === "object" && !Array.isArray(kept.tabs)) {
      for (const key of Object.keys(S.tabs)) {
        if (typeof kept.tabs[key] === "string" && /^[a-z][a-z0-9-]{0,39}$/.test(kept.tabs[key])) S.tabs[key] = kept.tabs[key];
      }
    }
    if (typeof kept.setPage === "string" && hasPage(kept.setPage)) S.setPage = kept.setPage;
    if (kept.drafts && typeof kept.drafts === "object") Object.assign(S.drafts, kept.drafts);
    if (sessionId(kept.chat)) await open(kept.chat);
    if (!current()) return drop();
    // The owner may have gone elsewhere while the conversation was read: their own move stands, nothing more is laid over it.
    const here = !sessionId(kept.chat) || (S.chat === kept.chat && S.view === "chat");
    if (here) {
      restoreLayout(kept.layout);
      // Opening the retained conversation sets the view to chat. The owner's actual place comes back after that read.
      S.view = view;
      renderNow();
    }
    const chat = S.chat;
    await frames();
    if (!current()) return drop();
    if (here && S.view === view && S.chat === chat) restoreComposer(kept);
    await frames();
    if (!current()) return drop();
    const accepted = await bridge()?.windowRestored?.(recovery ?? kept.commit);
    // Told once: a switch, the lock or a newer handover meanwhile drops only this snapshot, even if the page was refused.
    if (!current()) { forget(); return false; }
    if (accepted === false) throw new Error("The restored page was not accepted; its draft is kept for recovery.");
    forget();
    return true;
  } finally { authority.close(); }
}
