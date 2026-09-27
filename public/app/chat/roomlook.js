/* A room drawn as the prototype's group conversation (pass 10: "people and agents in a conversation"), from the engine's
   own record of the room (GET /api/trunks/rooms/<id>: events, people, roster, waiting, typing, here):
   - a stamp where the day changes or half an hour has passed (each event's `at`);
   - your own messages as yours; a household person's (or, for a person, the owner's) with their face, their name and a
     green dot while they have the room open (`here`);
   - each Trunk's message signed with its face and name, with the needs-you dot while it waits for a yes or asked for you;
   - Trunks talking it through (members answering another member's @mention, the engine's rounds after the first)
     folded into one card with the @names marked;
   - a member that had nothing to add (the engine's "pass" outcome) as a quiet pill where it happened;
   - who else is typing now (`typing`, reported by the message box through POST /api/trunks/rooms/<id>/typing);
   - an agent elsewhere seated in the room (`outside`: its card's name, the engine's badge "A2A · <where it runs>" and
     whether its card answered lately) in the prototype's dashed bubble, its words as plain text, never markdown.
   The transcript's own messages (GET /api/sessions/<id>) are matched to the events so each keeps its message tools. */

import { esc, render } from "../core/dom.js";
import { S, E } from "../core/state.js";
import { api } from "../core/api.js";
import { ic, av, toast } from "../core/ui.js";
import { face, nameOf } from "../core/faces.js";
import { t, language } from "../../i18n.js";
import { text } from "./markdown.js";
import { msgActs, pinnedClass } from "./messages.js";
import { timeLine } from "./comfort.js"; // message times Always
import { outClass, outBadge } from "./leaveout.js";
import { flagBadge } from "./flag.js";
import { roomView, readRoom, replyWords, authorOf } from "./rooms.js";

const L = { info: null, sid: null, sign: "", sentAt: 0, timer: 0, reading: false, reread: async () => [] };
const me = () => E.profiles?.active?.id ?? null;
/* The room is the conversation on screen now: only then does the box speak for it, or the room get read again. */
const onScreen = () => !!L.info?.room && S.view === "chat" && !!S.chat && E.rooms.find((r) => r.id === L.info.room.id)?.sessionId === S.chat;
/* A matched message keeps what the ordinary thread draws on it: pinned, left out, flagged. */
const marks = (m) => (m ? `${pinnedClass(m)}${outClass(m)}` : "");
const after = (m, sid) => (m ? `${outBadge(m)}${flagBadge(sid, m)}` : "");
const trunkOf = (view, id) => E.trunks.find((tr) => tr.id === id) ?? view.roster?.find((m) => m.id === id) ?? null;
const outsideOf = (view, id) => view.outside?.find((a) => a.id === id) ?? null;

/* ---------- when ---------- */
const clock = (d) => d.toLocaleTimeString(language(), { hour: "numeric", minute: "2-digit" });
function stamp(e, prev) {
  const d = new Date(e.at ?? "");
  if (Number.isNaN(d.getTime())) return "";
  const p = new Date(prev?.at ?? "");
  if (!Number.isNaN(p.getTime()) && p.toDateString() === d.toDateString() && d - p < 30 * 60000) return "";
  const words = d.toDateString() === new Date().toDateString() ? t("window.chat.msg.today", { amount: clock(d) })
    : `${d.toLocaleDateString(language(), { month: "short", day: "numeric" })} ${clock(d)}`;
  return `<div class="stamp">${esc(words)}</div>`;
}

/* ---------- faces ---------- */
/* A person's face (core/faces.js), falling back to the initial of the name the engine gave with the event. */
function personFace(id, name, size, online) {
  const dot = `<i class="st${online ? " st-online" : ""}"></i>`;
  const css = `width:${size}px;height:${size}px;font-size:${Math.round(size * 0.38)}px`;
  const known = nameOf(id);
  if (known) return face(id, { cls: "tav6", css: `--c:#56616B;${css}`, extra: dot });
  return `<span class="tav6" data-css="--c:#56616B;${css}" aria-hidden="true">${esc(String(name ?? "").trim().slice(0, 1).toUpperCase())}${dot}</span>`;
}
const personName = (id, name) => name || nameOf(id) || "";
/* An agent elsewhere: its initials, with the online dot while its card answered lately (the prototype's tAv). */
function agentFace(agent, size) {
  const letters = String(agent.name ?? "").split(" ").map((w) => w.slice(0, 1)).join("").slice(0, 2);
  return `<span class="tav6" data-css="--c:#56616B;width:${size}px;height:${size}px;font-size:${Math.round(size * 0.38)}px" aria-hidden="true">${esc(letters)}<i class="st${agent.online ? " st-online" : ""}"></i></span>`;
}
const trunkFace = (tr, size, sid, needs) => (needs ? `<span class="nd18">${av(tr, size, sid)}</span>` : av(tr, size, sid));
const mention = (s) => esc(s).replace(/@([a-z0-9][\w-]*)/gi, '<span class="mention">@$1</span>');

/* ---------- matching the transcript to the room's record ---------- */
/* The room keeps only its newest events (src/trunks/rooms.ts maxKeptEvents), while its conversation keeps every message:
   they are lined up from the newest back, so each message finds its own event and nothing older is lost. */
/* An outside agent's words are kept as Branch's note quoting them (`outsideAgent`, src/trunks/rooms.ts agentTurn): drawn
   as that agent's message, read back from the quote. */
const agentNote = (m) => m.role === "user" && m.from === "branch" && !!m.outsideAgent?.id;
function agentWords(m) {
  const content = String(m.content ?? ""), at = content.indexOf(": ");
  try { const words = JSON.parse(content.slice(at + 2)); return typeof words === "string" ? words : content; } catch { return content; }
}
const said = (m) => agentNote(m) || ((m.role === "user" || m.role === "assistant") && m.from !== "branch" && !m.system && !m.toolCalls?.length);
const kindOf = (m) => (m.role === "user" && !agentNote(m) ? "user" : "member");
const wordsOf = (m, info) => (agentNote(m) ? agentWords(m) : m.role === "user" ? m.content : replyWords(m, info));
function matchMessages(events, messages, info) {
  const byEvent = new Map(), byMessage = new Map();
  let at = events.length - 1;
  for (const m of [...messages].reverse()) {
    if (!said(m)) continue;
    const kind = kindOf(m), words = wordsOf(m, info);
    let i = at;
    while (i >= 0 && !(events[i].kind === kind && events[i].text === words)) i--;
    if (i >= 0) { byEvent.set(events[i], m); byMessage.set(m, events[i]); at = i - 1; }
  }
  return { byEvent, byMessage };
}
/* A message the room's record no longer holds, read from the conversation itself: who wrote it comes from the message
   (a person's own mark, or the Trunk's @name at the start of a reply). */
function fromMessage(m, info) {
  if (agentNote(m)) return { kind: "member", text: agentWords(m), at: m.at, memberId: m.outsideAgent.id };
  if (m.role === "user") return { kind: "user", text: m.content, at: m.at, ...(m.person ? { personId: m.person.id, personName: m.person.name } : {}) };
  return { kind: "member", text: replyWords(m, info), at: m.at, memberId: authorOf(m, 0, info)?.id };
}
/* Everything in order: the conversation's messages, with the room's own outcomes (passes, stops, failures) and any event
   the conversation lacks drawn where they happened. */
function merged(events, messages, info) {
  const { byEvent, byMessage } = matchMessages(events, messages, info);
  const items = [];
  let next = 0;
  for (const m of messages) {
    if (!said(m)) continue;
    const e = byMessage.get(m);
    if (!e) { items.push({ e: fromMessage(m, info), m }); continue; }
    const i = events.indexOf(e);
    for (; next < i; next++) items.push({ e: events[next], m: byEvent.get(events[next]) });
    items.push({ e, m });
    next = i + 1;
  }
  for (; next < events.length; next++) items.push({ e: events[next], m: byEvent.get(events[next]) });
  return items;
}

/* ---------- Trunks talking it through ---------- */
const ASKS_YOU = /@(you|owner|user)\b/i; // the engine's asksForOwner (src/trunks/room-plan.ts)
/* In each discussion, the members' later rounds (a member answering another's @mention) join the round-one message that
   brought them in: one card, drawn where that message was. */
/* trunk-rooms-live: under "Work together" (the owner's message kept the rule it was sent under) the lead's plan and the
   parts fold into the card even when every part was a pass, and the one reply (`final`) stays out of it, in the thread. */
function talks(events, view) {
  const cards = new Map(), inside = new Set();
  const together = new Set(events.filter((e) => e.kind === "user" && e.rule === "together").map((e) => e.seq));
  events = events.filter((e) => !outsideOf(view, e.memberId) && !e.final); // an agent elsewhere keeps its own bubble
  const discussions = new Set(events.filter((e) => e.kind === "member" && (e.round >= 1 || together.has(e.discussion))).map((e) => e.discussion));
  for (const d of discussions) {
    const said = events.filter((e) => e.kind === "member" && e.discussion === d);
    if (together.has(d)) { if (said.length) { cards.set(said[0], said); for (const e of said.slice(1)) inside.add(e); } continue; }
    // A message that calls for you (@you) is to you, not to the other Trunks: it stays out of the card.
    const later = said.filter((e) => e.round >= 1 && !ASKS_YOU.test(e.text));
    if (!later.length) continue;
    const opener = said.filter((e) => e.round === 0 && e.seq < later[0].seq).at(-1);
    const lines = [opener, ...later].filter(Boolean);
    // A card names at least two Trunks; otherwise every reply stays in the thread on its own.
    if (new Set(lines.map((e) => trunkOf(view, e.memberId)?.name).filter(Boolean)).size < 2) continue;
    cards.set(lines[0], lines);
    for (const e of lines.slice(1)) inside.add(e);
  }
  return { cards, inside };
}
function card(view, lines, sid, byEvent) {
  const names = [...new Set(lines.map((e) => trunkOf(view, e.memberId)?.name).filter(Boolean))];
  const passed = (view.events ?? []).filter((e) => e.kind === "pass" && e.discussion === lines[0].discussion).map((e) => trunkOf(view, e.memberId)?.name);
  for (const name of passed) if (name && !names.includes(name)) names.push(name); // a Trunk that had nothing to add still took part
  const words = t(lines.length === 1 ? "window.chat.a2a.talked-one" : "window.chat.a2a.talked", { a: names.slice(0, -1).join(", "), b: names.at(-1), count: lines.length });
  const rows = lines.map((e) => {
    const tr = trunkOf(view, e.memberId), m = byEvent.get(e);
    return `<div class="a2a-l${marks(m)}"${m?.messageId ? ` data-i15="${esc(m.messageId)}"` : ""}>${av(tr, 22, sid)}<span><b>${esc(tr?.name ?? "")}</b> ${mention(e.text)}</span>${m ? msgActs(m) : ""}</div>${after(m, sid)}`;
  }).join("");
  return `<div class="b"><div class="gut"></div><div><details class="a2a10" open><summary>${ic("branch", "s")}${esc(words)}</summary>${rows}</details></div></div>`;
}

/* ---------- who needs you ---------- */
function needing(view) {
  const ids = new Set((view.waiting ?? []).map((q) => q.memberId));
  for (const e of view.events ?? []) if (e.kind === "waiting" && !e.answered) ids.add(e.memberId);
  if (view.needsYou) {
    const last = (view.events ?? []).filter((e) => e.kind === "user").at(-1)?.seq ?? 0;
    for (const e of view.events ?? []) if (e.kind === "member" && e.seq > last && ASKS_YOU.test(e.text)) ids.add(e.memberId);
  }
  return ids;
}

/* ---------- one event ---------- */
function userRow(view, e, m, here, sid) {
  const mine = (e.personId ?? null) === me();
  if (mine) return `<div class="u${marks(m)}"${m?.messageId ? ` data-i15="${esc(m.messageId)}"` : ""}>${esc(e.text)}${m ? timeLine(m) + msgActs(m) : ""}</div>${after(m, sid)}`;
  const id = e.personId ?? null, key = id ?? "owner";
  return `<div class="msg10">${personFace(id, e.personName, 32, here.has(key))}<div><b>${esc(personName(id, e.personName))}</b><p>${esc(e.text)}</p></div></div>`;
}
function memberRow(view, e, m, sid, needs, first) {
  const agent = outsideOf(view, e.memberId);
  if (agent) return `<div class="msg10 ext10">${agentFace(agent, 32)}<div><b>${esc(agent.name)}<span class="tag6">${esc(agent.badge)}</span></b><p>${esc(e.text)}</p></div></div>`;
  const tr = trunkOf(view, e.memberId);
  const from = first && tr ? `<div class="from">${esc(tr.name)}</div>` : "";
  return `<div class="b${marks(m)}"${m?.messageId ? ` data-i15="${esc(m.messageId)}"` : ""}><div class="gut">${first && tr ? trunkFace(tr, 28, sid, needs.has(e.memberId)) : ""}</div><div>${from}<div class="txt">${text(e.text)}</div>${m ? timeLine(m) : ""}</div>${m ? msgActs(m) : ""}</div>${after(m, sid)}`;
}
function passRow(view, e) {
  const tr = trunkOf(view, e.memberId) ?? outsideOf(view, e.memberId);
  return tr?.name ? `<div class="pass10">${esc(t("rooms.passed", { name: tr.name }))}</div>` : "";
}

/** The room's whole thread, or null when this is not a room or its record is not read yet (the ordinary thread then). */
export function roomThread(info, messages, sid) {
  const view = roomView(info);
  if (!view) return null;
  const events = [...(view.events ?? [])].sort((a, b) => a.seq - b.seq);
  const items = merged(events, messages, info), byEvent = new Map(items.map(({ e, m }) => [e, m]));
  const { cards, inside } = talks(events, view), needs = needing(view);
  const here = new Set((view.here ?? []).map((p) => p.id));
  let prev = null, lastWho = null;
  const out = [];
  for (const { e, m } of items) {
    if (inside.has(e)) continue;
    out.push(stamp(e, prev));
    prev = e;
    if (cards.has(e)) { out.push(card(view, cards.get(e), sid, byEvent)); lastWho = null; continue; }
    if (e.kind === "user") { out.push(userRow(view, e, m, here, sid)); lastWho = null; }
    else if (e.kind === "member" || (e.kind === "waiting" && e.text)) { out.push(memberRow(view, e, m, sid, needs, lastWho !== e.memberId)); lastWho = e.memberId; }
    else if (e.kind === "pass") out.push(passRow(view, e));
    else if ((e.kind === "failed" || e.kind === "stopped") && e.text) out.push(`<div class="pass10">${esc(e.text)}</div>`);
  }
  return out.join("") + typingRows(view);
}

/* ---------- who else is typing ---------- */
function typingRows(view) {
  return (view.typing ?? []).map((p) => {
    const id = p.id === "owner" ? null : p.id, name = personName(id, p.name);
    return name ? `<div class="typing10">${personFace(id, name, 22, true)}<span>${esc(t("window.chat.room.typing", { name }))}</span><i></i><i></i><i></i></div>` : "";
  }).join("");
}

/* The message box says you are typing, at most every three seconds (the engine keeps it for six). */
function typed(e) {
  if (e.target?.id !== "prompt" || !onScreen() || !e.target.value.trim()) return;
  if (Date.now() - L.sentAt < 3000) return;
  L.sentAt = Date.now();
  api(`trunks/rooms/${encodeURIComponent(L.info.room.id)}/typing`, {}).catch((error) => toast(error.message));
}

/* While a room is open and in sight, its record is read again every three seconds, and the thread drawn again only when
   who is typing, who is here or what was said has changed. */
async function look() {
  if (!onScreen() || L.reading || document.visibilityState !== "visible") return;
  L.reading = true;
  try {
    const [view, messages] = await Promise.all([readRoom(L.info), L.reread()]);
    const sign = JSON.stringify([view?.typing, view?.here, view?.seq, view?.waiting?.length, messages?.length, messages?.at(-1)?.messageId,
      view?.outside?.map((a) => a.online)]);
    if (view && sign !== L.sign) { L.sign = sign; render(); }
  } finally { L.reading = false; }
}

/** The conversation open now (chat.js): a room is watched while it is open, anything else is not. `reread` reads the
    room's conversation again (so a new reply comes with its message tools) and answers its messages. */
export function watchRoom(info, reread) {
  const room = info?.kind === "room" && info.room ? info : null;
  L.info = room;
  if (reread) L.reread = reread;
  if (room && !L.timer) L.timer = setInterval(look, 3000);
  if (!room && L.timer) { clearInterval(L.timer); L.timer = 0; L.sign = ""; }
}

export function initRoomLook() {
  document.addEventListener("input", typed);
}
