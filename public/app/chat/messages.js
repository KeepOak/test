/* What each message in a conversation offers, and the readouts around it (design doc 4.2, audit A.3):
   - the action row: Edit (go back to just before a message and send it again: POST /api/sessions/{id}/rewind, undone
     with /unrevert), pin (GET/POST /api/sessions/{id}/pins) and Look inside (GET /api/runs/{id}/inspect);
   - the pinned bar above the thread, and the list of every pin;
   - "/" at the start of the box: the engine's commands and saved prompts (GET /api/commands?surface=window);
   - "@": call a Trunk (GET /api/trunks, already read into E.trunks);
   - the waiting line, messages queued while a task works (GET /api/sessions/{id}/followups; reorder, remove and reword
     through POST /api/flows-boards/waiting/followups/move|remove|edit);
   - Room left and today's spend in the status bar (GET /api/sessions/{id}/context, GET /api/usage);
   - choosing the active project from the sidebar (POST /api/projects/active).
   - Copy on a reply puts its words on the clipboard (the browser's own, no route).
   Try again, Report a problem and Tidy up stay greyed until each has its own real action; Branch from here and
   More are chat/branches.js and chat/more.js (pass 17). */

import { $, esc, render, renderNow } from "../core/dom.js";
import { S, E } from "../core/state.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { ic, av, mi, toast, openPop, closePop, openDlg, closeDlg } from "../core/ui.js";
import { markLive } from "../core/features.js";
import { moreButton, addMoreItem } from "./more.js";
import { loadSteps, everyStepItem } from "./timeline.js"; // pass 17: Look inside and More gain "Every step"
import { t, language } from "../../i18n.js";
import { flagOf, loadFlags } from "./flag.js";

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
  const asked = list.slice(0, list.indexOf(m)).reverse().find((x) => x.role === "user");
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
    return `<div class="msg-acts"><button type="button" aria-label="${t("prompts.action.edit")}" data-act="u-edit" data-mid="${esc(m.messageId)}">${ic("edit")}</button>${branch}${pinButton(m)}</div>`;
  const run = runFor(m);
  const look = run ? `<button type="button" aria-label="${t("inspector.open")}" data-act="inspect" data-run="${esc(run.id)}">${ic("eye")}</button>` : "";
  return `<div class="msg-acts"><button type="button" aria-label="${t("asks.examples.copy")}" data-act="copy15" data-mid="${esc(m.messageId)}">${ic("copy")}</button><button type="button" aria-label="${t("first-run-trouble.retry")}" data-act="toast">${ic("retry")}</button>${look}<button type="button" aria-label="${t("settings.card.report")}" data-act="flag" data-sid="${esc(sid() ?? "")}" data-mid="${esc(m.messageId)}" aria-pressed="${!!flagOf(sid(), m.messageId)}">${ic("flag")}</button>${branch}${pinButton(m)}</div>`;
}

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
export function pinsBar() {
  if (!mine() || !M.pins.length) return "";
  const last = M.pins[M.pins.length - 1];
  const more = M.pins.length > 1 ? `<button type="button" class="pin-n15" data-act="pinlist15" aria-label="${t("window.chat.msg.all-pinned")}">${M.pins.length}</button>` : "";
  return `<div class="pins15" role="region" aria-label="${t("window.chat.msg.pinned-messages")}"><span class="pin-i15">${ic("pin", "s")}</span><button type="button" class="pin-t15" data-act="pinjump15" data-mid="${esc(last.sourceId)}"><b>${t("window.chat.msg.pinned")}</b> ${esc(plain(last.content).slice(0, 90))}</button>${more}</div>`;
}
const pinsPop = () => `<div class="ph">${t("window.chat.msg.pinned-here")}</div>${M.pins.map((p) => `<div class="mi pinrow15"><button type="button" class="grow" data-act="pinjump15" data-mid="${esc(p.sourceId)}"><span class="mi-t">${esc(plain(p.content).slice(0, 70))}</span></button><button type="button" class="icon-btn" aria-label="${t("accounts.action.unpin")}" data-act="pin15" data-mid="${esc(p.sourceId)}">${ic("x", "s")}</button></div>`).join("")}`;

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
  const last = rec.rounds?.at(-1);
  const rows = [[t("coding.ci.model"), last?.model], [t("window.chat.msg.words"), last?.promptTokens != null ? contextWords(last.promptTokens) : ""],
    [t("window.chat.msg.time"), rec.seconds != null ? t("window.chat.msg.seconds", { n: rec.seconds }) : ""], [t("window.chat.msg.cost"), rec.cost?.display]].filter(([, v]) => v);
  const steps = (await loadSteps(runId))?.steps?.length ?? 0;
  if (steps) rows.push([t("window.chat.msg.steps"), t("window.chat.msg.steps-in", { count: steps })]);
  openDlg({
    title: t("inspector.open"),
    body: `<p class="lede" data-css="margin:0">${t("window.chat.msg.went-into", { name: esc(who()) })}</p><dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("")}</dl>`,
    foot: `${steps ? `<button class="btn pri" type="button" data-act="tlopen17c" data-run="${esc(runId)}">${ic("tl17c", "s")}${t("recording.page.steps")}</button>` : ""}<button class="btn" type="button" data-act="toast">${t("window.chat.msg.copy-record")}</button>`,
  });
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
const mentionOpen = () => !!document.querySelector(".pop [data-act='mention-pick']");
const mentionPop = () => `<div class="ph">${t("window.chat.msg.call-trunk")}</div>${E.trunks.map((tr) => `<button class="mi" type="button" data-act="mention-pick" data-v="${esc(tr.name)}">${av(tr, 22)}<span><span class="mi-t">${esc(tr.name)}</span><span class="mi-s">${esc(tr.title ?? "")}</span></span></button>`).join("")}`;

/* The list opens over the box while the person keeps typing, so the box keeps focus and caret. */
function mentionTyped(box) {
  if (/(^|\s)@\w*$/.test(box.value) && E.trunks.length) {
    const at = box.selectionStart;
    openPop($("#composer"), mentionPop(), { force: true });
    box.focus();
    box.setSelectionRange(at, at);
  } else if (mentionOpen()) closePop();
}

function pickMention(el) {
  const box = $("#prompt");
  closePop();
  if (box) setBox(box.value.replace(/@\w*$/, "") + "@" + el.dataset.v + " ");
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
    if (e.key === "Enter") document.querySelector(".pop [data-act='mention-pick']")?.click();
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

export function statusItems() {
  const room = S.view === "chat" && mine() && M.sid === S.chat && M.room?.limit && M.room.limitKnown !== false && E.state?.activeModel
    ? `<button class="sb" type="button" data-act="roommenu" data-tip="${t("window.chat.msg.room-tip")}">${t("window.chat.msg.room-left")} <span class="meter"><u data-css="width:${roomPct()}%"></u></span> ${roomPct()}%</button>` : "";
  const spend = M.spend && M.spend.today != null ? `<button class="sb hide-sm" type="button" data-act="spendmenu">${t("window.chat.msg.today", { amount: money(M.spend.today) })}</button>` : "";
  return room + spend;
}

function roomPop() {
  const r = M.room, part = (n) => Math.round(((n ?? 0) / r.limit) * 100);
  const bars = [[t("nav.chat"), r.conversation], [t("memory.movein.kind.instructions"), r.instructions], [t("dashboard.filter.tools"), r.tools]]
    .map(([n, v]) => `<div class="brow"><span>${n}</span><span class="track"><u data-css="width:${Math.min(100, part(v) * 5)}%"></u></span><span class="v">${part(v)}%</span></div>`).join("");
  return `<div class="pt">${t("window.chat.msg.room-title")}</div><p class="pp">${t("window.chat.msg.room-free", { pct: roomPct(), limit: kilo(r.limit) })}</p><div data-css="padding:0 10px 8px"><div class="bars">${bars}</div></div><hr>${mi("toast", "spark", t("window.chat.msg.tidy"))}`;
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

/* ---------- the active project ---------- */
async function chooseProject(el) {
  try {
    const active = await api("projects/active", { active: el.dataset.v });
    S.activeProject = active.id;
  } catch (error) { toast(error.message); }
  renderNow();
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
  S.view = "chat";
  S.drafts[S.chat ?? "new"] = p.body;
  renderNow();
  $("#prompt")?.focus();
}

export function initMessages(context) {
  X = context;
  addMoreItem((m) => (m.role === "assistant" ? everyStepItem(runFor(m)?.id) : "")); // pass 17: More › Every step behind this reply
  markLive(["copy15", "sw:rw-text", "sw:q15", "pin15", "pinjump15", "pinlist15", "u-edit", "rw-what", "rw-go", "undo", "inspect", "slash6-pick", "prompts-fill",
    "mention-pick", "queue15", "qup15", "qrm15", "roommenu", "spendmenu", "project"]);
  on("copy15", (el) => copyMessage(el));
  on("pin15", (el) => togglePin(el));
  on("pinjump15", (el) => jump(el));
  on("pinlist15", (el) => openPop(el, pinsPop()));
  on("u-edit", (el) => editAt(el));
  on("rw-what", (el) => editWhat(el));
  on("rw-go", () => editGo());
  on("undo", () => { document.querySelector(".toast")?.remove(); const again = toast.undo; toast.undo = null; again?.(); });
  on("inspect", (el) => inspect(el));
  on("slash6-pick", (el) => pickSlash(+el.dataset.i));
  on("prompts-fill", () => openPrompts());
  /* Live once Automations › Procedures draws its saved prompts from GET /api/prompts (it reads a field the engine lacks). */
  on("prompt-use", (el) => usePrompt(el));
  on("mention-pick", (el) => pickMention(el));
  on("queue15", (el) => openPop(el, queuePop()));
  on("qup15", (el) => moveQueued(el, "move"));
  on("qrm15", (el) => moveQueued(el, "remove"));
  on("roommenu", (el) => openPop(el, roomPop()));
  on("spendmenu", (el) => openPop(el, spendPop()));
  on("project", (el) => chooseProject(el));
  document.addEventListener("keydown", listKeys, true);
  document.addEventListener("input", (e) => { if (e.target.id === "prompt") { M.slashI = 0; slashTyped(); mentionTyped(e.target); } });
  document.addEventListener("branch-prompts", () => { M.commands = null; });
  document.addEventListener("focusout", (e) => { if (e.target.id === "prompt") setTimeout(() => { if (!document.activeElement?.closest(".slash6")) $(".slash6")?.remove(); }, 150); });
  document.addEventListener("change", (e) => { if (e.target.dataset?.q15) reword(e.target); });
  /* The waiting line changes while a task works; re-read it every few seconds while its conversation is open. */
  setInterval(async () => { if (S.view === "chat" && mine() && (await loadQueue(M.sid, true))) render(); }, 4000);
}
