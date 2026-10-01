/* Boots the window: saved choices, the engine's state, the live event stream, and the first draw. Each area draws its own
   view into #main; the shell draws the sidebar, title-bar actions and status bar. */

/* A phone paired in its browser adds its own secret to every request to this address (public/device-headers.js). */
import { installDeviceHeaders } from "../device-headers.js";
installDeviceHeaders();
import { $, onRender, render, renderNow, paint, applyCss, pressIn, keepDetails } from "./core/dom.js";
import { S, E, loadSaved, refresh, activeId } from "./core/state.js";
import { api, stream, link } from "./core/api.js";
import { listen, on } from "./core/actions.js";
import { listenTips, closePop, closeDlg, dialog } from "./core/ui.js";
import { greyOut } from "./core/features.js";
import { VIEWS } from "./views.js";
import { drawShell, initShell, PLACE_VIEWS, wide } from "./shell/shell.js";
import { showSignIn } from "./shell/signin.js";
import { showLock, watchLock, initLock } from "./shell/applock.js";
import { openConversation, rereadOpen } from "./chat/chat.js";
import { selectionHeld, scrollSecurity } from "./chat/scroll-follow.js";
import { forgetChips } from "./chat/chips.js";
import { toast } from "./core/ui.js";
import { goHome } from "./chat/goto.js";
import { leaveSettings } from "./settings/settings.js";
import { splash, splashDone } from "./shell/inperson.js";
import { initNotices } from "./shell/notices.js";
import { initLanguage, t } from "../i18n.js";
import { initLive, restoreOpen } from "./shell/liveupdate.js"; // hot-update: live window updates keep what is open
import { keepDrafts } from "./core/drafts.js"; // UP-UI-006: unsent words survive a restart

/* A place draws its own <main class="main" id="main">; inside the shell's #main that would be a second main and a second
   #main, so it becomes a <div> with the same classes and children (the styles are by class). */
function unnest(main) {
  const inner = main?.querySelector(":scope > main");
  if (!inner) return;
  const box = document.createElement("div");
  box.className = inner.className;
  box.append(...inner.childNodes);
  inner.replaceWith(box);
}

/* The focused control, and a text field's caret, are kept across redraws by core/dom.js for every region.
   A view whose markup has not changed since its last draw is left as it is: drawing it anew on every re-read replaced
   the buttons under a press, and a tap that landed between two draws went nowhere. */
const drawn = { key: null, first: null, view: null, parts: null, nodes: [], touched: new Set() };
/* After the person does something in the view, its next draw is always a fresh one, as before (a field put back as the
   engine keeps it, a button given back); only the re-reads between their actions leave an unchanged view alone. In a
   view drawn in parts (below), that is the part they did it in. */
for (const kind of ["click", "change", "keydown"]) document.addEventListener(kind, (e) => {
  const main = e.target.closest?.("#main");
  if (!main) return;
  drawn.key = null;
  const part = [...main.childNodes].find((node) => node.contains(e.target));
  if (part) drawn.touched.add(part);
}, true);

/* The conversation is drawn in parts (chat.js inParts): its header, each bar, the thread in its scroll box, the message
   box. Only the parts whose markup changed, or that the person touched, are drawn anew, so a letter typed in the message
   box or a re-read after an event no longer draws every message above it again (the slowest draw in a long
   conversation). When the parts do not line up with the last draw (another view, a bar more or less), all of it is
   drawn, as before. */
const markup = (node) => (node.nodeType === 1 ? node.outerHTML : node.textContent);
function drawParts(main, html) {
  const next = document.createElement("template");
  next.innerHTML = html;
  const fresh = [...next.content.childNodes], parts = fresh.map(markup), old = [...main.childNodes];
  const lined = drawn.view === S.view && drawn.parts?.length === parts.length && old.length === parts.length && old.every((node, i) => node === drawn.nodes[i]);
  if (!lined) {
    main.replaceChildren(...fresh);
    applyCss(main);
    greyOut(main);
    return Object.assign(drawn, { parts, nodes: fresh });
  }
  const nodes = old.map((node, i) => {
    if (parts[i] === drawn.parts[i] && !drawn.touched.has(node)) return node;
    if (node.nodeType === 1 && fresh[i].nodeType === 1) keepDetails(node, fresh[i]);
    node.replaceWith(fresh[i]);
    if (fresh[i].nodeType === 1) applyCss(fresh[i]);
    return fresh[i];
  });
  greyOut(main);
  Object.assign(drawn, { parts, nodes });
}

/* A redraw of the same page keeps where each of its boxes was scrolled, as setup's does: a click in a Settings page drew
   the page anew and put it back at the top. A box is found again by its id, or its tag and classes and its place among
   those that share them. Another page, place tab or view starts at its top, as before. The scrollbar's own class
   (sb-on14, set while a box scrolls) is no part of that name: the scrolled box carries it, the fresh one does not. */
const page = () => `${S.view}\n${S.view === "settings" ? S.setPage : S.tabs[S.view] ?? ""}`;
const boxClasses = (el) => [...el.classList].filter((c) => c !== "sb-on14").join(" ");
function boxKeys(main, each) {
  const seen = new Map();
  for (const el of main.querySelectorAll("*")) {
    const name = el.id ? `#${el.id}` : `${el.tagName}.${boxClasses(el)}`, n = seen.get(name) ?? 0;
    seen.set(name, n + 1);
    each(el, `${name}\n${n}`);
  }
}
function scrolledBoxes(main) {
  const at = new Map();
  if (drawn.page === page()) boxKeys(main, (el, key) => { if (el.scrollTop > 0) at.set(key, el.scrollTop); });
  return at;
}
function putBack(main, at) {
  if (at.size) boxKeys(main, (el, key) => { if (at.has(key)) el.scrollTop = at.get(key); });
}

/* Pass 18: a place's tab row scrolls sideways instead of clipping, so a fresh draw keeps the chosen tab in view. */
function tabInView(main) {
  for (const on of main.querySelectorAll('.place .tabs [aria-selected="true"]')) {
    const row = on.parentElement;
    if (row.scrollWidth > row.clientWidth) row.scrollLeft = Math.max(0, on.offsetLeft - row.offsetLeft - 24);
  }
}

function drawMain() {
  const main = $("#main");
  const draw = VIEWS[S.view] ?? VIEWS.chat;
  const html = draw(), key = `${S.view}\n${wide()}\n${html}`;
  const security = scrollSecurity();
  // Same conversation/principal only. Owner, policy and lock changes must replace superseded DOM immediately.
  if (S.view === "chat" && drawn.view === "chat" && drawn.chat === S.chat && drawn.security === security &&
      (selectionHeld($("#scroll", main)) || selectionHeld($(".beside15 .thread", main)))) return;
  if (key === drawn.key && main.firstElementChild && main.firstElementChild === drawn.first) {
    /* A place's after() is how it reads its own data again (the Inbox's questions, a library tab, Overview's health);
       it touches no markup and draws only when something came back different, so it still runs on an unchanged view. */
    if (PLACE_VIEWS.includes(S.view)) VIEWS.after?.[S.view]?.(main);
    return;
  }
  /* Never under a press: the same view is drawn again once the press ends (core/dom.js pressIn). */
  if (drawn.view === S.view && pressIn(main)) return;
  if (VIEWS.inParts?.[S.view]?.()) drawParts(main, html);
  else {
    const at = scrolledBoxes(main);
    paint(main, html);
    unnest(main);
    /* A place's header (the prototype's placeHead) is drawn in the title-bar row at every width (shell.js). */
    greyOut(main);
    putBack(main, at);
    tabInView(main);
    drawn.parts = null;
  }
  drawn.touched.clear();
  drawn.view = S.view;
  drawn.page = page();
  VIEWS.after?.[S.view]?.(main);
  Object.assign(drawn, { key, first: main.firstElementChild, chat: S.chat, security });
}

/* The conversation's width, from the owner's saved preference (the prototype's three: comfortable, wide, full); pass 18 makes
   Comfortable (720px) the default, with Wide and Full in Settings › Appearance. */
const THREAD_W = { comfortable: "720px", wide: "clamp(860px,52vw,1180px)", full: "100%" };
function drawWidth() {
  const width = THREAD_W[E.state?.preferences?.conversationWidth] ?? THREAD_W.comfortable;
  $("#app")?.style.setProperty("--thread-w", width);
  /* See-through panels (Settings › Appearance): the engine's preference seeThrough, laid on as --see from the start. */
  const see = E.state?.preferences?.seeThrough;
  if (typeof see === "number") $("#app")?.style.setProperty("--see", `${see}%`);
}

on("dlg-close", () => closeDlg());
on("view", (el) => { S.view = el.dataset.v; if (el.dataset.tab) S.tabs[el.dataset.v] = el.dataset.tab; $("#app")?.classList.remove("side-open"); closePop(); renderNow(); });
on("ptab", (el) => { S.view = el.dataset.place; S.tabs[el.dataset.place] = el.dataset.v; closePop(); renderNow(); });

/* Scrollbars show while a box scrolls and hide a second after it stops (pass 14: app.css .sb-on14). */
const scrolling = new WeakMap();
document.addEventListener("scroll", (e) => {
  const box = e.target === document ? document.documentElement : e.target;
  if (!(box instanceof Element)) return;
  box.classList.add("sb-on14");
  clearTimeout(scrolling.get(box));
  scrolling.set(box, setTimeout(() => box.classList.remove("sb-on14"), 1000));
}, { capture: true, passive: true });

async function boot() {
  loadSaved();
  if (S.theme) document.documentElement.dataset.theme = S.theme;
  /* The words t() looks up (public/locales), in the saved language, before anything is drawn. */
  await initLanguage();
  listen();
  listenTips();
  initShell();
  initNotices(); // UI-202: what the window saw that earns an achievement (shell/notices.js)
  initLock();
  onRender(drawShell);
  onRender(drawMain);
  onRender(drawWidth);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") escape(); });
  initLive();
  splash();
  await connect();
  splashDone();
}

/* Escape, as the prototype's: the popover, else the dialog, else Focus mode, else Settings back to where the person was;
   and the phone's list closes. */
function escape() {
  const app = $("#app");
  if (document.querySelector(".pop")) closePop({ refocus: true });
  else if (dialog()) closeDlg();
  else if (app?.classList.contains("focus")) { app.classList.remove("focus"); renderNow(); }
  else if (S.view === "settings") leaveSettings();
  app?.classList.remove("side-open");
}

/* The dashboard's way back in: /#open=<home> (a place and tab, or a Settings page) or /#open=<conversation id>, and
   /#task=<run id>, which opens the conversation that task belongs to. Only names the window knows are followed. */
const UUID = /^[a-f0-9-]{36}$/;
async function followLink() {
  const hash = new URLSearchParams(location.hash.slice(1));
  const route = hash.get("open"), task = hash.get("task");
  if (!route && !task) return;
  history.replaceState(null, "", location.pathname + location.search);
  if (route && UUID.test(route)) await openConversation(route);
  else if (route && goHome(route)) renderNow();
  const run = task && UUID.test(task) ? (E.state?.runs ?? []).find((r) => r.id === task) : null;
  if (run?.sessionId) await openConversation(run.sessionId);
}

/* First load; a browser without a valid session token is asked for one (the engine's words say why it refused). */
async function connect(refusal = "") {
  try { await refresh(); }
  catch (error) {
    if (error.status === 401 || error.status === 429) { showSignIn(() => connect(true), refusal || error.status === 429 ? error.message : ""); return; }
    /* App lock: a locked engine answers 423, and the window shows only the lock screen (shell/applock.js). */
    if (error.status === 423) { showLock(); return; }
    E.error = error; render(); return;
  }
  if (await watchLock(E.state?.lock)) return;
  keepDrafts();
  link.onChange = () => { offline(); if (link.up) caughtUp(); };
  let queued = null;
  const askNow = watchPerson();
  stream([], () => {
    clearTimeout(queued);
    queued = setTimeout(() => freshen(false), 250);
  }, (end) => { if (end?.reason === "profile") askNow(); });
  followLink();
  addEventListener("hashchange", () => followLink());
  await restoreOpen(openConversation);
}

/* The engine's state read again, and the open conversation with it when something happened there (or always, `all`).
   A read that fails while the engine is away is not shown: the offline notice already says so. */
async function freshen(all) {
  try {
    await refresh();
    await rereadOpen(all);
  } catch (error) {
    if (link.up) toast(error.message);
  }
  render();
}

/* The engine stopped answering: a notice that says so, over everything, until it answers again (the event stream and
   the person check keep asking, ever more slowly, api.js stream). Every light that said "on" is drawn off meanwhile. */
function offline() {
  let note = document.getElementById("offline18");
  if (link.up || link.quiet) note?.remove(); // an install or restart the window started: the swap screen covers it
  else if (!note) {
    note = Object.assign(document.createElement("div"), { id: "offline18", className: "offline18" });
    note.setAttribute("role", "status");
    note.textContent = t("window.shell.offline");
    $("#app")?.appendChild(note);
  }
  $("#app")?.classList.toggle("offline18-on", !link.up);
  renderNow();
}

/* Back: everything the window shows is read again, since anything may have changed while it was away. */
function caughtUp() {
  forgetChips();
  freshen(true);
}

/* Who is using Branch can change from anywhere (a switch through POST /api/profiles/switch sends no event), and App lock
   can lock it by the quiet period or from another window. One question answers both: GET /api/profiles names the person,
   and a Branch locked with a PIN answers it 423 (src/session-lock.ts refusal), as it answers everything but its lock.
   When the person changes, or Branch has locked, the window starts again from nothing: no editor, dialog or page the last
   person had open stays on screen or in memory, every page is read again as the new person, and a locked Branch opens on
   its lock screen (shell/applock.js). The session token is kept for the tab, so the window comes straight back.
   It is asked at once when the event stream ends because the person changed (the engine's end { reason: "profile" },
   src/streams.ts; locking Branch does not end the stream, so a lock is heard only from this question's 423) and when
   the tab is shown again; otherwise every two seconds while the tab is shown and every ten while it is hidden. A refused
   key is asked again ever more slowly, since every refused request counts against signing in (five in fifteen minutes
   shut this computer out for five): a 401 up to once every sixteen minutes, a 429 up to once every five, so a stale tab
   never keeps the door shut for the computer's other keys. The asking never stops. Answers the way to ask at once. */
let leaving = false; // this page is on its way to another address (see watchPerson's restart)
addEventListener("beforeunload", () => { leaving = true; });

function watchPerson() {
  let known = E.profiles ? activeId() : undefined, stopped = false, timer = null, refused = 0, cap = 0;
  const wait = () => (refused ? Math.min(cap, 2000 * 2 ** refused) : document.hidden ? 10000 : 2000);
  const again = () => { clearTimeout(timer); if (!stopped) timer = setTimeout(ask, wait()); };
  /* A page already on its way to another address (following a link to a conversation, say) is not restarted over it: the
     reload would cancel that navigation and land back on this page's own address, the link already taken off it, so the
     person would stand on a new conversation instead of the one they followed. The page that loads next reads the person
     itself. A navigation that never replaces this page (a download) lets the restart happen a few seconds later, so a
     window is never left showing the person from before the switch. */
  const restart = () => {
    stopped = true;
    clearTimeout(timer);
    if (leaving) setTimeout(() => location.reload(), 5000);
    else location.reload();
  };
  async function ask() {
    clearTimeout(timer);
    if (stopped) return;
    let now;
    try { now = await api("profiles"); } catch (error) {
      if (error.status === 423) return restart();
      if (error.status === 401 || error.status === 429) { refused += 1; cap = error.status === 401 ? 960000 : 300000; }
      return again();
    }
    refused = 0;
    const id = now?.active?.id ?? null;
    if (known === undefined) known = id;
    else if (id !== known) return restart();
    again();
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden && !refused) ask(); });
  again();
  return ask;
}

boot();
