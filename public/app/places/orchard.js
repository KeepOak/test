/* Orchard: Automations › Orchard, the board your Trunks work from (docs/orchard-canopy.md; engine src/orchard). It takes
   the place of the shared board that tab had, with its cards moved in.
   - GET /api/orchard[?board=<id>]: the boards (each with its count per column) and one board's cards in Seed, Growing,
     Ripe, Picked and Blocked. A growing card carries its task's newest live steps and the questions it waits on, each
     bound to its exact request by a fingerprint.
   - A card shows its title, who has it (that Trunk's own face, or a line icon for Branch), what it waits for, whether
     it waits for the owner's yes (a card a Trunk or a chat posted), its comments and failed tries. Buttons do what the
     engine does for that column: Plant it (POST .../assign, the owner's yes), Grow now (.../grow), Pause, Resume and
     Stop (the task's own /api/runs/<id>/pause, resume, cancel), Pick and Send back (.../move), Reset (.../reset).
   - A question on a card is answered as everywhere else: No or Allow once, by conversation and fingerprint, through
     POST /api/policy/approve, and only a question that carries a fingerprint (Q257).
   - Drag a card to a column to move it (.../move), or onto a Trunk's face to give it to them (.../assign); the card's
     menu does both from the keyboard. Open shows its notes, what it waits for (link, unlink), its comments (edit your own, remove any) and history; Edit
     changes its title and notes. The boards menu adds, renames and removes an empty board.
   Every engine refusal is shown as the engine said it. */

import { $, esc, renderNow } from "../core/dom.js";
import { E } from "../core/state.js";
import { ic, av, toast, openPop, closePop, openDlg, closeDlg } from "../core/ui.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { api } from "../core/api.js";
import { t, language, plural } from "../../i18n.js";
import { offTile } from "./switch-on.js";
import { empty18 } from "../core/p18.js";

const LANES = ["seed", "growing", "ripe", "picked", "blocked"];
const O = { view: null, problem: "", board: null, busy: new Set(), open: null, comments: {}, editing: null };
/* Q257: a question the engine bound to the exact request shown (its fingerprint); only such a question is answered here. */
const exactAsk = (q) => /^[a-f0-9]{32}$/.test(String(q?.fingerprint ?? ""));

const trunks = () => (Array.isArray(E.trunks) ? E.trunks : []);
const trunkOf = (id) => (id ? trunks().find((tr) => tr.id === id) : undefined);
const branchName = () => E.state?.identity?.name ?? "";
const cards = () => LANES.flatMap((lane) => O.view?.lanes?.[lane] ?? []);
const cardOf = (id) => cards().find((c) => c.id === id);
const laneWord = (lane) => t(`window.places.orchard.lane.${lane}`);
const whoHas = (c) => trunkOf(c.assignee)?.name ?? branchName();
/* A Trunk's own face; Branch's work shows a line icon (the mascot is only the logo). */
const faceOf = (c, size = 18) => (trunkOf(c.assignee) ? av(trunkOf(c.assignee), size) : `<span class="orc-branch">${ic("spark", "s")}</span>`);

function meta(c) {
  const waits = (c.after ?? []).map(cardOf).filter((p) => p && p.lane !== "picked");
  return [
    !c.planted ? `<span class="pill idle">${t("window.places.orchard.needs-yes")}</span>` : "",
    waits.length === 1 ? `<small>${esc(t("window.places.orchard.waits-for", { title: waits[0].title }))}</small>` : "",
    waits.length > 1 ? `<small>${esc(t("window.places.orchard.waits-for-count", { count: waits.length }))}</small>` : "",
    c.comments ? `<small class="orc-n">${ic("chat", "s")}${c.comments}</small>` : "",
    c.failures ? `<small class="orc-bad">${esc(plural(c.failures, { one: "window.places.orchard.failed-count.one", other: "window.places.orchard.failed-count" }))}</small>` : "",
  ].join("");
}

/* A growing card's newest steps, as the engine said them, and its questions with No and Allow once. */
function liveOf(c) {
  const steps = (c.live?.steps ?? []).map((s) => `<li class="orc-${esc(s.state)}"><span aria-hidden="true">${esc(s.icon)}</span><span>${esc(s.label)}</span></li>`).join("");
  const asks = (c.asks ?? []).filter(exactAsk).map((q) => {
    const id = `data-sid="${esc(q.sessionId)}" data-fp="${esc(q.fingerprint)}"${O.busy.has(`${q.sessionId}\n${q.fingerprint}`) ? " disabled" : ""}`;
    return `<div class="hpask17c orc-ask"><span class="pill idle">${esc(q.tool)}</span><span class="grow"><b>${esc(q.question || q.label)}</b><small>${esc(q.bytes || q.target || "")}</small></span><span class="hpbtn17c"><button class="btn ghost sm" type="button" data-act="orc-ask" data-v="deny" ${id}>${t("autonomy.needs.no")}</button><button class="btn pri sm" type="button" data-act="orc-ask" data-v="allow" ${id}>${t("window.chat.helpers.allow-once")}</button></span></div>`;
  }).join("");
  return `${steps ? `<ol class="orc-steps" aria-live="polite">${steps}</ol>` : ""}${asks}`;
}

/* What each column's card can do, as the engine allows it there. */
function buttons(c) {
  const id = `data-id="${esc(c.id)}"`, btn = (act, key, cls = "") => `<button class="btn sm ${cls}" type="button" data-act="${act}" ${id}>${t(key)}</button>`;
  if (c.lane === "seed") return c.planted ? btn("orc-grow", "window.places.orchard.grow") : btn("orc-plant", "window.places.orchard.plant", "pri");
  if (c.lane === "growing" || c.live) {
    if (!c.runId) return "";
    const run = `data-run="${esc(c.runId)}"`;
    const paused = c.live?.status === "interrupted";
    return `<button class="btn sm" type="button" data-act="${paused ? "orc-resume" : "orc-pause"}" ${id} ${run}>${t(paused ? "autonomy.resume" : "autonomy.pause")}</button><button class="btn sm ghost" type="button" data-act="orc-stop" ${id} ${run}>${t("dashboard.stop")}</button>`;
  }
  if (c.lane === "ripe") return `${btn("orc-pick", "window.places.orchard.pick", "pri")}${btn("orc-back", "window.places.orchard.send-back")}`;
  if (c.lane === "blocked") return c.stuck ? btn("orc-reset", "flowsBoards.board.reset") : btn("orc-back", "window.places.orchard.back-to-seed");
  return "";
}

function card(c) {
  const acts = buttons(c);
  return `<div class="card15 orc-card${c.asks?.length ? " orc-you" : ""}" role="listitem" draggable="true" data-orc-card="${esc(c.id)}"><button type="button" class="orc-title" data-act="orc-open" data-id="${esc(c.id)}">${esc(c.title)}</button><span class="c-foot15">${faceOf(c)}<small>${esc(whoHas(c))}</small>${meta(c)}</span>${c.live ? liveOf(c) : ""}${acts ? `<span class="orc-acts">${acts}</span>` : ""}<button type="button" class="c-mv15" data-act="orc-menu" data-id="${esc(c.id)}" aria-label="${t("window.places.automations.move-title", { title: esc(c.title) })}">${ic("more", "s")}</button></div>`;
}

/* The Trunks a card can be dropped on to give it to them, and Branch itself. They are drop targets only; from the
   keyboard, a card's menu gives it. */
function givers() {
  const one = (id, face, name) => `<div class="orc-give" role="listitem" data-orc-to="${esc(id)}" aria-label="${esc(t("window.places.orchard.give-to", { name }))}">${face}<small>${esc(name)}</small></div>`;
  return `<div class="orc-givers" role="list" aria-label="${t("window.places.orchard.give-to-title")}">${one("", `<span class="orc-branch">${ic("spark", "s")}</span>`, branchName())}${trunks().map((tr) => one(tr.id, av(tr, 28), tr.name)).join("")}</div>`;
}

export function orchardTab() {
  const hint = `<p class="hint" data-css="margin:4px 0 10px">${t("window.places.orchard.hint")}</p>`;
  if (!O.view) return `<div class="x15" data-tab15="board">${hint}${O.problem ? offTile("board", O.problem) || `<p class="hint">${esc(O.problem)}</p>` : ""}</div>`;
  const board = O.view.board;
  const bar = `<div class="orc-bar"><button type="button" class="btn sm orc-boards" data-act="orc-boards">${ic("board15", "s")}${esc(board?.name ?? t("window.places.orchard.boards"))}${ic("down", "s")}</button><span class="grow"></span><button class="btn pri sm" type="button" data-act="orc-new">${ic("plus", "s")}${t("window.places.orchard.new-card")}</button></div>`;
  if (!cards().length) return `<div class="x15" data-tab15="board">${hint}${bar}${empty18("automations:orchard")}</div>`;
  const cols = LANES.map((lane) => {
    const list = O.view.lanes?.[lane] ?? [];
    return `<section class="col15 orc-col" data-col15="${lane}" aria-label="${esc(laneWord(lane))}"><h3>${esc(laneWord(lane))}<span>${list.length}</span></h3>${list.map(card).join("") || `<p class="c-empty15">${t("window.places.automations.nothing-here")}</p>`}</section>`;
  }).join("");
  return `<div class="x15" data-tab15="board">${hint}${bar}${givers()}<div class="board15 orc-board" role="list">${cols}</div></div>`;
}

/** Canopy opens the board it names, then Automations' own refresh reads it. */
export function chooseOrchardBoard(id) { O.board = id; }

/* Reads the board again; true when something came back different (Automations draws again then). Switched off, the
   board is not asked for (it answers 409): the line is the engine's own label for it with its switch. */
export async function loadOrchard() {
  let fresh = null, problem = "";
  try {
    const parts = await api("flows-boards");
    if (parts.modes?.kanban === "off" && parts.labels?.kanban) problem = t("window.switch-on.off", { label: parts.labels.kanban });
    else {
      const which = O.board ? `?board=${encodeURIComponent(O.board)}` : "";
      fresh = await api(`orchard${which}`);
    }
  } catch (error) {
    // The board chosen here was removed elsewhere: the active project's board is shown instead.
    if (O.board && error.status === 400) { O.board = null; return loadOrchard(); }
    problem = error.message;
  }
  if (JSON.stringify(fresh) === JSON.stringify(O.view) && problem === O.problem) return false;
  O.view = fresh;
  O.problem = problem;
  if (O.open && cardOf(O.open)) await openCard(O.open, true);
  return true;
}

/* Every change goes to the engine, then the board is read again; a refusal is shown in the engine's words. */
async function change(path, body = {}) {
  closePop();
  let done = false;
  try { await api(path, body); done = true; } catch (error) { toast(error.message); }
  await loadOrchard();
  renderNow();
  return done;
}
const cardPath = (id, action) => `orchard/cards/${encodeURIComponent(id)}/${action}`;
const move = (id, lane) => change(cardPath(id, "move"), { lane });
const give = (id, to) => change(cardPath(id, "assign"), { to });

/* ---------- the question on a card ---------- */

async function answer(el) {
  const q = { sessionId: el.dataset.sid, fingerprint: el.dataset.fp }, key = `${q.sessionId}\n${q.fingerprint}`;
  if (!q.sessionId || O.busy.has(key)) return;
  O.busy.add(key);
  for (const b of el.closest(".orc-ask")?.querySelectorAll("button") ?? []) b.disabled = true;
  try {
    const waiting = (await api("policy")).waiting ?? [];
    const asked = waiting.find((w) => w.sessionId === q.sessionId && (w.fingerprint || "") === q.fingerprint);
    // Q257: only a question that carries a fingerprint is answered, and always with it, so a yes lands on what was shown.
    if (asked && exactAsk(asked)) await api("policy/approve", { sessionId: asked.sessionId, decision: el.dataset.v === "deny" ? "deny" : "allow", remember: "never", fingerprint: asked.fingerprint, carryOn: true });
  } catch (error) { toast(error.message); }
  O.busy.delete(key);
  await loadOrchard();
  renderNow();
}

/* ---------- boards ---------- */

function boardsMenu(el) {
  const board = O.view?.board;
  const rows = (O.view?.boards ?? []).map((b) => `<button class="mi" type="button" role="menuitemradio" aria-checked="${b.id === board?.id}" data-act="orc-board" data-id="${esc(b.id)}"><span class="mi-t">${esc(b.name)}</span><small>${LANES.map((lane) => b.counts?.[lane] ?? 0).join(" · ")}</small></button>`).join("");
  const seg = board ? `<div class="ph">${t("window.places.orchard.at-once")}</div><div class="seg orc-seg" role="group" aria-label="${t("window.places.orchard.at-once")}">${[1, 2, 3, 4].map((n) => `<button type="button" aria-pressed="${board.atOnce === n}" data-act="orc-at-once" data-v="${n}">${n}</button>`).join("")}</div>` : "";
  openPop(el, `<div class="ph">${t("window.places.orchard.boards")}</div>${rows}<button class="mi" type="button" data-act="orc-new-board">${ic("plus", "s")}<span class="mi-t">${t("window.places.orchard.new-board")}</span></button>${board ? `<button class="mi" type="button" data-act="orc-board-rename"><span class="mi-t">${t("accounts.action.rename")}</span></button><button class="mi" type="button" data-act="orc-board-remove"><span class="mi-t">${t("accounts.action.remove")}</span></button>` : ""}${seg}`);
}
/* A new board, or (renaming) the board shown now under a new name. */
function newBoard(renaming = false) {
  closePop();
  const board = renaming ? O.view?.board : null;
  if (renaming && !board) return;
  openDlg({ title: board ? t("accounts.action.rename") : t("window.places.orchard.new-board"),
    body: `<label class="fld"><span>${t("accounts.field.name")}</span><input class="inp" id="orc-board-name" maxlength="80" value="${esc(board?.name ?? "")}"${board ? ` data-id="${esc(board.id)}"` : ""}></label>`,
    foot: `<button class="btn pri" type="button" data-act="orc-board-save">${board ? t("action.save") : t("asks.runtimes.add")}</button>` });
}
async function saveBoard() {
  const field = $("#orc-board-name"), name = (field?.value ?? "").trim(), renaming = field?.dataset.id;
  if (!name) { field?.focus(); return; }
  try {
    if (renaming) await api(`orchard/boards/${encodeURIComponent(renaming)}`, { name });
    else O.board = (await api("orchard/boards", { name })).board.id;
    closeDlg();
  } catch (error) { toast(error.message); return; }
  await loadOrchard();
  renderNow();
}
/* Removes the board shown now; the engine refuses one that still has cards, in its own words. */
async function removeBoard() {
  const board = O.view?.board;
  if (!board) return;
  if (await change(`orchard/boards/${encodeURIComponent(board.id)}/remove`)) { O.board = null; await loadOrchard(); renderNow(); }
}

/* ---------- a new card ---------- */

const giveOptions = (chosen = "") => `<option value="">${esc(branchName())}</option>${trunks().map((tr) => `<option value="${esc(tr.id)}"${tr.id === chosen ? " selected" : ""}>${esc(tr.name)}</option>`).join("")}`;
function newCard() {
  const before = cards().filter((c) => c.lane !== "picked").map((c) => `<option value="${esc(c.id)}">${esc(c.title)}</option>`).join("");
  openDlg({ title: t("window.places.orchard.new-card"),
    body: `<label class="fld"><span>${t("window.places.orchard.card-title")}</span><input class="inp" id="orc-title" maxlength="200"></label><label class="fld"><span>${t("flowsBoards.board.notes")}</span><textarea class="inp" id="orc-notes" rows="3"></textarea></label><label class="fld"><span>${t("window.places.orchard.give-to-title")}</span><select class="inp" id="orc-to">${giveOptions()}</select></label>${before ? `<label class="fld"><span>${t("window.places.orchard.waits-for-title")}</span><select class="inp" id="orc-after"><option value="">${t("window.places.orchard.nothing")}</option>${before}</select></label>` : ""}`,
    foot: `<button class="btn pri" type="button" data-act="orc-save">${t("asks.runtimes.add")}</button>` });
}
/* Editing a card's title and notes (who has it, its column and what it waits for have their own controls). */
function editCard(id) {
  const c = cardOf(id);
  if (!c) return;
  O.open = null;
  openDlg({ title: t("prompts.action.edit"),
    body: `<label class="fld"><span>${t("window.places.orchard.card-title")}</span><input class="inp" id="orc-title" maxlength="200" value="${esc(c.title)}" data-id="${esc(c.id)}"></label><label class="fld"><span>${t("flowsBoards.board.notes")}</span><textarea class="inp" id="orc-notes" rows="3">${esc(c.notes ?? "")}</textarea></label>`,
    foot: `<button class="btn pri" type="button" data-act="orc-save">${t("action.save")}</button>` });
}
async function saveCard() {
  const field = $("#orc-title"), title = (field?.value ?? "").trim(), editing = field?.dataset.id;
  if (!title) { field?.focus(); return; }
  if (editing) {
    try { await api(cardPath(editing, "edit"), { title, notes: $("#orc-notes")?.value ?? "" }); closeDlg(); } catch (error) { toast(error.message); return; }
    await loadOrchard();
    renderNow();
    return openCard(editing);
  }
  const to = $("#orc-to")?.value ?? "", after = $("#orc-after")?.value ?? "";
  try {
    await api("orchard/cards", { title, notes: $("#orc-notes")?.value ?? "", ...(O.view?.board ? { board: O.view.board.id } : {}),
      ...(to ? { assignee: to } : {}), ...(after ? { after: [after] } : {}) });
    closeDlg();
  } catch (error) { toast(error.message); return; }
  await loadOrchard();
  renderNow();
}

/* ---------- one card, opened ---------- */

const when = (at) => new Date(at).toLocaleString(language(), { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
async function openCard(id, again = false) {
  let detail;
  try { detail = await api(`orchard/cards/${encodeURIComponent(id)}`); } catch (error) { toast(error.message); return; }
  const c = detail.card;
  O.open = c.id;
  if (again && !document.getElementById("orc-detail")) return;
  const waits = (c.after ?? []).map((p) => cardOf(p)).filter(Boolean).map((p) => `<div class="prow"><span class="grow"><b>${esc(p.title)}</b><small>${esc(laneWord(p.lane))}</small></span><button class="icon-btn" type="button" data-act="orc-unlink" data-id="${esc(c.id)}" data-v="${esc(p.id)}" aria-label="${t("accounts.action.remove")}">${ic("x", "s")}</button></div>`).join("");
  const could = cards().filter((p) => p.id !== c.id && !(c.after ?? []).includes(p.id) && p.lane !== "picked").map((p) => `<option value="${esc(p.id)}">${esc(p.title)}</option>`).join("");
  const editing = O.editing?.card === c.id ? O.editing.comment : "";
  const commentActs = (m) => `<span class="orc-cacts">${m.by === "owner" ? `<button class="icon-btn" type="button" data-act="orc-comment-edit" data-id="${esc(c.id)}" data-v="${esc(m.id)}" aria-label="${t("prompts.action.edit")}">${ic("edit", "s")}</button>` : ""}<button class="icon-btn" type="button" data-act="orc-comment-remove" data-id="${esc(c.id)}" data-v="${esc(m.id)}" aria-label="${t("accounts.action.remove")}">${ic("x", "s")}</button></span>`;
  const comments = (detail.comments ?? []).map((m) => `<li${m.id === editing ? ' class="orc-editing"' : ""}><b>${esc(byName(m.by))}</b><span>${esc(m.text)}</span><time>${esc(when(m.at))}</time>${commentActs(m)}</li>`).join("");
  const history = (c.history ?? []).slice(-8).reverse().map((h) => `<li><span>${esc(h.what)}</span><time>${esc(when(h.at))}</time></li>`).join("");
  openDlg({ title: c.title, wide: true,
    body: `<div id="orc-detail" class="orc-detail" data-id="${esc(c.id)}"><p class="orc-who">${faceOf(c, 24)}<span>${esc(whoHas(c))} · ${esc(laneWord(c.lane))}</span></p>${c.notes ? `<p>${esc(c.notes)}</p>` : ""}${c.lane === "growing" ? liveOf(c) : ""}
      <div class="sec"><h2>${t("window.places.orchard.waits-for-title")}</h2><div class="rows">${waits}</div>${could ? `<div class="orc-link"><select class="inp" id="orc-link" aria-label="${t("window.places.orchard.waits-for-title")}"><option value="">${t("window.places.orchard.nothing")}</option>${could}</select><button class="btn sm" type="button" data-act="orc-link" data-id="${esc(c.id)}">${t("asks.runtimes.add")}</button></div>` : ""}</div>
      <div class="sec"><h2>${t("window.places.orchard.comments")}</h2><ol class="orc-comments">${comments}</ol><div class="orc-link"><input class="inp" id="orc-comment" maxlength="2000" value="${esc(O.comments[c.id] ?? "")}" aria-label="${t("window.places.orchard.add-comment")}" placeholder="${esc(t("window.places.orchard.add-comment"))}"><button class="btn sm" type="button" data-act="orc-comment" data-id="${esc(c.id)}">${editing ? t("action.save") : t("asks.runtimes.add")}</button></div></div>
      <div class="sec"><h2>${t("place.inbox.history")}</h2><ol class="tl orc-history">${history}</ol></div></div>`,
    foot: `<button class="btn ghost" type="button" data-act="orc-edit" data-id="${esc(c.id)}">${t("prompts.action.edit")}</button>${c.lane === "growing" ? "" : `<button class="btn ghost" type="button" data-act="orc-remove" data-id="${esc(c.id)}">${t("accounts.action.remove")}</button>`}` });
}
/* Who wrote a comment: the owner, a Trunk by its name, Branch, a chat app or a key. */
function byName(by) {
  if (by.startsWith("trunk:")) return trunkOf(by.slice(6))?.name ?? "";
  if (by === "branch") return branchName();
  return t(`window.places.orchard.by.${["owner", "chat", "key"].includes(by) ? by : "owner"}`);
}

function cardMenu(el) {
  const c = cardOf(el.dataset.id);
  if (!c) return;
  const to = (lane) => `<button class="mi" type="button" role="menuitemradio" aria-checked="${c.lane === lane}" data-act="orc-move" data-id="${esc(c.id)}" data-v="${lane}"><span class="mi-t">${esc(laneWord(lane))}</span></button>`;
  const who = [["", branchName()], ...trunks().map((tr) => [tr.id, tr.name])].map(([id, name]) => `<button class="mi" type="button" role="menuitemradio" aria-checked="${c.assignee === id}" data-act="orc-give" data-id="${esc(c.id)}" data-v="${esc(id)}"><span class="mi-t">${esc(name)}</span></button>`).join("");
  openPop(el, `<button class="mi" type="button" data-act="orc-open" data-id="${esc(c.id)}"><span class="mi-t">${t("ov.open")}</span></button><div class="ph">${t("window.places.automations.move-to")}</div>${LANES.map(to).join("")}<div class="ph">${t("window.places.orchard.give-to-title")}</div>${who}`, { right: true });
}

/* ---------- dragging: onto a column moves the card, onto a face gives it ---------- */

function initDrag() {
  let dragged = null;
  const clear = () => document.querySelectorAll(".orc-dragging,.over15,.orc-over").forEach((x) => x.classList.remove("orc-dragging", "over15", "orc-over"));
  document.addEventListener("dragstart", (e) => {
    const c = e.target.closest?.("[data-orc-card]");
    if (!c) return;
    dragged = c.dataset.orcCard;
    c.classList.add("orc-dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", dragged);
  });
  document.addEventListener("dragover", (e) => {
    if (!dragged) return;
    const target = e.target.closest?.(".orc-col, .orc-give");
    if (!target) return;
    e.preventDefault();
    document.querySelectorAll(".over15,.orc-over").forEach((x) => x !== target && x.classList.remove("over15", "orc-over"));
    target.classList.add(target.classList.contains("orc-give") ? "orc-over" : "over15");
  });
  document.addEventListener("drop", (e) => {
    if (!dragged) return;
    const target = e.target.closest?.(".orc-col, .orc-give");
    if (!target) return;
    e.preventDefault();
    const id = dragged, c = cardOf(id);
    dragged = null;
    clear();
    if (target.classList.contains("orc-give")) { if (c && c.assignee !== target.dataset.orcTo) give(id, target.dataset.orcTo); return; }
    if (c && c.lane !== target.dataset.col15) move(id, target.dataset.col15);
  });
  document.addEventListener("dragend", () => { dragged = null; clear(); });
}

export function initOrchard() {
  markLive(["orc-boards", "orc-board", "orc-new-board", "orc-board-save", "orc-at-once", "orc-new", "orc-save", "orc-open", "orc-menu",
    "orc-move", "orc-give", "orc-plant", "orc-grow", "orc-pause", "orc-resume", "orc-stop", "orc-pick", "orc-back",
    "orc-reset", "orc-remove", "orc-ask", "orc-link", "orc-unlink", "orc-comment", "orc-comment-edit", "orc-comment-remove", "orc-edit",
    "orc-board-rename", "orc-board-remove",
    "sw:orc-board-name", "sw:orc-title", "sw:orc-notes", "sw:orc-to", "sw:orc-after", "sw:orc-link", "sw:orc-comment"]);
  on("orc-boards", (el) => boardsMenu(el));
  on("orc-board", async (el) => { closePop(); O.board = el.dataset.id; await loadOrchard(); renderNow(); });
  on("orc-new-board", () => newBoard());
  on("orc-board-save", () => saveBoard());
  on("orc-at-once", (el) => O.view?.board && change(`orchard/boards/${encodeURIComponent(O.view.board.id)}`, { atOnce: Number(el.dataset.v) }));
  on("orc-new", () => newCard());
  on("orc-save", () => saveCard());
  on("orc-open", (el) => { closePop(); openCard(el.dataset.id); });
  on("orc-menu", (el) => cardMenu(el));
  on("orc-move", (el) => move(el.dataset.id, el.dataset.v));
  on("orc-give", (el) => give(el.dataset.id, el.dataset.v));
  on("orc-plant", (el) => give(el.dataset.id, cardOf(el.dataset.id)?.assignee ?? ""));
  on("orc-grow", (el) => change(cardPath(el.dataset.id, "grow")));
  on("orc-pause", (el) => change(`runs/${encodeURIComponent(el.dataset.run)}/pause`));
  on("orc-resume", (el) => change(`runs/${encodeURIComponent(el.dataset.run)}/resume`));
  on("orc-stop", (el) => change(`runs/${encodeURIComponent(el.dataset.run)}/cancel`));
  on("orc-pick", (el) => move(el.dataset.id, "picked"));
  on("orc-back", (el) => move(el.dataset.id, "seed"));
  on("orc-reset", (el) => change(cardPath(el.dataset.id, "reset")));
  on("orc-remove", async (el) => { closeDlg(); O.open = null; await change(cardPath(el.dataset.id, "remove")); });
  on("orc-ask", (el) => answer(el));
  on("orc-link", async (el) => { const after = $("#orc-link")?.value; if (after) { await change(cardPath(el.dataset.id, "link"), { after }); openCard(el.dataset.id); } });
  on("orc-unlink", async (el) => { await change(cardPath(el.dataset.id, "unlink"), { after: el.dataset.v }); openCard(el.dataset.id); });
  on("orc-comment", async (el) => {
    const id = el.dataset.id, text = (O.comments[id] ?? $("#orc-comment")?.value ?? "").trim();
    if (!text) { $("#orc-comment")?.focus(); return; }
    const editing = O.editing?.card === id ? O.editing.comment : "";
    const done = await change(cardPath(id, editing ? "comment-edit" : "comment"), editing ? { comment: editing, text } : { text });
    if (done) { delete O.comments[id]; O.editing = null; }
    openCard(id);
  });
  /* Editing one of your own comments puts its words back in the comment box; Save writes them over the old. */
  on("orc-comment-edit", async (el) => {
    const found = (await api(`orchard/cards/${encodeURIComponent(el.dataset.id)}`).catch(() => null))?.comments?.find((m) => m.id === el.dataset.v);
    if (!found) return;
    O.editing = { card: el.dataset.id, comment: found.id };
    O.comments[el.dataset.id] = found.text;
    openCard(el.dataset.id);
  });
  on("orc-comment-remove", async (el) => {
    if (O.editing?.comment === el.dataset.v) { O.editing = null; delete O.comments[el.dataset.id]; }
    await change(cardPath(el.dataset.id, "comment-remove"), { comment: el.dataset.v });
    openCard(el.dataset.id);
  });
  on("orc-edit", (el) => editCard(el.dataset.id));
  on("orc-board-rename", () => newBoard(true));
  on("orc-board-remove", () => removeBoard());
  document.addEventListener("input", (event) => {
    if (event.target.id === "orc-comment" && O.open) O.comments[O.open] = event.target.value;
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.shiftKey) return;
    if (e.target.id === "orc-comment") { e.preventDefault(); document.querySelector('[data-act="orc-comment"]')?.click(); }
    else if (e.target.id === "orc-board-name") { e.preventDefault(); saveBoard(); }
    else if (e.target.id === "orc-title") { e.preventDefault(); saveCard(); }
  });
  initDrag();
}
