/* What each message in a conversation offers, and the readouts around it (design doc 4.2, audit A.3):
   - the action row: Edit (go back to just before a message and send it again: POST /api/sessions/{id}/rewind, undone
     with /unrevert), pin (GET/POST /api/sessions/{id}/pins) and Look inside (GET /api/runs/{id}/inspect);
   - the pinned bar above the thread, and the list of every pin;
   - "/" at the start of the box: the engine's commands and saved prompts (GET /api/commands?surface=window);
   - "@": call a Trunk (GET /api/trunks, already read into E.trunks);
   - the waiting line, messages queued while a task works (GET /api/sessions/{id}/followups; reorder, remove and reword
     through POST /api/flows-boards/waiting/followups/move|remove|edit);
   - Room left and today's spend in the status bar (GET /api/sessions/{id}/context, GET /api/usage);
   - Copy on a reply puts its words on the clipboard (the browser's own, no route).
   - parity B1: Try again (back to just before the words that asked, then the same words again), each row's "Sent at",
     a pin's time, Look inside's Read first and Tools offered with Copy the record, the Skills list for " /" and the
     + menu, the @ list's other computers and material, and Room left's Round by round and Tidy up (/compact).
   Branch from here and More are chat/branches.js and chat/more.js (pass 17). */

import { withBlanksFilled } from "../flows/whatcan.js";
import { mcpMentionRows } from '../mcp-native.js';
import { $, esc, render, renderNow, afterDraw } from "../core/dom.js";
import { S, E } from "../core/state.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { ic, av, mi, toast, openPop, closePop, openDlg, closeDlg } from "../core/ui.js";
import { markLive } from "../core/features.js";
import { moreButton, addMoreItem } from "./more.js";
import { loadSteps, everyStepItem } from "./timeline.js"; // pass 17: Look inside and More gain "Every step"
import { t, language, plural } from "../../i18n.js";
import { flagOf, loadFlags } from "./flag.js";
import { sentAt } from "./furniture.js"; // parity B1: when a message was written (GET /api/sessions/<id> messages[].at)
import { remoteTrunks } from "./beside.js"; // E2: asked only while "Trunks on other computers" is on
import { CF } from "./comfort.js"; // message times Always: the time is on the message itself, not in this row

const M = { sid: null, pins: [], followUps: [], room: null, spend: null, commands: null, slashBox: null, slashI: 0, edit: null };
/* What the conversation module hands over: its state, a way to send words, and a way to re-read a conversation. */
let X = { state: () => ({ sessionId: null, messages: [] }), sendText: async () => {}, reopen: async () => {} };

const plain = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const sid = () => X.state().sessionId;
const mine = () => M.sid && M.sid === sid();
const report = (error) => { toast(error.message); return null; };

/* ---------- the action row on each message ---------- */
const pinOf = (m) => (mine() ? M.pins.find((p) => p.sourceId === m.messageId) : undefined);
const pinnable = (m) => (m.role === "user" || m.role === "assistant") && !m.toolCalls?.length;
export const pinnedClass = (m) => (pinOf(m) ? " pinned15" : "");

function pinButton(m) {
  if (!mine() || !pinnable(m)) return "";
  const held = !!pinOf(m);
  return `<button type="button" aria-label="${held ? t("window.chat.msg.unpin-this") : t("window.chat.msg.pin-this")}" data-act="pin15" data-mid="${esc(m.messageId)}" aria-pressed="${held}">${ic("pin")}</button>`;
}

/* The task that answered a message: this conversation's latest task started by the words just before it. */
function runFor(m) {
  const list = X.state().messages ?? [];
  const asked = list.slice(0, list.indexOf(m)).reverse().find((x) => x.role === "user" && x.from !== "branch"); // Q206: never Branch's own nudge
  if (!asked) return null;
  return latestRun((r) => r.sessionId === sid() && r.prompt === asked.content);
}
function latestRun(wanted) {
  return (E.state?.runs ?? []).filter(wanted).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0] ?? null;
}

export function msgActs(m) {
  if (!m.messageId) return "";
  /* A path is taken from a settled conversation: while its answer is pending, Branch from here waits. */
  const held = X.state().sending ? " disabled" : "";
  const branch = `<button type="button" aria-label="${t("window.chat.branches.from-here")}" data-act="br17c" data-mid="${esc(m.messageId)}"${held}>${ic("branch")}</button>${moreButton(m)}`; // pass 17: chat/branches.js, chat/more.js
  if (m.role === "user")
    return `<div class="msg-acts"><button type="button" aria-label="${t("prompts.action.edit")}" data-act="u-edit" data-mid="${esc(m.messageId)}">${ic("edit")}</button>${branch}${pinButton(m)}${sentTime(m)}</div>`;
  const run = runFor(m);
  const look = run ? `<button type="button" aria-label="${t("inspector.open")}" data-act="inspect" data-run="${esc(run.id)}">${ic("eye")}</button>` : "";
  return `<div class="msg-acts"><button type="button" aria-label="${t("asks.examples.copy")}" data-act="copy15" data-mid="${esc(m.messageId)}">${ic("copy")}</button>${retryButton(m, held)}${look}<button type="button" aria-label="${t("settings.card.report")}" data-act="flag" data-sid="${esc(sid() ?? "")}" data-mid="${esc(m.messageId)}" aria-pressed="${!!flagOf(sid(), m.messageId)}">${ic("flag")}</button>${branch}${pinButton(m)}${sentTime(m)}</div>`;
}
/* The prototype's "Sent at" at the end of the row, from when the engine wrote the message (On hover, the engine's own
   default; Always draws it on the message instead, chat/comfort.js). */
const sentTime = (m) => { const at = CF.times || CF.hideTimes ? "" : sentAt(m); return at ? `<span class="ts15" aria-label="${esc(t("window.chat.msg.sent-at", { time: at }))}">${esc(at)}</span>` : ""; };
/* Try again: the words that asked for this reply, sent again after going back to just before them. Only a reply that
   answers words of the owner's has any to send. */
const askedBy = (m) => { const list = X.state().messages ?? []; return list.slice(0, list.indexOf(m)).reverse().find((x) => x.role === "user" && x.messageId); };
const retryButton = (m, held) => (askedBy(m) ? `<button type="button" aria-label="${t("first-run-trouble.retry")}" data-act="retry15" data-mid="${esc(m.messageId)}"${held}>${ic("retry")}</button>` : "");

/* ---------- Copy: the message's words as they were written (its Markdown) ---------- */
/* Through the clipboard; where the window refuses it, through a selection instead; the clipboard's refusal is said only
   when that fails too. */
async function copyMessage(el) {
  const m = (X.state().messages ?? []).find((x) => x.messageId === Number(el.dataset.mid));
  if (!m) return;
  const words = String(m.content ?? "");
  try { await navigator.clipboard.writeText(words); } catch (error) {
    if (!copyBySelection(words)) { toast(error.message); return; }
  }
  toast(t("message.copied"));
}
function copyBySelection(words) {
  const before = document.activeElement, box = document.createElement("textarea");
  box.value = words;
  box.readOnly = true;
  box.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
  document.body.append(box);
  box.select();
  let done = false;
  try { done = document.execCommand("copy"); } catch { done = false; }
  box.remove();
  before?.focus?.({ preventScroll: true });
  return done;
}

/* ---------- pins ---------- */
/** Hook (PARITY.md chat-029, B6's conversation menu row "Pinned messages N"): how many messages are pinned in `sid`, as
    last read (GET /api/sessions/<id>/pins); the row can open the list with the act `pinlist15`. */
export const pinnedCount = (sid) => (M.sid === sid ? M.pins.length : 0);
export function pinsBar() {
  if (!mine() || !M.pins.length) return "";
  const last = M.pins[M.pins.length - 1];
  const more = M.pins.length > 1 ? `<button type="button" class="pin-n15" data-act="pinlist15" aria-label="${t("window.chat.msg.all-pinned")}">${M.pins.length}</button>` : "";
  return `<div class="pins15" role="region" aria-label="${t("window.chat.msg.pinned-messages")}"><span class="pin-i15">${ic("pin", "s")}</span><button type="button" class="pin-t15" data-act="pinjump15" data-mid="${esc(last.sourceId)}"><b>${t("window.chat.msg.pinned")}</b> ${esc(plain(last.content).slice(0, 90))}</button>${more}</div>`;
}
const pinsPop = () => `<div class="ph">${t("window.chat.msg.pinned-here")}</div>${M.pins.map((p) => `<div class="mi pinrow15"><button type="button" class="grow" data-act="pinjump15" data-mid="${esc(p.sourceId)}"><span class="mi-t">${esc(plain(p.content).slice(0, 70))}</span>${pinTime(p)}</button><button type="button" class="icon-btn" aria-label="${t("accounts.action.unpin")}" data-act="pin15" data-mid="${esc(p.sourceId)}">${ic("x", "s")}</button></div>`).join("")}`;

/* A pin's row carries when its message was written, as the prototype's does. */
const pinTime = (p) => { const at = sentAt((X.state().messages ?? []).find((m) => m.messageId === p.sourceId)); return at ? `<span class="mi-s">${esc(at)}</span>` : ""; };

async function loadPins(id) {
  const got = await api(`sessions/${id}/pins`).catch(report);
  if (got && M.sid === id) M.pins = got.pins ?? [];
}

/* A pin is held against the message's lasting identity (sourceId); the engine takes and gives back its row id. */
async function togglePin(el) {
  const id = sid(), wanted = Number(el.dataset.mid);
  if (!id || !wanted) return;
  const held = M.pins.find((p) => p.sourceId === wanted);
  closePop();
  try {
    await api(`sessions/${id}/pins`, { messageId: held ? held.messageId : wanted, pinned: !held });
  } catch (error) { toast(error.message); return; }
  await loadPins(id);
  renderNow();
  toast(held ? t("settings.pins.unpinned") : t("window.chat.msg.pinned-toast"));
}

function jump(el) {
  closePop();
  const target = document.querySelector(`#conversation [data-i15="${CSS.escape(el.dataset.mid)}"]`);
  if (!target) return;
  target.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  target.classList.add("flash15");
  setTimeout(() => target.classList.remove("flash15"), 1400);
}

/* ---------- edit an earlier message and go back to just before it ---------- */
const WHAT = [["both", "rewind.choice.both"], ["conversation", "rewind.choice.conversation"], ["files", "rewind.choice.files"]];

async function editAt(el) {
  const id = sid(), wanted = Number(el.dataset.mid);
  const m = (X.state().messages ?? []).find((x) => x.messageId === wanted && x.role === "user");
  if (!id || !m) return;
  const status = await api(`sessions/${id}/rewind`).catch(report);
  if (!status) return;
  M.edit = { sid: id, mid: wanted, what: "both" };
  const note = status.note ? `<p class="hint">${esc(status.note)}</p>` : "";
  openDlg({
    title: t("window.chat.msg.edit-title"),
    body: `<textarea class="inp" id="rw-text" rows="3" aria-label="${t("composer.yourMessage")}">${esc(m.content)}</textarea><div class="fld" data-css="margin-top:10px"><span>${t("window.chat.msg.go-back")}</span><span class="seg" role="group" aria-label="${t("settings-kit.field.reset")}">${WHAT.map(([v, l]) => `<button type="button" data-act="rw-what" data-v="${v}" aria-pressed="${v === M.edit.what}">${t(l)}</button>`).join("")}</span></div><p class="hint">${t("window.chat.msg.undo-that")}</p>${note}`,
    foot: `<button class="btn ghost" type="button" data-act="dlg-close">${t("first-run-steps.restore-no")}</button><button class="btn pri" type="button" data-act="rw-go">${t("composer.send")}</button>`,
  });
}

function editWhat(el) {
  if (!M.edit) return;
  for (const b of el.parentElement.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b === el));
  M.edit.what = el.dataset.v;
}

/* The engine's own note wins when the files could not all come back (no snapshot, nothing recorded). */
function wentBack(what, files) {
  if (files && (files.method === "none" || files.note)) return files.note;
  return what === "conversation" ? t("window.chat.msg.went-back-conv") : t("window.chat.msg.went-back-files");
}

async function editGo() {
  const r = M.edit, text = ($("#rw-text")?.value ?? "").trim();
  if (!r || !text) return;
  let done;
  try { done = await api(`sessions/${r.sid}/rewind`, { messageId: r.mid, restore: r.what }); } catch (error) { toast(error.message); return; }
  closeDlg();
  M.edit = null;
  await X.reopen(r.sid);
  toast(wentBack(r.what, done.files), () => undoRewind(r.sid));
  X.sendText(text);
}

async function undoRewind(id) {
  try { await api(`sessions/${id}/unrevert`, {}); } catch (error) { toast(error.message); return; }
  await X.reopen(id);
}

/* Try again: back to just before the words that asked (the conversation only; files stay as they are), then the same
   words again (POST /api/sessions/<id>/rewind, then the ordinary send). Undo in the toast brings the reply back. */
async function retry(el) {
  const id = sid(), m = (X.state().messages ?? []).find((x) => x.messageId === Number(el.dataset.mid));
  const asked = m && askedBy(m);
  if (!id || !asked || X.state().sending) return;
  try { await api(`sessions/${id}/rewind`, { messageId: asked.messageId, restore: "conversation" }); } catch (error) { toast(error.message); return; }
  await X.reopen(id);
  toast(t("window.chat.msg.went-back-conv"), () => undoRewind(id));
  X.sendText(asked.content);
}

/* ---------- Look inside ---------- */
function who() {
  const s = E.sessions.find((x) => (x.sessionId ?? x.id) === sid());
  return E.trunks.find((tr) => tr.id === s?.trunkId || tr.id === s?.trunk?.id)?.name || "Branch";
}
function contextWords(n) {
  const limit = mine() ? M.room?.limit : 0;
  return limit ? t("window.chat.msg.context-of", { n: n.toLocaleString(language()), limit: limit.toLocaleString(language()), pct: Math.round((n / limit) * 100) }) : n.toLocaleString(language());
}

async function inspect(el) {
  closePop();
  const runId = el.dataset.run || latestRun((r) => r.sessionId === sid())?.id;
  if (!runId) return;
  const rec = await api(`runs/${runId}/inspect`).catch(report);
  if (!rec) return;
  const last = rec.rounds?.filter((round) => !round.check).at(-1); // the answer's own round, not the second opinion's after it
  const rows = [[t("coding.ci.model"), last?.model], [t("window.chat.msg.words"), last?.promptTokens != null ? contextWords(last.promptTokens) : ""], ...readRows(rec),
    [t("window.chat.msg.time"), rec.seconds != null ? t("window.chat.msg.seconds", { n: rec.seconds }) : ""], [t("window.chat.msg.timing"), timingLine(rec.timing)],
    [t("window.chat.msg.cost"), rec.cost?.display],
    /* models-ui: the second opinion's note (Settings › Models › Second opinion), kept beside the answer, never in it. */
    [t("window.chat.msg.second-opinion"), rec.advice?.line]].filter(([, v]) => v);
  const steps = (await loadSteps(runId))?.steps?.length ?? 0;
  if (steps) rows.push([t("window.chat.msg.steps"), t("window.chat.msg.steps-in", { count: steps })]);
  M.record = rec;
  openDlg({
    title: t("inspector.open"),
    body: `<p class="lede" data-css="margin:0">${t("window.chat.msg.went-into", { name: esc(who()) })}</p><dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("")}</dl>`,
    foot: `${steps ? `<button class="btn pri" type="button" data-act="tlopen17c" data-run="${esc(runId)}">${ic("tl17c", "s")}${t("recording.page.steps")}</button>` : ""}<button class="btn" type="button" data-act="insp-copy">${t("window.chat.msg.copy-record")}</button>`,
  });
}
/* Where the time went (src/inspect.ts timing): each part the record can say, in seconds, in order. */
function timingLine(timing) {
  const parts = timing?.parts ?? [];
  if (!parts.length) return "";
  return parts.map((p) => `${t(`window.chat.msg.timing-${p.part}`)} ${(p.ms / 1000).toFixed(1)} s`).join(" · ");
}
/* What the task read first (the instruction files carried in, and how many remembered things) and the tools it was offered. */
function readRows(rec) {
  const files = rec.readFirst?.files ?? [], n = rec.readFirst?.remembered;
  const read = [...files, n ? plural(n, { one: "window.chat.msg.remembers.one", other: "window.chat.msg.remembers" }) : ""].filter(Boolean).join(", ");
  const tools = rec.toolsOffered ? t("window.chat.msg.tools-offered", { shown: rec.toolsOffered.shown, more: rec.toolsOffered.oneStepAway }) : "";
  return [[t("window.chat.msg.read-first"), read], [t("window.chat.msg.tools"), tools]].filter(([, v]) => v);
}
/* Copy the record: the engine's own record of the task, as Look inside read it. */
async function copyRecord() {
  if (!M.record) return;
  const words = JSON.stringify(M.record, null, 2);
  try { await navigator.clipboard.writeText(words); } catch (error) { if (!copyBySelection(words)) { toast(error.message); return; } }
  toast(t("window.chat.msg.copied-record"));
}

/* ---------- "/" commands and saved prompts at the start of the box ---------- */
function slashItems(value) {
  const q = value.slice(1).toLowerCase();
  return (M.commands ?? []).filter((c) => c.listed !== false && c.name.startsWith(q))
    .map((c) => ({ v: `/${c.name} `, label: `/${c.name}`, arg: c.args, d: c.saved ? `${c.english} · ${t("window.chat.msg.saved-prompt")}` : c.english }));
}

function drawSlash() {
  const box = $("#prompt"), form = $("#composer");
  $(".slash6")?.remove();
  if (!box || !form || !M.commands) return;
  const value = box.value;
  if (!value.startsWith("/") || /\s/.test(value)) return;
  const items = slashItems(value);
  if (!items.length) return;
  M.slashI = Math.min(M.slashI, items.length - 1);
  form.insertAdjacentHTML("beforeend", `<div class="slash6" role="listbox" aria-label="${t("window.chat.msg.commands")}">${items.map((x, i) => `<button type="button" role="option" class="${i === M.slashI ? "sel6" : ""}" data-act="slash6-pick" data-i="${i}"><b>${esc(x.label)}</b>${x.arg ? `<code>${esc(x.arg)}</code>` : ""}<small>${esc(x.d)}</small></button>`).join("")}<span class="slash-f">${t("window.chat.msg.same-commands")}</span></div>`);
}

/* The list is read when the menu opens (the box starts with "/" again, or it is a new box after a redraw) and again after a
   prompt is saved (the "branch-prompts" event), not on every key. */
async function slashTyped() {
  const box = $("#prompt");
  if (!box?.value.startsWith("/")) { M.slashBox = null; $(".slash6")?.remove(); return; }
  if (M.slashBox !== box || !M.commands) {
    M.slashBox = box;
    const got = await api("commands?surface=window").catch(report);
    if (!got) { M.slashBox = null; return; }
    M.commands = got.commands ?? [];
  }
  drawSlash();
}

function setBox(value) {
  const box = $("#prompt");
  if (!box) return;
  box.value = value;
  box.focus();
  box.setSelectionRange(value.length, value.length);
  box.dispatchEvent(new Event("input", { bubbles: true }));
}

function pickSlash(i) {
  const it = slashItems($("#prompt")?.value ?? "")[i];
  if (!it) return;
  $(".slash6")?.remove();
  setBox(it.v);
}

/* ---------- "@" calls a Trunk ---------- */
const mentionOpen = () => !!document.querySelector(".pop [data-act='mention-pick'], .pop [data-act='slash-pick'], .pop [data-act='mcp-mention-open']");
/* The prototype's @ list: this computer's Trunks, the Trunks on the owner's other computers (POST /api/reach/trunks/remote,
   which only looks, read once a minute at most and only while that part is on: beside.js remoteTrunks), and material the engine reads for an @: the project's changes
   (@diff) and a web page (@https://…). */
/* Pass 18: "@ to call a Trunk" is a hint at the top of the @ list (the room's box says only "Message the room"). */
const mentionPop = () => `<p class="athint18c">${t("window.chat.composer.at-hint")}</p><div class="ph">${t("window.chat.msg.call-trunk")}</div>${E.trunks.map((tr) => `<button class="mi" type="button" data-act="mention-pick" data-v="${esc(tr.name)}">${av(tr, 22)}<span><span class="mi-t">${esc(tr.name)}</span><span class="mi-s">${esc(tr.title ?? "")}</span></span></button>`).join("")}${awayRows()}<div class="ph">${t("window.chat.msg.material")}</div>${MATERIAL().map(([v, icon, name, sub]) => `<button class="mi" type="button" data-act="mention-pick" data-v="${v}"><span class="ico">${ic(icon, "s")}</span><span><span class="mi-t">${name}</span><span class="mi-s">${sub}</span></span></button>`).join("")}`;
const MATERIAL = () => [["diff", "branch", t("window.chat.media.changes-diff"), t("window.chat.msg.changes-sub")], ["https://", "globe", t("window.chat.msg.a-link"), t("window.chat.msg.a-link-sub")]];
const away = { at: 0, rows: [] };
const nativeMentionPop = mentionPop;
function withNativeMentions() { return nativeMentionPop() + (E.profiles?.isOwner !== false ? mcpMentionRows() : ''); }
function awayRows() {
  if (Date.now() - away.at > 60000) {
    away.at = Date.now();
    remoteTrunks().then((computers) => { away.rows = computers.flatMap((c) => (c.trunks ?? []).map((tr) => ({ ...tr, machine: c.machine }))); if (mentionOpen()) mentionTyped($("#prompt")); }, report);
  }
  if (!away.rows.length) return "";
  return `<div class="ph">${t("window.chat.beside.other-computers")}</div>${away.rows.map((tr) => `<button class="mi" type="button" data-act="mention-pick" data-v="${esc(String(tr.address ?? tr.handle ?? "").replace(/^@/, ""))}">${av({ name: tr.name }, 22)}<span><span class="mi-t">${esc(tr.name)}</span><span class="mi-s">${esc([tr.machine, tr.title].filter(Boolean).join(" · "))}</span></span></button>`).join("")}`;
}
/* The prototype's Skills list: the skills switched on (GET /api/state skills), each put in the box as /name. */
const skillsOn = () => (E.state?.skills ?? []).filter((s) => s.activeVersion && s.name);
const skillsPop = () => `<div class="ph">${t("folder-trust.kind.skills")}</div>${skillsOn().map((s) => `<button class="mi" type="button" data-act="slash-pick" data-v="/${esc(s.name)}"><span class="mi-t" data-css="font-family:var(--mono)">/${esc(s.name)}</span><span class="r">${esc(s.description ?? "")}</span></button>`).join("")}`;
/** Opens the skills list over the box (the + menu's Use a skill). */
export function openSkills() {
  const box = $("#prompt");
  if (!box || !skillsOn().length) return false;
  openPop($("#composer"), skillsPop(), { force: true });
  box.focus();
  return true;
}

/* The list opens over the box while the person keeps typing, so the box keeps focus and caret. */
function mentionTyped(box) {
  if (!box) return;
  const at = box.selectionStart;
  if (/(^|\s)@\w*$/.test(box.value)) openPop($("#composer"), withNativeMentions(), { force: true });
  else if (/\s\/\w*$/.test(box.value) && skillsOn().length) openPop($("#composer"), skillsPop(), { force: true });
  else { if (mentionOpen()) closePop(); return; }
  box.focus();
  box.setSelectionRange(at, at);
}

function pickMention(el) {
  const box = $("#prompt");
  closePop();
  if (box) setBox(box.value.replace(/@\w*$/, "") + "@" + el.dataset.v + (el.dataset.v === "https://" ? "" : " "));
}
function pickSkill(el) {
  const box = $("#prompt");
  closePop();
  if (box) setBox(box.value.replace(/\/\w*$/, "").replace(/(\S)$/, "$1 ") + el.dataset.v + " ");
}

/* Arrows, Enter, Tab and Escape belong to an open list before the box sends anything. */
function listKeys(e) {
  if (e.target.id !== "prompt") return;
  const list = $(".slash6");
  if (list) {
    const n = list.querySelectorAll("[role='option']").length;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { M.slashI = (M.slashI + (e.key === "ArrowDown" ? 1 : n - 1)) % n; drawSlash(); }
    else if (e.key === "Enter" || e.key === "Tab") pickSlash(M.slashI);
    else if (e.key === "Escape") list.remove();
    else return;
  } else if (mentionOpen()) {
    if (e.key === "Enter") document.querySelector(".pop [data-act='mention-pick'], .pop [data-act='slash-pick']")?.click();
    else if (e.key === "Escape") closePop();
    else return;
  } else return;
  e.preventDefault();
  e.stopPropagation();
}

/* ---------- the waiting line ---------- */
export function queueRow() {
  if (!mine() || !M.followUps.length) return "";
  return `<div class="dockrow15"><button type="button" class="bgchip15 q15" data-act="queue15" aria-haspopup="menu">${ic("clock", "s")}${t("window.chat.msg.waiting", { count: M.followUps.length })}</button></div>`;
}
const queuePop = () => `<div class="ph">${t("window.chat.msg.queue-title")}</div>${M.followUps.map((f, i) => `<div class="mi qrow15"><span class="q-n15">${i + 1}</span><input class="inp" value="${esc(f.prompt)}" data-sw="q15" data-q15="${esc(f.id)}" aria-label="${t("window.chat.msg.queued-n", { n: i + 1 })}"><button type="button" class="icon-btn" aria-label="${t("accounts.action.up")}" data-act="qup15" data-id="${esc(f.id)}" ${i ? "" : "disabled"}>${ic("up", "s")}</button><button type="button" class="icon-btn" aria-label="${t("accounts.action.remove")}" data-act="qrm15" data-id="${esc(f.id)}">${ic("x", "s")}</button></div>`).join("") || `<p class="hint" data-css="margin:6px 10px">${t("window.chat.msg.nothing-waiting")}</p>`}`;

/* The every-few-seconds re-read stays quiet when it fails: the status bar already says the engine is not answering. */
async function loadQueue(id, polling = false) {
  const got = await api(`sessions/${id}/followups`).catch(polling ? () => null : report);
  if (!got || M.sid !== id) return false;
  const before = JSON.stringify(M.followUps);
  M.followUps = got.followUps ?? [];
  return before !== JSON.stringify(M.followUps);
}

const QUEUE_ROUTES = { move: "flows-boards/waiting/followups/move", remove: "flows-boards/waiting/followups/remove", edit: "flows-boards/waiting/followups/edit" };
async function changeQueue(how, body) {
  const id = sid();
  if (!id) return false;
  try {
    const got = await api(QUEUE_ROUTES[how], { sessionId: id, ...body });
    M.followUps = got.followUps ?? [];
    return true;
  } catch (error) { toast(error.message); return false; }
}

async function moveQueued(el, how) {
  closePop();
  await changeQueue(how, { id: el.dataset.id, ...(how === "move" ? { direction: "up" } : {}) });
  renderNow();
  const chip = document.querySelector('#main .dock [data-act="queue15"]');
  if (chip && M.followUps.length) openPop(chip, queuePop(), { force: true });
}

async function reword(input) {
  const prompt = input.value.trim();
  if (prompt && (await changeQueue("edit", { id: input.dataset.q15, prompt }))) toast(t("window.chat.msg.reworded"));
}

/* ---------- Room left and spend, in the status bar ---------- */
const money = (n) => `$${Number(n).toFixed(2)}`;
const roomPct = () => Math.max(0, Math.min(100, Math.round((M.room.left / M.room.limit) * 100)));
const kilo = (n) => (n >= 1000 ? `${Math.round(n / 1000)}K` : String(n));

/** Hook (PARITY.md shell-019, B6's status bar): the conversation's own items, Room left and today's spend. */
/* The prototype's Room left colours (pass 10): by the share already used. */
const roomColour = (used) => (used >= 95 ? "var(--bad)" : used >= 80 ? "#E8912F" : used >= 50 ? "var(--warn)" : "var(--ok)");
export function statusItems() {
  const room = S.view === "chat" && mine() && M.sid === S.chat && M.room?.limit && M.room.limitKnown !== false && E.state?.activeModel
    ? `<button class="sb" type="button" data-act="roommenu" data-tip="${t("window.chat.msg.room-tip")}">${t("window.chat.msg.room-left")} <span class="meter"><u data-css="width:${roomPct()}%;background:${roomColour(100 - roomPct())}"></u></span> ${roomPct()}%</button>` : "";
  const spend = M.spend && M.spend.today != null ? `<button class="sb hide-sm" type="button" data-act="spendmenu">${t("window.chat.msg.today", { amount: money(M.spend.today) })}</button>` : "";
  return room + spend;
}

function roomPop() {
  const r = M.room, part = (n) => Math.round(((n ?? 0) / r.limit) * 100);
  const bars = [[t("nav.chat"), r.conversation], [t("memory.movein.kind.instructions"), r.instructions], [t("dashboard.filter.tools"), r.tools]]
    .map(([n, v]) => `<div class="brow"><span>${n}</span><span class="track"><u data-css="width:${Math.min(100, part(v) * 5)}%"></u></span><span class="v">${part(v)}%</span></div>`).join("");
  const tidy = (M.commands ?? []).some((c) => c.name === "compact") ? "tidyconv15" : "tidyconv15-off";
  return `<div class="pt">${t("window.chat.msg.room-title")}</div><p class="pp">${t("window.chat.msg.room-free", { pct: roomPct(), limit: kilo(r.limit) })}</p><div data-css="padding:0 10px 8px"><div class="bars">${bars}</div></div>${roundsBlock()}<hr>${mi(tidy, "spark", t("window.chat.msg.tidy"))}`;
}

/* Pass 15's "Round by round": the words each of the conversation's last eight model rounds sent, and how much of it the
   provider's own cache served (GET /api/runs/<id>/inspect rounds, for this conversation's newest tasks). The share from
   the cache is said only when the provider said what it served. */
async function loadRounds() {
  const newest = (E.state?.runs ?? []).filter((r) => r.sessionId === sid()).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 4);
  const got = await Promise.all(newest.map((r) => api(`runs/${encodeURIComponent(r.id)}/inspect`).catch(() => null)));
  M.rounds = got.filter(Boolean).reverse().flatMap((rec) => rec.rounds ?? []).filter((r) => typeof r.tokens?.input === "number" && r.tokens.input > 0).slice(-8);
}
function roundsBlock() {
  const r = M.rounds ?? [];
  if (!r.length) return "";
  const most = Math.max(...r.map((x) => x.tokens.input)), said = r.filter((x) => typeof x.tokens.cachedInput === "number");
  const cached = said.length ? Math.round((said.reduce((n, x) => n + x.tokens.cachedInput, 0) / said.reduce((n, x) => n + x.tokens.input, 0)) * 100) : null;
  const bars = r.map((x, i) => `<i data-css="height:${Math.round((x.tokens.input / most) * 100)}%" title="${esc(t("window.chat.msg.round-words", { n: i + 1, words: kilo(x.tokens.input) }))}"><u data-css="height:${typeof x.tokens.cachedInput === "number" ? Math.round((x.tokens.cachedInput / x.tokens.input) * 100) : 0}%"></u></i>`).join("");
  return `<div class="rounds15"><div class="r-h15"><b>${t("window.chat.msg.rounds")}</b>${cached === null ? "" : `<small>${t("window.chat.msg.reused", { pct: cached })}</small>`}</div><div class="r-bars15" role="img" aria-label="${esc(t("window.chat.msg.rounds-label", { count: r.length }))}">${bars}</div><small class="r-k15"><span class="k-a15"></span>${t("window.chat.msg.new")} <span class="k-b15"></span>${t("window.chat.msg.from-cache")}</small></div>`;
}
async function openRoom(el) {
  await Promise.all([loadRounds(), M.commands ? null : api("commands?surface=window").then((got) => { M.commands = got.commands ?? []; }, report)]);
  openPop(el, roomPop());
}
/* Tidy up this conversation: the engine's /compact, which folds the earlier part into a summary (POST /api/commands/run).
   Live only while the engine lists /compact for this window. */
async function tidy() {
  closePop();
  let done;
  try { done = await api("commands/run", { surface: "window", line: "/compact", sessionId: sid() }); } catch (error) { toast(error.message); return; }
  if (done?.text) toast(done.text);
  await loadRoom(sid());
  document.dispatchEvent(new Event("branch-summary"));
  render();
}

function spendPop() {
  const week = M.spend.week != null ? ` · ${t("window.chat.msg.this-week", { amount: money(M.spend.week) })}` : "";
  return `<div class="pt">${t("dashboard.area.spend")}</div><p class="pp">${t("window.chat.msg.today", { amount: money(M.spend.today) })}${week}.</p><hr>${mi("setgo", "sliders", esc(t("window.chat.msg.data-usage")), "", 'data-v="usage"')}`;
}

/* A day's cost is known only when its tasks were priced; a day with only unpriced tasks has no amount. */
const dayCost = (d) => (d.pricedRuns ? d.estimatedCost : d.runs ? null : 0);
async function loadSpend() {
  const got = await api("usage?range=7d&by=day").catch(report);
  if (!got) return;
  const days = got.data ?? [], today = new Date().toISOString().slice(0, 10);
  const day = days.find((d) => d.date === today);
  const costs = days.map(dayCost);
  M.spend = { today: day ? dayCost(day) : 0, week: costs.includes(null) && !costs.some((c) => c) ? null : costs.reduce((a, c) => a + (c ?? 0), 0) };
}

async function loadRoom(id) {
  const got = await api(`sessions/${id}/context`).catch(report);
  if (got && M.sid === id) M.room = got;
}

/* ---------- loading ---------- */
/* Everything above for one conversation, read when it opens and after each message. */
const drawn = () => JSON.stringify([M.sid, M.pins, M.followUps, M.room, M.spend]);
/* The switch to another conversation is drawn by the caller's own redraw; this redraws again only if what it read differs. */
export async function loadExtras(id) {
  if (M.sid !== id) Object.assign(M, { sid: id, pins: [], followUps: [], room: null });
  const before = drawn();
  const jobs = [loadSpend(), loadFlags()];
  if (id) jobs.push(loadPins(id), loadQueue(id), loadRoom(id));
  await Promise.all(jobs);
  if (drawn() !== before) render();
}

function openPrompts() {
  closePop();
  S.view = "chat";
  renderNow();
  setBox("/");
}

async function usePrompt(el) {
  const got = await api("prompts").catch(report);
  const p = (got?.prompts ?? []).find((x) => x.id === el.dataset.v || x.command === el.dataset.v);
  if (!p) return;
  // QA retest 2026-09-28 (m16): its blanks are asked for first, as What can Branch do's Try it asks them.
  withBlanksFilled(p.title ?? "", p.body, (text) => {
    S.view = "chat";
    S.drafts[S.chat ?? "new"] = text;
    renderNow();
    $("#prompt")?.focus();
  });
}

export function initMessages(context) {
  X = context;
  addMoreItem((m) => (m.role === "assistant" ? everyStepItem(runFor(m)?.id) : "")); // pass 17: More › Every step behind this reply
  markLive(["copy15", "sw:rw-text", "sw:q15", "pin15", "pinjump15", "pinlist15", "u-edit", "rw-what", "rw-go", "undo", "inspect", "slash6-pick", "prompts-fill",
    "mention-pick", "queue15", "qup15", "qrm15", "roommenu", "spendmenu", "retry15", "insp-copy", "slash-pick", "tidyconv15"]);
  on("retry15", (el) => retry(el));
  on("insp-copy", () => copyRecord());
  on("slash-pick", (el) => pickSkill(el));
  on("tidyconv15", () => tidy());
  on("copy15", (el) => copyMessage(el));
  on("pin15", (el) => togglePin(el));
  on("pinjump15", (el) => jump(el));
  /* From the conversation menu (shell/extras.js) the list opens beside the menu's own button, as the menu closes. */
  on("pinlist15", (el) => { const menu = el.closest(".pop") && document.querySelector('[data-act="chatmenu"]'); openPop(menu || el, pinsPop(), menu ? { force: true, right: true } : {}); });
  on("u-edit", (el) => editAt(el));
  on("rw-what", (el) => editWhat(el));
  on("rw-go", () => editGo());
  on("undo", () => { document.querySelector(".toast")?.remove(); const again = toast.undo; toast.undo = null; again?.(); });
  on("inspect", (el) => inspect(el));
  on("slash6-pick", (el) => pickSlash(+el.dataset.i));
  on("prompts-fill", () => openPrompts());
  /* Hook (PARITY.md places-031, B3's saved prompts): Use puts the saved prompt's words in the box (GET /api/prompts, by
     its id or command, as Automations › Procedures names it). */
  on("prompt-use", (el) => usePrompt(el));
  markLive(["prompt-use"]);
  on("mention-pick", (el) => pickMention(el));
  on("queue15", (el) => openPop(el, queuePop()));
  on("qup15", (el) => moveQueued(el, "move"));
  on("qrm15", (el) => moveQueued(el, "remove"));
  on("roommenu", (el) => openRoom(el));
  on("spendmenu", (el) => openPop(el, spendPop()));
  document.addEventListener("keydown", listKeys, true);
  document.addEventListener("input", (e) => { if (e.target.id === "prompt") { M.slashI = 0; slashTyped(); mentionTyped(e.target); } });
  document.addEventListener("branch-prompts", () => { M.commands = null; });
  /* The list closes when the box loses focus for good; a redraw that puts focus back in the box keeps it. */
  document.addEventListener("focusout", (e) => { if (e.target.id === "prompt") setTimeout(() => { if (document.activeElement?.id !== "prompt" && !document.activeElement?.closest(".slash6")) $(".slash6")?.remove(); }, 150); });
  /* A redraw of the message box (a read that finishes while the person types) draws the list again over the new box. */
  afterDraw(() => { if (M.commands && $("#prompt")?.value.startsWith("/") && !$(".slash6")) drawSlash(); });
  document.addEventListener("change", (e) => { if (e.target.dataset?.q15) reword(e.target); });
  /* The waiting line changes while a task works; re-read it every few seconds while its conversation is open. */
  setInterval(async () => { if (S.view === "chat" && mine() && (await loadQueue(M.sid, true))) render(); }, 4000);
}
