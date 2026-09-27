/* Unread (pass 17, design/redesign/pass17/FEATURES17C.md §7), 1:1 with patch17c:
   - conversations: the list's own unread dot (GET /api/sessions says `unread`), "Mark all read" on the Recent heading
     while something is unread, and Mark as unread / Mark as read in a row's right-click menu;
   - opening a conversation marks it read, and so does a reply landing while it is open (POST /api/read-marks);
   - Inbox: a dot on unread items in Needs you and Finished, and "Mark all read" at the end of the tabs. Answering or
     opening an item marks it read. The engine keeps the marks (GET /api/read-marks); what came before the marks began,
     or before the last "Mark all read", is read.
   Marking read never answers or dismisses anything. */

import { esc, render, onRender } from "../core/dom.js";
import { S, E, refresh, ownName } from "../core/state.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { mi, toast, closePop } from "../core/ui.js";
import { markLive } from "../core/features.js";
import { t } from "../../i18n.js";

const U = { inbox: null, at: 0, keep: new Set(), last: null, marking: new Set(), drawn: new Set() };
const sid = (s) => s.sessionId ?? s.id;
const find = (id) => E.sessions.find((s) => sid(s) === id);
const nameOf = (s) => (s && ownName(sid(s))) || s?.title || s?.opening || t("comfort.field.newConversation");
const KEY = /^[a-z]{2,12}:[A-Za-z0-9:_-]{1,200}$/;

/* ---------- conversations ---------- */
export const unreadDot = (s) => (s.unread && S.chat !== sid(s) ? `<span class="unread" aria-label="${t("window.chat.unread.unread-lower")}"></span>` : "");
const anyUnread = () => E.sessions.some((s) => s.unread && sid(s) !== S.chat);
export const recentClass = () => (anyUnread() ? " lh17c" : "");
export const markAllButton = () => (anyUnread() ? `<button type="button" class="mar17c" data-act="markread17c">${t("window.chat.unread.mark-all")}</button>` : "");
export const unreadItem = (id) => { const s = find(id); return s ? mi("unread17c", "chat", s.unread ? t("window.chat.unread.mark-read") : t("window.chat.unread.mark-unread"), "", `data-id="${esc(id)}"`) : ""; };

async function markConversation(id, unread) {
  await api("read-marks", { conversation: id, unread });
  await refresh();
}

/* The open conversation is read: when it opens, and whenever a reply lands in it, unless it was just marked unread. */
function readOpen() {
  if (U.last !== S.chat) { U.keep.clear(); U.last = S.chat; }
  const s = S.view === "chat" && S.chat ? find(S.chat) : null;
  if (!s?.unread || U.keep.has(S.chat) || U.marking.has(S.chat)) return;
  const id = S.chat;
  U.marking.add(id);
  markConversation(id, false).catch((error) => { U.keep.add(id); toast(error.message); }).finally(() => U.marking.delete(id));
}

async function flipOne(el) {
  closePop();
  const s = find(el.dataset.id);
  if (!s) return;
  const unread = !s.unread;
  if (unread && sid(s) === S.chat) U.keep.add(S.chat);
  try { await markConversation(sid(s), unread); } catch (error) { toast(error.message); return; }
  toast(unread ? (sid(s) === S.chat ? t("window.chat.unread.marked-here") : t("window.chat.unread.marked-unread", { name: nameOf(s) })) : t("window.chat.unread.marked-read", { name: nameOf(s) }));
}

async function allRead() {
  try { await api("read-marks", { all: "conversations" }); await refresh(); } catch (error) { toast(error.message); return; }
  toast(t("window.chat.unread.all-read"));
}

/* ---------- Inbox ---------- */
async function loadInbox(force = false) {
  if (!force && Date.now() - U.at < 3000) return;
  U.at = Date.now();
  const got = await api("read-marks").catch((error) => { toast(error.message); return null; });
  if (!got) return;
  const before = JSON.stringify(U.inbox);
  U.inbox = got.inbox;
  if (JSON.stringify(U.inbox) !== before) render();
}
function isUnread(key, time) {
  const m = U.inbox;
  if (!m || !KEY.test(key)) return false;
  if (m.unread.includes(key)) return true;
  if (m.read.includes(key)) return false;
  return !time || String(time) > m.since;
}
/* The start of an Inbox row: `key` names the item (ask:<session>:<fingerprint>, run:<id>, …), `time` is when it came. */
export function prowOpen(key, time) {
  if (!isUnread(key, time)) return '<div class="prow">';
  U.drawn.add(key);
  return `<div class="prow unr17c" data-rk="${esc(key)}"><i class="udot17c" role="img" aria-label="${t("window.chat.unread.unread")}"></i>`;
}
/* After the rows are drawn: "Mark all read" while any of them is unread. */
export function inboxMarkAll() {
  const any = U.drawn.size > 0;
  U.drawn.clear();
  return any ? `<button type="button" class="mar17c" data-act="inread17c">${t("window.chat.unread.mark-all")}</button>` : "";
}

async function inboxAllRead() {
  try { await api("read-marks", { all: "inbox" }); await loadInbox(true); } catch (error) { toast(error.message); return; }
  render();
  toast(t("window.chat.unread.inbox-read"));
}

/* Opening or answering an Inbox item marks it read; the button's own action goes ahead as well. */
function readItem(e) {
  const row = e.target.closest?.("#main .prow[data-rk]");
  if (!row || !e.target.closest("button")) return;
  api("read-marks", { inbox: row.dataset.rk, unread: false }).then(() => loadInbox(true), (error) => toast(error.message));
}

export function initUnread() {
  markLive(["markread17c", "unread17c", "inread17c"]);
  on("markread17c", () => allRead());
  on("unread17c", (el) => flipOne(el));
  on("inread17c", () => inboxAllRead());
  document.addEventListener("click", readItem, true);
  onRender(() => { readOpen(); if (S.view === "inbox") loadInbox(); });
}
