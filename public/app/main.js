/* Boots the window: saved choices, the engine's state, the live event stream, and the first draw. Each area draws its own
   view into #main; the shell draws the sidebar, title-bar actions and status bar. */

/* A phone paired in its browser adds its own secret to every request to this address (public/device-headers.js). */
import { installDeviceHeaders } from "../device-headers.js";
installDeviceHeaders();
import { $, onRender, render, renderNow, paint } from "./core/dom.js";
import { S, E, loadSaved, refresh, activeId } from "./core/state.js";
import { api, stream, link } from "./core/api.js";
import { listen, on } from "./core/actions.js";
import { listenTips, closePop, closeDlg, dialog } from "./core/ui.js";
import { greyOut } from "./core/features.js";
import { VIEWS } from "./views.js";
import { drawShell, initShell, PLACE_VIEWS, wide } from "./shell/shell.js";
import { showSignIn } from "./shell/signin.js";
import { showLock, watchLock, initLock } from "./shell/applock.js";
import { openConversation } from "./chat/chat.js";
import { goHome } from "./chat/goto.js";
import { initLanguage } from "../i18n.js";

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
const drawn = { key: null, first: null };
/* After the person does something in the view, its next draw is always a fresh one, as before (a field put back as the
   engine keeps it, a button given back); only the re-reads between their actions leave an unchanged view alone. */
for (const kind of ["click", "change", "keydown"]) document.addEventListener(kind, (e) => { if (e.target.closest?.("#main")) drawn.key = null; }, true);
function drawMain() {
  const main = $("#main");
  const draw = VIEWS[S.view] ?? VIEWS.chat;
  const html = draw(), key = `${S.view}\n${wide()}\n${html}`;
  if (key === drawn.key && main.firstElementChild && main.firstElementChild === drawn.first) {
    /* A place's after() is how it reads its own data again (the Inbox's questions, a library tab, Overview's health);
       it touches no markup and draws only when something came back different, so it still runs on an unchanged view. */
    if (PLACE_VIEWS.includes(S.view)) VIEWS.after?.[S.view]?.(main);
    return;
  }
  paint(main, html);
  unnest(main);
  /* A place's header (the prototype's placeHead) is drawn in the title-bar row at every width (shell.js). */
  greyOut(main);
  VIEWS.after?.[S.view]?.(main);
  Object.assign(drawn, { key, first: main.firstElementChild });
}

/* The conversation's width, from the owner's saved preference (the prototype's three: comfortable, wide, full). */
const THREAD_W = { comfortable: "720px", wide: "clamp(860px,52vw,1180px)", full: "100%" };
function drawWidth() {
  const width = THREAD_W[E.state?.preferences?.conversationWidth] ?? THREAD_W.wide;
  $("#app")?.style.setProperty("--thread-w", width);
}

on("dlg-close", () => closeDlg());
on("view", (el) => { S.view = el.dataset.v; if (el.dataset.tab) S.tabs[el.dataset.v] = el.dataset.tab; $("#app")?.classList.remove("side-open"); closePop(); renderNow(); });
on("ptab", (el) => { S.view = el.dataset.place; S.tabs[el.dataset.place] = el.dataset.v; closePop(); renderNow(); });

async function boot() {
  loadSaved();
  if (S.theme) document.documentElement.dataset.theme = S.theme;
  /* The words t() looks up (public/locales), in the saved language, before anything is drawn. */
  await initLanguage();
  listen();
  listenTips();
  initShell();
  initLock();
  onRender(drawShell);
  onRender(drawMain);
  onRender(drawWidth);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") escape(); });
  await connect();
}

/* Escape, as the prototype's: the popover, else the dialog, else Focus mode; and the phone's list closes. */
function escape() {
  const app = $("#app");
  if (document.querySelector(".pop")) closePop({ refocus: true });
  else if (dialog()) closeDlg();
  else if (app?.classList.contains("focus")) app.classList.remove("focus");
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
  link.onChange = () => renderNow();
  let queued = null;
  stream([], () => {
    clearTimeout(queued);
    queued = setTimeout(() => refresh().then(render, () => {}), 250);
  });
  watchPerson();
  followLink();
  addEventListener("hashchange", () => followLink());
}

/* Who is using Branch can change from anywhere (a switch through POST /api/profiles/switch sends no event), so the window
   asks GET /api/profiles every two seconds. When the person changes, the window starts again from nothing: no editor,
   dialog or page the last person had open stays on screen or in memory, and every page is read again as the new person.
   The session token is kept for the tab, so the window comes straight back. */
function watchPerson() {
  let known = E.profiles ? activeId() : undefined;
  const timer = setInterval(async () => {
    let now;
    try { now = await api("profiles"); } catch (error) {
      /* A refused key stops the asking: every refused request counts against signing in. */
      if (error.status === 401 || error.status === 429) clearInterval(timer);
      return;
    }
    const id = now?.active?.id ?? null;
    if (known === undefined) known = id;
    else if (id !== known) location.reload();
  }, 2000);
}

boot();
