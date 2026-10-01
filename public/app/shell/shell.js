/* The frame around every view: the title bar (merged with the conversation header on wide windows, design doc 3), the
   sidebar (machine, search, Places, the conversation list, the person) and the status bar. Real data only. */

import { $, esc, paintChanged, renderNow } from "../core/dom.js";
import { plain } from "../chat/markdown.js"; // dogfood D11: plain words in the list
import { S, E, refresh, save, activeId, personHere, ownerHere, ownName, chatFace, needsYou } from "../core/state.js";
import { on, run } from "../core/actions.js";
import { ic, av, mi, openPop, closePop, openDlg, toast } from "../core/ui.js";
import { greyOut, markLive } from "../core/features.js";
import { stillOutOfSight } from "../core/still.js";
import { head as chatHead, openConversation, startFresh, addDockItem, conversationWho } from "../chat/chat.js";
import { contextMeter } from "./context-audit.js";
import { groups, lineOf, currentOf, freshIn, linePinned, lastAt, sid as idOf } from "../chat/trunkline.js"; // trunk-one-row
import { statusItems } from "../chat/messages.js";
import { initExtras, gatewayOn, readGateway } from "./extras.js";
import { initUsage, planMeter } from "./usage.js";
import { initCelebrate } from "./celebrate.js";
import { initCheer } from "./cheer.js";
import { initNotify } from "./notify.js";
import { initDash } from "../places/dashsw.js";
import { initAutoUpdate } from "./autoupdate.js";
import { initUpdating, statusItem as updateItem } from "./updating.js";
import { api, link, isDesktop } from "../core/api.js";
import { SQ, searchHTML, askEngine, initSearch } from "./search.js";
import { loadLook, applyLook, savePrefs } from "./look.js";
import { initThemes } from "./themes.js";
import { reserveControls, followControlsLook } from "./controls.js";
import { loadDelight, drawBackground, drawPet, petHTML, pat, D, sceneryHTML, paintScenery } from "./scene.js";
import { initPalette } from "./palette.js";
import { ACT, working, readActivity } from "./activity.js";
import { K, loadKeys, pressed, binding, spoken, ariaKeys } from "./keys.js";
import { M, machineName, loadMachineName } from "./machines.js";
import { chatOwner } from "../flows/trunk.js";
import { pausedChip } from "../flows/pause.js"; // chat-060: the status bar's "N paused" chip
import { convItems, putAwayEntries, initPutAway } from "../chat/putaway.js"; // conversations like iMessage
import { roomItems } from "../flows/roomwith.js"; // trunk-rooms-live: a room with another Trunk, from the row's menu
import { unreadDot, recentClass, markAllButton, unreadItem, initUnread } from "../chat/unread.js"; // pass 17
import { initQuick, quickItem } from "../chat/quick.js";
import { init as initPeople, pinNoticeDue } from "../flows/people.js"; // unhold/people: switching person, invites, roles
import { init as initProfile } from "../flows/profile.js"; // your-profile
import { face, nameOf } from "../core/faces.js"; // your-profile
import { onboardingHint } from "../flows/setup.js"; // setup-resume: Guide › Onboarding
import { waiting } from "../flows/whatsnew.js";
import { popupsRow } from "../flows/guides.js"; // setup-resume: Guide › Show tips and pop-ups
import { t, language } from "../../i18n.js";
import { say } from "../core/words.js";
import { resizerHTML, toggleSide, initResize, railNow } from "./resize.js";
import { projectRows, loadProjects } from "../places/project.js"; // area projects: the fold's rows and a project's own page
import { initWhatCan } from "../flows/whatcan.js"; // the "What can Branch do" gallery
import { homeButton, initHome } from "./home.js"; // RES-701: the Home panel beside any page
import { olderConversationsHTML, initSessionPages } from "./session-pages.js";
import { simpleButton, initSimple } from "./simple.js"; // RES-704: the Simple / Advanced switch

const WIDE = matchMedia("(min-width: 761px)");
export const PLACES = [["overview", "home", "Overview"], ["inbox", "inbox", "Inbox"], ["automations", "clock", "Automations"],
  ["library", "book", "Library"], ["team", "users", "Team"], ["customize", "sliders", "Customize"], ["seasons", "star", "Seasons"]];

/* A place's own header, the prototype's placeHead: on a narrow window the button that slides the list in, and Settings.
   It sits in the title-bar row at every width, as the conversation's header does (drawShell). */
export const PLACE_VIEWS = [...PLACES.map(([view]) => view), "project"];
export const placeHead = () => `<div class="head"><button class="icon-btn menu-only" type="button" aria-label="${t("window.shell.shell.show-conversations")}" data-act="side">${ic("menu")}</button><span class="tb-grow"></span><button class="icon-btn" type="button" aria-label="${t("memory.movein.kind.setting")}" data-act="view" data-v="settings">${ic("gear")}</button></div>`;
export const wide = () => WIDE.matches;

const sessionId = (s) => s.sessionId ?? s.id;
const hidden = (part) => (E.state?.preferences?.hidden ?? []).includes(part);
/* The Trunk that answers a conversation: its own chat, or the one the conversation names. */
const trunkFor = (s) => E.trunks.find((t) => t.id === s.trunkId || t.id === s.trunk?.id || (t.chatSessionId && t.chatSessionId === sessionId(s)));
/* A row's title and its last line are plain words, never the Markdown they were written in (dogfood D11). */
const sessionTitle = (s) => s.title || plain(s.opening) || t("comfort.field.newConversation");
/* One formatter per language and kind, made once: making one for every row cost about 2 ms a redraw. */
const formats = new Map();
const format = (kind, options) => {
  const key = `${language()}\n${kind}`;
  if (!formats.has(key)) formats.set(key, new Intl.DateTimeFormat(language(), options));
  return formats.get(key);
};
/* A row's time: today the hour; within the last week the weekday ("Sat"); older a date ("12 Sep"), with the year once it
   is another year's (UI-027: a weekday alone is unclear past one week). */
const WEEK = 6 * 24 * 60 * 60 * 1000;
export const when = (t, now = new Date()) => {
  if (!t) return "";
  const d = new Date(t);
  if (now.toDateString() === d.toDateString()) return format("time", { hour: "numeric", minute: "2-digit" }).format(d);
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (d.getTime() >= midnight - WEEK) return format("day", { weekday: "short" }).format(d);
  if (d.getFullYear() === now.getFullYear()) return format("date", { day: "numeric", month: "short" }).format(d);
  return format("year", { day: "numeric", month: "short", year: "numeric" }).format(d);
};

/* The engine's one count (Q050); a helper's question is answered in its task's Activity › Helpers (FEATURES17C §4). */
const waitingCount = needsYou;

/* Team's live count, the prototype's live6: the tasks working here now, as Team › Live now counts them (GET /api/state
   runs, running or waiting on an answer). */
const liveNow = () => (E.state?.runs ?? []).filter((r) => r.status === "running" || r.status === "needs_input").length;

/* A conversation with a task still going (E.state.runs) reads Working in its row, as the conversation header does. */
const runningIn = (id) => (E.state?.runs ?? []).some((r) => r.sessionId === id && ["running", "queued"].includes(r.status));

/* The prototype's rowHtml names and draws a Trunk's or a room's own conversation by the Trunk or room (core/state.js). */

/* trunk-one-row: a Trunk's one row, like a contact in iMessage: its face and name, its newest message and when, a dot
   while any of its conversations has something unread, Working while one of them works. It opens the Trunk's timeline
   at the conversation written in last (chat/trunkline.js), which is where the message box sends; while the Trunk is
   open it names the conversation open in it. */
function lineRow(trunk) {
  const line = lineOf(trunk), last = line.at(-1);
  const here = !!S.chat && line.some((s) => idOf(s) === S.chat), open = here || freshIn() === trunk.id, id = here ? S.chat : currentOf(trunk);
  const busy = line.some((s) => runningIn(idOf(s)));
  const unread = !open && line.some((s) => s.unread);
  const drags = ownerHere() ? ` draggable="true" data-trunk="${esc(trunk.id)}"` : ""; // trunk-rooms-live: onto another Trunk (flows/roomwith.js)
  return `<div class="rw18"><button class="row" type="button" data-act="chat" data-id="${esc(id)}" data-line="${esc(trunk.id)}" aria-current="${open}"${busy ? ' data-running="true"' : ""}${drags}>
    <span class="avw">${av(trunk, 40, id)}</span>
    <b><span class="ellip14">${esc(trunk.name)}</span>${trunk.paused ? `<span class="paused">${t("autonomy.orders.paused")}</span>` : ""}</b><time datetime="${esc(lastAt(last))}">${esc(when(lastAt(last)))}</time>
    ${busy ? `<p class="attn">${t("window.shell.working")}</p>` : `<p>${esc(plain(last?.lastMessage))}</p>`}${unreadDot({ sessionId: id, unread })}</button><button class="rmore18" type="button" data-act="conv-more" data-id="${esc(id)}" aria-haspopup="menu" aria-label="${t("more.label")}">${ic("more", "s")}</button></div>`;
}

function row(s) {
  const id = sessionId(s);
  const trunk = trunkFor(s);
  const busy = runningIn(id);
  const waits = E.rooms.some((r) => r.sessionId === id && r.needsYou); // GET /api/trunks rooms[].needsYou: the prototype's p.attn
  const drags = trunk && ownerHere() ? ` draggable="true" data-trunk="${esc(trunk.id)}"` : ""; // trunk-rooms-live: onto another Trunk (flows/roomwith.js)
  return `<div class="rw18"><button class="row" type="button" data-act="chat" data-id="${esc(id)}" aria-current="${S.chat === id}"${busy ? ' data-running="true"' : ""}${drags}>
    <span class="avw">${av(trunk ?? chatFace(id), 40, id)}</span>
    <b><span class="ellip14">${esc(ownName(id) || sessionTitle(s))}</span>${trunk?.paused ? `<span class="paused">${t("autonomy.orders.paused")}</span>` : ""}</b><time datetime="${esc(s.updatedAt ?? s.createdAt ?? "")}">${esc(when(s.updatedAt ?? s.createdAt))}</time>
    ${busy ? `<p class="attn">${t("window.shell.working")}</p>` : `<p${waits ? ' class="attn"' : ""}>${esc(plain(s.lastMessage))}</p>`}${unreadDot(s)}</button><button class="rmore18" type="button" data-act="conv-more" data-id="${esc(id)}" aria-haspopup="menu" aria-label="${t("more.label")}">${ic("more", "s")}</button></div>`;
}

/* Typing in search asks the engine for words inside conversations after a short pause; the box keeps focus and caret. */
let searchTimer;
function searchInside(q) {
  clearTimeout(searchTimer);
  if (q.trim().length < 2) return;
  searchTimer = setTimeout(async () => {
    if (!(await askEngine(q.trim()))) return;
    const box = $("#side-q"), typing = document.activeElement === box, from = box?.selectionStart, to = box?.selectionEnd;
    renderNow();
    if (typing) { const again = $("#side-q"); again?.focus(); again?.setSelectionRange(from, to); }
  }, 200);
}

/* The engine's projects (GET /api/projects), read when the fold is opened; the rows and a project's page are places/project.js. */
async function toggleProjects() {
  S.projOpen = !S.projOpen;
  if (S.projOpen && ownerHere()) await loadProjects().catch((error) => toast(error.message));
  renderNow();
}

/* A row is pinned when the engine keeps its Trunk or room pinned (POST /api/trunks/<id>, /api/trunks/rooms/<id>). */
const pinnedRow = (s) => !!(s.pinned || chatOwner(sessionId(s))?.pinned);

/* The rooms this person is in (GET /api/trunks rooms) that the conversation list does not already have: for a household
   person GET /api/sessions holds only their own conversations, so their rooms get a row from here. */
function roomRows() {
  const have = new Set(E.sessions.map(sessionId));
  return E.rooms.filter((r) => r.sessionId && !have.has(r.sessionId))
    .map((r) => ({ sessionId: r.sessionId, opening: r.name, lastMessage: r.latest ?? "", updatedAt: r.at, pinned: r.pinned }));
}

/* trunk-one-row: one row per Trunk (lineRow), one per room, and one per conversation the engine gives to no Trunk;
   Pinned first, then the rest, newest first. */
function list() {
  if (SQ.q.trim()) return `<nav class="list searching9" aria-label="${t("people.home.list")}">${searchHTML()}</nav>`;
  const entries = [
    ...E.trunks.map((trunk) => ({ at: lastAt(lineOf(trunk).at(-1)), pinned: linePinned(trunk), html: () => lineRow(trunk) })),
    ...[...groups().loose, ...roomRows()].map((s) => ({ at: lastAt(s), pinned: pinnedRow(s), html: () => row(s) })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  const pinned = entries.filter((e) => e.pinned), recent = entries.filter((e) => !e.pinned);
  const rows = (list) => list.map((e) => e.html()).join("");
  return `<nav class="list" aria-label="${t("people.home.list")}">
    ${hidden("projects") ? "" : `<button class="lh lh-btn" type="button" data-act="projtoggle" aria-expanded="${!!S.projOpen}" data-hide="projects">${ic(S.projOpen ? "down" : "chev", "s")}${t("memory.movein.kind.project")}</button>${S.projOpen ? projectRows() : ""}`}
    ${pinned.length ? `<div class="lh">${t("window.shell.shell.pinned")}</div>${rows(pinned)}` : ""}
    ${recent.length ? `<div class="lh${recentClass()}">${t("window.shell.shell.recent")}${markAllButton()}</div>${rows(recent)}` : ""}${olderConversationsHTML()}${putAwayEntries()}</nav>`;
}

function side() {
  const n = waitingCount(), live = liveNow();
  const person = personHere();
  const shut = S.placesShut && !railNow(), named = shut || railNow(); // the rail keeps the column of icons (prototype places14)
  return `${sceneryHTML()}${resizerHTML("side")}<div class="drag17" aria-hidden="true"></div>
    <button class="machine" type="button" data-act="machines" data-tip="${t("window.shell.shell.which-computer-youre-talking-to")}"><span class="mico">${ic("monitor", "s")}</span><span class="mach14"><b>${esc(machineName() || t("dashboard.computer.title"))}</b><i class="dot${link.up ? "" : " off"}"></i></span>${ic("chev", "s")}</button>
    <div class="side-top"><label class="sq9">${ic("search", "s")}<input id="side-q" type="search" placeholder="${t("action.search")}" value="${esc(SQ.q)}" autocomplete="off" aria-label="${t("window.shell.shell.search-chats-trunks-messages-and-past")}"${binding("palette") ? ` aria-keyshortcuts="${esc(ariaKeys(binding("palette")))}"` : ""}>${SQ.q ? `<button type="button" class="sq-x" data-act="sq-clear" aria-label="${t("window.shell.shell.clear-the-search")}">${ic("x", "s")}</button>` : binding("palette") ? `<kbd>${esc(spoken(binding("palette")))}</kbd>` : ""}</label><button class="icon-btn" type="button" aria-label="${t("window.shell.shell.new-conversation-trunk-room-or-automation")}" aria-expanded="false" data-act="newmenu">${ic("plus")}</button></div>
    <button class="lh lh-btn places-h14" type="button" data-act="places14" aria-expanded="${!S.placesShut}">${ic(S.placesShut ? "chev" : "down", "s")}${t("ew.places")}</button>
    <div class="side-nav nav7${shut ? " shut14" : ""}">${PLACES.map(([v, i, l]) => `<button class="nav" type="button" data-act="view" data-v="${v}" aria-current="${S.view === v}"${named ? ` aria-label="${esc(say(l))}" data-tip="${esc(say(l))}"` : ""}>${ic(i)}${say(l)}${v === "inbox" && n ? `<span class="cnt">${n}</span>` : ""}${v === "team" && live ? `<span class="live6" data-tip="${esc(t("window.shell.shell.count-running-now", { count: live }))}">${live}</span>` : ""}</button>`).join("")}</div>
    ${list()}
    <div class="owner-wrap pet18c"><div class="owner-row"><button class="owner" type="button" data-act="owner" aria-haspopup="menu" aria-expanded="false" data-tip="${t("window.shell.shell.who-is-using-branch-look-lock")}">${face(activeId())}<span class="who14"><b>${esc(person)}</b></span>${ic("chev", "s")}</button><button class="icon-btn" type="button" aria-label="${t("memory.movein.kind.setting")}" data-act="view" data-v="settings">${ic("gear")}</button></div>${petHTML("side")}</div>`;
}

function titleActions() {
  // Redesign: the owner removed the list's show/hide button; the list's edge (shell/resize.js) and Ctrl+B do it.
  const theme = document.documentElement.dataset.theme === "dark" ? "sun" : "moon";
  return `${hidden("notes") ? "" : `<button class="tb-btn" type="button" data-act="guide" aria-haspopup="menu" aria-expanded="false" data-hide="notes">${ic("bulb", "s")}${t("window.shell.shell.guide")}</button>`}
    ${homeButton()}${simpleButton()}<button class="tb-btn" type="button" aria-label="${t("window.shell.shell.switch-light-or-dark")}" data-act="theme-flip">${ic(theme, "s")}</button>`;
}

function status() {
  const version = E.state?.version ?? "";
  const model = modelLabel();
  /* At phone width the dots stay and the words go (pass 18, .sbt18c/.where18c), so the running count is never cut off. */
  return `<button class="sb" type="button" data-act="machines"><span class="dot ${link.up ? "" : "off"}"></span><span class="sbt18c">${link.up ? t("layout.connected") : t("window.shell.shell.not-connected")}</span><span class="where18c"> · ${esc(machineName() || t("window.shell.shell.this-computer"))}</span></button>
    ${hidden("gateway") ? "" : `<button class="sb" type="button" data-act="gwpop" data-hide="gateway" data-tip="${t("window.shell.shell.the-gateway-keeps-branch-running-in")}"><span class="dot${link.up && gatewayOn() ? "" : " off"}"></span><span class="sbt18c">${!link.up || gatewayOn() == null ? t("window.settings.gateway.gateway") : gatewayOn() ? t("window.shell.shell.gateway-on") : t("window.shell.shell.gateway-off")}</span></button>`}
    ${statusItems()}
    ${contextMeter(conversationWho().sessionId)}
    ${updateItem()}
    <button class="sb tasks10" type="button" data-act="tasks10" data-tip="${t("window.shell.shell.what-is-running-in-the-background")}"><i class="${working() ? "lit10" : ""}"></i>${working()} ${t("window.shell.shell.running")}</button>${pausedChip()}
    ${petHTML("status")}
    <span class="tb-grow"></span>
    ${model && !hidden("usage") ? `<button class="sb usage" type="button" data-act="usagepop" data-hide="usage" data-tip="${t("window.shell.shell.what-each-connection-has-left-5")}">${planMeter(model)}</button>` : ""}
    ${version ? `<button class="sb hide-sm" type="button" data-act="updmenu" data-tip="${t("window.shell.shell.version-and-updates")}">${esc(version)}</button>` : ""}`;
}

export const modelLabel = () => { const m = E.state?.activeModel; return m ? [m.presetName || m.model, m.reasoning].filter(Boolean).join(" · ") : ""; };

export function drawShell() {
  const app = document.getElementById("app");
  loadLook();
  if (!D.asked && E.loaded) loadDelight().then(() => renderNow());
  if (!K.asked && E.loaded) loadKeys().then(() => renderNow(), (error) => toast(error.message));
  if (!M.asked && E.loaded) loadMachineName().then(() => renderNow(), (error) => toast(error.message));
  readActivity();
  readGateway();
  app.classList.toggle("no-status", hidden("statusbar"));
  /* The desktop app's own minimise, maximise and close are drawn over the title row by the operating system
     (src/desktop/window-chrome-ipc.ts), so the page's own Minimize and Quit step aside there. */
  app.classList.toggle("desk-b6", isDesktop);
  $("#statusbar").dataset.hide = "statusbar";
  /* Chrome pass: a conversation's or a place's own buttons sit in the title-bar row at every width; the brand and the
     conversation's name are not drawn there. On a wide window that row floats over the main column (merged14) and the
     list and the view run to the window's top edge; on a narrow one it stays a row of its own (slim17). */
  /* Focus mode keeps a title row of its own, as the prototype's merged14() is false while S.focus. */
  /* Pass 18, one frame: Settings shares the same floating 52px title row, and its page list takes the list's place. */
  const place = PLACE_VIEWS.includes(S.view), inRow = S.view === "chat" || place, setting = S.view === "settings";
  const merged = WIDE.matches && (inRow || setting) && !app.classList.contains("focus");
  app.classList.toggle("set18c", merged && setting);
  app.dataset.surface = /Mac/.test(navigator.platform) ? "mac" : "desktop";
  app.classList.toggle("mac", app.dataset.surface === "mac");
  app.classList.toggle("places-shut14", S.placesShut);
  app.classList.toggle("merged14", merged);
  const header = app.querySelector(".titlebar");
  header.classList.toggle("merged14", merged);
  header.classList.toggle("slim17", inRow && !merged);
  header.style.setProperty("--side-w", getComputedStyle($("#body")).getPropertyValue("--side-w") || "292px");
  const slot = header.querySelector(".tb-head14") ?? header.querySelector(".tb-grow").insertAdjacentElement("afterend", Object.assign(document.createElement("div"), { className: "tb-head14" }));
  /* Each region is drawn again only when its markup changed (core/dom.js paintChanged). */
  const drew = [[slot, !inRow ? "" : place ? placeHead() : chatHead()], [$("#tbActions"), titleActions()], [$("#side"), side()], [$("#statusbar"), status()]]
    .filter(([region, html]) => paintChanged(region, html)).map(([region]) => region);
  for (const region of new Set(drew.map((region) => (header.contains(region) ? header : region)))) greyOut(region);
  // shell-013 (batch A): the title row carries the conversation header's Trunk-coloured line (chat/chat.js head --tint).
  header.style.setProperty("--tint14", (merged && slot.querySelector(".head")?.style.getPropertyValue("--tint")) || "transparent");
  if (drew.includes($("#side"))) stillOutOfSight($("#side .list"));
  drawBackground();
  paintScenery();
  drawPet();
}

export function initShell() {
  reserveControls();
  followControlsLook();
  addDockItem(() => petHTML("dock")); // the pet by the message box, when Appearance puts it there
  markLive(["sq-f", "sq-clear", "projtoggle", "sw:side-q"]);
  on("projtoggle", () => toggleProjects());
  on("sq-f", (el) => { SQ.f = el.dataset.v; renderNow(); });
  on("sq-clear", () => { SQ.q = ""; SQ.f = "all"; renderNow(); $("#side-q")?.focus(); });
  document.addEventListener("keydown", (e) => { if (e.target.id === "side-q" && e.key === "Escape") { SQ.q = ""; e.target.blur(); renderNow(); } });
  initExtras();
  initUsage();
  initCelebrate();
  initCheer();
  initNotify();
  initDash();
  initAutoUpdate();
  initUpdating(); // the update screen (shell/updating.js)
  initSearch();
  initSessionPages();
  initThemes();
  initPalette();
  initPerson();
  initUnread();
  initQuick();
  initResize();
  initWhatCan(); // flows/whatcan.js: the "What can Branch do" gallery (Overview, this Guide menu, an empty conversation)
  initPutAway();
  initHome();
  initSimple();
  markLive(["chat", "newconv", "newmenu", "places14", "themeset", "theme-flip", "guide", "focus", "new-with"]);
  on("conv-more", (el) => el.previousElementSibling?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: el.getBoundingClientRect().left, clientY: el.getBoundingClientRect().bottom })));
  // With no id (Settings' back button before any conversation is open) it just goes back to the conversation view.
  // area places: "new" is a new Trunk (flows/trunk.js).
  // trunk-one-row: a Trunk's row (or its menu's Open) goes to the Trunk's newest conversation, where the box sends.
  on("chat", (el) => { closePop(); if (el.dataset.id === "new") return run("new-trunk", el); const line = el.dataset.line && E.trunks.find((x) => x.id === el.dataset.line); const id = (line && currentOf(line)) || el.dataset.id; if (id) openConversation(id); else { S.view = "chat"; renderNow(); } });
  on("newconv", () => { closePop(); startFresh(); });
  // New room and New group chat both open the room dialog, which makes the room (flows/trunk.js grp-new, POST /api/trunks/rooms).
  on("newmenu", (el) => openPop(el, mi("newconv", "chat", t("comfort.field.newConversation"), binding("newConversation") ? `<kbd>${esc(spoken(binding("newConversation")))}</kbd>` : "") + mi("new-trunk", "plus", t("studio.newName")) + mi("grp-new", "room", t("window.shell.shell.new-room")) + mi("ptab", "clock", t("window.shell.shell.new-automation"), "", 'data-place="automations" data-v="scheduled"') + mi("ptab", "star", t("window.shell.shell.trunk-from-job"), "", 'data-place="customize" data-v="trunks"') + mi("grp-new", "users", t("window.shell.shell.new-group-chat"), t("window.shell.shell.people-trunks-agents")) + mi("mk-new", "spark", t("window.chat.mktrunk.title")) + quickItem()));
  on("places14", () => { S.placesShut = !S.placesShut; save(); renderNow(); });
  on("themeset", (el) => setTheme(el.dataset.v === "system" ? null : el.dataset.v));
  on("theme-flip", () => setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"));
  /* setup-resume: Onboarding picks setup up where it was left (flows/setup.js), with the engine's count of steps done; the
     last row is the "Show tips and pop-ups" switch (flows/guides.js). */
  on("guide", (el) => openPop(el, mi("whatsnew13", "star", t("window.settings.updates.whats-new"), t("window.shell.shell.this-version")) + `<div class="ph">${t("window.shell.shell.new-here")}</div>` + mi("onboard", "spark", t("window.setup.label"), t("window.shell.shell.3-min")) + mi("tour", "help", t("window.shell.shell.take-the-walkthrough"), t("window.shell.shell.2-min")) + mi("whatcan", "spark", t("window.what.title")) + mi("onboard-resume", "list15", t("window.shell.shell.onboarding"), esc(onboardingHint())) + popupsRow()));
  on("focus", () => toggleFocus());
  on("new-with", (el) => newWith(el.dataset.id));
  document.addEventListener("input", (e) => { if (e.target.id === "side-q") { if (!SQ.q.trim()) SQ.f = "all"; SQ.q = e.target.value; searchInside(SQ.q); const pos = e.target.selectionStart; renderNow(); const box = $("#side-q"); box?.focus(); box?.setSelectionRange(pos, pos); } });
  document.addEventListener("keydown", (e) => {
    if (pressed(e, "newConversation")) { e.preventDefault(); startFresh(); }
    if (pressed(e, "sideList")) { e.preventDefault(); toggleSide(); }
  });
  document.addEventListener("contextmenu", (e) => rowMenu(e) || hideMenu(e));
  document.addEventListener("keydown", rowArrows);
  WIDE.addEventListener("change", () => renderNow());
  measureTitleRow();
}

/* The floating title row's height, measured whenever it changes (a theme, a font or text size, the row's own buttons),
   so every bar and note at the top of a view starts below it (app.css, --tb-h). */
function measureTitleRow() {
  const app = document.getElementById("app"), header = app?.querySelector(".titlebar");
  if (!header) return;
  new ResizeObserver(() => app.style.setProperty("--tb-h", `${Math.ceil(header.getBoundingClientRect().height)}px`)).observe(header);
}

/* Up and Down move between the list's rows (Pinned, then Recent), as the old Trunks list did. */
function rowArrows(e) {
  if ((e.key !== "ArrowDown" && e.key !== "ArrowUp") || !e.target.matches?.("#side .row[data-id]")) return;
  const rows = [...document.querySelectorAll("#side .row[data-id]")];
  const next = rows[rows.indexOf(e.target) + (e.key === "ArrowDown" ? 1 : -1)];
  if (!next) return;
  e.preventDefault();
  next.focus();
}

/* Focus mode: the list and the status bar step aside until it is left (the button, or Ctrl+. again). */
export function toggleFocus(on) { document.getElementById("app").classList.toggle("focus", on); renderNow(); }

/* A row's own menu (right-click, the row's "…", or the keyboard's menu key), 1:1 with the prototype's: a conversation a
   Trunk answers offers a new one with it. Pin to top, Rename, Archive and Delete are chat/putaway.js: a Trunk's or a
   room's own conversation is pinned and renamed through its Trunk or room, any other through the engine's own marks. */
function rowMenu(e) {
  const row = e.target.closest?.("#side .row[data-id]");
  if (!row) return false;
  e.preventDefault();
  /* trunk-one-row: a Trunk's row is the Trunk: its pin, and one conversation's Rename, Archive and Delete are on that
     conversation's line in the timeline (chat/trunkline.js). */
  const line = row.dataset.line ? E.trunks.find((x) => x.id === row.dataset.line) : null;
  const id = esc(row.dataset.id), s = E.sessions.find((x) => sessionId(x) === row.dataset.id), tr = line ?? (s && trunkFor(s));
  const pin = line ? mi("tl-pin", "pin", linePinned(line) ? t("accounts.action.unpin") : t("window.shell.extras.pin-to-top"), "", `data-id="${esc(line.id)}"`)
    + mi("rename-id", "edit", t("accounts.action.rename"), "", `data-id="${esc(line.chatSessionId)}"`) : convItems(row.dataset.id);
  const pane = row.dataset.id !== S.chat ? mi("pane-add", "cols15", t("window.panes.open-in-pane"), "", `data-id="${id}"`) : ""; // RES-703
  const base = mi("chat", "chat", t("ov.open"), "", `data-id="${id}"${line ? ` data-line="${esc(line.id)}"` : ""}`) + pane + unreadItem(row.dataset.id) + pin;
  const tid = esc(tr?.id ?? "");
  const trunk = tr ? mi("new-with", "plus", t("window.shell.shell.new-conversation-with-name", { name: esc(tr.name) }), "", `data-id="${tid}"`) + roomItems(tr.id) + mi("pausetrunk", "pause", tr.paused ? t("autonomy.resume") : t("autonomy.pause"), "", `data-id="${tid}"`) + mi("edit", "sliders", t("window.shell.shell.edit-trunk"), "", `data-id="${tid}"`) + "<hr>" + mi("remove", "trash", t("strip.menu.remove"), "", `data-id="${tid}"`) : "";
  /* A room's own row ends with the prototype's "Leave and archive", greyed: the engine keeps no leaving or archiving of
     a room, only removing it for everyone (POST /api/trunks/rooms/<id>/remove). */
  const room = !tr && E.rooms.some((r) => r.sessionId === row.dataset.id) ? "<hr>" + mi("room-leave", "trash", t("window.shell.shell.leave-and-archive"), "", `data-id="${id}"`) : "";
  openPop(row, base + trunk + room, { force: true, label: tr?.name });
  return true;
}
/* A new conversation answered by that Trunk (POST /api/trunks/conversations). */
async function newWith(trunkId) {
  closePop();
  try {
    const made = await api("trunks/conversations", { trunkId });
    await refresh();
    await openConversation(made.sessionId);
  } catch (error) { toast(error.message); }
}

/* Right-clicking a part of the window offers to hide it, as the prototype always does and Settings › Appearance › What's
   shown says ("Right-click it anywhere to hide it too"); hiding is kept in the engine's preferences.hidden. */
function hideMenu(e) {
  const part = e.target.closest?.("[data-hide]");
  if (!part) return;
  e.preventDefault();
  openPop(part, mi("hide", "eye", t("onscreen.hideThis"), "", `data-v="${esc(part.dataset.hide)}"`) + mi("setgo", "sliders", t("window.shell.shell.choose-whats-shown"), "", 'data-v="appearance"'), { force: true });
}
async function hidePart(v) {
  closePop();
  const now = E.state?.preferences?.hidden ?? [];
  if (!now.includes(v)) await savePrefs({ hidden: [...now, v] });
  await refresh().catch((error) => toast(error.message));
  toast(t("window.shell.shell.hidden-bring-it-back-in-settings"));
}

/* ---------- the person menu ---------- */
/* your-profile: each tile is the person's own face and name (core/faces.js); your own opens Your profile (flows/profile.js),
   anybody else's switches to them through the PIN-guarded switch (flows/people.js). */
function people() {
  const all = [null, ...(E.profiles?.profiles ?? []).map((p) => p.id)];
  return all.map((id) => { const you = activeId() === id; return `<button type="button" data-act="${you ? "yp-open" : "switchto"}" data-v="${esc(id ?? "")}"${you ? ` data-tip="${t("window.profile.title")}"` : ""} data-css="display:grid;justify-items:center;gap:3px;font-size:11.5px;padding:4px;border-radius:10px;${you ? "background:var(--fill-2)" : ""}">${face(id)}${esc(nameOf(id))}</button>`; }).join("");
}
/* QA Q001: somebody else uses this computer and the owner has no PIN, so anyone here can switch back to them. Said once,
   here where switching happens, with the way to set one (flows/people.js), until a PIN is set or "Not now". */
function pinNotice() {
  if (!pinNoticeDue()) return "";
  return `<div class="pin-notice" data-css="padding:0 10px 8px;max-width:300px"><p class="hint" data-css="margin:0 0 6px">${t("household.pinNotice")}</p><div class="acts"><button class="btn pri sm" type="button" data-act="owner-pin-ask">${t("household.setPin")}</button><button class="btn ghost sm" type="button" data-act="owner-pin-later">${t("glance.notNow")}</button></div></div>`;
}
/* "Update to <version>" shows only while the desktop's updater has a newer version waiting (flows/whatsnew.js waiting);
   it opens Settings › Updates & about (settings/settings.js updmenu-go). */
function ownerMenu(next) {
  const current = document.documentElement.dataset.theme || "system", earned = D.earned;
  return `<div class="ph">${t("strip.who")}</div><div data-css="display:flex;gap:8px;padding:4px 10px 8px;flex-wrap:wrap">${people()}${ownerHere() ? `<button type="button" data-act="invite" data-css="display:grid;justify-items:center;gap:3px;font-size:11.5px;padding:4px"><span class="me" data-css="background:var(--fill);color:var(--ink-2)">+</span>${t("asks.runtimes.add")}</button>` : ""}</div>${pinNotice()}<hr>
    <div class="row-in"><span>${t("window.shell.look")}</span><span class="seg">${[["light", t("look.mode.light")], ["dark", t("look.mode.dark")], ["system", t("look.season.auto")]].map(([v, l]) => `<button type="button" data-act="themeset" data-v="${v}" aria-pressed="${current === v}">${l}</button>`).join("")}</span></div><hr>
    ${mi("view", "gear", t("memory.movein.kind.setting"), binding("appearance") ? `<kbd>${esc(spoken(binding("appearance")))}</kbd>` : "", 'data-v="settings"')}${mi("setgo", "medal", t("delight.ach.title"), earned == null ? "" : esc(String(earned)), 'data-v="achievements"')}${mi("shortcuts", "keyboard", t("comfort.keys.title"), "<kbd>?</kbd>")}${mi("help", "bulb", t("window.shell.shell.guide-why-each-thing-is-here"))}${next ? mi("updmenu-go", "spark", esc(t("window.shell.shell.update-to", { version: next.version })), '<span class="dot" data-css="background:var(--accent)"></span>') : ""}${mi("firstrun", "spark", t("window.shell.shell.replay-the-first-run"))}${mi("about", "info", t("window.shell.shell.about-branch"))}<hr>${mi("lockscreen", "lock", t("window.shell.shell.lock-branch"))}`;
}
/* About Branch: the engine's version, and which kind of computer this is, from the browser. */
function about() {
  closePop();
  const os = /Mac/.test(navigator.platform) ? "Mac" : /Win/.test(navigator.platform) ? "Windows" : "";
  openDlg({ title: t("window.shell.shell.about-branch"), body: `<div data-css="display:flex;gap:16px;align-items:center"><span class="mark mark-full" data-css="width:84px;height:84px" aria-hidden="true"></span><div><b>Branch Agent ${esc(E.state?.version ?? "")}</b><p class="hint" data-css="margin:2px 0 0">${t("window.shell.shell.by-keepoak-value", { value: os ? " · " + os : "" })}</p></div></div>` });
}
function initPerson() {
  markLive(["owner", "help", "about", "hide", "pat", "updmenu-go"]);
  initPeople();
  initProfile();
  on("pat", () => pat());
  document.addEventListener("keydown", (e) => { if (e.target.id === "pet-cv" && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); pat(); } });
  on("owner", async (el) => openPop(el, ownerMenu(await waiting().catch((error) => { toast(error.message); return null; }))));
  on("help", () => { closePop(); run("tour"); });
  on("about", () => about());
  // The desktop menu bar's Help: "What can Branch do" and "About Branch" open here (src/desktop/app-menu.ts).
  window.branchDesktop?.onHelp?.((item) => run(item));
  on("hide", (el) => hidePart(el.dataset.v));
}

/* The look applies at once and is kept by the engine too (its words: daylight is light, forest is dark). */
function setTheme(value) {
  if (value) document.documentElement.dataset.theme = value; else delete document.documentElement.dataset.theme;
  S.theme = value;
  save();
  applyLook();
  savePrefs({ followSystem: !value, ...(value ? { appearance: value === "light" ? "daylight" : "forest" } : {}) }).then(() => renderNow());
  closePop();
  renderNow();
}

export { toast };
