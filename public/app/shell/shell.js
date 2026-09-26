/* The frame around every view: the title bar (merged with the conversation header on wide windows, design doc 3), the
   sidebar (machine, search, Places, the conversation list, the person) and the status bar. Real data only. */

import { $, esc, paint, renderNow } from "../core/dom.js";
import { S, E, refresh, save, activeId, personHere, ownerHere, ownName, chatFace, roleLabel, projectName } from "../core/state.js";
import { on, run } from "../core/actions.js";
import { ic, av, mi, openPop, closePop, openDlg, toast } from "../core/ui.js";
import { greyOut, markLive } from "../core/features.js";
import { head as chatHead, openConversation, startConversation } from "../chat/chat.js";
import { statusItems } from "../chat/messages.js";
import { initExtras } from "./extras.js";
import { initUsage } from "./usage.js";
import { initCelebrate } from "./celebrate.js";
import { initAutoUpdate } from "./autoupdate.js";
import { api, link } from "../core/api.js";
import { SQ, searchHTML, askEngine, initSearch } from "./search.js";
import { loadLook, applyLook, savePrefs } from "./look.js";
import { initThemes } from "./themes.js";
import { loadDelight, drawBackground, drawPet, petHTML, pat, D } from "./scene.js";
import { initPalette } from "./palette.js";
import { ACT, working, readActivity } from "./activity.js";
import { K, loadKeys, pressed, binding, spoken, ariaKeys } from "./keys.js";
import { M, machineName, loadMachineName } from "./machines.js";
import { chatOwner, pinChat, renameDlg } from "../flows/trunk.js";
import { unreadDot, recentClass, markAllButton, unreadItem, initUnread } from "../chat/unread.js"; // pass 17
import { initQuick, quickItem } from "../chat/quick.js";
import { init as initPeople } from "../flows/people.js"; // unhold/people: switching person, invites, roles
import { t, language } from "../../i18n.js";
import { say } from "../core/words.js";
import { resizerHTML, toggleSide, initResize, railNow } from "./resize.js";

const WIDE = matchMedia("(min-width: 761px)");
const PLACES = [["overview", "home", "Overview"], ["inbox", "inbox", "Inbox"], ["automations", "clock", "Automations"],
  ["library", "book", "Library"], ["team", "users", "Team"], ["customize", "sliders", "Customize"]];

/* A place's own header, the prototype's placeHead: on a narrow window the button that slides the list in, and Settings.
   It sits in the title-bar row at every width, as the conversation's header does (drawShell). */
export const PLACE_VIEWS = PLACES.map(([view]) => view);
export const placeHead = () => `<div class="head"><button class="icon-btn menu-only" type="button" aria-label="${t("window.shell.shell.show-conversations")}" data-act="side">${ic("menu")}</button><span class="tb-grow"></span><button class="icon-btn" type="button" aria-label="${t("memory.movein.kind.setting")}" data-act="view" data-v="settings">${ic("gear")}</button></div>`;
export const wide = () => WIDE.matches;

const sessionId = (s) => s.sessionId ?? s.id;
const hidden = (part) => (E.state?.preferences?.hidden ?? []).includes(part);
/* The Trunk that answers a conversation: its own chat, or the one the conversation names. */
const trunkFor = (s) => E.trunks.find((t) => t.id === s.trunkId || t.id === s.trunk?.id || (t.chatSessionId && t.chatSessionId === sessionId(s)));
const sessionTitle = (s) => s.title || s.opening || t("comfort.field.newConversation");
const when = (t) => {
  if (!t) return "";
  const d = new Date(t);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString(language(), { hour: "numeric", minute: "2-digit" }) : d.toLocaleDateString(language(), { weekday: "short" });
};

/* A helper's question (parentRunId) is answered in its task's Activity › Helpers, never counted here (FEATURES17C §4). */
function waitingCount() {
  const a = E.state?.attention;
  return (Array.isArray(a) ? a.filter((w) => !w.parentRunId).length : a?.count ?? 0) + (E.state?.trunkWaiting?.length ?? 0);
}

/* A conversation with a task still going (E.state.runs) reads Working in its row, as the conversation header does. */
const runningIn = (id) => (E.state?.runs ?? []).some((r) => r.sessionId === id && ["running", "queued"].includes(r.status));

/* The prototype's rowHtml names and draws a Trunk's or a room's own conversation by the Trunk or room (core/state.js). */

function row(s) {
  const id = sessionId(s);
  const trunk = trunkFor(s);
  const busy = runningIn(id);
  const waits = E.rooms.some((r) => r.sessionId === id && r.needsYou); // GET /api/trunks rooms[].needsYou: the prototype's p.attn
  return `<button class="row" type="button" data-act="chat" data-id="${esc(id)}" aria-current="${S.chat === id}"${busy ? ' data-running="true"' : ""}>
    <span class="avw">${av(trunk ?? chatFace(id), 40)}</span>
    <b><span class="ellip14">${esc(ownName(id) || sessionTitle(s))}</span>${trunk?.paused ? `<span class="paused">${t("autonomy.orders.paused")}</span>` : ""}</b><time>${esc(when(s.updatedAt ?? s.createdAt))}</time>
    ${busy ? `<p class="attn">${t("window.shell.working")}</p>` : `<p${waits ? ' class="attn"' : ""}>${esc(s.lastMessage ?? "")}</p>`}${unreadDot(s)}</button>`;
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

/* The engine's projects (GET /api/projects), read when the fold is opened. A project's own page is not in this window yet. */
let projects = [];
const projectRows = () => projects.map((pr) => `<button class="nav" type="button" data-act="project" data-v="${esc(pr.id)}" aria-current="${S.activeProject === pr.id}">${ic("folder", "s")}${esc(projectName(pr))}</button>`).join("");
async function toggleProjects() {
  S.projOpen = !S.projOpen;
  const got = S.projOpen ? await api("projects").catch(() => null) : null;
  projects = got?.all ?? projects;
  S.activeProject = got?.active?.id ?? S.activeProject; // chosen in chat/messages.js (POST /api/projects/active)
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

function list() {
  if (SQ.q.trim()) return `<nav class="list searching9" aria-label="${t("people.home.list")}">${searchHTML()}</nav>`;
  const rows = [...E.sessions, ...roomRows()];
  const pinned = rows.filter(pinnedRow);
  const recent = rows.filter((s) => !pinnedRow(s));
  return `<nav class="list" aria-label="${t("people.home.list")}">
    ${hidden("projects") ? "" : `<button class="lh lh-btn" type="button" data-act="projtoggle" aria-expanded="${!!S.projOpen}" data-hide="projects">${ic(S.projOpen ? "down" : "chev", "s")}${t("memory.movein.kind.project")}</button>${S.projOpen ? projectRows() : ""}`}
    ${pinned.length ? `<div class="lh">${t("window.shell.shell.pinned")}</div>${pinned.map(row).join("")}` : ""}
    ${recent.length ? `<div class="lh${recentClass()}">${t("window.shell.shell.recent")}${markAllButton()}</div>${recent.map(row).join("")}` : ""}</nav>`;
}

function side() {
  const n = waitingCount();
  const person = personHere();
  const shut = S.placesShut && !railNow(), named = shut || railNow(); // the rail keeps the column of icons (prototype places14)
  return `${resizerHTML("side")}<div class="drag17" aria-hidden="true"></div>
    <button class="machine" type="button" data-act="machines" data-tip="${t("window.shell.shell.which-computer-youre-talking-to")}"><span class="mico">${ic("monitor", "s")}</span><span class="mach14"><b>${esc(machineName() || t("dashboard.computer.title"))}</b><i class="dot"></i></span>${ic("chev", "s")}</button>
    <div class="side-top"><label class="sq9">${ic("search", "s")}<input id="side-q" type="search" placeholder="${t("action.search")}" value="${esc(SQ.q)}" autocomplete="off" aria-label="${t("window.shell.shell.search-chats-trunks-messages-and-past")}"${binding("palette") ? ` aria-keyshortcuts="${esc(ariaKeys(binding("palette")))}"` : ""}>${SQ.q ? `<button type="button" class="sq-x" data-act="sq-clear" aria-label="${t("window.shell.shell.clear-the-search")}">${ic("x", "s")}</button>` : binding("palette") ? `<kbd>${esc(spoken(binding("palette")))}</kbd>` : ""}</label><button class="icon-btn" type="button" aria-label="${t("window.shell.shell.new-conversation-trunk-room-or-automation")}" data-act="newmenu">${ic("plus")}</button></div>
    <button class="lh lh-btn places-h14" type="button" data-act="places14" aria-expanded="${!S.placesShut}">${ic(S.placesShut ? "chev" : "down", "s")}${t("ew.places")}</button>
    <div class="side-nav nav7${shut ? " shut14" : ""}">${PLACES.map(([v, i, l]) => `<button class="nav" type="button" data-act="view" data-v="${v}" aria-current="${S.view === v}"${named ? ` aria-label="${esc(say(l))}" data-tip="${esc(say(l))}"` : ""}>${ic(i)}${say(l)}${v === "inbox" && n ? `<span class="cnt">${n}</span>` : ""}</button>`).join("")}</div>
    ${list()}
    ${petHTML("side")}
    <div class="owner-wrap"><div class="owner-row"><button class="owner" type="button" data-act="owner" aria-haspopup="menu" data-tip="${t("window.shell.shell.who-is-using-branch-look-lock")}"><span class="me" aria-hidden="true">${esc(person.slice(0, 1).toUpperCase())}</span><span class="who14"><b>${esc(person)}</b></span>${ic("chev", "s")}</button><button class="icon-btn" type="button" aria-label="${t("memory.movein.kind.setting")}" data-act="view" data-v="settings">${ic("gear")}</button></div></div>`;
}

function titleActions() {
  // Redesign: the owner removed the list's show/hide button; the list's edge (shell/resize.js) and Ctrl+B do it.
  const theme = document.documentElement.dataset.theme === "dark" ? "sun" : "moon";
  return `${hidden("notes") ? "" : `<button class="tb-btn" type="button" data-act="guide" aria-haspopup="menu" data-hide="notes">${ic("bulb", "s")}${t("window.shell.shell.guide")}</button>`}
    <button class="tb-btn" type="button" aria-label="${t("window.shell.shell.switch-light-or-dark")}" data-act="theme-flip">${ic(theme, "s")}</button>`;
}

function status() {
  const version = E.state?.version ?? "";
  const model = modelLabel();
  return `<button class="sb" type="button" data-act="machines"><span class="dot ${link.up ? "" : "off"}"></span>${link.up ? t("layout.connected") : t("window.shell.shell.not-connected")} · ${esc(machineName() || t("window.shell.shell.this-computer"))}</button>
    ${hidden("gateway") ? "" : `<button class="sb" type="button" data-act="gwpop" data-hide="gateway" data-tip="${t("window.shell.shell.the-gateway-keeps-branch-running-in")}"><span class="dot off"></span>${t("window.settings.gateway.gateway")}</button>`}
    ${statusItems()}
    <button class="sb tasks10" type="button" data-act="tasks10" data-tip="${t("window.shell.shell.what-is-running-in-the-background")}"><i class="${working() ? "lit10" : ""}"></i>${working()} ${t("window.shell.shell.running")}</button>
    ${petHTML("status")}
    <span class="tb-grow"></span>
    ${model && !hidden("usage") ? `<button class="sb usage" type="button" data-act="usagepop" data-hide="usage" data-tip="${t("window.shell.shell.what-each-connection-has-left-5")}"><span class="hide-sm">${esc(model)}</span></button>` : ""}
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
  app.classList.toggle("no-status", hidden("statusbar"));
  $("#statusbar").dataset.hide = "statusbar";
  /* Chrome pass: a conversation's or a place's own buttons sit in the title-bar row at every width; the brand and the
     conversation's name are not drawn there. On a wide window that row floats over the main column (merged14) and the
     list and the view run to the window's top edge; on a narrow one it stays a row of its own (slim17). */
  const place = PLACE_VIEWS.includes(S.view), inRow = S.view === "chat" || place, merged = WIDE.matches && inRow;
  app.dataset.surface = /Mac/.test(navigator.platform) ? "mac" : "desktop";
  app.classList.toggle("mac", app.dataset.surface === "mac");
  app.classList.toggle("places-shut14", S.placesShut);
  app.classList.toggle("merged14", merged);
  const header = app.querySelector(".titlebar");
  header.classList.toggle("merged14", merged);
  header.classList.toggle("slim17", inRow && !merged);
  header.style.setProperty("--side-w", getComputedStyle($("#body")).getPropertyValue("--side-w") || "292px");
  const slot = header.querySelector(".tb-head14") ?? header.querySelector(".tb-grow").insertAdjacentElement("afterend", Object.assign(document.createElement("div"), { className: "tb-head14" }));
  paint(slot, !inRow ? "" : place ? placeHead() : chatHead());
  paint($("#tbActions"), titleActions());
  paint($("#side"), side());
  paint($("#statusbar"), status());
  for (const region of [header, $("#side"), $("#statusbar")]) greyOut(region);
  drawBackground();
  drawPet();
}

export function initShell() {
  markLive(["sq-f", "sq-clear", "projtoggle", "sw:side-q"]);
  on("projtoggle", () => toggleProjects());
  on("sq-f", (el) => { SQ.f = el.dataset.v; renderNow(); });
  on("sq-clear", () => { SQ.q = ""; SQ.f = "all"; renderNow(); $("#side-q")?.focus(); });
  document.addEventListener("keydown", (e) => { if (e.target.id === "side-q" && e.key === "Escape") { SQ.q = ""; e.target.blur(); renderNow(); } });
  initExtras();
  initUsage();
  initCelebrate();
  initAutoUpdate();
  initSearch();
  initThemes();
  initPalette();
  initPerson();
  initUnread();
  initQuick();
  initResize();
  markLive(["chat", "newconv", "newmenu", "places14", "themeset", "theme-flip", "guide", "focus", "new-with", "pin-id", "rename-id"]);
  // With no id (Settings' back button before any conversation is open) it just goes back to the conversation view.
  // area places: "new" is a new Trunk (flows/trunk.js).
  on("chat", (el) => { closePop(); if (el.dataset.id === "new") return run("new-trunk", el); if (el.dataset.id) openConversation(el.dataset.id); else { S.view = "chat"; renderNow(); } });
  on("newconv", () => { closePop(); startConversation(); });
  // New room and New group chat both open the room dialog, which makes the room (flows/trunk.js grp-new, POST /api/trunks/rooms).
  on("newmenu", (el) => openPop(el, mi("newconv", "chat", t("comfort.field.newConversation"), binding("newConversation") ? `<kbd>${esc(spoken(binding("newConversation")))}</kbd>` : "") + mi("new-trunk", "plus", t("studio.newName")) + mi("grp-new", "room", t("window.shell.shell.new-room")) + mi("ptab", "clock", t("window.shell.shell.new-automation"), "", 'data-place="automations" data-v="scheduled"') + mi("ptab", "star", t("window.shell.shell.trunk-from-job"), "", 'data-place="customize" data-v="trunks"') + mi("grp-new", "users", t("window.shell.shell.new-group-chat"), t("window.shell.shell.people-trunks-agents")) + mi("mk-new", "spark", t("window.chat.mktrunk.title")) + quickItem()));
  on("places14", () => { S.placesShut = !S.placesShut; save(); renderNow(); });
  on("themeset", (el) => setTheme(el.dataset.v === "system" ? null : el.dataset.v));
  on("theme-flip", () => setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"));
  on("guide", (el) => openPop(el, mi("whatsnew13", "star", t("window.settings.updates.whats-new"), t("window.shell.shell.this-version")) + `<div class="ph">${t("window.shell.shell.new-here")}</div>` + mi("onboard", "spark", t("window.setup.label"), t("window.shell.shell.3-min")) + mi("tour", "help", t("window.shell.shell.take-the-walkthrough"), t("window.shell.shell.2-min"))));
  on("focus", () => toggleFocus());
  on("new-with", (el) => newWith(el.dataset.id));
  document.addEventListener("input", (e) => { if (e.target.id === "side-q") { if (!SQ.q.trim()) SQ.f = "all"; SQ.q = e.target.value; searchInside(SQ.q); const pos = e.target.selectionStart; renderNow(); const box = $("#side-q"); box?.focus(); box?.setSelectionRange(pos, pos); } });
  on("pin-id", (el) => pinChat(el.dataset.id));
  on("rename-id", (el) => renameDlg(el.dataset.id));
  document.addEventListener("keydown", (e) => {
    const mod = e.ctrlKey || e.metaKey, key = e.key.toLowerCase();
    if (pressed(e, "newConversation")) { e.preventDefault(); startConversation(); }
    if (pressed(e, "sideList")) { e.preventDefault(); toggleSide(); }
    if (mod && key === ".") { e.preventDefault(); toggleFocus(); }
  });
  document.addEventListener("contextmenu", (e) => rowMenu(e) || hideMenu(e));
  document.addEventListener("keydown", rowArrows);
  WIDE.addEventListener("change", () => renderNow());
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
function toggleFocus() { document.getElementById("app").classList.toggle("focus"); }

/* A row's own menu (right-click), 1:1 with the prototype's: a conversation a Trunk answers offers a new one with it.
   Pin and Rename change the Trunk or room whose own conversation the row is (flows/trunk.js); the engine keeps no pin
   or name for any other conversation, so there they stay greyed. */
function rowMenu(e) {
  const row = e.target.closest?.("#side .row[data-id]");
  if (!row) return false;
  e.preventDefault();
  const id = esc(row.dataset.id), s = E.sessions.find((x) => sessionId(x) === row.dataset.id), tr = s && trunkFor(s), own = chatOwner(row.dataset.id);
  const base = mi("chat", "chat", t("ov.open"), "", `data-id="${id}"`) + unreadItem(row.dataset.id) + mi(own ? "pin-id" : "pin-id-off", "pin", own?.pinned ? t("accounts.action.unpin") : t("window.shell.extras.pin-to-top"), "", `data-id="${id}"`) + mi(own ? "rename-id" : "rename-id-off", "edit", t("accounts.action.rename"), "", `data-id="${id}"`);
  const tid = esc(tr?.id ?? "");
  const trunk = tr ? mi("new-with", "plus", t("window.shell.shell.new-conversation-with-name", { name: esc(tr.name) }), "", `data-id="${tid}"`) + mi("pausetrunk", "pause", tr.paused ? t("autonomy.resume") : t("autonomy.pause"), "", `data-id="${tid}"`) + mi("edit", "sliders", t("window.shell.shell.edit-trunk"), "", `data-id="${tid}"`) + "<hr>" + mi("remove", "trash", t("strip.menu.remove"), "", `data-id="${tid}"`) : "";
  openPop(row, base + trunk, { force: true, label: tr?.name });
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

/* Right-clicking a part of the window offers to hide it, when the engine's "right-click to hide" switch is on. */
function hideMenu(e) {
  const part = e.target.closest?.("[data-hide]");
  if (!part || !E.state?.preferences?.rightClickHide) return;
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
function people() {
  const owner = roleLabel("owner");
  const all = [[null, owner], ...(E.profiles?.profiles ?? []).map((p) => [p.id, p.name])];
  return all.map(([id, name]) => `<button type="button" data-act="switchto" data-v="${esc(id ?? "")}" data-css="display:grid;justify-items:center;gap:3px;font-size:11.5px;padding:4px;border-radius:10px;${activeId() === id ? "background:var(--fill-2)" : ""}"><span class="me">${esc(String(name ?? "").slice(0, 1).toUpperCase())}</span>${esc(name)}</button>`).join("");
}
function ownerMenu() {
  const current = document.documentElement.dataset.theme || "system", earned = D.earned;
  return `<div class="ph">${t("strip.who")}</div><div data-css="display:flex;gap:8px;padding:4px 10px 8px;flex-wrap:wrap">${people()}${ownerHere() ? `<button type="button" data-act="invite" data-css="display:grid;justify-items:center;gap:3px;font-size:11.5px;padding:4px"><span class="me" data-css="background:var(--fill);color:var(--ink-2)">+</span>${t("asks.runtimes.add")}</button>` : ""}</div><hr>
    <div class="row-in"><span>${t("window.shell.look")}</span><span class="seg">${[["light", t("look.mode.light")], ["dark", t("look.mode.dark")], ["system", t("look.season.auto")]].map(([v, l]) => `<button type="button" data-act="themeset" data-v="${v}" aria-pressed="${current === v}">${l}</button>`).join("")}</span></div><hr>
    ${mi("view", "gear", t("memory.movein.kind.setting"), binding("appearance") ? `<kbd>${esc(spoken(binding("appearance")))}</kbd>` : "", 'data-v="settings"')}${mi("setgo", "medal", t("delight.ach.title"), earned == null ? "" : esc(String(earned)), 'data-v="achievements"')}${mi("shortcuts", "keyboard", t("comfort.keys.title"), "<kbd>?</kbd>")}${mi("help", "bulb", t("window.shell.shell.guide-why-each-thing-is-here"))}${mi("firstrun", "spark", t("window.shell.shell.replay-the-first-run"))}${mi("about", "info", t("window.shell.shell.about-branch"))}<hr>${mi("lockscreen", "lock", t("window.shell.shell.lock-branch"))}`;
}
/* About Branch: the engine's version, and which kind of computer this is, from the browser. */
function about() {
  closePop();
  const os = /Mac/.test(navigator.platform) ? "Mac" : /Win/.test(navigator.platform) ? "Windows" : "";
  openDlg({ title: t("window.shell.shell.about-branch"), body: `<div data-css="display:flex;gap:16px;align-items:center"><span class="mark mark-full" data-css="width:84px;height:84px" aria-hidden="true"></span><div><b>Branch Agent ${esc(E.state?.version ?? "")}</b><p class="hint" data-css="margin:2px 0 0">${t("window.shell.shell.by-keepoak-value", { value: os ? " · " + os : "" })}</p></div></div>` });
}
function initPerson() {
  markLive(["owner", "help", "about", "hide", "pat"]);
  initPeople();
  on("pat", () => pat());
  document.addEventListener("keydown", (e) => { if (e.target.id === "pet-cv" && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); pat(); } });
  on("owner", (el) => openPop(el, ownerMenu()));
  on("help", () => { closePop(); run("tour"); });
  on("about", () => about());
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
