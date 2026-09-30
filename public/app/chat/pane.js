/* The side panel beside a conversation (design doc 4.6), 1:1 with the prototype's: Activity (each tool the task used, from
   the conversation's own messages), Plan (GET /api/runs/<id>/plan), Files (what each task changed, from its run) and
   Memory, and Terminal (each command the tasks ran, from GET /api/panels/work: terminal.js).
   Pass 17: Timeline, right after Activity (timeline.js), and Helpers at the end of Activity (helpers.js). Another area
   adds its own tab through `extraTabs`: push [id, label, draw, shown], drawn after these while shown() is true.
   Parity B2: the pass-17 tab row has no Browser tab (the header's computer and browser buttons open the full-size view,
   chat/chat.js), and Branches sits right after Timeline, as the prototype inserts it. Files lists what each task
   changed or made and, from GET /api/panels/work `files.read`, the files a task only read. */

import { $, esc, applyCss, render } from "../core/dom.js";
import { ic, av } from "../core/ui.js";
import { agentState } from "../core/doing.js";
import { S, E } from "../core/state.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive, greyOut } from "../core/features.js";
import { sendingPrompt, sendingHere } from "./chat.js";
import { initStage } from "./stage.js";
import { initPrivateDesktopPane, beforePrivatePaneDraw } from "./private-desktop-pane.js";
import { terminalBody, loadWork, initTerminal, work } from "./terminal.js";
import { pressed } from "../shell/keys.js";
import { timelineBody, initTimeline } from "./timeline.js";
import { helpersSection, initHelpers } from "./helpers.js";
import { t } from "../../i18n.js";
import { resizerHTML } from "../shell/resize.js";
import { roomView } from "./rooms.js";
import { liveLine18, empty18 } from "../core/p18.js"; // pass 18: the lines under faces, and the empty Activity

const TABS = [["activity", "dashboard.area.activity"], ["tl17c", "window.chat.pane.timeline"], ["plan", "pane.plan"], ["files", "pane.files"], ["memory", "memory.movein.kind.memory"], ["terminal", "pane.terminal"]];
const REAL = new Set(["activity", "tl17c", "plan", "files", "memory", "terminal"]);
const P = { sid: null, messages: [], plan: null, at: 0 };

/* This conversation's tasks; before a new conversation has its id, the task its first message started. */
const runsHere = () => {
  const first = sendingPrompt();
  return (E.state?.runs ?? []).filter((r) => (S.chat ? r.sessionId === S.chat : first && r.prompt === first));
};
const working = () => runsHere().some((r) => ["running", "queued", "waiting"].includes(r.status));
/* What was read for the open conversation only: a new conversation shows each tab's empty words, never the last one's. */
const mine = () => (P.sid && P.sid === S.chat ? P : { messages: [], plan: null });

function target(args) {
  try {
    const a = typeof args === "string" ? JSON.parse(args) : args ?? {};
    // A command shows as it was run: the program and its arguments.
    if (a.executable) return [a.executable, ...(Array.isArray(a.args) ? a.args : [])].join(" ");
    return a.path ?? a.url ?? a.command ?? a.query ?? a.name ?? "";
  } catch { return ""; }
}

function activity() {
  const { messages } = mine();
  const results = new Map(messages.filter((m) => m.role === "tool").map((m) => [m.toolCallId, m.content]));
  const steps = messages.flatMap((m) => m.toolCalls ?? []).map((c) => {
    let ok = null;
    try { ok = JSON.parse(results.get(c.id) ?? "null")?.ok ?? null; } catch { /* a result that is not JSON */ }
    return { name: c.name, detail: target(c.arguments), ok };
  });
  /* The welcome only once this conversation was read (or a new one, with nothing to read yet). */
  if (!steps.length && !working()) return roomHere() || (S.chat && P.sid !== S.chat) ? "" : empty18("pane:activity");
  const rows = steps.map((s, i) => `<li class="${s.ok === false ? "" : "ok"}">${ic(s.ok === false ? "x" : "check", "s")}<span>${esc(s.name)}<small>${esc(s.detail)}</small></span><time>${i + 1}</time></li>`).join("");
  const now = working() ? `<li class="run">${ic("spin", "s")}<span>${esc(runsHere().find((r) => r.status === "running")?.prompt?.split("\n")[0] ?? "")}</span><time>${t("window.chat.pane.now")}</time></li>` : "";
  return `<ol class="tl">${rows}${now}</ol>`;
}

/* Pass 18b, "Who's in the room": a room's members each answer in their own conversation, so the room's Activity opens
   with one lane per member, in seat order, from the room (E.rooms, GET /api/trunks) and its own record (GET
   /api/trunks/rooms/<id>, read by chat/rooms.js while the room is on screen): the Trunk's character acting out what it is
   doing in the room, its name and its live line (core/p18.js), or "Had nothing to add" when its newest turn in the room was the
   engine's pass. Another assistant seated in the room shows the engine's badge for it; a person shows a letter face and
   "Person · here now" while the engine counts them here. A Trunk's lane opens its conversation in the room. */
const roomHere = () => (S.chat ? E.rooms.find((r) => r.sessionId === S.chat) ?? null : null);
const letter = (name) => `<span class="face18 who18" aria-hidden="true">${esc(String(name ?? "").trim().charAt(0).toUpperCase())}</span>`;
function trunkLane(seated, view) {
  /* The member answers the room in the conversation the room keeps for it (the room's memberSessions): its face, line
     and lane follow that conversation's runs. */
  const sid = view?.memberSessions?.[seated.id], tr = sid ? { ...seated, chatSessionId: sid } : seated;
  const last = (view?.events ?? []).filter((e) => e.memberId === tr.id).at(-1);
  const passed = last?.kind === "pass" && !["work", "wait"].includes(agentState(tr));
  const line = passed ? `<span class="live18">${t("window.p18.had-nothing")}</span>` : liveLine18(tr);
  const body = `${av(tr, 40)}<span class="grow"><b>${esc(tr.name)}</b>${line}</span>`;
  /* lane18b opens the member's conversation in the room view only, with Back to the room (chat/helpframe.js): as an
     ordinary chat its composer would run work in the hidden member session outside the room, so it has none. */
  return `<div class="lane18b">${body}${sid ? `<button class="icon-btn" type="button" data-act="lane18b" data-id="${esc(sid)}" data-m="${esc(tr.id)}" aria-label="${esc(tr.name)}">${ic("chev", "s")}</button>` : ""}</div>`;
}
function lanes(room) {
  const view = roomView({ kind: "room", room });
  const seat = (id) => E.trunks.find((tr) => tr.id === id) ?? view?.roster?.find((tr) => tr.id === id) ?? room.roster?.find((tr) => tr.id === id);
  const trunks = (room.members ?? []).map(seat).filter(Boolean).map((tr) => trunkLane(tr, view));
  const outside = (view?.outside ?? []).map((a) => `<div class="lane18b">${letter(a.name)}<span class="grow"><b>${esc(a.name)}</b><span class="live18">${esc(a.badge ?? "")}</span></span></div>`);
  const here = new Set((view?.here ?? []).map((p) => p.id));
  const people = (view?.people ?? []).map((p) => `<div class="lane18b">${letter(p.name)}<span class="grow"><b>${esc(p.name)}</b>${here.has(p.id) ? `<span class="live18">${t("window.p18.person-here")}</span>` : ""}</span></div>`);
  return `<section class="lanes18b" aria-label="${t("window.p18.whos-in-room")}"><h3>${t("window.p18.whos-in-room")}</h3>${[...trunks, ...outside, ...people].join("")}</section>`;
}
const activityBody = () => (roomHere() ? lanes(roomHere()) : "") + activity() + helpersSection();

function plan() {
  const steps = mine().plan?.steps ?? [];
  if (!steps.length) return `<p class="empty">${t("window.chat.pane.no-plan")}</p>`;
  const cls = { done: "done", working: "now", failed: "bad", waiting: "" };
  return `<ul class="plan">${steps.map((s) => `<li class="${cls[s.status] ?? ""}"><span class="box">${s.status === "done" ? ic("check") : ""}</span><span>${esc(s.title)}</span></li>`).join("")}</ul>`;
}

const fileRow = (path, st, meta, pill, said) => `<button class="memrow" type="button" data-css="text-align:left" data-act="fileopen" data-n="${esc(path)}" data-st="${st}"><span><b data-css="font-weight:500">${esc(path)}</b></span><small>${meta}</small><span class="pill ${pill}" data-css="grid-row:1 / span 2;grid-column:2;align-self:center">${said}</span></button>`;
function files() {
  const changed = runsHere().flatMap((r) => r.changes ?? []);
  const read = S.chat ? work(S.chat)?.files?.read ?? [] : [];
  if (!changed.length && !read.length) return `<p class="empty">${t("window.chat.pane.no-files")}</p>`;
  return changed.map((f) => (f.existed ? fileRow(f.path, "changed", `+${Number(f.added) || 0} −${Number(f.removed) || 0}`, "warn", t("window.chat.pane.changed"))
    : fileRow(f.path, "made", `+${Number(f.added) || 0} −${Number(f.removed) || 0}`, "done", t("window.chat.pane.made")))).join("")
    + read.map((path) => fileRow(path, "read", "", "idle", t("window.chat.pane.read"))).join("");
}

const BODY = { activity: activityBody, tl17c: timelineBody, plan, files, memory: () => `<p class="empty">${t("window.chat.pane.no-memory")}</p>`, terminal: () => terminalBody(S.chat) };
/* Tabs other areas add (pass 17): [id, label, draw, shown]; each draws its own body and says when it is shown. */
export const extraTabs = [];
const extraShown = () => extraTabs.filter(([, , , shown]) => shown());
/* The tab row in the prototype's order: Branches right after Timeline, any other added tab at the end. */
function tabRow(extra) {
  const after = extra.filter(([id]) => id === "branches"), rest = extra.filter(([id]) => id !== "branches");
  const at = TABS.findIndex(([id]) => id === "tl17c") + 1;
  return [...TABS.slice(0, at), ...after, ...TABS.slice(at), ...rest];
}
const tabAct = (id) => (REAL.has(id) || extraShown().some(([x]) => x === id) ? "ptabp" : "ptabp-" + id);

function ptabButton(id, label, tab) {
  return `<button class="ptab" role="tab" type="button" aria-selected="${tab === id}" data-act="${tabAct(id)}" data-p="${id}" data-v="${id}">${t(label)}</button>`;
}

export function drawPane() {
  const pane = $("#pane"), body = $("#body");
  // Open in every conversation, a new one too: each tab then says what it has (nothing yet, before the first message).
  const open = S.view === "chat" && !!S.pane;
  if (!pane) return;
  pane.hidden = !open;
  body?.classList.toggle("pane-on", open);
  if (!open) { beforePrivatePaneDraw(null); pane.innerHTML = ""; return; }
  const extra = extraShown(), own = extra.find(([id]) => id === S.pane);
  const tab = REAL.has(S.pane) || own ? S.pane : "activity";
  const keptPrivateDesktop = beforePrivatePaneDraw(tab);
  if (keptPrivateDesktop) { loadPane(); return; } // Do not detach a focused canvas or lose held-key state on message refresh.
  pane.innerHTML = `${resizerHTML("pane")}<div class="pane-h"><div class="ptabs" role="tablist">${tabRow(extra).map(([id, l]) => ptabButton(id, l, tab)).join("")}</div><button class="icon-btn" type="button" aria-label="${t("pane.close")}" data-act="pane" data-p="close">${ic("x")}</button></div><div class="pane-b">${own ? own[2]() : BODY[tab]()}</div>`;
  applyCss(pane);
  greyOut(pane);
  // The tab row scrolls when its tabs outgrow the card (pass 17 adds Timeline and Branches); keep the chosen one in view.
  const tabs = pane.querySelector(".ptabs"), on = tabs?.querySelector('[aria-selected="true"]');
  if (on && (on.offsetLeft + on.offsetWidth > tabs.scrollLeft + tabs.clientWidth || on.offsetLeft < tabs.scrollLeft)) tabs.scrollLeft = on.offsetLeft - 8;
  loadPane();
  if (tab === "terminal" || tab === "files") loadWork(S.chat);
}

/* The open conversation's messages and its newest task's plan, read again at most every two seconds; the panel alone is
   drawn again when they change. */
async function loadPane() {
  const sid = S.chat;
  if (!sid || (sid === P.sid && Date.now() - P.at < 2000)) return;
  P.at = Date.now();
  const newest = runsHere().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
  const [session, planned] = await Promise.all([
    api(`sessions/${encodeURIComponent(sid)}`).catch(() => null),
    newest ? api(`runs/${encodeURIComponent(newest.id)}/plan`).catch(() => null) : null,
  ]);
  const messages = session?.messages ?? [], planNow = planned?.plan ?? null;
  const same = sid === P.sid && JSON.stringify(messages) === JSON.stringify(P.messages) && JSON.stringify(planNow) === JSON.stringify(P.plan);
  Object.assign(P, { sid, messages, plan: planNow });
  if (!same && S.chat === sid) drawPane();
}

/* The header's side panel button says whether the panel is open (the prototype's aria-pressed). */
function pressedNow() {
  for (const b of document.querySelectorAll('[data-act="pane"][data-p="activity"][aria-pressed]')) b.setAttribute("aria-pressed", String(!!S.pane && S.pane !== "browser"));
}
/* DG-114, DG-118: closing the panel (its close button or the shortcut) hands the keyboard back to the switch that opens it. */
function focusSwitch() {
  [...document.querySelectorAll('[data-act="pane"][data-p="activity"][aria-pressed]')].find((b) => b.offsetParent !== null)?.focus({ preventScroll: true });
}

export function initPane() {
  initPrivateDesktopPane(extraTabs);
  initStage();
  initTerminal();
  initTimeline({ redraw: drawPane, changed: render, messages: () => (P.sid === S.chat ? P.messages : []), first: sendingPrompt,
    /* A household person's task works under the owner's name while lent, so the window's picture of tasks never holds
       it: while one is at the window (or a message is being answered), the engine's activity list is asked instead. */
    busy: () => sendingHere() || !!E.profiles?.active?.id });
  initHelpers({ redraw: drawPane });
  markLive(["pane", "ptabp", "ask18c"]);
  on("ask18c", () => $("#prompt")?.focus()); // the empty Activity's "Ask something": the message box
  on("pane", (el) => {
    const p = el.dataset.p, inHead = !!el.closest(".head");
    S.pane = p === "close" ? null : inHead && S.pane ? null : p;
    drawPane();
    pressedNow();
    if (!S.pane) focusSwitch();
  });
  on("ptabp", (el) => { S.pane = el.dataset.p; drawPane(); });
  document.addEventListener("keydown", (e) => {
    if (pressed(e, "sidePane")) { e.preventDefault(); S.pane = S.pane ? null : "activity"; drawPane(); pressedNow(); if (!S.pane) focusSwitch(); }
  });
}
