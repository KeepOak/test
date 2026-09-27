/* The sidebar's search results, 1:1 with the prototype's: filter chips with counts, then Chats and Trunks (titles and
   answering Trunks), Messages (words inside conversations, from GET /api/search), Past sessions (every conversation
   with the words, from POST /api/sessions/search) and Files and memory (what the engine remembers). A message opens
   its conversation with those words found; a past session opens to read (GET /api/sessions/<id>) and can be carried on
   as a new conversation (POST /api/sessions/<id>/duplicate). Matches are marked. */

import { esc } from "../core/dom.js";
import { ic, av, openDlg, closeDlg, toast } from "../core/ui.js";
import { E, refresh, ownName, chatFace, trunkIntro } from "../core/state.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { openConversation } from "../chat/chat.js";
import { FIND } from "../chat/find.js";
import { t, language } from "../../i18n.js";

export const SQ = { q: "", f: "all", hits: [], past: [], asked: "" };

/* The words around the first match, the match marked. */
const hl = (text, q) => {
  const t = String(text ?? ""), i = t.toLowerCase().indexOf(q.toLowerCase());
  if (!q || i < 0) return esc(t.slice(0, 90));
  const a = Math.max(0, i - 36), s = t.slice(a, i + q.length + 60), j = i - a;
  return (a ? "…" : "") + esc(s.slice(0, j)) + "<mark>" + esc(s.slice(j, j + q.length)) + "</mark>" + esc(s.slice(j + q.length)) + (i + q.length + 60 < t.length ? "…" : "");
};
const idOf = (s) => s.sessionId ?? s.id;
/* A Trunk's or a room's own conversation is found and shown by its name and face, as the list's rows are (core/state.js). */
const titleOf = (s) => ownName(idOf(s)) || s.opening || s.title || "";
const trunkOf = (s) => E.trunks.find((t) => t.id === s.trunkId || t.id === s.trunk?.id || (t.chatSessionId && t.chatSessionId === (s.sessionId ?? s.id)));
const day = (t) => (t ? new Date(t).toLocaleDateString(language(), { month: "short", day: "numeric" }) : "");

/* Asks the engine for words inside conversations and for older conversations; the caller draws again when both land. */
export async function askEngine(q) {
  const [answer, older] = await Promise.all([api("search?q=" + encodeURIComponent(q)).catch(() => null), api("sessions/search", { query: q }).catch(() => null)]);
  if (q !== SQ.q.trim()) return false;
  SQ.hits = answer?.results ?? [];
  /* Every conversation with those words, also one the list shows: here it is read and carried on, not opened. */
  SQ.past = older?.sessions ?? [];
  SQ.asked = q;
  return true;
}

function found(q) {
  const lq = q.toLowerCase();
  const chats = E.sessions.filter((s) => titleOf(s).toLowerCase().includes(lq) || (trunkOf(s)?.name ?? "").toLowerCase().includes(lq));
  const inside = SQ.asked === q ? SQ.hits.filter((h) => h.kind === "conversation") : [];
  const seen = new Set();
  const msgs = inside.map((h) => ({ id: String(h.link ?? "").split("/").pop(), snippet: h.snippet ?? "" }))
    .filter((m) => m.id && !seen.has(m.id) && seen.add(m.id));
  const memory = (E.state?.memory ?? []).filter((m) => JSON.stringify(m.data ?? m).toLowerCase().includes(lq));
  return { chats, msgs, sessions: SQ.asked === q ? SQ.past : [], memory };
}

export function searchHTML() {
  const q = SQ.q.trim(), f = SQ.f, r = found(q);
  const count = { all: r.chats.length + r.msgs.length + r.sessions.length + r.memory.length, chats: r.chats.length, msgs: r.msgs.length, sessions: r.sessions.length, files: r.memory.length };
  const chips = `<div class="sq-chips">${[["all", t("look.filter.all")], ["chats", t("memory.movein.kind.chat")], ["msgs", t("window.shell.search.messages")], ["sessions", t("window.shell.search.past")], ["files", t("pane.files")]].map(([v, l]) => `<button type="button" data-act="sq-f" data-v="${v}" aria-pressed="${f === v}">${l}${count[v] ? ` <em>${count[v]}</em>` : ""}</button>`).join("")}</div>`;
  const sec = (k, title, html) => ((f === "all" || f === k) && html ? `<div class="lh">${title}</div>${html}` : "");
  const session = (id) => E.sessions.find((s) => idOf(s) === id);
  const body = sec("chats", t("window.shell.search.chats-and-trunks"), r.chats.map((s) => `<button type="button" class="sr-row" data-act="chat" data-id="${esc(idOf(s))}">${av(trunkOf(s) ?? chatFace(idOf(s)), 34)}<span><b>${hl(titleOf(s), q)}</b><small>${esc(trunkOf(s)?.name ?? "")}</small></span></button>`).join(""))
    + sec("msgs", t("window.shell.search.messages"), r.msgs.slice(0, 40).map((m) => `<button type="button" class="sr-row msg9" data-act="sr-msg" data-id="${esc(m.id)}">${av(trunkOf(session(m.id) ?? {}) ?? chatFace(m.id), 34)}<span><b>${esc(titleOf(session(m.id) ?? {}))}</b><small>${hl(m.snippet, q)}</small></span></button>`).join(""))
    + sec("sessions", t("window.shell.search.past-sessions"), r.sessions.map((s) => `<button type="button" class="sr-row" data-act="sr-sess" data-v="${esc(s.sessionId)}"><span class="ico-tile sm9">${ic("clock", "s")}</span><span><b>${hl(ownName(s.sessionId) || s.preview, q)}<time>${esc(day(s.createdAt))}</time></b></span></button>`).join(""))
    + sec("files", t("window.shell.search.files-and-memory"), r.memory.map((m) => `<button type="button" class="sr-row" data-act="view" data-v="library"><span class="ico-tile sm9">${ic("book", "s")}</span><span><b>${hl(m.data?.text ?? m.data?.fact ?? m.data?.content ?? "", q)}</b><small>${t("memory.movein.kind.memory")}</small></span></button>`).join(""));
  return chips + (body || `<p class="sq-none">${t("window.shell.search.no-chats-messages-or-files-with", { value: esc(q) })}<br><button class="link" type="button" data-act="sq-f" data-v="sessions">${t("window.shell.search.look-in-past-sessions")}</button></p>`);
}

/* A past session, to read, with Carry it on. */
async function showSession(id) {
  let messages = [];
  try { messages = (await api("sessions/" + encodeURIComponent(id))).messages ?? []; } catch (error) { toast(error.message); return; }
  const s = SQ.past.find((x) => x.sessionId === id), q = SQ.q.trim();
  const lines = messages.filter((m) => (m.role === "user" || m.role === "assistant") && !trunkIntro(m)).map((m) => `<div class="${m.role === "user" ? "me9" : ""}">${m.role === "user" ? "" : av({ kind: "main" }, 22)}<span>${q ? hl(m.content, q) : esc(m.content)}</span></div>`).join("");
  openDlg({ title: `${ownName(id) || s?.preview || ""} · ${day(s?.createdAt)}`, wide: true, body: `<p class="hint" data-css="margin:0">${t("window.shell.search.read-it-here-or-carry-it")}</p><div class="sess9">${lines}</div>`,
    foot: `<button class="btn ghost" type="button" data-act="dlg-close">${t("delight.ach.close")}</button><button class="btn pri" type="button" data-act="sess-carry" data-v="${esc(id)}">${t("window.shell.search.carry-it-on")}</button>` });
}

async function carryOn(id) {
  let copy;
  try { copy = await api(`sessions/${encodeURIComponent(id)}/duplicate`, {}); } catch (error) { toast(error.message); return; }
  closeDlg();
  SQ.q = "";
  SQ.f = "all";
  await refresh().catch((error) => toast(error.message));
  await openConversation(copy.sessionId ?? copy.id);
  toast(t("window.shell.search.carried-on-it-remembers-everything-from"));
}

/* A message found in a conversation opens it with the same words found and marked. */
function openFound(id) {
  Object.assign(FIND, { on: true, q: SQ.q.trim(), i: 0 });
  openConversation(id);
}

export function initSearch() {
  markLive(["sr-msg", "sr-sess", "sess-carry"]);
  on("sr-msg", (el) => openFound(el.dataset.id));
  on("sr-sess", (el) => showSession(el.dataset.v));
  on("sess-carry", (el) => carryOn(el.dataset.v));
}
