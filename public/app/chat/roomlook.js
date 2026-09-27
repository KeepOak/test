/* A room drawn as the prototype's group conversation (pass 10: "people and agents in a conversation"), from the engine's
   own record of the room (GET /api/trunks/rooms/<id>: events, people, roster, waiting, typing, here):
   - a stamp where the day changes or half an hour has passed (each event's `at`);
   - your own messages as yours; a household person's (or, for a person, the owner's) with their face, their name and a
     green dot while they have the room open (`here`);
   - each Trunk's message signed with its face and name, with the needs-you dot while it waits for a yes or asked for you;
   - Trunks talking it through (members answering another member's @mention, the engine's rounds after the first)
     folded into one card with the @names marked;
   - a member that had nothing to add (the engine's "pass" outcome) as a quiet pill where it happened;
   - who else is typing now (`typing`, reported by the message box through POST /api/trunks/rooms/<id>/typing).
   The transcript's own messages (GET /api/sessions/<id>) are matched to the events so each keeps its message tools. */

import { esc, render } from "../core/dom.js";
import { E } from "../core/state.js";
import { api } from "../core/api.js";
import { ic, av, toast } from "../core/ui.js";
import { face, nameOf } from "../core/faces.js";
import { t, language } from "../../i18n.js";
import { text } from "./markdown.js";
import { msgActs } from "./messages.js";
import { roomView, readRoom, replyWords } from "./rooms.js";

const L = { info: null, sid: null, sign: "", sentAt: 0, timer: 0, reading: false };
const me = () => E.profiles?.active?.id ?? null;
const trunkOf = (view, id) => E.trunks.find((tr) => tr.id === id) ?? view.roster?.find((m) => m.id === id) ?? null;

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
const trunkFace = (tr, size, sid, needs) => (needs ? `<span class="nd18">${av(tr, size, sid)}</span>` : av(tr, size, sid));
const mention = (s) => esc(s).replace(/@([a-z0-9][\w-]*)/gi, '<span class="mention">@$1</span>');

/* ---------- matching the transcript to the room's record ---------- */
function matchMessages(events, messages, info) {
  const byEvent = new Map();
  let at = 0;
  for (const m of messages) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    const kind = m.role === "user" ? "user" : "member", words = m.role === "user" ? m.content : replyWords(m, info);
    const i = events.findIndex((e, n) => n >= at && e.kind === kind && e.text === words);
    if (i >= 0) { byEvent.set(events[i], m); at = i + 1; }
  }
  return byEvent;
}

/* ---------- Trunks talking it through ---------- */
const ASKS_YOU = /@(you|owner|user)\b/i; // the engine's asksForOwner (src/trunks/room-plan.ts)
/* In each discussion, the members' later rounds (a member answering another's @mention) join the round-one message that
   brought them in: one card, drawn where that message was. */
function talks(events) {
  const cards = new Map(), inside = new Set();
  const discussions = new Set(events.filter((e) => e.kind === "member" && e.round >= 1).map((e) => e.discussion));
  for (const d of discussions) {
    const said = events.filter((e) => e.kind === "member" && e.discussion === d);
    // A message that calls for you (@you) is to you, not to the other Trunks: it stays out of the card.
    const later = said.filter((e) => e.round >= 1 && !ASKS_YOU.test(e.text));
    if (!later.length) continue;
    const opener = said.filter((e) => e.round === 0 && e.seq < later[0].seq).at(-1);
    const lines = [opener, ...later].filter(Boolean);
    if (lines.length < 2) continue;
    cards.set(lines[0], lines);
    for (const e of lines.slice(1)) inside.add(e);
  }
  return { cards, inside };
}
function card(view, lines, sid) {
  const names = [...new Set(lines.map((e) => trunkOf(view, e.memberId)?.name).filter(Boolean))];
  if (names.length < 2) return null;
  const words = t("window.chat.a2a.talked", { a: names.slice(0, -1).join(", "), b: names.at(-1), count: lines.length });
  const rows = lines.map((e) => { const tr = trunkOf(view, e.memberId); return `<div class="a2a-l">${av(tr, 22, sid)}<span><b>${esc(tr?.name ?? "")}</b> ${mention(e.text)}</span></div>`; }).join("");
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
function userRow(view, e, m, here) {
  const mine = (e.personId ?? null) === me();
  if (mine) return `<div class="u"${m?.messageId ? ` data-i15="${esc(m.messageId)}"` : ""}>${esc(e.text)}${m ? msgActs(m) : ""}</div>`;
  const id = e.personId ?? null, key = id ?? "owner";
  return `<div class="msg10">${personFace(id, e.personName, 32, here.has(key))}<div><b>${esc(personName(id, e.personName))}</b><p>${esc(e.text)}</p></div></div>`;
}
function memberRow(view, e, m, sid, needs, first) {
  const tr = trunkOf(view, e.memberId);
  const from = first && tr ? `<div class="from">${esc(tr.name)}</div>` : "";
  return `<div class="b"${m?.messageId ? ` data-i15="${esc(m.messageId)}"` : ""}><div class="gut">${first ? trunkFace(tr ?? { kind: "main" }, 28, sid, needs.has(e.memberId)) : ""}</div><div>${from}<div class="txt">${text(e.text)}</div></div>${m ? msgActs(m) : ""}</div>`;
}
function passRow(view, e) {
  const tr = trunkOf(view, e.memberId);
  return tr?.name ? `<div class="pass10">${esc(t("rooms.passed", { name: tr.name }))}</div>` : "";
}

/** The room's whole thread, or null when this is not a room or its record is not read yet (the ordinary thread then). */
export function roomThread(info, messages, sid) {
  const view = roomView(info);
  if (!view) return null;
  const events = [...(view.events ?? [])].sort((a, b) => a.seq - b.seq);
  const byEvent = matchMessages(events, messages, info), { cards, inside } = talks(events), needs = needing(view);
  const here = new Set((view.here ?? []).map((p) => p.id));
  let prev = null, lastWho = null;
  const out = [];
  for (const e of events) {
    if (inside.has(e)) continue;
    const drawn = cards.has(e) ? card(view, cards.get(e), sid) : null;
    out.push(stamp(e, prev));
    prev = e;
    if (drawn) { out.push(drawn); lastWho = null; continue; }
    if (e.kind === "user") { out.push(userRow(view, e, byEvent.get(e), here)); lastWho = null; }
    else if (e.kind === "member" || (e.kind === "waiting" && e.text)) { out.push(memberRow(view, e, byEvent.get(e), sid, needs, lastWho !== e.memberId)); lastWho = e.memberId; }
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
  if (e.target?.id !== "prompt" || !L.info?.room || !e.target.value.trim()) return;
  if (Date.now() - L.sentAt < 3000) return;
  L.sentAt = Date.now();
  api(`trunks/rooms/${encodeURIComponent(L.info.room.id)}/typing`, {}).catch((error) => toast(error.message));
}

/* While a room is open and in sight, its record is read again every three seconds, and the thread drawn again only when
   who is typing, who is here or what was said has changed. */
async function look() {
  if (!L.info?.room || L.reading || document.visibilityState !== "visible") return;
  L.reading = true;
  try {
    const view = await readRoom(L.info);
    const sign = JSON.stringify([view?.typing, view?.here, view?.seq, view?.waiting?.length]);
    if (view && sign !== L.sign) { L.sign = sign; render(); }
  } finally { L.reading = false; }
}

/** The conversation open now (chat.js): a room is watched while it is open, anything else is not. */
export function watchRoom(info) {
  const room = info?.kind === "room" && info.room ? info : null;
  L.info = room;
  if (room && !L.timer) L.timer = setInterval(look, 3000);
  if (!room && L.timer) { clearInterval(L.timer); L.timer = 0; L.sign = ""; }
}

export function initRoomLook() {
  document.addEventListener("input", typed);
}
