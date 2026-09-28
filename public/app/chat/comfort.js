/* The owner's comfort choices the conversation reads (Settings › General › The conversation), from the engine's own
   cards: GET /api/comfort values.keys.vim and values.display.timestamps, read once after sign-in and again from every
   save (core/api.js comfortSaved). A household person may not read the owner's cards (Q261): the window behaves as it
   always has for them.
   - Vim keys in the message box (en.json comfort.note.vim): Esc moves to moving mode (h j k l, w b, 0 $, x, dd), i, a
     or o goes back to typing, and a second Esc leaves the box. Ported from the old window's public/comfort.js
     (git 21eca9ec^), which the redesign removed. The mode is on the box as data-vim ("normal" or "insert").
   - Message times, Always: each message shows when the engine wrote it (messages[].at) in the message itself; On hover
     (the engine's off) keeps the time in the message's action row only (chat/messages.js).
   - How Branch gets the owner's attention (values.notify: method, sound, needsYes, taskDone) and the quiet hours and
     whole days off (GET /api/calendar quietHours), which shell/notify.js follows. */

import { $, esc, render, afterDraw } from "../core/dom.js";
import { E } from "../core/state.js";
import { api, comfortSaved } from "../core/api.js";
import { toast } from "../core/ui.js";
import { sentAt } from "./furniture.js";

export const CF = { vim: false, times: false, hideTimes: false, asked: false, notify: null, quiet: null };
const vim = { mode: "insert", pending: "" };

function take(values) {
  const times = values?.display?.timestamps === true;
  CF.vim = values?.keys?.vim === true;
  const hide = !times && values?.display?.hideTimes === true;
  if (hide !== CF.hideTimes) { CF.hideTimes = hide; render(); }
  if (values?.notify) CF.notify = values.notify;
  if (!CF.vim) { vim.mode = "insert"; vim.pending = ""; }
  if (times !== CF.times) { CF.times = times; render(); }
  mark();
}

/* Read once the window is signed in; the owner's own window only. */
function load() {
  if (CF.asked || !E.loaded) return;
  CF.asked = true;
  if (E.profiles?.isOwner !== true) return;
  api("comfort").then((c) => take(c.values), (error) => toast(error.message));
  readQuiet();
}

/* Quiet hours and whole days off, read again after Settings › Notifications saves them. */
export function readQuiet() {
  if (E.profiles?.isOwner !== true) return;
  api("calendar").then((c) => { CF.quiet = c.settings?.quietHours ?? null; }, () => {});
}

/* A time on the message itself, when the owner chose Always. */
export function timeLine(m) {
  const at = CF.times ? sentAt(m) : "";
  return at ? `<time class="at15" datetime="${esc(m.at)}">${esc(at)}</time>` : "";
}

/* ---------- vim keys ---------- */
function mark() {
  const box = $("#prompt");
  if (!box) return;
  if (CF.vim) box.dataset.vim = vim.mode;
  else delete box.dataset.vim;
}
const lineStart = (text, at) => text.lastIndexOf("\n", at - 1) + 1;
const lineEnd = (text, at) => { const end = text.indexOf("\n", at); return end === -1 ? text.length : end; };
function vertical(text, at, down) {
  const start = lineStart(text, at), column = at - start;
  if (down) { const end = lineEnd(text, at); if (end >= text.length) return at; const next = end + 1; return Math.min(next + column, lineEnd(text, next)); }
  if (start === 0) return at;
  return Math.min(lineStart(text, start - 1) + column, start - 1);
}
/* Where a moving-mode key puts the cursor, or null when the key is not a motion. */
function motion(text, at, key) {
  switch (key) {
    case "h": return Math.max(lineStart(text, at), at - 1);
    case "l": return Math.min(Math.max(lineStart(text, at), lineEnd(text, at) - 1), at + 1);
    case "0": return lineStart(text, at);
    case "$": return Math.max(lineStart(text, at), lineEnd(text, at) - 1);
    case "j": return vertical(text, at, true);
    case "k": return vertical(text, at, false);
    case "w": { const found = /\s\S/.exec(text.slice(at)); return found ? at + found.index + 1 : text.length; }
    case "b": { const before = text.slice(0, at).replace(/\S*\s*$/, ""); return before.length === at ? Math.max(0, at - 1) : before.length; }
    default: return null;
  }
}
function typing(box, at) { vim.mode = "insert"; box.setSelectionRange(at, at); mark(); }
/* Carries out one moving-mode key on the box; a change goes through "input", as typing does (the draft is kept). */
function vimKey(box, key) {
  const text = box.value, at = box.selectionStart ?? 0;
  const put = (value, cursor) => { box.value = value; box.setSelectionRange(cursor, cursor); box.dispatchEvent(new Event("input", { bubbles: true })); };
  const moved = motion(text, at, key);
  if (moved !== null) { box.setSelectionRange(moved, moved); return; }
  if (key === "d" && vim.pending !== "d") { vim.pending = "d"; return; }
  const pending = vim.pending;
  vim.pending = "";
  if (key === "d" && pending === "d") {
    const start = lineStart(text, at), end = Math.min(text.length, lineEnd(text, at) + 1);
    return put(text.slice(0, start) + text.slice(end), Math.min(start, text.length - (end - start)));
  }
  if (key === "x") return put(text.slice(0, at) + text.slice(at + 1), Math.min(at, Math.max(0, text.length - 2)));
  const insertAt = { i: at, a: Math.min(text.length, at + 1), I: lineStart(text, at), A: lineEnd(text, at) }[key];
  if (insertAt !== undefined) return typing(box, insertAt);
  if (key === "o" || key === "O") {
    const where = key === "o" ? lineEnd(text, at) : lineStart(text, at);
    put(text.slice(0, where) + "\n" + text.slice(where), key === "o" ? where + 1 : where);
    typing(box, key === "o" ? where + 1 : where);
  }
}
/* First on the page (window, capture), so the box's own keys (Enter sends) never see a moving-mode key. An open "/" or
   "@" list keeps its own Esc and arrows. */
function onKey(e) {
  const box = e.target;
  if (!CF.vim || box?.id !== "prompt" || e.isComposing) return;
  if (document.querySelector(".slash6, .pop [data-act='mention-pick'], .pop [data-act='slash-pick']")) return;
  if (e.key === "Escape" && vim.mode === "insert") {
    e.preventDefault();
    e.stopImmediatePropagation();
    vim.mode = "normal";
    vim.pending = "";
    return mark();
  }
  if (vim.mode !== "normal" || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === "Escape") { box.blur(); return; } // a second Esc leaves the box
  if (e.key.length !== 1 && e.key !== "Enter" && e.key !== "Backspace") return;
  e.preventDefault();
  e.stopImmediatePropagation();
  if (e.key.length === 1) vimKey(box, e.key);
}

export function initComfort() {
  comfortSaved.add(take);
  afterDraw(() => { load(); mark(); });
  window.addEventListener("keydown", onKey, true);
}
