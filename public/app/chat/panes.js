/* RES-703 / SELF-308, from Hermes Desktop: one composer, many panes. Conversations sit side by side, each under its own
   tab (its face, its name, a live dot while it works, a close button). The open conversation is the main pane, drawn in
   full by chat.js; every other pane reads its own conversation from the engine (GET /api/sessions/{id}) and is sent to
   like any other (POST /api/run, or the busy send while a task works there), several at once.
   There is one message box. The pane under the pointer (after a short pause, so crossing one on the way does not count)
   or the one focused is the active pane: it carries an accent ring, its tab is marked, and the box names it before Enter
   is pressed. That marking is laid on directly, never by drawing the conversations again.
   A conversation is pulled into a pane from its row's menu in the list, from the + at the end of the tabs, or from the
   conversation's own menu ("Open another conversation beside"). Panes are widened by the handle between them, put in
   another order by dragging a tab (or Alt+Left and Alt+Right on it), and closed from their tab. The layout (the order,
   the widths and the active pane) is kept with the window's saved choices; a pane whose conversation is gone is dropped.
   Below 1000px there is room for the main pane only, and the box writes to it.
   Each pane shows its task working as the main conversation does: its live steps (chat/livesteps.js, a follower of its
   own) and, when the task stops to ask, the same approval card, answered in place (chat/chat.js paneAsks); the task
   carries on in its pane. So several Trunks can be watched, and let go on, side by side. */

import { $, $$, esc, render, renderNow, applyCss, onRender, afterDraw } from "../core/dom.js";
import { S, E, save, refresh, ownName, chatFace, trunkIntro, displayPreference, revealDisplay } from "../core/state.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { ic, av, openPop, closePop, toast } from "../core/ui.js";
import { markLive } from "../core/features.js";
import { text, plain } from "./markdown.js";
import { mediaRows } from "./media.js";
import { openConversation, conversationWho } from "./chat.js";
import { liveFollower } from "./livesteps.js";
import { t } from "../../i18n.js";
import { waitRoom, holdWait, LONG_WAITS } from "../core/inflight.js"; // each send waits until its task ends

const MAIN = "@main";
const LIVE = ["running", "queued", "waiting", "needs_input"];
const NARROW = matchMedia("(max-width:999px)");
const P = new Map(); // a pane's conversation: { messages, loaded, mark, sending, reading }
const LIVES = new Map(); // a pane's live-steps follower
const HOOK = { asks: () => "", readAsks: async () => {} }; // chat.js: the approval cards, and reading them again
const sid = (s) => s.sessionId ?? s.id;

/* ---------- the layout, as kept (S.panes19) ---------- */
function layout() {
  const preference = S.panes19 && typeof S.panes19 === "object" ? S.panes19 : {};
  const kept = displayPreference("panes19", preference) ?? { ...preference, ids: [MAIN], active: MAIN };
  const ids = [...new Set((Array.isArray(kept.ids) ? kept.ids : []).filter((id) => typeof id === "string" && id))];
  if (!ids.includes(MAIN)) ids.unshift(MAIN);
  const w = kept.w && typeof kept.w === "object" ? { ...kept.w } : {};
  return { ids, active: typeof kept.active === "string" ? kept.active : MAIN, w, main: typeof kept.main === "string" ? kept.main : null };
}
function keep(next) { if (!revealDisplay("panes19", next)) S.panes19 = next; save(); }
/** The panes drawn now: the main one and every other conversation but the one already open in it. */
function shown() { return layout().ids.filter((id) => id === MAIN || id !== S.chat); }
export const panesOn = () => shown().length > 1;
const activeId = () => { const L = layout(), list = shown(); return list.includes(L.active) && !NARROW.matches ? L.active : MAIN; };
/** The conversation the box writes to when it is not the main one, else null. */
/** Whether conversation `id` is open in a pane beside the main one. */
export const paneOpen = (id) => !!id && id !== MAIN && panesOn() && shown().includes(id);
export const paneTarget = () => (panesOn() && activeId() !== MAIN ? activeId() : null);

const sessionOf = (id) => E.sessions.find((s) => sid(s) === id);
const nameOf = (id) => (id === MAIN ? conversationWho().title : ownName(id) || sessionOf(id)?.title || plain(sessionOf(id)?.opening ?? "") || t("comfort.field.newConversation"));
/* The panes' widths, as grid columns with a 7px handle between two: laid on after every draw (the split is a part of the
   conversation drawn on its own, main.js drawParts, and is given its columns here rather than by data-css). */
/* With the side panel, the Home panel and many panes open, a share could fall below a readable width: then each pane
   keeps MIN_PANE and the row scrolls sideways (tight19) instead of squeezing every conversation. */
const MIN_PANE = 300;
const columns = (L, tight = false) => shown().map((id) => (tight ? `${MIN_PANE}px` : `minmax(0,${Math.max(0.2, Number(L.w[id]) || 1)}fr)`)).join(" 7px ");
function sizePanes() {
  const split = $(".panes19");
  if (!split) return;
  const tight = split.clientWidth / shown().length < MIN_PANE;
  split.classList.toggle("tight19", tight);
  split.style.setProperty("--cols19", columns(layout(), tight));
}
const faceOf = (id) => chatFace(id === MAIN ? S.chat : id);
const working = (id) => { const s = id === MAIN ? S.chat : id; return !!s && ((E.state?.runs ?? []).some((r) => r.sessionId === s && LIVE.includes(r.status)) || !!P.get(id)?.sending); };
/** Whether pane `id`'s conversation has a task working (a message to it then goes through the busy send). */
export const paneBusy = (id) => working(id);
const waiting = (id) => (E.state?.attention ?? []).some((w) => (w.open || w.sessionId) === id);

/* ---------- drawing ---------- */
function thread(id) {
  const p = P.get(id);
  let last = null;
  const rows = (p?.messages ?? []).filter((m) => (m.role === "user" || m.role === "assistant") && m.from !== "branch" && !trunkIntro(m) && String(m.content ?? "").trim()).map((m) => {
    const html = m.role === "user" ? `<div class="u">${esc(m.content)}</div>${mediaRows(m, id)}`
      : `<div class="b"><div class="gut">${last !== "assistant" ? av(chatFace(id), 28) : ""}</div><div><div class="txt">${text(m.content)}</div></div></div>`;
    last = m.role;
    return html;
  });
  const live = liveOf(id);
  if (working(id)) rows.push(`<div class="b"><div class="gut">${av(chatFace(id), 28)}</div><div>${live.shown() ? live.block() : `<span class="typing" aria-label="${t("window.chat.typing")}"><i></i><i></i><i></i></span>`}</div></div>`);
  /* Its questions, as the main conversation's cards, once its task has stopped on them (a yes given while it is still
     stopping would carry nothing on); until then, and until they are read, a line that says one waits. */
  const stopped = !(E.state?.runs ?? []).some((r) => r.sessionId === id && ["running", "queued"].includes(r.status)) && !P.get(id)?.sending;
  const asks = stopped ? HOOK.asks(id) : "";
  if (asks) rows.push(asks);
  else if (waiting(id) || (!stopped && HOOK.asks(id))) { rows.push(`<p class="wait19">${ic("bell", "s")}<span>${t("window.panes.needs-you")}</span></p>`); readAsksSoon(); }
  return rows.join("");
}
function tab(id, last) {
  const on = activeId() === id, main = id === MAIN;
  const close = main ? t("window.panes.close-main") : t("window.chat.beside.close");
  return `<div class="tab19" tabindex="0" draggable="true" data-pane="${esc(id)}" aria-current="${on}">${av(faceOf(id), 20)}<b>${esc(nameOf(id))}</b>${working(id) ? '<i class="live19" aria-hidden="true"></i>' : ""}<span class="tb-grow"></span>`
    + (main ? "" : `<button class="icon-btn" type="button" data-act="pane-main" data-pane="${esc(id)}" aria-label="${t("window.panes.make-main", { name: esc(nameOf(id)) })}" data-tip="${t("window.panes.make-main", { name: esc(nameOf(id)) })}">${ic("panel", "s")}</button>`)
    + `<button class="icon-btn" type="button" data-act="pane-x" data-pane="${esc(id)}" aria-label="${close}">${ic("x", "s")}</button>`
    + (last ? `<button class="icon-btn" type="button" data-act="pane-pick" aria-label="${t("window.panes.add")}" data-tip="${t("window.panes.add")}">${ic("plus", "s")}</button>` : "") + "</div>";
}
/** The conversation's scroll area, alone, or with the other panes beside it. */
export function panesWrap(scroll) {
  if (!panesOn()) return scroll;
  const L = layout(), list = shown();
  for (const id of list) if (id !== MAIN) load(id);
  const parts = list.map((id, i) => {
    const on = activeId() === id ? " on19" : "", handle = i < list.length - 1 ? `<div class="pz19" role="separator" aria-orientation="vertical" aria-label="${t("window.panes.resize")}" data-i="${i}"></div>` : "";
    const body = id === MAIN ? scroll : `<div class="bs-body15"><div class="thread">${thread(id)}</div></div>`;
    const tag = id === MAIN ? "section" : "aside", kind = id === MAIN ? "main19" : "beside15";
    return `<${tag} class="pn19 ${kind}${on}" data-pane="${esc(id)}" aria-label="${esc(nameOf(id))}">${tab(id, i === list.length - 1)}${body}</${tag}>${handle}`;
  });
  return `<div class="split15 panes19" role="group" aria-label="${t("window.panes.label")}" >${parts.join("")}</div>`;
}
/** The box's "to" pill: whom Enter sends to, while there are panes. */
export function paneTo() {
  if (!panesOn()) return "";
  const id = activeId();
  return `<span class="to19" id="to19" aria-live="polite">${av(faceOf(id), 18)}<b>${esc(nameOf(id))}</b></span>`;
}
/** The box's words while a pane other than the main one is active, else null. */
export const paneWords = () => (paneTarget() ? t("window.chat.composer.message-to", { name: nameOf(paneTarget()) }) : null);

/* The active pane marked in place: the ring, the tab, the pill and the box's words, without drawing anything again. */
function paintActive() {
  const id = activeId();
  for (const pane of $$(".pn19[data-pane]")) pane.classList.toggle("on19", pane.dataset.pane === id);
  for (const tb of $$(".tab19[data-pane]")) tb.setAttribute("aria-current", String(tb.dataset.pane === id));
  $("#composer")?.classList.toggle("away19", id !== MAIN); // the model and mode chips are the main conversation's
  const pill = $("#to19");
  if (pill) { pill.innerHTML = `${av(faceOf(id), 18)}<b>${esc(nameOf(id))}</b>`; applyCss(pill); }
  const box = $("#prompt"), words = paneWords() ?? box?.dataset.main;
  if (box && words) { box.placeholder = words; box.setAttribute("aria-label", words); }
}
function activate(id) {
  const L = layout();
  if (L.active === id || !shown().includes(id)) return;
  keep({ ...L, active: id });
  paintActive();
}

/* ---------- each pane's task, live ---------- */
function liveOf(id) {
  if (!LIVES.has(id)) LIVES.set(id, liveFollower({ block: `live19-${id}`, scroll: ".bs-body15", onAsk: () => readAsksSoon(true), onGone: render }));
  return LIVES.get(id);
}
/* The task working in pane `id` now, if any, is followed; one that ended lets its follower go. */
function watchLive(id) {
  const run = (E.state?.runs ?? []).filter((r) => r.sessionId === id && LIVE.includes(r.status)).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
  if (run) liveOf(id).follow(run.id);
  else if (LIVES.get(id)?.runId()) LIVES.get(id).stop();
}
let asksAt = 0;
function readAsksSoon(now = false) {
  if (!now && Date.now() - asksAt < 3000) return;
  asksAt = Date.now();
  HOOK.readAsks().catch((error) => toast(error.message));
}
/** A pane's task carried on after its question was answered there: its pane follows it until it stops working. */
export async function followPane(id) {
  await refresh().catch((error) => toast(error.message));
  /* The yes carries the task on a moment later: it is waited for (up to 20 s) before its end is. */
  let seen = false;
  for (let i = 0; i < 600 && paneOpen(id); i++) {
    watchLive(id);
    await load(id, true);
    seen ||= working(id);
    if (seen ? !working(id) : i >= 13) break;
    await new Promise((done) => setTimeout(done, 1500));
    await refresh().catch(() => {});
  }
  render();
}

/* ---------- each pane's conversation ---------- */
const markOf = (id) => JSON.stringify([sessionOf(id)?.updatedAt ?? "", (E.state?.runs ?? []).filter((r) => r.sessionId === id).map((r) => [r.id, r.status])]);
/* Read again when the engine's picture of it changed, or `force`. Only the newest read for a pane is kept. */
async function load(id, force = false) {
  const p = P.get(id) ?? { messages: [], loaded: false, mark: "", sending: false, reading: 0 };
  P.set(id, p);
  watchLive(id);
  const mark = markOf(id);
  if (!force && (p.mark === mark || p.reading)) return;
  p.mark = mark;
  const ticket = ++p.reading;
  let got;
  try { got = await api(`sessions/${encodeURIComponent(id)}`); } catch (error) {
    if (p.reading === ticket) p.reading = 0;
    if (error.status === 404 || error.status === 403) { drop(id); return; } // gone, or not this person's: quietly left out
    toast(error.message);
    return;
  }
  if (p.reading !== ticket) return;
  p.reading = 0;
  const next = got.messages ?? [];
  const same = p.loaded && JSON.stringify(next) === JSON.stringify(p.messages);
  Object.assign(p, { messages: next, loaded: true });
  if (!same) render();
}
function forget(id) { P.delete(id); LIVES.get(id)?.forget(); LIVES.delete(id); }
function drop(id) {
  const L = layout();
  forget(id);
  keep({ ...L, ids: L.ids.filter((x) => x !== id), active: L.active === id ? MAIN : L.active });
  render();
}

/* ---------- sending to a pane ---------- */
/** Whether a message may go to pane `id` now; says why not. Asked before the box's files are taken for it. */
export function paneRoom(id) {
  if (working(id) || waitRoom()) return true;
  toast(t("window.panes.full", { count: LONG_WAITS }));
  return false;
}
/** Sends `prompt` (with `fields`: files sent ahead) to pane `id`'s conversation; answers false when it was not sent. */
export async function sendToPane(id, prompt, fields = {}) {
  const p = P.get(id) ?? { messages: [], loaded: false, mark: "", sending: false, reading: 0 };
  P.set(id, p);
  if ((E.state?.runs ?? []).some((r) => r.sessionId === id && LIVE.includes(r.status)) || p.sending) {
    if (!prompt) return false;
    const said = await api("flows-boards/busy/send", { sessionId: id, prompt }).catch((error) => { toast(error.message); return null; });
    if (!said) return false;
    if (said.message) toast(said.message);
    await refresh().catch((error) => toast(error.message));
    await load(id, true);
    return true;
  }
  if (!paneRoom(id)) return false;
  const before = p.messages;
  p.messages = [...p.messages, { role: "user", content: prompt }];
  p.sending = true;
  renderNow();
  const letGo = holdWait(), follow = setInterval(() => load(id, true), 1500);
  let taken = true;
  try { await api("run", { prompt, sessionId: id, ...fields }); } catch (error) {
    toast(error.message);
    /* Refused at once, or the engine was away: it never got the message, so the words and files stay in the box. */
    if (error.offline || (error.status >= 400 && error.status < 500)) { taken = false; p.messages = before; }
  } finally {
    clearInterval(follow);
    letGo();
    p.sending = false;
    await refresh().catch((error) => toast(error.message));
    await load(id, true);
    render();
  }
  return taken;
}

/* ---------- adding, closing, swapping, moving, widening ---------- */
/* There is one box: what is written in it stays there when another conversation becomes the main one. */
async function openMain(id) {
  const words = $("#prompt")?.value ?? "";
  if (words) { S.drafts[id] = words; S.drafts[S.chat ?? "new"] = ""; }
  await openConversation(id);
}
/** Pulls conversation `id` into a pane (next to the active one), or makes its pane the active one. */
export function addPane(id) {
  if (!id) return;
  const L = layout();
  closePop();
  if (id === S.chat) { activate(MAIN); return; }
  if (!L.ids.includes(id)) L.ids.splice(L.ids.indexOf(activeId()) + 1, 0, id);
  keep({ ...L, active: id });
  renderNow();
  if (NARROW.matches) toast(t("window.chat.beside.wider"));
}
async function closePane(id) {
  const L = layout();
  if (id !== MAIN) { forget(id); keep({ ...L, ids: L.ids.filter((x) => x !== id), active: L.active === id ? MAIN : L.active }); renderNow(); return; }
  /* The main pane closed: the next pane's conversation takes its place. */
  const next = shown().find((x) => x !== MAIN);
  if (!next) return;
  keep({ ...L, ids: L.ids.filter((x) => x !== next), active: MAIN, w: { ...L.w, [MAIN]: L.w[next] ?? L.w[MAIN] } });
  forget(next);
  await openMain(next);
}
/* A pane's conversation becomes the main one (where its approvals and live steps are), and the main one takes its place. */
export async function makeMain(id) {
  const L = layout(), was = S.chat;
  const ids = L.ids.map((x) => (x === MAIN ? (was ?? MAIN) : x === id ? MAIN : x)).filter((x, i, all) => all.indexOf(x) === i);
  if (!ids.includes(MAIN)) ids.unshift(MAIN);
  const w = { ...L.w, [MAIN]: L.w[id] ?? 1, ...(was ? { [was]: L.w[MAIN] ?? 1 } : {}) };
  keep({ ids, active: MAIN, w });
  forget(id);
  await openMain(id);
}
function move(id, to) {
  const L = layout(), list = shown(), from = list.indexOf(id);
  if (from < 0 || to < 0 || to >= list.length || to === from) return false;
  const target = list[to];
  const ids = L.ids.filter((x) => x !== id);
  ids.splice(ids.indexOf(target) + (to > from ? 1 : 0), 0, id);
  keep({ ...L, ids });
  renderNow();
  $(`.tab19[data-pane="${CSS.escape(id)}"]`)?.focus();
  return true;
}
function pick(anchor) {
  const L = layout();
  const rows = E.sessions.filter((s) => sid(s) !== S.chat && !L.ids.includes(sid(s))).slice(0, 10)
    .map((s) => `<button class="mi" type="button" data-act="beside15" data-v="${esc(sid(s))}">${av(chatFace(sid(s)), 22)}<span><span class="mi-t">${esc(nameOf(sid(s)))}</span><span class="mi-s">${esc(plain(String(s.lastMessage || "")).slice(0, 44))}</span></span></button>`).join("");
  openPop(anchor, `<div class="ph">${t("window.chat.beside.open-beside")}</div>${rows || `<p class="hint" data-css="margin:6px 10px">${t("window.panes.none-left")}</p>`}`, { right: true, force: true });
}
/* The handle between two panes: dragging it shares their width between them, kept when let go. */
function widen(handle, e) {
  const split = handle.closest(".panes19"), list = shown(), i = Number(handle.dataset.i);
  const left = handle.previousElementSibling, right = handle.nextElementSibling;
  if (!split || !left || !right) return;
  e.preventDefault();
  const L = layout(), a = list[i], b = list[i + 1];
  const total = left.getBoundingClientRect().width + right.getBoundingClientRect().width, start = e.clientX, from = left.getBoundingClientRect().width;
  const sum = (Number(L.w[a]) || 1) + (Number(L.w[b]) || 1);
  const step = (ev) => {
    const px = Math.min(total - 160, Math.max(160, from + ev.clientX - start));
    L.w[a] = +(sum * px / total).toFixed(3);
    L.w[b] = +(sum - L.w[a]).toFixed(3);
    split.style.setProperty("--cols19", columns(L, split.classList.contains("tight19")));
  };
  const end = () => { removeEventListener("pointermove", step); removeEventListener("pointerup", end); keep(L); document.body.classList.remove("resizing9"); };
  document.body.classList.add("resizing9");
  addEventListener("pointermove", step);
  addEventListener("pointerup", end);
}

/* The main pane's conversation is kept with the layout, and opened again when the window starts with panes beside it
   (the window otherwise starts on a new conversation). One that is gone is not. */
let restored = false;
function followMain() {
  if (!E.loaded) return;
  const L = layout();
  if (!restored) {
    restored = true;
    const kept = S.panes19;
    if (!S.chat && kept?.main && Array.isArray(kept.ids) && kept.ids.length > 1
      && E.sessions.some((s) => sid(s) === kept.main)) { openConversation(kept.main); return; }
  }
  if (panesOn() && S.chat && L.main !== S.chat) keep({ ...L, main: S.chat });
}

/* ---------- listening ---------- */
let dwell = null;
export function initPanes(hooks = {}) {
  Object.assign(HOOK, hooks);
  markLive(["beside15", "pane-x", "pane-main", "pane-pick", "pane-add"]);
  on("beside15", (el) => { if (el.dataset.v == null) pick($('[data-act="chatmenu"]') || el); else if (el.dataset.v) addPane(el.dataset.v); else closePop(); });
  on("pane-pick", (el) => pick(el));
  on("pane-add", (el) => addPane(el.dataset.id));
  on("pane-x", (el) => closePane(el.dataset.pane));
  on("pane-main", (el) => makeMain(el.dataset.pane));
  /* The pane under the pointer becomes the active one after a moment there; a pane focused becomes it at once. */
  document.addEventListener("pointerover", (e) => {
    const pane = e.target.closest?.(".pn19[data-pane]");
    clearTimeout(dwell);
    if (pane && pane.dataset.pane !== activeId()) dwell = setTimeout(() => activate(pane.dataset.pane), 140);
  });
  document.addEventListener("focusin", (e) => { const pane = e.target.closest?.(".pn19[data-pane]"); if (pane) activate(pane.dataset.pane); });
  document.addEventListener("keydown", (e) => {
    const tb = e.target.closest?.(".tab19[data-pane]");
    if (!tb || !e.altKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
    e.preventDefault();
    move(tb.dataset.pane, shown().indexOf(tb.dataset.pane) + (e.key === "ArrowLeft" ? -1 : 1));
  });
  document.addEventListener("dragstart", (e) => { const tb = e.target.closest?.(".tab19[data-pane]"); if (tb) { e.dataTransfer.setData("application/x-branch-pane", tb.dataset.pane); e.dataTransfer.effectAllowed = "move"; } });
  document.addEventListener("dragover", (e) => { if (e.target.closest?.(".tab19[data-pane]") && e.dataTransfer.types.includes("application/x-branch-pane")) e.preventDefault(); });
  document.addEventListener("drop", (e) => {
    const tb = e.target.closest?.(".tab19[data-pane]"), id = e.dataTransfer.getData("application/x-branch-pane");
    if (!tb || !id) return;
    e.preventDefault();
    move(id, shown().indexOf(tb.dataset.pane));
  });
  document.addEventListener("pointerdown", (e) => { const handle = e.target.closest?.(".pz19"); if (handle) widen(handle, e); });
  NARROW.addEventListener("change", () => render());
  onRender(followMain);
  addEventListener("resize", sizePanes);
  afterDraw(sizePanes);
}
