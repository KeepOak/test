/* Trunks in a conversation (prototype block(): a room's replies signed with the Trunk's face, and its name when the
   speaker changes), wired to the engine's own routes (src/trunks/api.ts, src/trunks/conversations.ts):
   - who answers here and who wrote each reply: GET /api/trunks/conversations/<id> (kind, trunk, room, authors), read by
     the + menu (plus.js loadWho) and shared from there;
   - where a message goes, as the engine expects it (the old window's rooms.js routeFor): a room's message goes to
     POST /api/trunks/rooms/<id>/send; "@name …" with choosing a Trunk switched off goes to that Trunk's own chat
     (POST /api/trunks/<id>/say); "@name …" in a conversation your assistant answers makes that Trunk answer here from now
     on (POST /api/trunks/conversations or /api/trunks/conversations/<id>) and is then sent as usual;
   - a room member waiting for a yes: GET /api/trunks/rooms/<id> waiting, answered for that exact request with
     POST /api/trunks/rooms/<id>/answer { memberId, decision, fingerprint }. */

import { esc } from "../core/dom.js";
import { av } from "../core/ui.js";
import { E } from "../core/state.js";
import { api } from "../core/api.js";
import { t, plural } from "../../i18n.js";

const R = { view: null, viewFor: null, answered: new Map() };

const modeOn = (part) => (E.trunkModes?.trunks ?? "on") !== "off" && (E.trunkModes?.[part] ?? "on") !== "off";
const trunkBy = (id, info) => E.trunks.find((tr) => tr.id === id) ?? info?.trunks?.find((tr) => tr.id === id)
  ?? info?.room?.members?.find((tr) => tr.id === id) ?? (info?.trunk?.id === id ? info.trunk : null);
const byHandle = (handle, info) => {
  const h = String(handle).toLowerCase();
  return E.trunks.find((tr) => !tr.hidden && tr.handle === h) ?? info?.room?.members?.find((tr) => tr.handle === h) ?? null;
};

/** The Trunks a message names with @handle, in order, each once. */
export function named(text, info) {
  const found = [];
  for (const match of String(text).matchAll(/(?:^|\s)@([a-z0-9][\w-]*)/gi)) {
    const trunk = byHandle(match[1], info);
    if (trunk && !found.includes(trunk)) found.push(trunk);
  }
  return found;
}

/* ---------- who wrote a reply ---------- */
const ROOM_REPLY = /^@([a-z0-9][\w.-]*):\s*/i;
/** A room's reply is kept as "@handle: words"; the words without the handle. */
export const replyWords = (m, info) => (info?.kind === "room" ? String(m.content ?? "").replace(ROOM_REPLY, "") : m.content);

/** The Trunk that wrote this reply, or null for your assistant. `index` counts the replies before it the way the engine
   does (assistant messages that call no tool). */
export function authorOf(m, index, info) {
  if (!info) return null;
  if (info.kind === "room") { const at = ROOM_REPLY.exec(String(m.content ?? "")); return at ? byHandle(at[1], info) : null; }
  if (info.kind === "trunk-chat" || info.kind === "member") return info.trunk ? trunkBy(info.trunk.id, info) ?? info.trunk : null;
  /* A conversation that changed hands (kind trunk, or plain again after a Trunk answered) keeps who gave each reply. */
  if (info.kind !== "trunk" && info.kind !== "plain") return null;
  const answered = [...(info.authors ?? [])].filter((a) => a.from <= index).at(-1);
  return answered?.trunkId ? trunkBy(answered.trunkId, info) : null;
}
export const countsAsReply = (m) => m.role === "assistant" && !m.toolCalls?.length;

/* ---------- where a message goes ---------- */
/** What sending `text` means here, as a function to run, or null when the ordinary send does it. `hooks` are the
   conversation's own: open(id), sendPlain(text), after(). */
export function routeFor(text, sid, info, hooks) {
  if (info?.kind === "room" && info.room) return () => sendToRoom(info, text, hooks);
  const names = named(text, info);
  if (!names.length || !modeOn("trunks")) return null;
  if (!modeOn("conversations")) {
    const match = /^@([a-z0-9][\w-]*)\s+([\s\S]+)$/i.exec(text.trim());
    const trunk = match && byHandle(match[1], info);
    return trunk?.chatSessionId ? () => sayToTrunk(trunk, match[2].trim(), hooks) : null;
  }
  const kind = info?.kind ?? (sid ? null : "plain");
  if (kind !== "plain") return null;
  return () => chooseAndSend(names[0], sid, text, hooks);
}

async function sendToRoom(info, text, hooks) {
  await api(`trunks/rooms/${encodeURIComponent(info.room.id)}/send`, { text });
  await hooks.followRoom(info);
}
async function sayToTrunk(trunk, text, hooks) {
  await hooks.open(trunk.chatSessionId);
  const before = hooks.mark();
  await api(`trunks/${encodeURIComponent(trunk.id)}/say`, { text });
  await hooks.open(trunk.chatSessionId);
  hooks.readAloud(before);
}
async function chooseAndSend(trunk, sid, text, hooks) {
  if (sid) await api(`trunks/conversations/${encodeURIComponent(sid)}`, { trunkId: trunk.id });
  else await hooks.open((await api("trunks/conversations", { trunkId: trunk.id })).sessionId);
  await hooks.after();
  await hooks.sendPlain(text);
}

/* ---------- a room's own state: speaking, and who waits for a yes ---------- */
export async function readRoom(info, { throwOnError = false } = {}) {
  if (info?.kind !== "room" || !info.room) { R.view = null; R.viewFor = null; return null; }
  try { R.view = await api(`trunks/rooms/${encodeURIComponent(info.room.id)}`); R.viewFor = info.room.id; }
  catch (error) { R.view = null; if (throwOnError) throw error; }
  return R.view;
}
export const roomView = (info) => (info?.kind === "room" && R.viewFor === info.room?.id ? R.view : null);

/* A room member's question, 1:1 with the conversation's approval card; the buttons name the room, the member and the
   exact request. */
export function roomAsks(info, busy) {
  const view = roomView(info);
  const waiting = view?.waiting ?? [];
  if (waiting.length > 1 || [...R.answered.values()].some((a) => a.room === info.room?.id && a.shown)) return groupedAsks(info, waiting, busy);
  return waiting.map((q) => {
    const who = trunkBy(q.memberId, info);
    const off = busy(q) ? " disabled" : "";
    const id = `data-room="${esc(info.room.id)}" data-member="${esc(q.memberId)}" data-fp="${esc(q.fingerprint || "")}"${off}`;
    return `<div class="b"><div class="gut"></div><div>${who ? `<div class="from">${esc(who.name)}</div>` : ""}<div class="card ask" id="live-ask" data-approval-card tabindex="0" role="group" aria-label="${esc(t("dashboard.needs.title"))}" aria-keyshortcuts="Enter Escape"><div class="card-h"><span class="q">${esc(q.label)}</span><span class="pill work ml"><i></i>${t("dashboard.needs.title")}</span></div>
      <div class="acts"><button class="btn pri" type="button" data-act="room-ask" data-v="allow" ${id}>${t("trunks.room.allow")}</button><button class="btn ghost" type="button" data-act="room-ask" data-v="deny" ${id}>${t("window.chat.ask.dont-allow")}</button></div></div></div></div>`;
  }).join("");
}
export async function answerRoom(el, decision) {
  const said = await api(`trunks/rooms/${encodeURIComponent(el.dataset.room)}/answer`, { memberId: el.dataset.member, decision, ...(el.dataset.fp ? { fingerprint: el.dataset.fp } : {}) });
  const grouped = !!el.closest(".g-ask");
  R.answered.set(askId(el.dataset.room, el.dataset.member, el.dataset.fp), { room: el.dataset.room, member: el.dataset.member, decision, shown: grouped, label: el.dataset.label ?? "", code: el.dataset.code ?? "" });
  return said;
}

/* ---------- "Two things need you": several members waiting at once (prototype block ask2) ---------- */
/* One row per member's question, each with Yes and No naming that exact request (room, member, fingerprint); a row
   answered here keeps its Allowed or Refused pill while the others wait, "Yes to both" is drawn and stays greyed: it would
   answer requests it does not name one by one (a separate security review). */
const askId = (room, member, fp) => `${room}\n${member}\n${fp || ""}`;
function groupedAsks(info, waiting, busy) {
  const room = info.room.id;
  const answered = [...R.answered.entries()].filter(([, a]) => a.room === room && a.shown);
  const rows = waiting.map((q) => groupRow(info, q, busy(q))).join("") + answered.map(([, a]) => doneRow(info, a)).join("");
  if (!waiting.length) { for (const [k] of answered) R.answered.delete(k); }
  const count = waiting.length + answered.length;
  const title = count === 2 ? t("window.chat.room.two-need-you") : plural(count, { one: "window.chat.room.need-you.one", other: "window.chat.room.need-you" });
  const pill = waiting.length ? `<span class="pill work ml"><i></i>${t("dashboard.needs.title")}</span>` : `<span class="pill done ml"><i></i>${t("window.chat.room.answered")}</span>`;
  const all = waiting.length > 1 ? `<div class="acts"><button class="btn pri" type="button" data-act="g-all" data-room="${esc(room)}">${t("window.chat.room.yes-to-both")}</button></div>` : "";
  return `<div class="b"><div class="gut"></div><div><div class="card g-ask"><div class="card-h"><b>${esc(title)}</b>${pill}</div>${rows}${all}</div></div></div>`;
}
function groupRow(info, q, off) {
  const who = trunkBy(q.memberId, info);
  const id = `data-room="${esc(info.room.id)}" data-member="${esc(q.memberId)}" data-fp="${esc(q.fingerprint || "")}" data-label="${esc(q.label)}" data-code="${esc(q.target || q.tool)}"${off ? " disabled" : ""}`;
  return `<div class="g-row" data-approval-card tabindex="0" role="group" aria-label="${esc(q.label)}" aria-keyshortcuts="Enter Escape">${who ? av(who, 26) : ""}<span><b>${esc(who?.name ?? "")}: ${esc(q.label)}</b><code>${esc(q.target || q.tool)}</code></span><span class="acts"><button class="btn pri sm" type="button" data-act="g-ans" data-v="allow" ${id}>${t("autonomy.needs.yes")}</button><button class="btn ghost sm" type="button" data-act="g-ans" data-v="deny" ${id}>${t("autonomy.needs.no")}</button></span></div>`;
}
function doneRow(info, a) {
  const who = trunkBy(a.member, info), yes = a.decision === "allow";
  return `<div class="g-row">${who ? av(who, 26) : ""}<span><b>${esc(who?.name ?? "")}: ${esc(a.label)}</b><code>${esc(a.code)}</code></span><span class="pill ${yes ? "done" : "no"}"><i></i>${yes ? t("window.chat.tl.allowed") : t("panels.state.refused")}</span></div>`;
}
