/* trunk-one-row: a Trunk is one contact with one thread, like iMessage. The list has one row per Trunk (shell/shell.js),
   and opening it draws all of that Trunk's conversations as one timeline, oldest at the top: each conversation stays
   the engine's own session (its own context), starts under a quiet "New conversation" line whose menu renames, archives
   or deletes that one conversation, and keeps its day and time stamps (chat/furniture.js stampBefore). The message box
   sends to the conversation drawn in full (chat/chat.js), which is the newest one unless another was opened on purpose
   (search, the Inbox). The conversations above it are read (GET /api/sessions/<id>) only as the owner scrolls up to
   them, and drawn as plain bubbles, since nothing in them is acted on from here.

   Which Trunk a conversation is with: a Trunk's own chat (or one it retired), else the Trunk the engine names for it
   (GET /api/sessions trunkId: a thread with the default Trunk or another, a chat app's thread, the owner's choice). A
   room keeps a row of its own, and so does a conversation the engine gives to no Trunk (Trunks switched off, or made
   before a default Trunk and not moved to one). */

import { $, esc, render, renderNow } from "../core/dom.js";
import { E, refresh, trunkIntro } from "../core/state.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { av, ic, mi, openPop, closePop, toast } from "../core/ui.js";
import { markLive } from "../core/features.js";
import { text } from "./markdown.js";
import { stampBefore, stampWords } from "./furniture.js";
import { timeLine } from "./comfort.js";
import { steerWords, steeredLine, chatSteerOf, chatSteerLine } from "./steer.js";
import { renameConversation } from "./putaway.js";
import { t, language } from "../../i18n.js";

export const sid = (s) => s?.sessionId ?? s?.id;
/* When a conversation was last written in (GET /api/sessions updatedAt), else when it began. */
export const lastAt = (s) => String(s?.updatedAt ?? s?.createdAt ?? "");
const byTime = (a, b) => lastAt(a).localeCompare(lastAt(b));

/* trunkId: the Trunk whose timeline is open; fresh: a new conversation begun in it and not sent yet; cache: each older
   conversation's messages and drawn bubbles; extra: conversations past the list's first page (read when a timeline opens). */
const L = { trunkId: null, fresh: false, adopt: null, active: null, older: false, cache: new Map(), extra: new Map(), extraAt: 0, grouped: null, key: null };

const isRoom = (id) => E.rooms.some((r) => r.sessionId === id);
const ownChat = (id) => E.trunks.find((tr) => tr.chatSessionId === id || (tr.retiredChats ?? []).includes(id));
function trunkOfSession(s) {
  const id = sid(s);
  if (isRoom(id)) return undefined;
  const own = ownChat(id);
  if (own) return own;
  return s.trunkId ? E.trunks.find((tr) => tr.id === s.trunkId) : undefined;
}

/* Every listed conversation by its Trunk (oldest first), and the loose ones; worked out again only when the engine's
   lists change. */
export function groups() {
  const key = [E.sessions, E.sessions.length, E.trunks, E.trunks.length, E.rooms, L.extra];
  if (L.grouped && L.key.every((part, i) => part === key[i])) return L.grouped;
  const of = new Map(), loose = [], seen = new Set();
  for (const s of [...E.sessions, ...L.extra.values()]) {
    const id = sid(s);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const trunk = trunkOfSession(s);
    if (trunk) of.set(trunk.id, [...(of.get(trunk.id) ?? []), s]);
    else if (!L.extra.has(id)) loose.push(s);
  }
  for (const list of of.values()) list.sort(byTime);
  L.key = key;
  L.grouped = { of, loose };
  return L.grouped;
}

/* A Trunk's conversations, oldest first; a Trunk with none listed still has its own chat. */
export function lineOf(trunk) {
  const list = groups().of.get(trunk.id) ?? [];
  return list.length ? list : trunk.chatSessionId ? [{ sessionId: trunk.chatSessionId }] : [];
}
/* The conversation the Trunk's row opens and the message box sends to: the one written in last. */
export const currentOf = (trunk) => sid(lineOf(trunk).at(-1));
export function trunkOfId(id) {
  if (!id) return undefined;
  for (const [trunkId, list] of groups().of) if (list.some((s) => sid(s) === id)) return E.trunks.find((tr) => tr.id === trunkId);
  return isRoom(id) ? undefined : ownChat(id);
}
export const lineTrunk = () => (L.trunkId ? E.trunks.find((tr) => tr.id === L.trunkId) : undefined);
/* The Trunk a fresh conversation was begun in, before its first message. */
export const freshIn = () => (L.fresh ? L.trunkId : null);

/* Opening a conversation: past the list's first page, the rest of the owner's conversations are read once, so a Trunk's
   timeline reaches further back than the list does (GET /api/sessions caps a page at 100). */
export function openLine() {
  L.adopt = null;
  L.fresh = false;
  if (E.sessions.length < 50 || Date.now() - L.extraAt < 30000) return;
  L.extraAt = Date.now();
  api("sessions?limit=100").then((got) => {
    const listed = new Set(E.sessions.map(sid));
    L.extra = new Map((got?.sessions ?? []).filter((s) => !listed.has(sid(s))).map((s) => [sid(s), s]));
    render();
  }, () => undefined);
}
/* A fresh conversation in `trunk` ("New conversation", Ctrl+N, /new): its timeline stays, with a new line at its end. */
export function freshLine(trunk) {
  L.trunkId = trunk?.id ?? null;
  L.fresh = !!trunk;
  L.adopt = null;
}
/* A plain new conversation, a room or nothing open: no timeline. */
export function leaveLine() { freshLine(null); }
/* The Trunk whose timeline is drawn around `active`. A conversation just made from a fresh start keeps its Trunk's
   timeline until the list is read again and names it. */
function lineAround(active) {
  if (!active) {
    if (!L.fresh) L.trunkId = null;
    return lineTrunk();
  }
  const trunk = trunkOfId(active);
  if (trunk) L.trunkId = trunk.id;
  else if (L.fresh || L.adopt === active) L.adopt = active;
  else L.trunkId = null;
  L.fresh = false;
  return lineTrunk();
}

/* ---------- drawing ---------- */
const ownWords = (words) => String(words ?? "").replace(/^\[Trunk @[a-z0-9-]{1,60}\] /, "");
const shown = (m) => m.from !== "branch" && ((m.role === "user" && !trunkIntro(m)) || (m.role === "assistant" && !!String(m.content ?? "").trim()));
/** The first message of a conversation that has a time: its line names that time, so the message carries no stamp of its own. */
export const firstTimed = (messages) => (messages ?? []).find((m) => shown(m) && m.at) ?? null;

/* Where a conversation begins: its name once renamed, else "New conversation", with when it began, and a menu for it. */
function sepHTML(s, messages) {
  const id = sid(s) ?? "";
  const d = new Date(firstTimed(messages)?.at ?? s?.createdAt ?? "");
  const when = Number.isNaN(d.getTime()) ? "" : ` · ${stampWords(d)}`;
  const more = id ? `<button class="tl-mb19" type="button" data-act="tl-menu" data-id="${esc(id)}" aria-haspopup="menu" aria-label="${esc(t("more.label"))}">${ic("more", "s")}</button>` : "";
  return `<div class="tl-sep19"${id ? ` data-tl="${esc(id)}"` : ""}><span>${esc((s?.title || t("comfort.field.newConversation")) + when)}</span>${more}</div>`;
}

/* An older conversation's messages as plain bubbles, signed with the Trunk's face where its replies begin. */
function bubbles(trunk, messages) {
  const list = messages.filter(shown), out = [];
  let prev = firstTimed(list), last = null;
  for (const m of list) {
    const stamp = stampBefore(m, prev);
    if (m.at) prev = m;
    if (m.role === "user") {
      const steered = steerWords(m), outside = steered === null ? chatSteerOf(m) : null;
      out.push(stamp + (steered !== null ? steeredLine(steered) : outside ? chatSteerLine(outside) : `<div class="u">${esc(ownWords(m.content))}${timeLine(m)}</div>`));
      last = "user";
    } else {
      out.push(`${stamp}<div class="b"><div class="gut">${last === "assistant" ? "" : av(trunk, 28)}</div><div><div class="txt">${text(m.content)}</div>${timeLine(m)}</div></div>`);
      last = "assistant";
    }
  }
  return out.join("");
}

/* What changes an older conversation's drawing: a new message or name, the day (Today / Yesterday), the language, the
   Trunk's face and whether messages show their time. */
const readKey = (s) => `${lastAt(s)}|${s.messageCount ?? ""}`;
const drawKey = (trunk, s) => [s.title ?? "", new Date().toDateString(), language(), trunk.name, JSON.stringify(trunk.look ?? null), timeLine({ at: "2000-01-01T00:00:00.000Z" })].join("|");

/* Reads a conversation's messages once, and again when the list says it changed; `then` runs once they are in. */
function want(s, then = render) {
  const id = sid(s), got = L.cache.get(id);
  if (got?.reading) return got.reading;
  if (got?.messages && got.read === readKey(s)) return Promise.resolve();
  const reading = api("sessions/" + encodeURIComponent(id)).then(
    (view) => { L.cache.set(id, { read: readKey(s), messages: view?.messages ?? [] }); },
    (error) => { L.cache.set(id, { read: readKey(s), messages: got?.messages ?? [] }); toast(error.message); },
  ).then(() => then());
  L.cache.set(id, { ...got, reading });
  return reading;
}
const ready = (s) => !!L.cache.get(sid(s))?.messages;
/** The conversation drawn in full until now keeps its messages when it becomes an older one (a fresh start), so it
    stays in place instead of being read again. */
export function keepRead(id, messages) {
  const s = [...E.sessions, ...L.extra.values()].find((x) => sid(x) === id);
  if (s && messages?.length) L.cache.set(id, { read: readKey(s), messages });
}
function block(trunk, s) {
  const got = L.cache.get(sid(s)), key = drawKey(trunk, s);
  if (got.drawn !== key || got.drawnFrom !== got.messages) Object.assign(got, { drawn: key, drawnFrom: got.messages, html: sepHTML(s, got.messages) + bubbles(trunk, got.messages) });
  return `<div class="tl-block19" data-tl-block="${esc(sid(s))}">${got.html}</div>`;
}

/**
 * The timeline around the conversation drawn in full (`active`, its `messages`), or null outside a Trunk: the older
 * conversations above it (`before`, the ones not read yet held back behind a "more" mark), its own line (`sep`), and
 * any conversation written in since (`after`), which is read at once.
 */
export function lineHTML(active, messages, activeSession) {
  const trunk = lineAround(active);
  L.active = active;
  if (!trunk) return null;
  const all = lineOf(trunk), at = active ? all.findIndex((s) => sid(s) === active) : -1;
  const before = at < 0 ? all.filter((s) => sid(s) !== active) : all.slice(0, at), after = at < 0 ? [] : all.slice(at + 1);
  for (const s of after) want(s);
  if (before.length) want(before.at(-1));
  for (const s of [...before, ...after]) if (ready(s)) want(s); // one written in since it was read is read again
  let from = before.length;
  while (from > 0 && ready(before[from - 1])) from--;
  const more = from > 0 ? `<div class="tl-more19" id="tl-more" aria-hidden="true"></div>` : "";
  return {
    before: more + before.slice(from).map((s) => block(trunk, s)).join(""),
    sep: sepHTML(activeSession ?? (active ? { sessionId: active } : null), messages),
    after: after.filter(ready).map((s) => block(trunk, s)).join(""),
  };
}

/* Scrolled up to the "more" mark: the conversation just above the ones on screen is read and drawn above, and the reader
   keeps their place. It is found from what is drawn, not from what is read: one whose read landed after the last drawing
   is drawn first, so a conversation further up is never read before the owner could scroll to it. */
async function loadOlder() {
  const trunk = lineTrunk();
  if (!trunk || L.older) return;
  const all = lineOf(trunk), at = all.findIndex((s) => sid(s) === L.active);
  const drawn = (s) => !!$("#scroll")?.querySelector(`[data-tl-block="${CSS.escape(sid(s))}"]`);
  const next = (at < 0 ? all.filter((s) => sid(s) !== L.active) : all.slice(0, at)).findLast((s) => !drawn(s));
  if (!next) return;
  if (!ready(next)) {
    L.older = true;
    try { await want(next, () => undefined); } finally { L.older = false; }
  }
  const box = $("#scroll"), height = box?.scrollHeight ?? 0, top = box?.scrollTop ?? 0;
  renderNow();
  const now = $("#scroll");
  if (now && box) now.scrollTop = top + (now.scrollHeight - height);
}
const heard = new WeakSet();
/** After the conversation is drawn: scrolling near its top reads further back, and so does a thread too short to scroll. */
export function lineAfter(box) {
  if (!box || !L.trunkId) return;
  /* Only a box still on screen: the browser sends a scroll it queued (the thread put at its end on a drawing) on the next
     frame, and when a redraw has replaced the box by then, the old one is off the page, where its scrollTop reads 0, so
     it looked scrolled to the top and read the conversation above what was drawn (CI, window-trunk-timeline). */
  const due = () => box.isConnected && $("#tl-more", box) && box.scrollTop < 240;
  const short = () => box.isConnected && $("#tl-more", box) && box.scrollHeight <= box.clientHeight + 240;
  if (!heard.has(box)) {
    heard.add(box);
    box.addEventListener("scroll", () => { if (due()) loadOlder(); }, { passive: true });
  }
  // Measured again when the timer runs: a drawing in between (the conversation's own messages, or the one above it) can
  // have filled the window, and a thread that scrolls now waits for the owner to scroll up.
  if (short()) setTimeout(() => { if (short()) loadOlder(); });
}

/* ---------- actions ---------- */
/* A Trunk's row is pinned while the Trunk is, or while one of its conversations still carries a pin from before. */
export function linePinned(trunk) { return !!trunk.pinned || (groups().of.get(trunk.id) ?? []).some((s) => s.pinned); }
/** Pin to top / Unpin for a Trunk's row: the Trunk's own pin (POST /api/trunks/<id>), and unpinning clears its
    conversations' own pins too, so the row really leaves Pinned. */
export async function pinLine(trunkId) {
  closePop();
  const trunk = E.trunks.find((tr) => tr.id === trunkId);
  if (!trunk) return;
  const pin = !linePinned(trunk);
  try {
    if (!!trunk.pinned !== pin) await api(`trunks/${encodeURIComponent(trunk.id)}`, { pinned: pin });
    if (!pin) for (const s of (groups().of.get(trunk.id) ?? []).filter((x) => x.pinned)) await api(`sessions/${sid(s)}/pin`, { pinned: false });
    await refresh();
  } catch (error) { toast(error.message); }
}
/* One conversation's own menu, on its line: Rename, Archive and Delete (chat/putaway.js; Delete keeps it in Recently
   Deleted, where Restore brings it back into this timeline). */
function lineMenu(el) {
  const id = `data-id="${esc(el.dataset.id)}"`;
  openPop(el, mi("tl-rename", "edit", t("accounts.action.rename"), "", id) + mi("conv-archive", "folder", t("window.chat.putaway.archive"), "", id)
    + mi("conv-delete", "trash", t("window.chat.putaway.delete"), "", id), { force: true });
}
/** A conversation put away (archived or deleted) leaves its timeline. */
export function dropFromLine(id) {
  L.cache.delete(id);
  if (L.extra.delete(id)) L.extra = new Map(L.extra);
}

export function initTrunkLine() {
  markLive(["tl-menu", "tl-rename", "tl-pin"]);
  on("tl-menu", (el) => lineMenu(el));
  on("tl-rename", (el) => { closePop(); renameConversation(el.dataset.id); });
  on("tl-pin", (el) => pinLine(el.dataset.id));
}
