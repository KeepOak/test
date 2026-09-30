/* Inbox: approvals, finished tasks, history - matches reference place-inbox-*.html.
   "Needs you" lists three kinds of request, each answered only by its own route: a task waiting on a yes (GET /api/policy;
   Allow names it by session and fingerprint, the chat’s exact-match "ask"), a message one Trunk wants to send
   another (state.trunkWaiting; POST /api/trunks/messages/<id>/answer or /decline), and a request for a package or a tool
   server (GET /api/flows-boards/installs; POST /api/flows-boards/installs/<id>/approve|decline). Allow records the owner's
   answer after a fresh malware check and shows the manual next step; nothing is installed or started.
   Above every tab: each task Branch closed on that can be continued (state.attention with canContinue), picked up with
   POST /api/runs/<id>/resume or left with POST /api/runs/<id>/cancel. At the bottom of "Needs you": each request to change
   Branch itself (GET /api/self-development/requests), waiting or prepared; its review shows the request and the engine's
   bounded diff of it (GET /api/self-development/requests/<id>/diff). Decline closes a waiting one for good (POST
   /api/self-development/requests/<id>/decline, the owner's alone in the app). Security tier: "Approve the edits" and
   "Publish the draft" stay greyed. A yes is the owner writing the contract terms Branch's own source is prepared under,
   and the window has no place to write them; publishing has no route of its own.
   "Allow all N…" (more than one waiting) answers exactly the questions and Trunk messages its confirm lists, each once,
   through the same routes as their own Allow: POST /api/policy/approve { remember: "never" } by session and fingerprint,
   and POST /api/trunks/messages/<id>/answer. It never keeps a standing yes, and it leaves out install requests, whose
   own answer is separate, and any question that carries no fingerprint; anything that arrives after the confirm opened
   waits for its own answer.
   History's "Verify" walks the activity chain (POST /api/safety-extras/activity/verify) and shows what the engine found.
   "Watch again" plays a task back from its recording (GET /api/runs/<id>/recording): the engine's own frames, stepped or
   played; with recordings switched off the engine's sentence is shown. It never runs the task again. "Save as a page"
   downloads the engine's own page of the recording (GET /api/runs/<id>/recording/page, in the window's language); the
   desktop app drops every download and has no guarded save for a page, so there it stays greyed. "Make a workflow"
   saves the workflow the engine drafts from the recording (POST /api/runs/<id>/recording/flow). */

import { $, esc, renderNow, paint } from "../core/dom.js";
import { S, E, refresh, level, needsYou, ownerHere, activeId } from "../core/state.js";
import { ic, av, toast, openDlg, closeDlg, dialog } from "../core/ui.js";
import { api, token } from "../core/api.js";
import { readEventLog } from "./event-replay.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { openConversation } from "../chat/chat.js";
import { recBar, updateCard } from "../chat/rec.js";
import { prowOpen, inboxMarkAll } from "../chat/unread.js"; // pass 17: unread dots and Mark all read
import { adaptCards, laterTab, laterCount, receiptsSection, readInbox17, initInbox17, faceOf, nameOf } from "./inbox17.js";
import { initDemo17 } from "./demo17.js";
import { t, language } from "../../i18n.js";
import { offTile } from "./switch-on.js";
import { revokedPrompts } from "../settings/pages/chatapps.js"; // pass 17 part D §8: a refused chat-app token
import { workSection, readWork, pausedIds } from "./inboxwork.js"; // long-work: what is working or paused, with Pause, Resume, Stop
import { empty18 } from "../core/p18.js"; // pass 18: an empty list is a welcome
import { readSourceMerges, sourceMergeCards } from "./self-development-merge.js";
import { readSourcePublications, sourcePublicationCards } from "./self-development-publication.js";
import { readUrgency, byUrgency } from "./inbox-urgency.js"; // Sort the Inbox by urgency (decision models)
import { autonomyRows, autonomyCount, readAutonomy, initAutonomyInbox } from "./inbox-autonomy.js";
import { initPages19 } from "./pages19.js"; // SELF-309

let asks = [];
let asksRead = false; // pass 18: "Nothing needs you" only once the engine answered (after() below)
/* stress test B001: the recordings switch as the engine has it (GET /api/recordings settings.mode), read on History; while
   it is off, History says so with its switch, as the engine's sentence ("Turn them on under Inbox, History") points. */
let recMode = null;
const recordingsOff = (sentence) => offTile("recordings", sentence || t("window.switch-on.recordings"), t("window.switch-on.recordings-old"));
let installs = [];
const installAnswers = new Set();
let changeRequests = [];
let chain = null;
const trunkName = (id) => (Array.isArray(E.trunks) ? E.trunks : []).find((t) => t.id === id || t.name === id)?.name ?? id ?? "";
const firstLine = (text) => String(text ?? "").split("\n")[0].slice(0, 60);
const runById = (id) => (E.state.runs ?? []).find((r) => r.id === id);
const when = (iso) => (iso ? new Date(iso).toLocaleString(language(), { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "");

/* The Trunk that asks: the one the question names, else the one whose conversation it is (Branch in its own). */
const trunkById = (id) => (id ? (Array.isArray(E.trunks) ? E.trunks : []).find((t) => t.id === id || t.name === id) : undefined);
function askRow(q) {
  const asker = trunkById(q.trunk);
  return `${prowOpen(`ask:${q.sessionId}:${q.fingerprint || ""}`, q.createdAt ?? runById(q.runId)?.createdAt)}${asker ? av(asker, 34) : faceOf(q.sessionId, 34)}<span class="grow"><b>${esc(q.question || q.label || "")}</b><small>${esc([asker?.name || q.trunk || nameOf(q.sessionId), q.question ? q.label : q.target].filter(Boolean).join(" · "))}</small></span><button class="btn sm" type="button" data-act="chat" data-id="${esc(q.sessionId)}">${t("ov.open")}</button><button class="btn pri sm" type="button" data-act="ask" data-v="allow" data-sid="${esc(q.sessionId)}" data-fp="${esc(q.fingerprint || "")}">${t("trunks.room.allow")}</button></div>`;
}
/* A request for a package or a tool server (GET /api/flows-boards/installs, status waiting). Answering it only writes the
   answer down: a yes comes back with the exact next step, and nothing is installed. */
function installRow(r) {
  const disabled = installAnswers.has(r.id) || E.profiles?.isOwner !== true ? "disabled" : "";
  return `${prowOpen(`install:${r.id}`, r.at)}<span class="ico-tile">${ic("puzzle", "s")}</span><span class="grow"><b>${esc(r.ask?.why ?? "")}</b><small>${t("window.places.inbox.from-wants-value-nothing-is-installed", { from: esc(r.from), value: esc(r.ask?.name ?? "") })}</small></span><button class="btn ghost sm" type="button" data-act="xdo-no" data-id="${esc(r.id)}" data-v="denied" ${disabled}>${t("window.places.inbox.dont")}</button><button class="btn pri sm" type="button" data-act="xdo" data-id="${esc(r.id)}" data-v="allowed" ${disabled}>${t("trunks.room.allow")}</button></div>`;
}
function messageRow(m) {
  return `${prowOpen(`tmsg:${m.id}`, m.createdAt ?? m.at)}${trunkById(m.from) ? av(trunkById(m.from), 34) : `<span class="ico-tile">${ic("chat", "s")}</span>`}<span class="grow"><b>${esc(m.message)}</b><small>${esc(trunkName(m.from))} → ${esc(trunkName(m.to))}</small></span><button class="btn ghost sm" type="button" data-act="tmsg" data-id="${esc(m.id)}" data-v="decline">${t("window.places.inbox.dont")}</button><button class="btn pri sm" type="button" data-act="tmsg" data-id="${esc(m.id)}" data-v="answer">${t("trunks.room.allow")}</button></div>`;
}

/* A task Branch closed on, from the engine's attention list; its name is the task's own first line. */
function cutCard(a) {
  const trunk = a.who ? (Array.isArray(E.trunks) ? E.trunks : []).find((t) => t.name === a.who) : null;
  const name = (runById(a.runId)?.title ?? firstLine(runById(a.runId)?.prompt)) || a.question;
  return `<div class="cut15" role="status">${trunk ? av(trunk, 30) : `<span class="ico-tile">${ic("retry", "s")}</span>`}<span class="grow"><b>${t("window.places.inbox.pick-up-what-the-update-cut")}</b><small>${esc(name)}</small></span><button class="btn ghost sm" type="button" data-act="cutno15" data-id="${esc(a.runId)}">${t("window.places.inbox.leave-it")}</button><button class="btn pri sm" type="button" data-act="cutgo15" data-id="${esc(a.runId)}" data-sid="${esc(a.sessionId)}">${t("window.places.inbox.pick-it-up")}</button></div>`;
}
const cutCards = () => (E.state.attention ?? []).filter((a) => a.canContinue && !a.parentRunId && !pausedIds().has(a.runId)).map(cutCard).join(""); // not a helper (FEATURES17C §4); a paused one is under long work

function selfCard(r) {
  const stage = r.status === "approved" ? t("window.places.inbox.edits-approved-ready-to-publish") : t("flowsBoards.installs.waiting");
  return `<div class="self15"><span class="ico-tile">${ic("branch", "s")}</span><span class="grow"><b>${t("window.places.inbox.branch-wants-to-improve-itself")}</b><small>${esc(firstLine(r.text))} · ${stage}</small></span><button class="btn sm" type="button" data-act="selfrev15" data-id="${esc(r.id)}">${t("window.places.inbox.review")}</button></div>`;
}
/* Waiting for the owner's yes, or prepared and so showing its edits before a draft is published. */
const waitingChanges = () => changeRequests.filter((r) => r.status === "waiting" || r.status === "approved");

/* Q050: the tab counts what the engine counts (GET /api/state needsYou, as the sidebar and Overview do), plus the install
   requests only this place lists; the rows drawn are what decides "Nothing is waiting". */
const waitingCount = () => needsYou() + installs.length;
const rowsWaiting = () => asks.length + E.state.trunkWaiting.length + installs.length + autonomyCount();
/* What Allow all may answer: the questions and the Trunk messages, never the install requests. On a household profile
   it is not offered: GET /api/policy lists the owner's questions there too, and one yes for all of them is the owner's.
   A question with no fingerprint is left to its own Allow: without one, a yes is not bound to the request shown. */
const exact = (q) => /^[a-f0-9]{32}$/.test(String(q.fingerprint ?? ""));
const exactAsks = () => asks.filter(exact);
const allowable = () => (E.profiles?.active?.id ? 0 : exactAsks().length + E.state.trunkWaiting.length);
/* Each row of Needs you with its key (the one its unread dot uses) and its words, for Sort the Inbox by urgency. */
const needRows = () => [
  ...asks.map((q) => ({ key: `ask:${q.sessionId}:${q.fingerprint || ""}`, text: [q.question || q.label, q.target].filter(Boolean).join(" · "), row: () => askRow(q) })),
  ...installs.map((r) => ({ key: `install:${r.id}`, text: [r.ask?.why, r.ask?.name].filter(Boolean).join(" · "), row: () => installRow(r) })),
  ...E.state.trunkWaiting.map((m) => ({ key: `tmsg:${m.id}`, text: m.message, row: () => messageRow(m) })),
];
function needsTab() {
  const count = allowable();
  let html = `<div class="rows">`;
  if (count > 1) html += `<div class="acts" data-css="margin:4px 0 6px"><button class="btn" type="button" data-act="allowall">${t("window.places.inbox.allow-all-count", { count })}</button></div>`;
  html += byUrgency(needRows().map(({ key, row }) => [key, row()])).join("");
  html += autonomyRows();
  html += `</div>`;
  return html + waitingChanges().map(selfCard).join("") + sourceMergeCards() + sourcePublicationCards();
}

/* Needs you, and the prototype's line when nothing at all waits (a p.empty: the Branch-in-person pose, setup-delight-033,
   is drawn above it by the shell). */
function needsBody() {
  const lead = cutCards() + revokedPrompts() + adaptCards();
  const nothing = asksRead && !lead && !rowsWaiting() && !waitingChanges().length && !sourceMergeCards() && !sourcePublicationCards();
  return revokedPrompts() + adaptCards() + needsTab() + (nothing ? empty18("inbox:needs") : "");
}

function finishedTab() {
  const finished = E.state.runs?.filter((r) => r.status === "completed") || [];
  const rows = finished.slice(0, 20).map((r) => `${prowOpen(`run:${r.id}`, r.updatedAt)}${faceOf(r.sessionId, 34)}<span class="grow"><b>${esc(r.title ?? firstLine(r.prompt))}</b><small>${esc([nameOf(r.sessionId), firstLine(r.output)].filter(Boolean).join(" · "))}</small></span><button class="btn sm" type="button" data-act="chat" data-id="${esc(r.sessionId || "")}">${t("ov.open")}</button></div>`);
  return rows.length ? `<div class="rows">${rows.join("")}</div>` : empty18("inbox:finished");
}

function duration(r) {
  const secs = r.updatedAt && r.createdAt ? Math.round((new Date(r.updatedAt).getTime() - new Date(r.createdAt).getTime()) / 1000) : 0;
  return secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`;
}
/* The newest finished task, offered to watch again; the tile is not drawn when nothing has finished. */
function replayTile() {
  if (recMode === "off" && (E.state.runs ?? []).length) return `<div data-css="margin:10px 0 12px">${recordingsOff()}<button class="btn ghost sm" type="button" data-act="rp-import">Open event log</button></div>`;
  const done = (E.state.runs ?? []).filter((r) => r.status === "completed"), last = done[0];
  const importButton = '<button class="btn ghost sm" type="button" data-act="rp-import">Open event log</button>';
  if (!last) return importButton;
  const before = done.find((r) => r !== last && r.prompt === last.prompt);
  const day = before ? dayWord(before.createdAt) : "";
  const compare = before ? `<button class="btn ghost sm" type="button" data-act="compare" data-id="${esc(last.id)}" data-v="${esc(before.id)}">${t("window.places.inbox.compare-it-with-value-s", { value: esc(day.charAt(0).toLowerCase() + day.slice(1)) })}</button>` : "";
  return `<div class="tile" data-css="margin:10px 0 12px"><div class="th"><b>${t("recordings.title")}</b></div><p>${t("window.places.inbox.step-through-what-a-task-did")}</p><div class="acts"><button class="btn sm" type="button" data-act="replay" data-id="${esc(last.id)}">${ic("play", "s")}${t("window.places.inbox.watch-prompt", { prompt: esc(last.title ?? firstLine(last.prompt)) })}</button>${compare}${importButton}</div></div>`;
}

/* A task's day as the prototype names it: Today, Last <weekday> within the week, else the date. */
function dayWord(iso) {
  const d = new Date(iso), now = new Date();
  if (d.toDateString() === now.toDateString()) return t("dashboard.today.title");
  if (now.getTime() - d.getTime() < 7 * 86400000) return t("window.places.inbox.last-day", { day: d.toLocaleDateString(language(), { weekday: "long" }) });
  return d.toLocaleDateString(language(), { month: "short", day: "numeric" });
}

/* Two tasks side by side, both read from GET /api/runs/<id>/inspect (the record the inspector reads): the cost, the time,
   the rounds and the tools used, then how the answers differ line by line. */
async function openCompare(el) {
  let older, newer;
  try { [older, newer] = await Promise.all([api(`runs/${encodeURIComponent(el.dataset.v)}/inspect`), api(`runs/${encodeURIComponent(el.dataset.id)}/inspect`)]); } catch (error) { toast(error.message); return; }
  const secs = (s) => { const n = Math.round(Number(s) || 0); return n >= 60 ? `${Math.floor(n / 60)}m ${n % 60}s` : `${n}s`; };
  const rows = [[t("window.settings.p17-models.cost"), older.cost?.display ?? "", newer.cost?.display ?? ""], [t("comfort.status.item.time"), secs(older.seconds), secs(newer.seconds)], [t("window.places.inbox.rounds"), older.rounds?.length ?? 0, newer.rounds?.length ?? 0], [t("window.places.inbox.tools-used"), older.calls?.length ?? 0, newer.calls?.length ?? 0]];
  const table = `<table class="cmp6"><thead><tr><th></th><th>${esc(dayWord(older.run.createdAt))}</th><th>${esc(dayWord(newer.run.createdAt))}</th></tr></thead><tbody>${rows.map(([n, a, b]) => `<tr><th>${n}</th><td>${esc(a)}</td><td>${esc(b)}</td></tr>`).join("")}</tbody></table>`;
  const was = String(older.run.output ?? "").split("\n"), now = String(newer.run.output ?? "").split("\n");
  const diff = [...was.filter((l) => !now.includes(l)).map((l) => `<span class="d-del">- ${esc(l)}</span>`), ...now.map((l) => (was.includes(l) ? `<span>  ${esc(l)}</span>` : `<span class="d-add">+ ${esc(l)}</span>`))].join("");
  openDlg({ title: t("activity.compareTitle"), wide: true, body: `${table}<pre class="diff6">${diff}</pre><p class="hint">${t("window.places.inbox.read-from-the-same-look-inside")}</p>`, foot: `<button class="btn pri" type="button" data-act="dlg-close">${t("first-run-steps.done")}</button>` });
}

/* Search what ran: the words typed, matched against each task's words and who did it, as the prototype filters. */
let histQ = "";
function historyTab() {
  const verify = `<button type="button" class="rec15" data-act="verify15" data-tip="${t("window.places.inbox.every-entry-is-linked-to-the")}">${ic("shield15", "s")}<span>${chain?.ok ? t("window.inbox.intact") : ""}</span><u>${t("window.places.inbox.verify")}</u></button>`;
  const q = histQ.trim().toLowerCase();
  const shown = (E.state.runs || []).filter((r) => !q || [r.title, r.prompt].map((s) => String(s ?? "")).join("\n").toLowerCase().includes(q) || nameOf(r.sessionId).toLowerCase().includes(q));
  const rows = shown.slice(0, 50).map((r) => {
    const cost = typeof r.cost?.amount === "number" ? "$" + r.cost.amount.toFixed(2) : r.cost?.display ?? "";
    return `<div class="prow">${faceOf(r.sessionId, 34)}<span class="grow"><b>${esc(r.title ?? firstLine(r.prompt))}</b><small>${esc([nameOf(r.sessionId), when(r.createdAt)].filter(Boolean).join(" · "))}</small></span><span class="meta">${[duration(r), cost].filter(Boolean).map(esc).join(" · ")}</span><button class="btn ghost sm" type="button" data-act="replay" data-id="${esc(r.id)}">${t("window.places.inbox.watch-again")}</button></div>`;
  });
  return `${replayTile()}<div class="rows"><div class="nl"><input class="inp" id="histq" placeholder="${t("window.places.inbox.search-what-ran")}" value="${esc(histQ)}" aria-label="${t("window.places.inbox.search-history")}">${verify}</div>${rows.join("") || (q ? `<p class="empty">${t("window.places.inbox.nothing-matches")}</p>` : "")}</div>${rows.length || q ? "" : empty18("inbox:history")}`;
}

export function draw() {
  const tab = S.tabs.inbox || "needs";
  if (!E.state) return `<main class="main enter11" id="main"><div class="scroll"><div class="place"></div></div></main>`;

  const count = waitingCount();
  const body = workSection() + cutCards() + (tab === "needs" ? needsBody() : tab === "finished" ? finishedTab() : tab === "history" ? historyTab() + receiptsSection() : tab === "later" ? laterTab() : "");
  let html = `<main class="main enter11" id="main"><div class="lock-banner"><svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l7.5 3v5.5c0 4.6-3.2 8.2-7.5 9.5-4.3-1.3-7.5-4.9-7.5-9.5V6z"></path></svg>${t("window.places.automations.lockdown-is-on-trunks-can-read")}<button type="button" data-act="lock">${t("lockdown.turnOff")}</button></div><div class="scroll"><div class="place">
    ${recBar()}${updateCard()}
    <h1>${t("place.inbox")}</h1><p class="lede">${t("window.places.inbox.everything-a-trunk-is-waiting-on")}</p>
    <div class="tabs" role="tablist"><button class="tab" role="tab" type="button" aria-selected="${tab === "needs" ? "true" : "false"}" data-act="ptab" data-place="inbox" data-v="needs">${t("dashboard.needs.title")}<span class="n">${count}</span></button><button class="tab" role="tab" type="button" aria-selected="${tab === "finished" ? "true" : "false"}" data-act="ptab" data-place="inbox" data-v="finished">${t("place.inbox.finished")}</button><button class="tab" role="tab" type="button" aria-selected="${tab === "history" ? "true" : "false"}" data-act="ptab" data-place="inbox" data-v="history">${t("place.inbox.history")}</button><button class="tab" role="tab" type="button" aria-selected="${tab === "later" ? "true" : "false"}" data-act="ptab" data-place="inbox" data-v="later">${t("window.places.inbox.later")}${laterCount() ? `<span class="n">${laterCount()}</span>` : ""}</button>${inboxMarkAll()}</div>`;

  html += body;

  html += `</div></div></main>`;
  return html;
}

/* A refusal while re-reading is said once, not on every redraw, and the list it was for is drawn empty. */
const said = new Set();
function sayOnce(error) {
  if (!said.has(error.message)) { said.add(error.message); toast(error.message); }
  return {};
}

/* The waiting requests for packages and tool servers; with that part switched off (GET /api/flows-boards) there are none. */
async function readInstalls() {
  const modes = (await api("flows-boards").catch(sayOnce)).modes ?? {};
  if (!modes["install-requests"] || modes["install-requests"] === "off") return [];
  return ((await api("flows-boards/installs").catch(sayOnce)).requests ?? []).filter((r) => r.status === "waiting");
}

const installOwnerVisible = () => E.profiles?.isOwner === true && !E.profiles?.active?.id &&
  S.view === "inbox" && (S.tabs.inbox || "needs") === "needs" && !document.querySelector(".lockscreen, #app.locked-b17");

function installAnswerResult(request) {
  if (request?.status === "declined") { toast(t("window.places.inbox.install-declined")); return; }
  const approved = request?.status === "approved" && typeof request.nextStep === "string" && request.nextStep;
  openDlg({ title: t(approved ? "window.places.inbox.install-approved" : "window.places.inbox.install-refused"),
    body: approved ? `<p>${esc(t("window.places.inbox.install-manual-next-step"))}</p><pre class="diff6">${esc(request.nextStep)}</pre>` : `<p>${esc(request?.check?.note || t("window.places.inbox.install-refused"))}</p>`,
    foot: `<button class="btn pri" type="button" data-act="dlg-close">${t("first-run-steps.done")}</button>` });
}

/* Each answer is for the exact waiting request displayed. Approval records a manual step, never executes it. */
async function answerInstall(el) {
  const id = el.dataset.id, shown = installs.find((r) => r.id === id);
  if (!shown || shown.status !== "waiting" || installAnswers.has(id) || !installOwnerVisible()) return;
  const snapshot = JSON.stringify(shown), yes = el.dataset.v === "allowed";
  installAnswers.add(id); el.disabled = true;
  try {
    const [profiles, lock, fresh] = await Promise.all([api("profiles"), api("lock"), api("flows-boards/installs")]);
    if (!installOwnerVisible() || !el.isConnected || !profiles.isOwner || profiles.active?.id || lock.locked) return;
    const current = (fresh.requests ?? []).find((r) => r.id === id);
    if (JSON.stringify(current) !== snapshot) throw new Error(t("window.places.inbox.install-changed"));
    const { request } = await api(`flows-boards/installs/${encodeURIComponent(id)}/${yes ? "approve" : "decline"}`, { expectedRequest: snapshot });
    const [answerer, answeredLock] = await Promise.all([api("profiles"), api("lock")]);
    if (installOwnerVisible() && answerer.isOwner && !answerer.active?.id && !answeredLock.locked && !dialog()) installAnswerResult(request);
  } catch (error) { if (installOwnerVisible()) toast(error.message); }
  finally {
    installAnswers.delete(id);
    if (installOwnerVisible()) {
      const waiting = await readInstalls();
      if (installOwnerVisible()) { installs = waiting; renderNow(); }
    }
  }
}

/* After a draw: re-read what the tab shows from the engine, and draw again only if it changed. */
export async function after() {
  const tab = S.tabs.inbox || "needs";
  let changed = false;
  if (tab === "needs" && await readSourceMerges()) changed = true;
  if (tab === "needs" && await readSourcePublications()) changed = true;
  // A helper's question (parentRunId) is answered in its task's Activity › Helpers, not here (FEATURES17C §4).
  const policy = await api("policy").catch((error) => { sayOnce(error); return null; });
  const fresh = (policy?.waiting ?? []).filter((q) => !q.parentRunId);
  const key = (list) => list.map((q) => q.sessionId + q.fingerprint).join();
  if (key(fresh) !== key(asks)) { asks = fresh; changed = true; }
  if (tab === "needs") {
    try { if (await readAutonomy()) changed = true; } catch (error) { sayOnce(error); }
    const requests = (await api("self-development/requests").catch(sayOnce)).requests ?? [];
    if (JSON.stringify(requests) !== JSON.stringify(changeRequests)) { changeRequests = requests; changed = true; }
    const waiting = await readInstalls();
    if (JSON.stringify(waiting) !== JSON.stringify(installs)) { installs = waiting; changed = true; }
    if (policy && !asksRead) { asksRead = true; changed = true; }
    if (await readUrgency(needRows().map(({ key, text }) => ({ key, text: String(text ?? "").slice(0, 600) })), sayOnce)) changed = true; // Sort the Inbox by urgency
  }
  if (await readWork().catch((error) => { sayOnce(error); return false; })) changed = true; // long-work
  const p17 = await readInbox17(tab);
  if (p17.error) sayOnce(p17.error);
  if (p17.changed) changed = true;
  if (tab === "history") {
    let mode = recMode;
    try { mode = (await api("recordings")).settings?.mode ?? null; } catch (error) { sayOnce(error); }
    if (mode !== recMode) { recMode = mode; changed = true; }
  }
  if (tab === "history" && !chain) {
    try { chain = (await api("safety-extras/activity/verify", {})).check; changed = true; } catch (error) { toast(error.message); chain = { ok: false }; }
  }
  if (changed) renderNow();
}

/* Checking the record: the engine walks the whole chain and answers whether it is unbroken, and where not. */
async function verifyRecord() {
  openDlg({ title: t("window.places.inbox.checking-the-record"), body: `<div class="ver15"><div class="ver-ring15"><svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="27"/><circle class="ver-arc15" cx="32" cy="32" r="27" pathLength="100"/></svg>${ic("shield15")}</div><b id="ver-t15"></b><p class="hint" id="ver-s15">${t("window.places.inbox.each-entry-carries-a-fingerprint-of")}</p></div>`, foot: `<button class="btn" type="button" data-act="dlg-close">${t("delight.ach.close")}</button>` });
  let check;
  try { check = (await api("safety-extras/activity/verify", {})).check; } catch (error) { toast(error.message); return; }
  chain = check;
  const box = dialog()?.querySelector(".ver15");
  if (!box) return renderNow();
  box.classList.toggle("ok15", check.ok);
  $("#ver-t15").textContent = check.ok ? t("window.inbox.intact") : check.reason;
  $("#ver-s15").innerHTML = `${check.ok ? esc(check.reason) : ""}${level() >= 2 ? `<br><code>chain head ${esc(String(check.tip).slice(0, 4))}…${esc(String(check.tip).slice(-4))} · sha-256</code>` : ""}`;
  renderNow();
}

/* ---------- watching a task again: the engine's recording, one frame at a time ---------- */
const RP = { id: "", frames: [], i: 0, timer: null, wanted: "" };
function stopReplay() { clearInterval(RP.timer); RP.timer = null; }
function drawReplay(i) {
  RP.i = i;
  const box = dialog()?.querySelector(".replay6");
  if (!box) return stopReplay();
  const n = RP.frames.length;
  const path = RP.frames.map((_, j) => `<i class="${j < i ? "rp-d" : j === i ? "rp-n" : ""}"></i>`).join("<b></b>");
  const steps = RP.frames.map((f, j) => `<li class="${j < i ? "ok" : ""} ${j === i ? "now6" : ""}">${ic(j < i ? "check" : j === i ? "play" : "info", "s")}<span>${esc(f.label)}<small>${esc(f.detail)}</small></span></li>`).join("");
  paint(box, `<div class="rp-path">${path}</div><ol class="tl">${steps}</ol><span class="meter6"><u data-css="width:${n ? ((i + 1) / n) * 100 : 0}%"></u></span>`);
}
async function openReplay(id) {
  let recording;
  try { recording = await api(`runs/${encodeURIComponent(id)}/recording`); } catch (error) {
    // B001: switched off, the engine's sentence comes with the switch; once on, this same task plays (see initReplayOff).
    if (error.status === 403 && (await api("recordings").catch(() => null))?.settings?.mode === "off") { RP.wanted = id; openDlg({ title: t("recordings.title"), body: recordingsOff(error.message) }); return; }
    toast(error.message);
    return;
  }
  stopReplay();
  RP.id = id;
  RP.frames = recording.frames ?? [];
  const page = typeof window.branchDesktop === "object" ? "rp-page-desktop" : "rp-page";
  openDlg({ title: t("recordings.title"), wide: true, body: '<div class="replay6"></div>',
    foot: `<button class="btn ghost" type="button" data-act="rp" data-v="step">${t("window.places.inbox.step")}</button><button class="btn" type="button" data-act="rp" data-v="play">${ic("play", "s")}${t("recording.page.play")}</button><span class="grow"></span><button class="btn ghost" type="button" data-act="${page}">${t("recordings.save-page")}</button>${ownerHere() ? `<button class="btn ghost" type="button" data-act="rp-events">${t("recording.save-events")}</button>` : ""}<button class="btn" type="button" data-act="rp-flow">${t("window.places.inbox.make-a-workflow")}</button>` });
  drawReplay(0);
}
/* The engine's page of this recording, saved as the file the engine names. */
async function savePage() {
  try {
    const response = await fetch(`/api/runs/${encodeURIComponent(RP.id)}/recording/page?lang=${encodeURIComponent(language())}`, { cache: "no-store", headers: token.get() ? { authorization: "Bearer " + token.get() } : {} });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || String(response.status));
    const name = /filename="([^"]+)"/.exec(response.headers.get("content-disposition") ?? "")?.[1] ?? "";
    const url = URL.createObjectURL(await response.blob());
    Object.assign(document.createElement("a"), { href: url, download: name }).click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(t("window.places.inbox.saved-as-a-page"));
  } catch (error) { toast(error.message); }
}
async function saveEvents() {
  const id = RP.id, box = dialog(), profile = activeId();
  const current = () => ownerHere() && activeId() === profile && RP.id === id && dialog() === box
    && !document.getElementById("app")?.classList.contains("locked-b17");
  if (!current()) return;
  try {
    const response = await fetch(`/api/runs/${encodeURIComponent(id)}/recording/events`, { cache: "no-store",
      headers: token.get() ? { authorization: "Bearer " + token.get() } : {} });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || String(response.status));
    const blob = await response.blob();
    if (!current()) return;
    const url = URL.createObjectURL(blob);
    Object.assign(document.createElement("a"), { href: url, download: `task-events-${id}.jsonl` }).click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) { if (current()) toast(error.message); }
}

let importedLog = null;
function importEvents() {
  const picker = Object.assign(document.createElement("input"), { type: "file", accept: ".jsonl,application/x-ndjson" });
  picker.onchange = async () => {
    stopReplay();
    const profile = activeId();
    try {
      const log = await readEventLog(picker.files?.[0]);
      if (activeId() !== profile || document.getElementById("app")?.classList.contains("locked-b17")) return;
      importedLog = { ...log, profile };
      openDlg({ title: "Recorded event log", wide: true,
        body: '<p>Playback shows the retained events exactly as exported. It does not execute tools or restore approvals.</p><pre id="event-log-step"></pre>',
        foot: '<button class="btn" type="button" data-act="event-step">Step</button><button class="btn" type="button" data-act="event-play">Play</button>'
          + (ownerHere() ? '<button class="btn ghost" type="button" data-act="event-restart">Restart as a new task…</button>' : "") });
      importedLog.index = 0;
      drawImportedEvent();
    } catch (error) { toast(error.message); }
  };
  picker.click();
}
function drawImportedEvent() {
  const box = dialog()?.querySelector("#event-log-step"), log = importedLog;
  if (!box || !log || activeId() !== log.profile || document.getElementById("app")?.classList.contains("locked-b17")) {
    stopReplay(); if (box) box.textContent = t("recording.log-reopen"); return false;
  }
  box.textContent = log.events.length ? `${log.index + 1} / ${log.events.length}\n` + JSON.stringify(log.events[log.index], null, 2) : t("recording.log-no-events");
  return true;
}
function advanceImportedEvent(play) {
  stopReplay();
  if (!drawImportedEvent()) return;
  const advance = () => {
    if (!importedLog || importedLog.index >= importedLog.events.length - 1) return stopReplay();
    importedLog.index++;
    drawImportedEvent();
  };
  if (play) RP.timer = setInterval(advance, 800); else advance();
}
async function restartImportedEvent() {
  stopReplay();
  const log = importedLog;
  if (!log || !ownerHere() || activeId() !== log.profile || !drawImportedEvent()) return;
  if (!window.confirm(t("recording.log-restart-confirm"))) return;
  if (!ownerHere() || activeId() !== log.profile || !drawImportedEvent()) return;
  try {
    const done = await api("recordings/restart", { jsonl: log.text, confirmed: true });
    if (activeId() === log.profile) toast(`New task: ${done.replay}`);
  } catch (error) { if (activeId() === log.profile) toast(error.message); }
}
/* The workflow the engine drafts from the recording, saved; its steps are the recorded ones it can repeat. */
async function makeFlow() {
  try { await api(`runs/${encodeURIComponent(RP.id)}/recording/flow`, {}); } catch (error) { toast(error.message); return; }
  toast(t("window.places.inbox.made-a-workflow"));
}
/* Step moves one frame on; Play runs from here (or from the start, once at the end) through the frames already loaded. */
function stepReplay(el) {
  stopReplay();
  const last = RP.frames.length - 1;
  if (last < 0) return;
  if (el.dataset.v === "step") return drawReplay(Math.min(last, RP.i + 1));
  let i = RP.i >= last ? 0 : RP.i;
  drawReplay(i);
  RP.timer = setInterval(() => { if (++i > last || !dialog()?.querySelector(".replay6")) return stopReplay(); drawReplay(i); }, 800);
}

/* The engine's bounded diff (GET /api/self-development/requests/<id>/diff): one block per changed file, new files by name,
   and the engine's own sentence when there is nothing yet or something falls outside the contract. */
function diffBlocks(d) {
  const lines = (f) => f.lines.map((l) => `<span class="${l.m === "+" ? "d-add" : l.m === "-" ? "d-del" : ""}">${esc(l.m)} ${esc(l.t)}</span>`).join("");
  const files = d.files.map((f) => `<div class="diff15"><div class="df-h15"><code>${esc(f.path)}</code><span>+${f.added} −${f.removed}</span></div><pre>${lines(f)}</pre></div>`).join("");
  const added = d.untracked.map((p) => `<div class="diff15"><div class="df-h15"><code>${esc(p)}</code><span></span></div></div>`).join("");
  return `${[d.note, d.warning].filter(Boolean).map((s) => `<p class="hint">${esc(s)}</p>`).join("")}${files}${added}`;
}

/* The request as it was sent, who sent it and from which app, and its diff before any yes. Decline (selfno15) is live
   while it waits; the yes needs the owner's contract terms and publishing has no route, so selfdo15 stays greyed. */
async function reviewChange(id) {
  const r = changeRequests.find((x) => x.id === id);
  if (!r) return;
  let diff;
  try { diff = await api(`self-development/requests/${encodeURIComponent(r.id)}/diff`); } catch (error) { toast(error.message); return; }
  const editing = r.status === "approved";
  const stages = [[t("window.places.inbox.approve-the-edits"), editing], [t("window.places.inbox.publish-a-draft-pull-request"), false]].map(([t, d], i) => `<li class="${d ? "done" : (i === 0 && !editing) || (i === 1 && editing) ? "now" : ""}"><em>${d ? ic("check", "s") : i + 1}</em>${t}</li>`).join("");
  const foot = editing ? `<button class="btn pri" type="button" data-act="selfdo15" data-v="published" data-id="${esc(r.id)}">${t("window.places.inbox.publish-the-draft")}</button>`
    : `<button class="btn ghost" type="button" data-act="selfno15" data-id="${esc(r.id)}">${t("flowsBoards.installs.decline")}</button><button class="btn pri" type="button" data-act="selfdo15" data-v="editing" data-id="${esc(r.id)}">${t("window.places.inbox.approve-the-edits")}</button>`;
  openDlg({ title: t("window.places.inbox.a-change-to-branchs-own-code"), wide: true,
    body: `<p data-css="margin:0 0 10px">${esc(r.text)}</p><p class="hint">${esc([r.from?.senderName, r.from?.channel, when(r.at)].filter(Boolean).join(" · "))}</p>${r.problem ? `<p class="hint">${esc(r.problem)}</p>` : ""}${diffBlocks(diff)}<ol class="stages15">${stages}</ol>`,
    foot });
}

/* Decline: the engine closes the request, and it can never be approved afterwards. */
async function declineChange(el) {
  el.disabled = true;
  try { await api(`self-development/requests/${encodeURIComponent(el.dataset.id)}/decline`, {}); } catch (error) { el.disabled = false; toast(error.message); return; }
  closeDlg();
  changeRequests = (await api("self-development/requests").catch(sayOnce)).requests ?? [];
  renderNow();
}

/* ---------- Allow all: the confirm names each request, and only those are answered ---------- */
let allowing = null;
function openAllowAll() {
  if (allowable() < 2) return;
  allowing = { asks: exactAsks().map((q) => ({ sessionId: q.sessionId, fingerprint: q.fingerprint, label: q.question || q.label || "" })),
    messages: E.state.trunkWaiting.map((m) => ({ id: m.id, label: m.message })) };
  const n = allowing.asks.length + allowing.messages.length;
  if (n < 2) return;
  const items = [...allowing.asks, ...allowing.messages].map((x) => `<li>${esc(x.label)}</li>`).join("");
  openDlg({ title: t("window.places.inbox.allow-all-question", { count: n }), body: `<ul data-css="margin:0 0 8px">${items}</ul><p data-css="margin:0">${t("window.places.inbox.each-trunk-still-asks")}</p>`,
    foot: `<button class="btn ghost" type="button" data-act="dlg-close">${t("mode.cancel")}</button><button class="btn pri" type="button" data-act="allowall-go">${t("window.places.inbox.allow-all-go", { count: n })}</button>` });
}
async function allowAll() {
  const picked = allowing;
  allowing = null;
  closeDlg();
  if (!picked) return;
  let failed = 0;
  for (const q of picked.asks.filter(exact)) {
    try { await api("policy/approve", { sessionId: q.sessionId, decision: "allow", remember: "never", fingerprint: q.fingerprint, carryOn: true }); }
    catch (error) { failed++; toast(error.message); }
  }
  for (const m of picked.messages) {
    try { await api(`trunks/messages/${encodeURIComponent(m.id)}/answer`, {}); } catch (error) { failed++; toast(error.message); }
  }
  if (!failed) toast(t("window.places.inbox.all-allowed"));
  asks = ((await api("policy").catch(sayOnce)).waiting ?? []).filter((q) => !q.parentRunId);
  await refresh().catch((error) => toast(error.message));
  renderNow();
}

export function init() {
  initAutonomyInbox();
  initDemo17();
  initPages19(); // SELF-309: published pages open from Library and from /#page=<id>
  initInbox17();
  // Install answers only record the owner's decision and show a manual next step.
  markLive(["allowall", "allowall-go", "ptab", "chat", "tmsg", "cutgo15", "cutno15", "verify15", "selfrev15", "replay", "rp", "compare", "xdo", "xdo-no", "sw:histq", "selfno15", "rp-events", "rp-page", "rp-flow"]);
  on("replay", (el) => openReplay(el.dataset.id));
  /* Recordings switched on from History or from the replay dialog: the task that was asked for plays now. */
  document.addEventListener("branch-switched", (e) => {
    if (e.detail?.key !== "recordings") return;
    recMode = e.detail.mode;
    const id = RP.wanted;
    RP.wanted = "";
    if (id && dialog()?.querySelector('[data-off="recordings"]')) openReplay(id);
  });
  on("compare", (el) => openCompare(el));
  on("xdo", (el) => answerInstall(el));
  on("xdo-no", (el) => answerInstall(el));
  on("rp", (el) => stepReplay(el));
  on("rp-events", () => saveEvents());
  on("rp-import", () => importEvents());
  markLive(["rp-import", "event-step", "event-play", "event-restart"]);
  on("event-step", () => advanceImportedEvent(false));
  on("event-play", () => advanceImportedEvent(true));
  on("event-restart", () => restartImportedEvent());
  on("rp-page", () => savePage());
  on("rp-flow", () => makeFlow());
  on("tmsg", async (el) => {
    try { await api(`trunks/messages/${encodeURIComponent(el.dataset.id)}/${el.dataset.v === "answer" ? "answer" : "decline"}`, {}); } catch (error) { toast(error.message); }
    await refresh().catch((error) => toast(error.message));
    renderNow();
  });
  /* Continues the task from its saved transcript in its own conversation; the engine answers once it has run. */
  on("cutgo15", (el) => {
    const run = api(`runs/${encodeURIComponent(el.dataset.id)}/resume`, {});
    openConversation(el.dataset.sid);
    run.catch((error) => toast(error.message)).finally(() => refresh().catch((error) => toast(error.message)));
  });
  /* Leaving it ends the task, so the card does not come back. */
  on("cutno15", async (el) => {
    try { await api(`runs/${encodeURIComponent(el.dataset.id)}/cancel`, {}); } catch (error) { toast(error.message); }
    await refresh().catch((error) => toast(error.message));
    renderNow();
  });
  on("verify15", () => verifyRecord());
  document.addEventListener("input", (e) => {
    if (e.target.id !== "histq") return;
    histQ = e.target.value;
    const pos = e.target.selectionStart;
    renderNow();
    const box = $("#histq");
    if (box) { box.focus(); box.setSelectionRange(pos, pos); }
  });
  on("allowall", () => openAllowAll());
  on("allowall-go", () => allowAll());
  on("selfrev15", (el) => reviewChange(el.dataset.id));
  on("selfno15", (el) => declineChange(el));
}
