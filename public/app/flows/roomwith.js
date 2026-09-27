/* trunk-rooms-live: the owner's own words for rooms, over the engine's rooms (src/trunks/rooms.ts, src/trunks/room-plan.ts):
   - Dragging one Trunk (its row in the side list, or its row in Customize › Trunks) onto another opens a small menu:
     "Open a room with both" opens the room the two already share alone, or makes one through POST /api/trunks/rooms
     {name, members: [a, b]} and opens it. The keyboard's way: the menu key (or Shift+F10) on a Trunk's row lists the other
     Trunks, each "Open a room with <name>", which does the same (in the side list, inside that row's own menu).
   - In a room, by the message box, one toggle for who answers: "Everyone answers" (the engine's rule "mention": talking
     freely every Trunk answers, a tag addresses that Trunk), "Only who I tag" ("tag") and "Work together" ("together"),
     saved through POST /api/trunks/rooms/<id> {rule} and read back from GET /api/trunks (rooms[].rule). "Everyone, every
     time" ("all": a tag narrows nothing) and "A lead Trunk decides" ("lead"), both chosen in Room rules, press none.
   Only the owner makes or changes a room (src/trunks/api.ts requireOwner; refused to household people and short-lived
   keys), so for anybody else nothing here is drawn and nothing can be dragged. */

import { esc } from "../core/dom.js";
import { E, ownerHere, refresh } from "../core/state.js";
import { api } from "../core/api.js";
import { on, run } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { openPop, closePop, toast, av, mi } from "../core/ui.js";
import { addDockItem } from "../chat/chat.js";
import { roomsChanged } from "./trunk.js";
import { t } from "../../i18n.js";

const TALK = [["mention", "window.rooms.talk.everyone"], ["tag", "window.flows.trunk.rule-tag"], ["together", "window.flows.trunk.rule-together"]];
const trunkById = (id) => E.trunks.find((tr) => tr.id === id);
const trunkEl = (target) => (target instanceof Element ? target.closest("[data-trunk]") : null);

/* ---------- a room with both ---------- */

/* The room these two already share with nobody else (no household person, no outside agent), if there is one. */
const shared = (a, b) => E.rooms.find((r) => (r.members ?? []).length === 2 && r.members.includes(a) && r.members.includes(b) && !(r.agents ?? []).length && !(r.people ?? []).length);
/* "<a> and <b>", kept to the engine's 60 characters and away from a name another room has. */
function freeName(a, b) {
  const base = t("window.rooms.drop.name", { a: a.name, b: b.name }).slice(0, 60);
  const taken = new Set(E.rooms.map((r) => String(r.name).toLowerCase()));
  for (let n = 1; n < 100; n++) {
    const name = n === 1 ? base : `${base.slice(0, 56)} ${n}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
  return base;
}
function openChat(sessionId) {
  const el = document.createElement("button");
  el.dataset.id = sessionId;
  run("chat", el);
}
async function roomWith(el) {
  closePop();
  const a = trunkById(el.dataset.a), b = trunkById(el.dataset.b);
  if (!a || !b || a.id === b.id) return;
  try {
    const room = shared(a.id, b.id) ?? (await api("trunks/rooms", { name: freeName(a, b), members: [a.id, b.id] })).room;
    await Promise.all([refresh(), roomsChanged()]);
    if (room?.sessionId) openChat(room.sessionId);
  } catch (error) { toast(error.message); }
}
const both = (a, b) => `data-a="${esc(a.id)}" data-b="${esc(b.id)}"`;
/* Dropped on another Trunk: the menu names the two, with their faces. */
function dropMenu(anchor, a, b) {
  openPop(anchor, mi("room-both", "room", t("window.rooms.drop.both"), `${av(a, 18)}${av(b, 18)}`, both(a, b)), { force: true, label: `${a.name} · ${b.name}` });
}
/** From the keyboard (and a Trunk's row menu in the side list, shell/shell.js): every other Trunk, each a room with this one. */
export function roomItems(id) {
  const a = ownerHere() ? trunkById(id) : null;
  if (!a) return "";
  return E.trunks.filter((tr) => tr.id !== a.id && !tr.hidden).map((b) => mi("room-both", "room", esc(t("window.rooms.drop.with", { name: b.name })), av(b, 18), both(a, b))).join("");
}
function withMenu(anchor, a) {
  const items = roomItems(a.id);
  if (items) openPop(anchor, items, { force: true, label: a.name });
}

/* ---------- dragging ---------- */
const D = { from: null };
function lift(e) {
  const el = trunkEl(e.target);
  if (!el || !ownerHere() || !trunkById(el.dataset.trunk)) return;
  D.from = el.dataset.trunk;
  el.classList.add("lift-tr");
  e.dataTransfer.effectAllowed = "link";
  e.dataTransfer.setData("application/x-branch-trunk", D.from);
}
const target = (e) => { const el = trunkEl(e.target); return D.from && el && el.dataset.trunk !== D.from && trunkById(el.dataset.trunk) ? el : null; };
function over(e) {
  const el = target(e);
  if (!el) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "link";
  for (const x of document.querySelectorAll(".over-tr")) if (x !== el) x.classList.remove("over-tr");
  el.classList.add("over-tr");
}
function drop(e) {
  const el = target(e);
  if (!el) return;
  e.preventDefault();
  const a = trunkById(D.from), b = trunkById(el.dataset.trunk);
  settle();
  dropMenu(el, a, b);
}
function settle() {
  D.from = null;
  for (const x of document.querySelectorAll(".lift-tr,.over-tr")) x.classList.remove("lift-tr", "over-tr");
}
/* A Trunk's row in the side list has its own menu (the menu key opens it, shell/shell.js rowMenu), which lists these too. */
function menuKey(e) {
  if (e.key !== "ContextMenu" && !(e.shiftKey && e.key === "F10")) return;
  const el = trunkEl(e.target), a = el && !el.closest("#side") && trunkById(el.dataset.trunk);
  if (!a || !ownerHere()) return;
  e.preventDefault();
  withMenu(el, a);
}

/* ---------- the toggle in a room ---------- */
const pressedOf = (rule) => (!rule || rule === "mention" ? "mention" : rule);
function talkRow(sessionId) {
  const r = ownerHere() ? E.rooms.find((x) => x.sessionId === sessionId) : null;
  if (!r) return "";
  const now = pressedOf(r.rule);
  return `<div class="talk-tr"><span class="seg" role="group" aria-label="${t("rooms.who.choose")}">${TALK.map(([v, k]) => `<button type="button" data-act="room-talk" data-v="${v}" data-id="${esc(r.id)}" aria-pressed="${now === v}">${t(k)}</button>`).join("")}</span></div>`;
}
async function setTalk(el) {
  const r = E.rooms.find((x) => x.id === el.dataset.id), v = el.dataset.v, words = TALK.find(([k]) => k === v);
  if (!r || !words || pressedOf(r.rule) === v) return;
  try {
    await api(`trunks/rooms/${encodeURIComponent(r.id)}`, { rule: v });
    await Promise.all([refresh(), roomsChanged()]);
    toast(t("window.flows.trunk.rule-in-room", { rule: t(words[1]), room: r.name }));
  } catch (error) { toast(error.message); }
}

export function init() {
  markLive(["room-both", "room-talk"]);
  on("room-both", (el) => roomWith(el));
  on("room-talk", (el) => setTalk(el));
  addDockItem(talkRow);
  document.addEventListener("dragstart", lift);
  document.addEventListener("dragover", over);
  document.addEventListener("drop", drop);
  document.addEventListener("dragend", settle);
  document.addEventListener("keydown", menuKey);
}
