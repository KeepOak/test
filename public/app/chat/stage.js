/* The full-size view of the computer or browser a conversation's task works in (design doc A.5, the prototype's stageHTML
   and renderStage7), with only what the engine really has:
   - the browser is live while a task works in it: a frame of the tab the task works in, its address, its tabs and what
     the task is doing now, read about twice a second (stage-live.js, GET /api/panels/live). After the task ends the
     engine's last frame is shown, and with none the newest picture a task took (GET /api/panels/work `browser.picture`).
   - the computer is the newest picture the conversation's own desktop.screenshot results kept; each picture's bytes come
     from GET /api/artifacts/file. Pictures are not a stream, so its chip says "Now", never "Live".
   - with nothing to show, one themed line sized to its words (never a blank page).
   - the steps are the task's plan (GET /api/runs/<id>/plan); showing the screen at an earlier step needs recorded frames
     per step, which the engine does not keep, so those chips stay greyed.
   - Stop is POST /api/runs/<id>/cancel. The dock's box steers a working task (POST /api/runs/<id>/steer) or, with none
     working, sends the conversation a message.
   - Take over and Hand back are the engine's only take-over: the shared Linux desktop Branch drives (GET /api/linux-desktop,
     POST /api/linux-desktop/take-over and /hand-back, each the owner's alone), drawn on the computer view. Branch's own
     browser has no hand-over and no task can be paused (the engine has neither), so the browser view's Take over and
     every Pause are drawn greyed.
   Which view is open, picture in picture and the docked conversation (and its width) are window state only.
   Parity B2 (pane-stage-006, -013): the view is named for whoever the conversation is (its Trunk, "The room", or the
   assistant), with that face and role line in the dock and the computer it uses on the small window's bar; the dock's
   foot says what This computer lets it reach, with "Change what it may use" (Settings › Computer). A conversation that
   may use two or more computers (flows/computers17.js) gets a tab per computer, which picks that computer for it
   (POST /api/devices/pick), and All screens, every one of them side by side. Only This computer's own screen is ever
   drawn: the engine keeps no picture of another computer's, so its tab and cell show the empty line.
   Parity B2, as the owner asked: This computer's screen is live while the owner has the computer view open on it
   (stage-screen.js, GET /api/panels/screen: a frame taken as it is asked for, about once a second, and nothing while the
   view is closed, hidden or locked; the engine's words stand in its place when it refuses). And the browser view has an
   address field: what the owner types opens in Branch's own browser for this conversation, through the engine's gate
   for a tool pressed by hand (POST /api/panels/browse; a question it asks is put to the owner with "Allow once"), and
   the live view shows it. The field is drawn only for the owner and stays disabled while a task works here, so the
   owner never steers the task's own tab. Taking over the screen stays greyed: this is viewing only. */

import { $, esc, applyCss, onRender, render } from "../core/dom.js";
import { ic, av, toast, app, closePop, openDlg, closeDlg } from "../core/ui.js";
import { S, E, refresh, trunkIntro, ownName, chatFace } from "../core/state.js";
import { api, token } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive, greyOut } from "../core/features.js";
import { work, loadWork } from "./terminal.js";
import { t } from "../../i18n.js";
import { pickChip, computersOf, computerNamed, pickFor } from "../flows/computers17.js"; // pass 17 part D §9: the conversation's computer menu
import { liveOf, watchLive } from "./stage-live.js";
import { watchScreen, screenFrame, screenRefusal } from "./stage-screen.js";
import { resizerHTML } from "../shell/resize.js"; // the dock's edge: shell/resize.js drags it and keeps its width
import { startWith, openConversation } from "./chat.js";

const G = { kind: null, pip: null, dock: true, grid: false, browsed: null, asked: null, sid: null, messages: [], plan: null, at: 0, desk: null, said: "", drawn: {} };
const SHOT = new Map(); // picture path → its bytes as a blob: address ("" while loading or after the engine refused it)
const STOPPABLE = new Set(["running", "needs_input", "interrupted"]);

/* Whoever the conversation is: its Trunk, its room, or the assistant (Branch's own); the words the view is named with. */
const name = () => ownName(S.chat) || E.state?.identity?.name || "";
const isRoom = () => chatFace(S.chat).kind === "room";
const owner = () => (isRoom() ? t("window.chat.stage.the-room") : name());
function role() {
  const face = chatFace(S.chat);
  return face.kind === "room" ? t("window.settings.advanced.room") : face.kind === "main" ? t("window.chat.plus.assistant") : face.title ?? "";
}
/* The computers the conversation may use and the one it uses, once the engine has said (null before, or for anyone but
   the owner); This computer's own screen is the only one the engine keeps pictures of. */
const comps = () => computersOf(S.chat);
const onThis = () => { const st = comps(); return !st || st.using === "this"; };
const runsHere = () => (E.state?.runs ?? []).filter((r) => S.chat && r.sessionId === S.chat)
  .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
const live = () => liveOf(S.chat);
/** The conversation's task that is still going: the engine's live answer first, then the window's list of tasks. */
function goingRun() {
  const now = live();
  if (now?.runId) return { id: now.runId, status: now.status };
  const run = runsHere()[0];
  return run && STOPPABLE.has(run.status) ? run : null;
}
const working = () => goingRun()?.status === "running";

function parsed(text) {
  try { return JSON.parse(text); } catch { return null; } // a result that is not JSON names no picture
}

/* The newest picture a desktop.screenshot call in this conversation kept ({ok, result: {path}} in its tool message). */
function desktopPicture() {
  const calls = new Set(G.messages.flatMap((m) => m.toolCalls ?? []).filter((c) => c.name === "desktop.screenshot").map((c) => c.id));
  const found = G.messages.filter((m) => m.role === "tool" && calls.has(m.toolCallId)).map((m) => parsed(m.content)?.result?.path).filter(Boolean);
  return found.at(-1) ?? "";
}
const picturePath = (kind) => (kind === "browser" ? work(G.sid)?.browser?.picture ?? "" : onThis() ? desktopPicture() : "");
/* The page the picture was taken on: the address of the last browser.screenshot step, which took that picture. */
const pageUrl = () => work(G.sid)?.browser?.entries?.filter((e) => e.tool === "browser.screenshot" && /^https?:\/\//.test(e.what)).at(-1)?.what ?? "";

/* The picture's bytes through the artifacts route, signed like every other request. Each picture is kept under its own
   path, so one view never shows the other's picture; a picture neither view names any more is let go. */
async function fetchShot(path) {
  SHOT.set(path, "");
  try {
    const headers = token.get() ? { authorization: "Bearer " + token.get() } : {};
    const response = await fetch("/api/artifacts/file?path=" + encodeURIComponent(path), { cache: "no-store", headers });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || String(response.status));
    const url = URL.createObjectURL(await response.blob());
    if (SHOT.has(path)) SHOT.set(path, url); else URL.revokeObjectURL(url);
  } catch (error) {
    toast(error.message);
  }
  drawStage();
}
function shotUrl(path) {
  if (!path) return "";
  const wanted = new Set([picturePath("browser"), desktopPicture()]); // This computer's is kept for All screens too
  for (const [kept, url] of SHOT) if (!wanted.has(kept)) { if (url) URL.revokeObjectURL(url); SHOT.delete(kept); }
  if (!SHOT.has(path)) fetchShot(path);
  return SHOT.get(path) ?? "";
}

/* Branch's browser as the engine last saw it: its tabs, its address and the frame (painted in by paintFrames, so a new
   frame never redraws the view). */
function liveWindow(view, src = "") {
  const tabs = view.tabs.map((tab) => `<span class="${tab.active ? "on7" : ""}">${esc(tab.title || tab.url)}</span>`).join("");
  const bar = view.url ? `<div class="dk-url">${ic("lock", "s")}${esc(view.url)}</div>` : "";
  return `<div class="desk7 brfull7 live7"><div class="dk-win br7"><div class="dk-tabs">${tabs}</div>${bar}<img class="shot7 live7-img"${src ? ` src="${esc(src)}"` : ""} alt="${esc(view.title)}"></div></div>`;
}
/* The screen: the live frame, else the picture as it was taken; "" when there is nothing to show. */
/* This computer's live screen, the frame painted in by paintFrames (a new frame never redraws the view). */
const liveScreen = () => `<div class="desk7"><img class="shot7 livescr-img" alt="${esc(t("dashboard.computer.title"))}"></div>`;
function screen(kind) {
  const view = kind === "browser" ? live()?.browser : null;
  if (view?.frame) return liveWindow(view);
  if (kind === "computer" && onThis() && screenFrame()) return liveScreen();
  const url = shotUrl(picturePath(kind));
  if (!url) return "";
  if (kind === "computer") return `<div class="desk7"><img class="shot7" src="${esc(url)}" alt="${esc(owner())}"></div>`;
  const address = pageUrl();
  const bar = address ? `<div class="dk-url">${ic("lock", "s")}${esc(address)}</div>` : "";
  return `<div class="desk7 brfull7 live7"><div class="dk-win br7">${bar}<img class="shot7" src="${esc(url)}" alt="${esc(address)}"></div></div>`;
}

/* Nothing to show: the prototype's own words, sized to them, in the window's colours; "hasn't opened a page" only while
   no task of this conversation has opened one. */
function emptyHTML(kind, small) {
  const opened = (work(S.chat)?.browser?.entries ?? []).length > 0;
  // This computer's screen refused by the engine (its switch, a password window, Lockdown): the engine's own words.
  const refused = kind === "computer" && onThis() && screenRefusal() ? `<small>${esc(screenRefusal())}</small>` : "";
  const line = refused || (kind === "browser" && !opened ? `<small>${t("window.chat.stage.no-page", { name: esc(name()) })}</small>` : "");
  return `<div class="st7-empty${small ? " mini7" : ""}" role="status">${ic(kind === "browser" ? "globe" : "monitor")}<b>${t("window.chat.stage.nothing-open")}</b>${line}</div>`;
}

/* Who holds the shared Linux desktop, as the engine last said: "agent", "user" or "none". */
const holder = () => (G.desk?.running ? G.desk.control : "none");

function controls(kind) {
  const run = goingRun(), yours = holder() === "user";
  if (yours) return `<button class="btn pri sm" type="button" data-act="handback">${t("window.chat.stage.hand-back-to", { name: esc(owner()) })}</button>`;
  const take = kind === "computer" ? (holder() === "agent" ? `<button class="btn pri sm" type="button" data-act="takeover">${t("action.take-over")}</button>` : "")
    : run?.status === "running" ? `<button class="btn pri sm" type="button" data-act="stage-take-browser">${t("action.take-over")}</button>` : "";
  const pause = run?.status === "running" ? `<button class="btn sm" type="button" data-act="stage-pause">${t("goal.action.pause")}</button>` : "";
  const stop = run && STOPPABLE.has(run.status) ? `<button class="btn ghost sm" type="button" data-act="stage-stop" data-id="${esc(run.id)}">${t("dashboard.stop")}</button>` : "";
  return take + pause + stop;
}

function top(kind, steps) {
  const now = steps.findIndex((s) => s.status === "working"), yours = holder() === "user";
  const title = kind === "browser" ? t("window.chat.stage.browser-of", { name: esc(owner()) }) : t("window.chat.stage.computer-of", { name: esc(owner()) });
  const own = kind === "browser" && live()?.browser?.frame ? `<span class="st7-sub">${ic("lock", "s")}${t("window.chat.stage.own-browser")}</span>` : "";
  const field = kind === "browser" ? addressField() : "";
  // A task waiting on a yes says so; the question itself is answered in the conversation, one click back.
  const pill = yours ? `<span class="pill you"><i></i>${t("window.chat.stage.you-control")}</span>`
    : goingRun()?.status === "needs_input" ? `<span class="pill warn"><i></i>${t("strip.status.wait")}</span>`
    : working() ? `<span class="pill work"><i></i>${t("strip.status.working")}${now >= 0 ? ` · ${t("window.chat.stage.step-of", { n: now + 1, total: steps.length })}` : ""}</span>` : `<span class="pill idle"><i></i>${t("window.chat.stage.idle")}</span>`;
  const sw = [["computer", "monitor", t("strip.kind.computer")], ["browser", "globe", t("pane.browser")]].map(([v, i, l]) => `<button type="button" data-act="stage" data-v="${v}" aria-pressed="${kind === v}">${ic(i, "s")}${l}</button>`).join("");
  return `<div class="st7-top"><button class="st7-back" type="button" data-act="stage-close">${ic("back", "s")}${esc(name())}</button>
    <span class="st7-title"><b>${title}</b>${kind === "computer" ? pickChip(S.chat) : own}</span>${field}${pill}<span class="tb-grow"></span>${controls(kind)}
    <span class="st7-sw" role="group" aria-label="${t("dashboard.filter.label")}">${sw}</span>
    <button class="icon-btn" type="button" aria-label="${t("window.chat.stage.shrink")}" data-tip="${t("window.chat.stage.pip")}" data-act="stage-pip">${ic("layers")}</button>
    <button class="icon-btn" type="button" aria-label="${G.dock ? t("window.chat.stage.hide-conversation") : t("window.chat.stage.show-conversation")}" data-tip="${G.dock ? t("window.chat.stage.full-screen") : t("window.chat.stage.show-conversation")}" data-act="stage-dock" aria-pressed="${G.dock}">${ic("panel")}</button></div>`;
}

const STEP = { done: "done", working: "now", failed: "", waiting: "" };
function dock(steps, kind) {
  const plan = steps.length ? `<ul class="dk7-plan">${steps.map((s) => { const c = STEP[s.status] ?? ""; return `<li class="${c}">${ic(c === "done" ? "check" : c === "now" ? "spin" : "info", c === "now" ? "s spin" : "s")}${esc(s.title)}</li>`; }).join("")}</ul>` : "";
  const said = G.messages.filter((m) => (m.role === "user" || m.role === "assistant") && m.content && !trunkIntro(m)).slice(-3)
    .map((m) => `<div class="dk7-m ${m.role === "user" ? "me7" : ""}">${esc(String(m.content).slice(0, 180))}</div>`).join("");
  const tell = t("window.chat.stage.tell", { name: esc(isRoom() ? t("window.chat.stage.the-room-lower") : name()) });
  return `<aside class="st7-dock" aria-label="${t("onscreen.group.middle")}">${resizerHTML("dock")}
    <div class="dk7-h">${av(chatFace(S.chat), 28, S.chat)}<b>${esc(name())}</b><small>${esc(role())}</small></div>${plan}<div class="dk7-msgs">${said}</div>
    <form class="dk7-in" data-form="stage"><input id="st-in" autocomplete="off" placeholder="${tell}" aria-label="${tell}"><button type="submit" class="c-btn send ready" aria-label="${t("composer.send")}">${ic("up")}</button></form>${dockFoot(kind)}</aside>`;
}
/* The computer view's foot: what This computer lets it reach (Settings › Computer's own line), and where to change it. */
function dockFoot(kind) {
  if (kind !== "computer") return "";
  // Parity B2 (review): the live view says plainly that it shows the screen as it is, and when it is held back.
  const reach = onThis() ? `${t("window.settings.computer.your-screen-mouse-and-apps-it")} ${t("window.chat.stage.screen-shown")} ` : "";
  return `<p class="dk7-foot">${reach}<button class="link" type="button" data-act="setgo" data-v="computer">${t("window.chat.stage.change-reach")}</button></p>`;
}

/* What the task is doing now, over the screen while it works: its plan's step, else the engine's words for its step. */
function caption(steps) {
  if (!working()) return "";
  const said = steps.find((s) => s.status === "working")?.title || live()?.doing || "";
  return said ? `<div class="st7-cap">${esc(said)}</div>` : "";
}

/* Two or more computers: a tab each (the working dot on the one in use while a task works) and All screens. */
const several = (kind) => (kind === "computer" && (comps()?.list.length ?? 0) > 1 ? comps() : null);
function compTabs(st, steps) {
  const dot = (id) => `<i class="${working() && st.using === id ? "on7" : ""}"></i>`;
  const tabs = st.list.map((x) => `<button type="button" role="tab" data-act="comp-view" data-v="${esc(x.id)}" aria-selected="${!G.grid && st.using === x.id}">${ic(x.icon, "s")}${esc(x.name)}${dot(x.id)}</button>`).join("");
  return `<div class="st7-tabs" role="tablist" aria-label="${t("window.p17d.its-computers")}">${tabs}<button type="button" role="tab" data-act="comp-grid" aria-selected="${G.grid}">${ic("layers", "s")}${t("window.chat.stage.all-screens")}</button></div>`;
}
/* Every screen side by side: This computer's picture, and the empty line for a computer the engine keeps none of. */
function gridHTML(st, steps) {
  const doing = working() ? steps.find((s) => s.status === "working")?.title || live()?.doing || "" : "";
  const shot = screenFrame() ? "" : shotUrl(desktopPicture());
  const cells = st.list.map((x) => {
    const mine = x.id === "this" && (screenFrame() ? liveScreen() : shot ? `<div class="desk7"><img class="shot7" src="${esc(shot)}" alt="${esc(x.name)}"></div>` : "");
    const pic = mine ? `<span class="st7-scale">${mine}</span>` : emptyHTML("computer", true);
    return `<button type="button" class="st7-cell" data-act="comp-view" data-v="${esc(x.id)}"><span class="st7-screen grid7">${pic}</span><span class="st7-cl">${ic(x.icon, "s")}${esc(x.name)}<em>${st.using === x.id ? esc(doing) : ""}</em></span></button>`;
  }).join("");
  return `<div class="st7-wrap gridwrap7"><div class="st7-grid">${cells}</div></div>`;
}

function stageHTML(kind) {
  const steps = G.plan?.steps ?? [], scr = screen(kind), many = several(kind);
  const chips = steps.map((s, i) => `<button type="button" class="st7-chip ${STEP[s.status] ?? ""}" data-act="stage-step" data-v="${i}"><em>${i + 1}</em>${esc(s.title)}</button>`).join("");
  const liveNow = kind === "browser" && live()?.browser?.live && working();
  const body = scr ? `<div class="st7-screen"><div class="st7-scale">${scr}</div>${caption(steps)}</div>` : emptyHTML(kind);
  const wrap = many && G.grid ? gridHTML(many, steps) : `<div class="st7-wrap">${body}</div>`;
  return `${top(kind, steps)}${many ? compTabs(many, steps) : ""}<div class="st7-body ${G.dock ? "" : "nodock"}">${wrap}${G.dock ? dock(steps, kind) : ""}</div>
    ${steps.length ? `<div class="st7-steps">${chips}<button type="button" class="st7-chip live7" data-act="stage-step" data-v="live">${liveNow ? `<i></i>${t("dashboard.live")}` : t("dashboard.area.now")}</button></div>` : ""}`;
}

function pipHTML() {
  const kind = G.pip.kind, scr = screen(kind);
  const inner = scr ? `<div class="st7-scale">${scr}</div>` : emptyHTML(kind, true);
  const on = kind === "browser" ? t("window.chat.stage.browser-lower") : computerNamed(comps()?.using)?.name ?? "";
  return `<div class="pip7-screen" data-act="stage" data-v="${kind}" role="button" aria-label="${t("window.chat.stage.full-size")}">${inner}</div><div class="pip7-bar"><span>${esc(name())}${on ? ` · ${esc(on)}` : ""}</span><button type="button" data-act="stage" data-v="${kind}" aria-label="${t("window.chat.stage.full-size")}">${ic("up", "s")}</button><button type="button" data-act="pip-x" aria-label="${t("window.chat.stage.close-small")}">${ic("x", "s")}</button></div>`;
}

/* The screen is drawn at 1280 × 800 and scaled to fit, as the prototype's fitStage does. */
function fit(root) {
  for (const scr of root.querySelectorAll(".st7-screen,.pip7-screen")) {
    // A screen in All screens is sized by its cell (CSS), and only scaled to it.
    const wrap = scr.classList.contains("st7-screen") && !scr.classList.contains("grid7") ? scr.parentElement : null;
    let w = scr.clientWidth;
    if (wrap) { w = Math.max(240, Math.min(wrap.clientWidth - 36, (wrap.clientHeight - 36) * 1.6)); scr.style.width = w + "px"; scr.style.height = w / 1.6 + "px"; }
    const s = scr.querySelector(".st7-scale");
    if (s) s.style.transform = `scale(${w / 1280})`;
  }
}
const refit = () => { for (const id of ["stage7", "pip7"]) { const el = document.getElementById(id); if (el) fit(el); } };

/* The card in the conversation while its task works in Branch's browser (the prototype's computer card): a small live
   picture and Watch full size. chat.js draws it under the conversation's messages. */
export function stageCard() {
  const now = live(), view = now?.browser;
  if (!S.chat || !view?.live || !view.frame || now.status !== "running" || G.kind === "browser") return "";
  const sub = now.doing ? `<div class="sub">${esc(now.doing)}</div>` : "";
  return `<div class="b"><div class="gut"></div><div><div class="card comp7"><div class="card-h"><b>${ic("globe", "s")}${t("window.chat.stage.browser-of", { name: esc(name()) })}</b><span class="pill work ml"><i></i>${t("strip.status.working")}</span></div>${sub}
    <button type="button" class="comp7-thumb" data-act="stage" data-v="browser" aria-label="${t("window.chat.stage.full-size")}"><span class="st7-scale">${liveWindow(view, view.frame)}</span></button>
    <div class="acts"><button class="btn pri sm" type="button" data-act="stage" data-v="browser">${ic("monitor", "s")}${t("window.chat.stage.watch-full")}</button></div></div></div></div>`;
}
const cardKey = (v) => JSON.stringify([v?.runId, v?.status, v?.doing, v?.browser?.live, !!v?.browser?.frame, v?.browser?.url, v?.browser?.title]);
/* A new answer: the conversation is drawn again when its card changes; otherwise only the view (a frame is painted in). */
function onLive(before, now) {
  if (cardKey(before) !== cardKey(now)) render(); else drawStage();
}
function fitCards() {
  for (const card of document.querySelectorAll("#main .comp7-thumb")) {
    const s = card.querySelector(".st7-scale");
    if (s) s.style.transform = `scale(${card.clientWidth / 1280})`;
  }
}

/* The newest frame, set straight onto the picture: a frame alone never redraws the view. */
function paintFrames() {
  const frame = live()?.browser?.frame, desk = screenFrame();
  if (frame) for (const img of document.querySelectorAll("#stage7 .live7-img, #pip7 .live7-img, #main .comp7-thumb .live7-img")) if (img.getAttribute("src") !== frame) img.setAttribute("src", frame);
  if (desk) for (const img of document.querySelectorAll("#stage7 .livescr-img, #pip7 .livescr-img")) if (img.getAttribute("src") !== desk) img.setAttribute("src", desk);
}

/* Words typed in the dock's box and the address field survive a redraw: their words, focus and caret are put back. */
const BOXES = ["#st-in", "#st-addr"];
function redraw(el, html) {
  const kept = BOXES.map((sel) => el.querySelector(sel)).map((box) => box && { value: box.value, focused: document.activeElement === box, start: box.selectionStart, end: box.selectionEnd });
  el.innerHTML = html;
  BOXES.forEach((sel, i) => {
    const box = el.querySelector(sel), was = kept[i];
    if (!box || !was) return;
    box.value = was.value;
    if (was.focused) { box.focus(); if (box.type !== "url") box.setSelectionRange(was.start, was.end); }
  });
}

/* One region each for the full-size view and the small window, made once and removed when closed; drawn again only
   when what it shows changed. */
function region(id, cls, show, html) {
  let el = document.getElementById(id);
  if (!show) { el?.remove(); G.drawn[id] = ""; return; }
  if (!el) { el = Object.assign(document.createElement("div"), { id, className: cls }); app()?.appendChild(el); G.drawn[id] = ""; }
  const next = html();
  if (next !== G.drawn[id]) {
    redraw(el, next);
    el.classList.toggle("tabs-b2", !!el.querySelector(".st7-tabs"));
    G.drawn[id] = next;
    applyCss(el);
    greyOut(el);
  }
  fit(el);
}

export function drawStage() {
  const here = S.view === "chat" && !!S.chat;
  if (G.pip && G.pip.chat !== S.chat) G.pip = null;
  if (!here) G.kind = null;
  // The owner's browser window goes with the view that opened it: closed, or another conversation.
  if (G.browsed && (G.browsed !== S.chat || (!G.kind && !G.pip))) closeBrowsed();
  region("stage7", "stage7", here && !!G.kind, () => stageHTML(G.kind));
  $("#stage7")?.setAttribute("role", "region");
  $("#stage7")?.setAttribute("aria-label", t("window.stage.label"));
  region("pip7", "pip7", here && !G.kind && !!G.pip, pipHTML);
  paintFrames();
  const browser = here && (G.kind === "browser" || (!G.kind && G.pip?.kind === "browser"));
  const computer = here && (G.kind === "computer" || (!G.kind && G.pip?.kind === "computer"));
  // This computer's screen: read only while its view is showing to the owner (on This computer, or All screens).
  // All screens reads it only when This computer is one of the screens it draws.
  const grid = G.grid ? several("computer") : null, shows = grid ? grid.list.some((x) => x.id === "this") : onThis();
  watchScreen(computer && E.profiles?.isOwner !== false && shows, (redraw) => (redraw ? drawStage() : paintFrames()));
  // Read while the view shows the browser (twice a second), or while a task of this conversation works (every few
  // seconds, for the card in the conversation).
  // The frames are the owner's alone (the engine refuses anyone else), so nobody else's window asks for them.
  const going = here && S.view === "chat" && runsHere()[0]?.status === "running", mine = E.profiles?.isOwner !== false;
  watchLive(mine && (browser || going) ? S.chat : null, onLive, browser);
  fitCards();
  if (here && (G.kind || G.pip)) load();
}

/* The conversation's messages and its newest task's plan, read again at most every two seconds. */
async function load() {
  const sid = S.chat;
  loadWork(sid);
  if (sid === G.sid && Date.now() - G.at < 2000) return;
  G.at = Date.now();
  const newest = runsHere()[0];
  try {
    const [session, planned, desk] = await Promise.all([api(`sessions/${encodeURIComponent(sid)}`), newest ? api(`runs/${encodeURIComponent(newest.id)}/plan`) : null, api("linux-desktop")]);
    const next = { sid, messages: session?.messages ?? [], plan: planned?.plan ?? null, desk: { running: desk?.running === true, control: desk?.control }, said: "" };
    const same = JSON.stringify([G.sid, G.messages, G.plan, G.desk]) === JSON.stringify([next.sid, next.messages, next.plan, next.desk]);
    Object.assign(G, next);
    if (!same && S.chat === sid) drawStage();
  } catch (error) {
    // Said once, not again every two seconds while the engine keeps refusing for the same reason.
    if (error.message !== G.said) toast(error.message);
    G.said = error.message;
  }
}

async function stop(el) {
  try {
    await api(`runs/${encodeURIComponent(el.dataset.id)}/cancel`, {});
    await refresh();
  } catch (error) { toast(error.message); }
  G.at = 0;
  drawStage();
}

/* Take over or Hand back: the engine's answer is the desktop's state now, drawn straight away. */
async function hold(path, done) {
  try {
    const desk = await api(path, {});
    G.desk = { running: desk?.running === true, control: desk?.control };
    if (done) toast(done);
  } catch (error) { toast(error.message); }
  drawStage();
}

/* The address field (the owner's alone): disabled, with the engine's reason, while a task works or waits here. */
function addressField() {
  if (E.profiles?.isOwner === false) return "";
  const busy = !!goingRun(), words = t("window.chat.stage.address");
  return `<form class="st7-addr" data-form="browse"><input id="st-addr" class="inp" autocomplete="off" spellcheck="false" placeholder="${words}" aria-label="${words}"${busy ? ` disabled data-tip="${t("window.chat.stage.address-busy")}"` : ""}><button type="submit" class="icon-btn" aria-label="${t("window.chat.stage.go")}"${busy ? " disabled" : ""}>${ic("up", "s")}</button></form>`;
}
/* What the owner typed opens in Branch's browser for this conversation, through the engine's gate; a question the gate
   asks is put to the owner, and only Allow once sends it again, confirmed. */
async function browseTo(address, confirm = false) {
  const sid = S.chat;
  let outcome;
  try { outcome = await api("panels/browse", { sessionId: sid, address, confirm }); } catch (error) { toast(error.message); return; }
  G.browsed = sid;
  if (outcome.status === "asked") return askBrowse(outcome.question, address);
  if (outcome.status === "refused") toast(outcome.reason);
  else if (outcome.status === "failed") toast(outcome.error);
  else { const box = $("#st-addr"); if (box) box.value = ""; }
  drawStage();
}
function askBrowse(question, address) {
  G.asked = address;
  openDlg({ title: t("window.chat.stage.browser-of", { name: owner() }), body: `<p data-css="margin:0">${esc(question)}</p>`,
    foot: `<button class="btn ghost" type="button" data-act="dlg-close">${t("window.chat.term.no")}</button><button class="btn pri" type="button" data-act="browse-yes">${t("window.chat.helpers.allow-once")}</button>` });
}
/* The owner's window for this conversation closes with the view (the engine closes it anyway once nobody reads it). */
function closeBrowsed() {
  if (!G.browsed) return;
  const sid = G.browsed;
  G.browsed = null;
  api("panels/browse/close", { sessionId: sid }).catch((error) => toast(error.message));
}

/* The dock's box: a working task is steered (it reads the words before its next step); with none working the words
   are sent to the conversation as a message. */
async function tell(form) {
  const box = form.querySelector("#st-in"), words = box?.value.trim();
  if (!words) return;
  const run = goingRun();
  try {
    if (run?.status === "running") {
      await api(`runs/${encodeURIComponent(run.id)}/steer`, { text: words });
      box.value = "";
      toast(t("window.chat.stage.told", { name: name() }));
    } else {
      box.value = "";
      await startWith(words, S.chat);
    }
  } catch (error) { toast(error.message); }
}

/* Opens the full-size view (from the header's computer and browser buttons, the view's own switch, the small window or
   Team). */
export function openStage(kind) {
  G.kind = kind === "browser" ? "browser" : "computer";
  G.pip = null;
  G.grid = false;
  closePop();
  drawStage();
}

/* The dock's width is the window's (shell/resize.js drags its edge, keeps it and sets --dock-w); it calls this so the
   screen is fitted to the room left beside the dock. */
export function setDockWidth() {
  const el = document.getElementById("stage7");
  if (el) fit(el);
}

/* Team › Live now: Watch opens that task's conversation with its browser full size. */
async function watchRun(el) {
  const run = (E.state?.runs ?? []).find((r) => r.id === el.dataset.id);
  if (!run?.sessionId) return;
  await openConversation(run.sessionId);
  openStage("browser");
}

export function initStage() {
  markLive(["stage", "stage-close", "stage-dock", "stage-pip", "pip-x", "stage-stop", "takeover", "handback", "run-watch", "sw:st-in", "comp-view", "comp-grid", "sw:st-addr", "browse-yes"]);
  // A computer's tab (or its cell in All screens) picks it for this conversation; All screens is the view's own layout.
  on("comp-view", async (el) => { if (await pickFor(S.chat, el.dataset.v)) { G.grid = false; G.at = 0; drawStage(); } });
  on("comp-grid", () => { G.grid = true; drawStage(); });
  on("stage", (el) => openStage(el.dataset.v));
  on("stage-close", () => { G.kind = null; drawStage(); });
  // Only the address that was asked about, once, confirmed.
  on("browse-yes", () => { const address = G.asked; G.asked = null; closeDlg(); if (address) browseTo(address, true); });
  on("stage-pip", () => { G.pip = { kind: G.kind, chat: S.chat }; G.kind = null; drawStage(); });
  on("pip-x", () => { G.pip = null; drawStage(); });
  on("stage-dock", () => { G.dock = !G.dock; drawStage(); });
  on("stage-stop", (el) => stop(el));
  on("takeover", () => hold("linux-desktop/take-over"));
  on("handback", () => hold("linux-desktop/hand-back", t("window.chat.stage.handed-back")));
  on("run-watch", (el) => watchRun(el));
  onRender(drawStage);
  document.addEventListener("submit", (e) => {
    const addr = e.target.closest?.('#stage7 form[data-form="browse"]');
    if (addr) { e.preventDefault(); const words = addr.querySelector("#st-addr")?.value.trim(); if (words) browseTo(words); return; }
    const form = e.target.closest?.('#stage7 form[data-form="stage"]');
    if (!form) return;
    e.preventDefault();
    tell(form);
  }, true);
  // Before the window's own Escape (which closes a menu or dialog first), as the prototype listens.
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && G.kind && !document.querySelector(".dlg, .pop")) { G.kind = null; drawStage(); } }, true);
  window.addEventListener("resize", refit);
}
