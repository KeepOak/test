/* RES-701, from OpenClaw 2.0: the Home panel. The default Trunk (GET /api/trunks defaultId, in its own conversation;
   while the engine names none, as with Trunks off, a conversation of the panel's own) opens in a panel beside any page: a conversation, Settings, a place. It has its own
   message box and its own conversation, read from and sent to the engine like any other (POST /api/run, or the busy
   send while a task works there).
   Above the box sits "Working on": a snapshot of the page the person is on (its name, the row they last picked on it
   (a conversation, a task or a file, from the page's own lists) and the words they selected on it, if any). Its eye shows the exact words that go in front of the message; its x leaves them out until the page changes.
   The panel's full-page button opens its conversation (or a new one) as the page, with the draft in the box and the
   snapshot still attached, as a chip by the box that the next message carries (chat/chat.js addSendPrefix). */

import { $, esc, afterDraw, paintChanged, applyCss, render, renderNow } from "../core/dom.js";
import { S, E, save, refresh, ownName, ownerHere, defaultTrunk } from "../core/state.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive, greyOut } from "../core/features.js";
import { ic, av, toast, dialog } from "../core/ui.js";
import { text, plain } from "../chat/markdown.js";
import { openConversation, startConversation, addDockItem, addSendPrefix } from "../chat/chat.js";
import { attachedChips, pickFiles, readyUploads, filesSent, hasFiles, moveFiles } from "../chat/attach.js";
import { newConversationMode } from "../chat/chips.js";
import { simplePart } from "./simple.js";
import { t } from "../../i18n.js";
import { initHistoryIdeas } from "./history-ideas.js";
import { initTodayActivity } from "./today-activity.js";
import { initHomeConversation } from "./home-conversation.js";
import { initHomeListKeys } from "./home-accessibility.js";

const H = { sid: undefined, messages: [], sending: false, mark: "", seeing: false, left: null, picked: null, row: null, carried: null };
let homeOpener = null;
const BUSY = ["running", "queued", "waiting", "needs_input"];

/* ---------- who the panel talks to ---------- */
/* The default Trunk the engine names (GET /api/trunks defaultId, core/state.js defaultTrunk), in its own conversation. */
export const homeTrunk = () => defaultTrunk() ?? null;
const homeSid = () => homeTrunk()?.chatSessionId ?? S.home19?.sid ?? null;
const panelOpen = () => S.home19?.open === true;
const keep = (patch) => { S.home19 = { open: false, sid: null, ...S.home19, ...patch }; save(); };

/* ---------- Working on ---------- */
const words = (selector) => $(selector)?.textContent?.replace(/\s+/g, " ").trim() ?? "";
const sessionTitle = (id) => { const s = E.sessions.find((x) => (x.sessionId ?? x.id) === id); return ownName(id) || s?.title || plain(s?.opening ?? "") || ""; };
/** The page the person is on, by the names the window shows for it: a conversation's title, a Settings page, a place and its tab. */
function pageNow() {
  if (S.view === "chat") return S.chat ? sessionTitle(S.chat) || t("comfort.field.newConversation") : t("comfort.field.newConversation");
  if (S.view === "settings") return [t("memory.movein.kind.setting"), words('.set-nav .nav[aria-current="true"]')].filter(Boolean).join(" › ");
  return [words('#side .side-nav .nav[aria-current="true"]'), words('#main .tabs [aria-selected="true"]')].filter(Boolean).join(" › ");
}
/** The snapshot as it would be sent, or null when there is nothing to say or the person took it off this page. */
function snapshot() {
  const page = pageNow();
  if (!page || H.left === page) return null;
  const picked = H.picked?.page === page ? H.picked.words : "";
  const row = H.row?.page === page ? H.row : null;
  return { page, picked, row };
}
const rowText = (row) => t(`window.home.snap.row.${row.kind}`, { name: row.name });
const snapshotText = (snap) => (snap ? [t("window.home.snap.page", { page: snap.page }), snap.row ? rowText(snap.row) : "", snap.picked ? t("window.home.snap.picked", { words: snap.picked }) : ""].filter(Boolean).join("\n") : "");

/* The row the person picked on the page, by what the page's own list says it is: a conversation (a row that opens one),
   a file (a row with a file's tile), a task (a row that replays or steers a run), else an item; named by its title. */
const ROWS = "#main .prow, #main .row[data-id], #main .rw18 .row";
function kindOf(row) {
  if (row.matches('[data-act="chat"]') || row.querySelector('[data-act="chat"]')) return "conversation";
  if (row.querySelector(".fi")) return "file";
  if (row.querySelector('[data-act="replay"], [data-act^="lw-"], [data-act="bgopen15"]')) return "task";
  return "item";
}
function notePickedRow(e) {
  const row = e.target.closest?.(ROWS);
  if (!row || row.closest("#home19")) return;
  const name = (row.querySelector("b")?.textContent ?? row.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
  if (name) H.row = { page: pageNow(), kind: kindOf(row), name };
}

/* The words the person selected on the page (not in the panel), kept with the page they were on. */
function notePicked() {
  const sel = document.getSelection();
  const node = sel?.anchorNode?.nodeType === 1 ? sel.anchorNode : sel?.anchorNode?.parentElement;
  if (!node || !node.closest?.("#main") || node.closest("#home19")) return;
  const picked = String(sel).replace(/\s+/g, " ").trim().slice(0, 600);
  if (picked) H.picked = { page: pageNow(), words: picked };
}

/* ---------- the panel ---------- */
function thread() {
  const rows = H.messages.filter((m) => (m.role === "user" || m.role === "assistant") && !m.toolCalls?.length && m.from !== "branch" && String(m.content ?? "").trim());
  const face = faceHere(24);
  const out = rows.map((m) => (m.role === "user" ? `<div class="u">${esc(m.content)}</div>` : `<div class="b"><div class="gut">${face}</div><div><div class="txt">${text(m.content)}</div></div></div>`));
  const waits = (E.state?.attention ?? []).some((w) => (w.open || w.sessionId) === homeSid());
  if (waits) out.push(`<p class="hm19-wait">${ic("bell", "s")}${t("window.home.needs-you")}<button class="btn sm" type="button" data-act="home19-full">${t("ov.open")}</button></p>`);
  if (H.sending || busy()) out.push(`<div class="b"><div class="gut">${face}</div><div><span class="typing" aria-label="${t("window.chat.typing")}"><i></i><i></i><i></i></span></div></div>`);
  return out.join("") || `<p class="hm19-empty">${t("window.home.empty", { name: esc(nameNow()) })}</p>`;
}
/* The default Trunk's own moving face; with none named the panel wears no face (Branch's mark stays on the logo). */
const faceHere = (size) => (homeTrunk() ? av(homeTrunk(), size) : "");
const nameNow = () => homeTrunk()?.name || E.state?.identity?.name || "Branch";
const busy = () => { const sid = homeSid(); return !!sid && (E.state?.runs ?? []).some((r) => r.sessionId === sid && BUSY.includes(r.status)); };

function snapRow() {
  const snap = snapshot();
  if (!snap) return "";
  const seen = H.seeing ? `<pre class="hm19-sent" aria-label="${t("window.home.snap.sent")}">${esc(snapshotText(snap))}</pre>` : "";
  return `<div class="hm19-snap"><span class="hm19-chip">${ic("pin", "s")}<span class="grow"><small>${t("window.home.snap.title")}</small><b>${esc(snap.page)}</b>${snap.row ? `<small class="hm19-pick">${esc(rowText(snap.row))}</small>` : ""}${snap.picked ? `<small class="hm19-pick">“${esc(snap.picked.slice(0, 80))}”</small>` : ""}</span>`
    + `<button class="icon-btn" type="button" data-act="home19-see" aria-expanded="${H.seeing}" aria-label="${t("window.home.snap.see")}" data-tip="${t("window.home.snap.see")}">${ic("eye", "s")}</button>`
    + `<button class="icon-btn" type="button" data-act="home19-drop" aria-label="${t("window.home.snap.remove")}" data-tip="${t("window.home.snap.remove")}">${ic("x", "s")}</button></span>${seen}</div>`;
}

function panel() {
  const draft = S.drafts.home19 ?? "";
  const words = esc(t("window.chat.composer.message-to", { name: nameNow() }));
  return `<section class="hm19 glass" role="region" aria-keyshortcuts="Escape" aria-label="${t("window.home.label", { name: esc(nameNow()) })}">
    <header class="hm19-h">${faceHere(30)}<b class="grow">${esc(nameNow())}</b>
      ${ownerHere() ? '<button class="btn ghost" type="button" data-act="history-ideas">Ideas</button>' : ""}
      ${ownerHere() ? '<button class="btn ghost" type="button" data-act="today-activity">Today</button>' : ""}
      ${ownerHere() ? '<button class="btn ghost" type="button" data-act="home-conversation">Home conversation</button>' : ""}
      <button class="icon-btn" type="button" data-act="home19-new" aria-label="${t("comfort.field.newConversation")}" data-tip="${t("comfort.field.newConversation")}"${homeTrunk() ? " disabled" : ""}>${ic("plus", "s")}</button>
      <button class="icon-btn" type="button" data-act="home19-full" aria-label="${t("window.home.full")}" data-tip="${t("window.home.full")}">${ic("panel", "s")}</button>
      <button class="icon-btn" type="button" data-act="home19" aria-label="${t("window.home.close")}">${ic("x", "s")}</button></header>
    <p class="home-sr" role="status" aria-live="polite" aria-atomic="true">${H.sending || busy() ? esc(t("window.chat.typing")) : ""}</p>
    <div class="hm19-scroll" id="home19-scroll" tabindex="0" role="region" aria-label="Home conversation messages"><div class="thread">${thread()}</div></div>
    <div class="hm19-dock">${snapRow()}<div id="home19-attached">${attachedChips("home19")}</div><form class="composer hm19-box" id="home19-form"><button class="c-btn" type="button" data-act="home19-attach" aria-label="${t("window.home.attach")}" data-tip="${t("window.home.attach")}">${ic("clip")}</button><textarea id="home19-prompt" rows="1" placeholder="${words}" aria-label="${words}">${esc(draft)}</textarea>
      <button class="c-btn send${draft.trim() ? " ready" : ""}" type="submit" aria-label="${t("composer.send")}">${ic("up")}</button></form></div></section>`;
}

function drawHome() {
  const box = $("#home19");
  if (!box) return;
  const open = panelOpen() && !document.getElementById("app")?.classList.contains("focus");
  box.hidden = !open;
  $("#body")?.classList.toggle("home-on", open);
  if (!open) { box.innerHTML = ""; return; }
  if (paintChanged(box, panel())) { applyCss(box); greyOut(box); const scroll = $("#home19-scroll"); if (scroll) scroll.scrollTop = scroll.scrollHeight; }
  loadThread();
}

/* The panel's conversation read again when the engine's picture of it changed (its row in the list, its tasks). */
async function loadThread(force = false) {
  const sid = homeSid();
  if (H.sending) return;
  if (!sid) { if (H.sid !== null) { H.sid = null; H.messages = []; render(); } return; }
  const mark = JSON.stringify([sid, E.sessions.find((s) => (s.sessionId ?? s.id) === sid)?.updatedAt ?? "", (E.state?.runs ?? []).filter((r) => r.sessionId === sid).map((r) => r.status)]);
  if (!force && mark === H.mark && H.sid === sid) return;
  H.mark = mark;
  let got;
  try { got = await api(`sessions/${encodeURIComponent(sid)}`); } catch (error) {
    if (error.status === 404 && !homeTrunk()) { keep({ sid: null }); H.messages = []; render(); return; } // it was deleted
    toast(error.message); return;
  }
  if (homeSid() !== sid) return;
  H.sid = sid;
  H.messages = got.messages ?? [];
  render();
}

/* ---------- sending ---------- */
/* A new conversation starts as the owner's new conversations do: their chosen mode (Ask first, Plan, …), never looser,
   and filed under the default project, as the main box's first message is (chat/chat.js startMode, newProject). */
async function startFields() {
  return { ...(await newConversationMode()), ...(ownerHere() ? { project: "default" } : {}) };
}
async function send() {
  const box = $("#home19-prompt"), said = (box?.value ?? "").trim();
  if ((!said && !hasFiles("home19")) || H.sending) return;
  const lead = snapshotText(snapshot()), prompt = lead ? `${lead}\n\n${said}` : said, sid = homeSid();
  S.drafts.home19 = "";
  if (box) box.value = "";
  H.sending = true;
  H.messages = [...H.messages, { role: "user", content: prompt }];
  renderNow();
  try {
    if (sid && busy()) {
      /* While a task works the words join its waiting line; files wait on their chips for the next message. */
      const queued = await api("flows-boards/busy/send", { sessionId: sid, prompt });
      if (queued?.message) toast(queued.message);
    } else {
      const uploads = await readyUploads("home19");
      const run = await api("run", { prompt, ...(sid ? { sessionId: sid } : await startFields()), ...(uploads.length ? { uploads } : {}) });
      filesSent("home19");
      if (!homeTrunk()) keep({ sid: run.sessionId });
    }
  } catch (error) {
    toast(error.message);
    if (error.offline) S.drafts.home19 = said; // the engine never got it: the words go back in the box
  } finally {
    H.sending = false;
    await refresh().catch((error) => toast(error.message));
    await loadThread(true);
    renderNow();
  }
}

/* ---------- the full page ---------- */
/** The panel as the page: its conversation (or a new one), with the draft in the box and the snapshot kept by the box. */
async function fullPage() {
  const sid = homeSid(), draft = $("#home19-prompt")?.value ?? S.drafts.home19 ?? "", lead = snapshotText(snapshot());
  H.carried = lead ? { key: sid ?? "new", words: lead, page: snapshot().page } : null;
  keep({ open: false });
  S.drafts.home19 = "";
  S.drafts[sid ?? "new"] = draft;
  moveFiles("home19", "main"); // the files wait by the page's box, sent with its next message
  if (sid) await openConversation(sid); else startConversation();
  $("#prompt")?.focus();
}
/* The carried snapshot, a chip by the full page's box until the next message there takes it, or its x. */
function carriedChip(sid) {
  const c = H.carried;
  if (!c || c.key !== (sid ?? "new")) return "";
  return `<div class="hm19-carried"><span class="hm19-chip">${ic("pin", "s")}<span class="grow"><small>${t("window.home.snap.title")}</small><b>${esc(c.page)}</b></span><button class="icon-btn" type="button" data-act="home19-uncarry" aria-label="${t("window.home.snap.remove")}">${ic("x", "s")}</button></span></div>`;
}
function takeCarried(sid) {
  const c = H.carried;
  if (!c || c.key !== (sid ?? "new")) return "";
  H.carried = null;
  return c.words;
}

/* RES-704: Simple closes the panel; Advanced opens it again if it was open. */
simplePart({ name: "home19", take: () => panelOpen(), hide: () => { if (panelOpen()) keep({ open: false }); }, give: (open) => { if (typeof open === "boolean") keep({ open }); } });

/** The title row's button that opens and closes the panel. */
export function homeButton() {
  return `<button class="tb-btn" type="button" data-act="home19" aria-expanded="${panelOpen()}" aria-controls="home19" aria-label="${t("window.home.label", { name: esc(nameNow()) })}" data-tip="${t("window.home.label", { name: esc(nameNow()) })}">${ic("chat", "s")}</button>`;
}

function toggle() {
  const open = !panelOpen();
  if (open) homeOpener = document.activeElement;
  keep({ open });
  H.seeing = false;
  renderNow();
  if (open) $("#home19-prompt")?.focus();
  else if (homeOpener?.isConnected && !homeOpener.closest?.("#home19")) homeOpener.focus({ preventScroll: true });
  else document.querySelector('[data-act="home19"][aria-controls="home19"]')?.focus({ preventScroll: true });
}

export function initHome() {
  initHomeListKeys();
  initHistoryIdeas();
  initTodayActivity();
  initHomeConversation();
  markLive(["home19-attach", "home19", "home19-new", "home19-full", "home19-see", "home19-drop", "home19-uncarry", "sw:home19-prompt"]);
  on("home19", () => toggle());
  on("home19-full", () => fullPage());
  on("home19-attach", () => pickFiles(false, "home19"));
  on("home19-new", () => { if (homeTrunk()) return; keep({ sid: null }); H.messages = []; H.mark = ""; renderNow(); $("#home19-prompt")?.focus(); });
  on("home19-see", () => { H.seeing = !H.seeing; renderNow(); });
  on("home19-drop", () => { H.left = pageNow(); H.seeing = false; renderNow(); });
  on("home19-uncarry", () => { H.carried = null; renderNow(); });
  addDockItem(carriedChip);
  addSendPrefix(takeCarried);
  document.addEventListener("input", (e) => {
    if (e.target.id !== "home19-prompt") return;
    S.drafts.home19 = e.target.value;
    e.target.closest("form")?.querySelector(".send")?.classList.toggle("ready", !!e.target.value.trim());
  });
  document.addEventListener("submit", (e) => { if (e.target.id === "home19-form") { e.preventDefault(); send(); } });
  document.addEventListener("keydown", (e) => {
    if (e.defaultPrevented || e.isComposing || e.keyCode === 229) return;
    if (e.key === "Escape" && e.target.closest?.("#home19") && panelOpen() && !dialog() && !document.querySelector(".pop, .palette, .gsel-pop")) {
      e.preventDefault(); e.stopImmediatePropagation(); toggle(); return;
    }
    if (e.target.id === "home19-prompt" && e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && !e.repeat) { e.preventDefault(); send(); }
  }, true);
  document.addEventListener("selectionchange", notePicked);
  document.addEventListener("pointerdown", notePickedRow, true);
  document.addEventListener("focusin", notePickedRow);
  afterDraw(drawHome); // after the view is drawn: "Working on" reads the page the person now sees
}
