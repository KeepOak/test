/* The conversation (design doc 4.1–4.4): the header (merged into the title bar on wide windows), the thread, the
   composer, sending through POST /api/run, and the approval card for a task waiting on a yes (GET /api/policy). */

import { restOf } from "../core/sleep.js";
import { $, esc, renderNow, render, onRender } from "../core/dom.js";
import { S, E, refresh, trunkIntro, chatFace, defaultTrunk, threadTrunk, ownerHere, projectName, level } from "../core/state.js";
import { api, whenBack } from "../core/api.js";
import { on } from "../core/actions.js";
import { ic, av, toast, faceOf } from "../core/ui.js";
import { markLive } from "../core/features.js";
import { text, plain } from "./markdown.js";
import { chips, loadChips, initChips, startMode, trunkModelRefused, showModelMenu } from "./chips.js";
import { drawPane, initPane } from "./pane.js";
import { attached, takePending, filesSent, resendFiles, hasFiles, initPlus, loadWho, readyWho, whoHere, forgetWho, temporaryNext } from "./plus.js";
import { practiceFlag, practiceSent, refusePracticeRoute } from "./practice-next.js";
import { initRec } from "./rec.js";
import { noModelRow } from "./nomodel.js";
import { binding, spoken } from "../shell/keys.js";
import { checkpointRows, initCheckpoints } from "./checkpoints.js";
import { selfCard, loadSelfChange, initSelfChange } from "./selfchange.js";
import { mkCard, initMkTrunk } from "./mktrunk.js";
import { teachBar, teachAdopt, initTeach } from "./teach.js";
import { FIND, findBar, applyFind, initFind } from "./find.js";
import { initToolsHub } from "./toolshub.js";
import { initDictate, loadDictation, dictating, micButton, dictRow, wakeOffer } from "./dictate.js";
import { initTalkLive } from "./talklive.js";
import { replyMark, readNewReply, sentMessage } from "./aloud.js";
import { dockRow, initBg } from "./bg.js";
import { sendInBackground, roomAway } from "./bgsend.js"; // RES-702: Ctrl+Enter starts a new conversation in the background
import { fileRows, mediaRows, pictureCards, initMedia } from "./media.js";
import { besideWrap, rosterButton, initBeside } from "./beside.js";
import { msgActs, pinnedClass, pinsBar, queueRow, loadExtras, initMessages } from "./messages.js";
import { initScrollFollow, jumpRow, selectionHeld } from "./scroll-follow.js";
import { initInputHistory } from "./input-history.js";
import { initFlag, flagBadge } from "./flag.js";
import { rememberCards, initRemember } from "./remember.js";
import { goalStrip, loadGoal, initGoal } from "./goal.js";
import { goHome } from "./goto.js";
import { routeFor, authorOf, countsAsReply, replyWords, readRoom, roomView, roomAsks, answerRoom } from "./rooms.js";
import { planBlock, loadPlan, failedLine, failedRow } from "./runview.js";
import { followLive, stopLive, liveShown, liveBlock, initLive } from "./livesteps.js"; // live steps
import { initWork, pausedCard } from "../places/inboxwork.js"; // long-work: Pause, Resume and Stop, here and in the Inbox
import { stageCard, computerCard, cardResumes } from "./stage.js"; // live-stage: the card while a task works in Branch's browser; batch A: the computer's
import { pathBar, pathMarks, loadPaths, initBranches } from "./branches.js"; // pass 17
import { outClass, outBadge, initLeaveOut } from "./leaveout.js";
import { initMore } from "./more.js";
import { initDiagram } from "./diagram.js";
import { agentWin, initAgent17 } from "./agent17.js"; // pass 17: a Trunk's character beside the conversation
import { helpersChip } from "./helpers.js"; // pass 17: the helpers chip, steering and the model-switch note
import { steerChip, steeredNotes, steeredLine, steerWords, chatSteerOf, chatSteerLine, initSteer } from "./steer.js";
import { helpFrame, frameAfter, viewingHelper, leaveHelper, helperWho, helperThread, helperDock, initHelpFrame } from "./helpframe.js"; // pass 18a
import { droppedNote, initSwitched } from "./switched.js";
import { loadLow, costLine, loadCost, flags, lockBanner } from "./dockinfo.js"; // parity B1
import { pauseNote } from "../flows/pause.js"; // chat-060: a paused Trunk's note at the end of its conversation
import { asksFirst, loadAskFirst, holdForQuestions, initAskFirst } from "./askfirst.js"; // parity B1
import { requestRows, stampBefore, runOfPrompt, stepsBlock, beforeEnd, decidedAt, afterEnd, forgetMade, summaryCard, loadSummary, choiceOf, choiceCard, a2aOf, a2aCard, roomLine, initFurniture } from "./furniture.js"; // parity B1
import { t } from "../../i18n.js";
import { roomThread, watchRoom, initRoomLook } from "./roomlook.js"; // a room drawn as the prototype's group conversation
import { timeLine, initComfort } from "./comfort.js"; // Settings › General: vim keys in the box, a time on every message
import { media17, sized, look17 } from "../core/art17.js";
import { stillOutOfSight } from "../core/still.js";
import { liveRun as engineRun } from "./timeline.js"; // household: the task the engine says works here
import { lineHTML, lineAfter, openLine, freshLine, leaveLine, lineTrunk, trunkOfId, currentOf, dropFromLine, freshIn, firstTimed, keepRead, initTrunkLine } from "./trunkline.js"; // trunk-one-row

/* seat: counts each conversation opened or started, so a send whose answer comes back after the person went to another
   conversation leaves that one on screen (chat/chat.js sendPlain). */
const C = { sessionId: null, messages: [], waiting: [], sending: false, thinking: "", mark: "", project: null, seat: 0 };
const LINE = { now: null }; // trunk-one-row: the timeline drawn around the open conversation (draw, thread)
const routingSends = new Set();
/* Q257: a question the engine bound to the exact request shown (its fingerprint); only such a question is answered here. */
const exactAsk = (q) => /^[a-f0-9]{32}$/.test(String(q.fingerprint ?? ""));

const current = () => E.sessions.find((s) => (s.sessionId ?? s.id) === C.sessionId);
/* A Trunk's own conversation (its chat now, or one it retired). */
const ownTrunk = (sid = C.sessionId) => E.trunks.find((tr) => tr.chatSessionId === sid || (tr.retiredChats ?? []).includes(sid));
const speaker = () => ownTrunk() ?? (whoHere()?.trunk ? E.trunks.find((tr) => tr.id === whoHere().trunk.id) : threadTrunk(C.sessionId) ?? defaultTrunk());
/* The face of whoever answers here: the conversation's Trunk (or room); Branch's own only where Branch itself answers. */
const answerer = () => speaker() ?? chatFace(C.sessionId);
/* The face of whoever wrote reply `m`: its author, else the conversation's own Trunk, room, or Branch. */
const faceFor = (m, info, index) => authorOf(m, index, info) ?? chatFace(C.sessionId);
/* The prototype's renderChat names a Trunk's or a room's conversation by the Trunk or room (c.name). */
const title = () => ownTrunk()?.name || (C.sessionId ? trunkOfId(C.sessionId) : freshIn() && lineTrunk())?.name || E.rooms.find((r) => r.sessionId === C.sessionId)?.name || current()?.title || plain(current()?.opening) || plain(C.messages.find((m) => m.role === "user")?.content).slice(0, 70) || t("comfort.field.newConversation");
/* The engine starts a Trunk's own conversation by asking it to introduce itself, a message it marks (core/state.js
   trunkIntro). The prototype's Trunk conversation opens with the Trunk's hello, so that ask is not drawn as the owner's. */
const enginePrompt = (m) => trunkIntro(m) && !!ownTrunk();

/* Branch on the empty conversation: its idle loop, its sleep once left alone, its still after the long sleep (core/sleep.js). */

/* Chrome pass (owner's call): the header is the conversation's own buttons in the title-bar row, with no face and no
   visible name; the list's row shows which conversation is open. The name stays as the header's accessible heading, and
   Working or Paused shows beside the buttons while it is true. */
/* shell-013: a Trunk's conversation draws a thin line in the Trunk's colour under its header (the prototype's
   --tint: its colour + 66 alpha); the title bar copies it while the header sits in it (shell/shell.js --tint14). Its
   colour is the face's, hex-checked (core/ui.js faceOf). */
const tint = () => { const tr = ownTrunk(); return tr ? ` data-css="--tint:${faceOf(tr).color}66"` : ""; };
export function head() {
  const working = C.sending, paused = E.trunks.find((tr) => tr.chatSessionId === C.sessionId)?.paused;
  const status = working ? `<small class="head-st17 attn"><i></i>${t("strip.status.working")}</small>` : paused ? `<small class="head-st17">${t("window.chat.head.paused")}</small>` : "";
  return `<div class="head"${tint()}><button class="icon-btn menu-only" type="button" aria-label="${t("window.chat.head.show-conversations")}" data-act="side">${ic("menu")}</button>
    ${helperWho() || `<div class="who sr-only17" role="heading" aria-level="1"><b>${esc(title())}</b></div>`}
    <span class="tb-grow"></span>${projectChip()}${status}${stageButtons(working)}
    <button class="icon-btn" type="button" aria-label="${t("window.chat.head.side-panel")}${binding("sidePane") ? ` (${esc(binding("sidePane"))})` : ""}" aria-pressed="${!!S.pane && S.pane !== "browser"}" data-act="pane" data-p="activity">${ic("sidebar")}</button>
    ${rosterButton()}<button class="icon-btn" type="button" aria-label="${t("window.chat.head.find-label")}" data-tip="${t("window.chat.head.find")}" data-act="find-open">${ic("search")}</button>
    <button class="icon-btn" type="button" aria-label="${t("window.chat.head.more")}" aria-expanded="false" data-act="chatmenu">${ic("more")}</button></div>`;
}

/* Dogfood D14: the project this conversation is filed under (GET /api/sessions/<id> project), or the one a new
   conversation will start in, shown by its name while it is not the default one, so nothing is filed out of sight. It
   opens the project's page. Projects are the owner's: nothing is drawn for anybody else. */
function projectChip() {
  const pr = ownerHere() && C.project && C.project !== "default" ? (E.state?.project?.all ?? []).find((p) => p.id === C.project) : null;
  return pr ? `<button class="proj-chip18" type="button" data-act="project" data-v="${esc(pr.id)}">${ic("folder", "s")}<span>${esc(projectName(pr))}</span></button>` : "";
}
/* A new conversation starts in the project it was begun from (a project's "New conversation in …"), else in the default
   one, never in whichever project happened to be opened last (dogfood D14). It is named on the message itself, and the
   engine keeps every task in its own conversation's project (src/project-scope.ts), so nothing global is switched. */
function newProject() {
  return ownerHere() ? { project: C.project ?? "default" } : {};
}

/* The prototype's computer and browser buttons (its "calmer window" pass): each opens the stage full size (chat/stage.js's
   `stage`); the computer's carries a live dot while a task of this conversation works. */
function stageButtons(working) {
  const who = speaker()?.name || E.state?.identity?.name || "";
  const live = working || (E.state?.runs ?? []).some((r) => r.sessionId === C.sessionId && r.status === "running");
  const computer = who ? `<button class="icon-btn" type="button" aria-label="${esc(t("window.chat.head.computer-full", { name: who }))}" data-tip="${esc(t("window.chat.head.computer-full", { name: who }))}" data-act="stage" data-v="computer">${ic("monitor")}${live ? '<i class="live7"></i>' : ""}</button>` : "";
  return `${computer}<button class="icon-btn" type="button" aria-label="${t("window.chat.head.browser-full")}" data-tip="${t("window.chat.head.browser-full")}" data-act="stage" data-v="browser">${ic("globe")}</button>`;
}

const mid = (m) => (m.messageId ? ` data-i15="${esc(m.messageId)}"` : "");
/* In a view-only conversation (a room member's, pass 18b) a message has no actions: nothing there starts work. */
const acts = (m) => (viewingHelper() ? "" : msgActs(m));
/* dogfood D15: a Trunk's routine is asked with "[Trunk @handle] " in front, for the scheduler; the thread shows its words. */
const ownWords = (words) => String(words ?? "").replace(/^\[Trunk @[a-z0-9-]{1,60}\] /, "");
function user(m) { return `<div class="u${pinnedClass(m)}${outClass(m)}"${mid(m)}>${esc(ownWords(m.content))}${timeLine(m)}${acts(m)}</div>${outBadge(m)}${fileRows(m)}${mediaRows(m)}`; }
/* A reply is signed as the prototype's are: the face of whoever wrote it when the speaker changes (a Trunk's, or Branch's),
   and in a room the Trunk's name above it. */
function bot(m, first, who, info) {
  const from = first && who && info?.kind === "room" ? `<div class="from">${esc(who.name)}</div>` : "";
  return `<div class="b${pinnedClass(m)}${outClass(m)}"${mid(m)}><div class="gut">${first ? av(who ?? chatFace(C.sessionId), 28) : ""}</div><div>${from}<div class="txt">${text(replyWords(m, info))}</div>${timeLine(m)}</div>${acts(m)}</div>${outBadge(m)}${flagBadge(C.sessionId, m)}`;
}

/* The approval card, 1:1 with the prototype's: the action's verb (allow once), "Always allow" (a standing rule in the
   owner's policy, POST /api/policy/approve { remember: "always" }; the engine keeps it for every Trunk, so the card does
   not name one), and "Don't …" (deny). Always allow is drawn only where the engine could keep it: not in Ask first or
   Plan (noStanding), not for a call that names nothing a rule could hold (noAlways), not for a once-only question, not
   for work the owner did not start, not on a household profile, and not under Lockdown; the engine refuses each anyway. The verb comes from the tool alone,
   never from the label, which can carry a reviewer's or hook's words; the label is the card's body. Each button names
   its request by session and fingerprint, and only that exact request is answered. */
const VERBS = { files: "window.chat.ask.change-it", shell: "playground.run", code: "playground.run", device: "trunks.room.allow", browser: "window.chat.ask.go-ahead", channels: "window.chat.ask.send-it", memory: "window.chat.ask.save-it" };
const verbOf = (tool) => t(tool === "files.read" ? "window.chat.ask.read-it" : VERBS[String(tool ?? "").split(".")[0]] ?? "trunks.room.allow");
/* The requests being answered now, by session and fingerprint: from the first press until the engine answers, the card's
   buttons stay disabled (also when the card is drawn again meanwhile) and a second press sends nothing. */
const answering = new Set();
const askKey = (sid, fp) => `${sid}\n${fp || ""}`;
/* QA Q049: a request that hands work to helpers lists each job in plain words (the engine's `jobs`: who, and what it was
   asked); the request's raw text stays for those who asked to see more (How much to show). */
function requestBody(q) {
  const jobs = Array.isArray(q.jobs) ? q.jobs : [];
  if (!jobs.length) return q.bytes ? requestRows(q.bytes) : "";
  return jobs.map((j) => `${j.name ? `<dt>${esc(j.name)}</dt>` : ""}<dd>${esc(j.job)}</dd>`).join("") + (q.bytes && level() >= 2 ? requestRows(q.bytes) : "");
}
function askCard(q) {
  const verb = verbOf(q.tool);
  const off = answering.has(askKey(q.sessionId, q.fingerprint)) ? " disabled" : "";
  const id = `data-sid="${esc(q.sessionId)}" data-fp="${esc(q.fingerprint || "")}"${off}`;
  const locked = document.getElementById("app")?.classList.contains("locked"); // Lockdown keeps no standing yes either
  const standing = !q.noStanding && !q.noAlways && !q.onceOnly && q.source === "owner" && !E.profiles?.active?.id && !locked;
  const always = standing ? `<button class="btn" type="button" data-act="ask-always" ${id}>${t("window.chat.ask.always")}</button>` : "";
  return `<div class="b"><div class="gut"></div><div><div class="card ask" id="live-ask"><div class="card-h"><span class="q">${esc(q.question || q.label)}</span><span class="pill work ml"><i></i>${t("dashboard.needs.title")}</span></div>
    ${(q.question && q.label) || q.bytes || q.jobs?.length ? `<dl class="kv">${q.question && q.label ? `<dd class="mailbody">${esc(q.label)}</dd>` : ""}${requestBody(q)}</dl>` : ""}
    <div class="acts"><button class="btn pri" type="button" data-act="ask" data-v="allow" ${id}>${esc(verb)}</button>${always}<button class="btn ghost" type="button" data-act="ask" data-v="deny" ${id}>${t("window.chat.ask.dont-allow")}</button></div></div></div></div>`;
}

/* The thread, 1:1 with the prototype's blocks: a stamp where the day changes or time has passed, the owner's messages,
   each reply signed by whoever wrote it, the tool calls between replies folded to one steps line, and, where a task
   ended, its answered questions, the files it made and how long it took (chat/furniture.js). */
const shown = (m) => m.role !== "tool" && m.role !== "system" && m.from !== "branch" && !enginePrompt(m);
const nextShown = (list, i) => list.slice(i + 1).find(shown);
function thread() {
  const info = whoHere(), list = C.messages, marks = pathMarks(list), line = LINE.now;
  /* Each reply's place among the replies, counted as the engine counts them for `authors`. */
  const index = new Map();
  let replies = 0;
  for (const m of list) { index.set(m, replies); if (countsAsReply(m)) replies++; }
  const T = { out: [], calls: [], run: null, worked: false, choice: null, lastRole: null, lastWho: null, prev: line ? firstTimed(list) : null, used: new Set(), decided: new Set(), failed: new Set(), placed: new Set() };
  /* A room is drawn as the prototype's group conversation (chat/roomlook.js) once its record is read; its asks still follow. */
  const inRoom = roomThread(info, list, C.sessionId);
  if (inRoom !== null) T.out.push(inRoom);
  else list.forEach((m, i) => {
    if (!shown(m) || T.used.has(m)) return;
    if (m.role === "user") userRow(T, m, i, marks);
    else if (m.toolCalls?.length) toolRow(T, m, info, index);
    else replyRow(T, m, i, info, index, marks);
    if (m.at) T.prev = m;
  });
  flushSteps(T);
  flushDecided(T);
  flushFailed(T);
  const asks = C.waiting.filter((q) => q.sessionId === C.sessionId).map(askCard).join("") + roomAsks(info, (q) => answering.has(roomKey(info.room.id, q.memberId, q.fingerprint)));
  const think = C.sending && C.thinking ? `<div class="think">${ic("spark", "s")}<span>${esc(C.thinking)}</span></div>` : "";
  const typing = C.sending ? `<div class="b"><div class="gut">${av(answerer(), 28)}</div><div>${liveShown() ? liveBlock() : think || `<span class="typing" aria-label="${t("window.chat.typing")}"><i></i><i></i><i></i></span>`}</div></div>` : "";
  const room = info?.kind === "room" ? roomLine(info.room?.members) : "";
  /* pass 18b: a room member's conversation, view only, is its messages alone; its questions are answered in the room. */
  if (viewingHelper()) return marks.start + T.out.join("");
  return summaryCard(C.sessionId) + room + marks.start + T.out.join("") + helpersChip() + steeredNotes(list) + planBlock(liveRun()) + stageCard() + computerCard(C.messages) + failedLine(E.state?.runs, C.sessionId, C.sending, T.failed) + rememberCards(C.sessionId) + wakeOffer() + hooked(OUT.notes) + asks + (C.sending || cardResumes() ? "" : pausedCard(E.state?.runs, C.sessionId)) + typing;
}
function flushSteps(T) {
  if (!T.calls.length) return;
  const first = T.lastRole !== "assistant"; // the steps open the answer: signed with its face, as the prototype's block()
  T.out.push(stepsBlock(T.calls, T.run?.id, first ? T.callsFace : null));
  if (first) { T.lastRole = "assistant"; T.lastWho = T.callsBy; }
  T.worked = true;
  T.calls = [];
}
/* A task's answered questions stay where they were asked, as decided lines: right after the steps that asked (toolRow;
   a yes carries the task that asked on as itself, Q050), else after its last step, before the next message, or at the end. */
function flushDecided(T) {
  if (!T.run || T.decided.has(T.run.id)) return;
  T.decided.add(T.run.id);
  const lines = beforeEnd(T.run, T.placed);
  if (lines) T.out.push(lines);
}
/* Q068: a task that failed keeps the engine's words in its own turn, after a later task has come and gone. */
function flushFailed(T) {
  if (!T.run || T.failed.has(T.run.id)) return;
  const line = failedRow(T.run);
  if (!line) return;
  T.failed.add(T.run.id);
  T.out.push(line);
}
function userRow(T, m, i, marks) {
  flushSteps(T);
  /* A note steered in while the task worked: the owner's own words as the "You steered …" line, in its place; the task
     it steered carries on (dogfood D23: never the engine's wrapper as a message). */
  const steered = steerWords(m);
  if (steered !== null) { T.out.push(marks.before(m) + steeredLine(steered) + marks.after(m)); T.lastRole = "steer"; return; }
  const fromChat = chatSteerOf(m); // dogfood-ux-2: a note from a chat app, as its sender's name and words
  if (fromChat) { T.out.push(marks.before(m) + chatSteerLine(fromChat) + marks.after(m)); T.lastRole = "steer"; return; }
  flushDecided(T);
  flushFailed(T);
  const a2a = a2aOf(m);
  if (a2a) { T.out.push(marks.before(m) + stampBefore(m, T.prev) + a2aRow(T, m, i, a2a) + marks.after(m)); T.lastRole = "a2a"; return; }
  T.run = runOfPrompt(C.sessionId, m.content, m.at);
  T.worked = false;
  T.out.push(marks.before(m) + stampBefore(m, T.prev) + droppedNote(m, C.messages) + user(m) + marks.after(m));
  T.lastRole = "user";
}
/* A Trunk's message to this one (its reply follows it here), or the answer to a message this one sent (the words it sent
   are its own trunk.message call before it). */
function a2aRow(T, m, i, a2a) {
  const me = ownTrunk(), other = E.trunks.find((tr) => tr.handle === a2a.handle) ?? { name: a2a.name };
  if (a2a.kind === "message") {
    const reply = C.messages.slice(i + 1).find((x) => x.role === "user" || countsAsReply(x));
    const lines = [[other, a2a.words]];
    if (reply && reply.role === "assistant") { lines.push([me ?? chatFace(C.sessionId), reply.content]); T.used.add(reply); }
    return a2aCard(a2a, lines, me);
  }
  const sent = C.messages.slice(0, i).reverse().flatMap((x) => x.toolCalls ?? []).find((c) => c.name === "trunk.message" && argsOf(c).to?.replace(/^@/, "") === a2a.handle);
  const lines = sent ? [[me ?? chatFace(C.sessionId), String(argsOf(sent).message ?? "")], [other, a2a.words]] : [[other, a2a.words]];
  return a2aCard(a2a, lines, me);
}
const argsOf = (call) => { try { return JSON.parse(call.arguments || "{}") ?? {}; } catch { return {}; } }; // not JSON: no arguments to read
function toolRow(T, m, info, index) {
  if (!T.calls.length) { T.callsBy = authorOf(m, index.get(m), info); T.callsFace = faceFor(m, info, index.get(m)); }
  if (String(m.content ?? "").trim()) T.out.push(replyBubble(T, m, info, index.get(m)));
  for (const call of m.toolCalls) {
    const choice = choiceOf(call);
    if (choice) T.choice = choice;
    else if (call.name !== "user.ask") T.calls.push(call);
  }
  const ids = m.toolCalls.map((call) => call.id), asked = decidedAt(T.run, ids);
  if (asked) { flushSteps(T); T.out.push(asked); ids.forEach((id) => T.placed.add(id)); }
  T.out.push(checkpointRows(m, C.messages) + selfCard(m, C.messages) + mkCard(m) + pictureCards(m, C.messages));
}
function replyBubble(T, m, info, index) {
  const who = authorOf(m, index, info);
  const first = T.lastRole !== "assistant" || (who?.id ?? null) !== (T.lastWho?.id ?? null);
  T.lastRole = "assistant";
  T.lastWho = who;
  return bot(m, first, who, info);
}
function replyRow(T, m, i, info, index, marks) {
  flushSteps(T);
  const next = nextShown(C.messages, i), ends = !next || next.role === "user";
  const choice = T.choice && T.choice.question === String(m.content ?? "").trim() ? T.choice : null;
  T.choice = null;
  const face = faceFor(m, info, index.get(m));
  const body = choice ? choiceCard(choice, next?.role === "user" ? next.content : null, m.messageId ?? i, face) : replyBubble(T, m, info, index.get(m));
  if (choice) { T.lastRole = "choice"; T.lastWho = null; }
  const run = ends && T.run && !LIVE.includes(T.run.status) ? T.run : null;
  T.out.push(marks.before(m) + stampBefore(m, T.prev) + body + checkpointRows(m, C.messages) + selfCard(m, C.messages) + mkCard(m) + afterEnd(run, T.worked, face, C.messages) + marks.after(m));
}

/* The empty conversation, 1:1 with the prototype's emptyChat() (with pass 11's waving Branch in place of the mark): the
   question, starting points that send themselves (POST /api/run, as a typed message is), and the Trunks to ask, each
   opening its own conversation. The prototype's flight booking names an example city (check-fakes), so it is left out. */
/* Each starting point is sent as the person's own message, in the words they read (the language in force). */
const SUGG = ["window.chat.empty.downloads", "window.chat.empty.pdfs", "window.chat.empty.week"];
const isEmpty = () => !C.sessionId && !C.messages.length && !C.sending && !freshIn();
/* The product's name, small and quiet, where a new conversation starts (the owner's "small Branch Agent writing"); the
   title-bar row carries no brand. "Branch Agent" is the product's name, the same in every language. */
const WORDMARK = `<p class="wm17">Branch <span>Agent</span></p>`;
function emptyChat() {
  const ask = E.trunks.filter((tr) => tr.chatSessionId && tr.name !== "New Trunk").slice(0, 4)
    .map((tr) => `<button type="button" data-act="chat" data-id="${esc(currentOf(tr) ?? tr.chatSessionId)}" aria-label="${t("window.chat.empty.ask", { name: esc(tr.name) })}">${av(tr, 28)}</button>`).join("");
  return `<div class="empty-chat"><span class="hero11">${defaultTrunk() ? av(defaultTrunk(), 84) : ""}</span><h1>${t("window.chat.empty.title")}</h1><div class="chips">${SUGG.map((key) => t(key)).map((x) => `<button class="chipb" type="button" data-act="sugg" data-v="${esc(x)}">${esc(x)}</button>`).join("")}</div><button class="link15 wc-go" type="button" data-act="whatcan">${t("window.what.title")}</button>${ask ? `<div class="askrow">${t("window.chat.empty.or-ask", { trunks: ask })}</div>` : ""}${WORDMARK}</div>`;
}

/* The box names who it writes to, as the prototype's does: the room, or the Trunk that answers here. */
function placeholder() {
  if (whoHere()?.kind === "room") return t("window.chat.composer.room");
  const who = speaker();
  return who?.name ? t("window.chat.composer.message-to", { name: who.name }) : t("window.chat.composer.message");
}
function composer() {
  const draft = S.drafts[C.sessionId ?? "new"] ?? "", words = esc(placeholder());
  return `<div class="dock">${helpFrame()}<div id="attached">${attached()}</div>${noModelRow()}${queueRow()}${dockRow()}${steerChip()}${hooked(OUT.dock)}<form class="composer${temporaryNext() ? " temp" : ""}" id="composer" data-form="composer">
    <button class="c-btn" type="button" aria-label="${t("window.chat.composer.plus")}" aria-haspopup="menu" aria-expanded="false" data-act="plusmenu">${ic("plus")}</button><button class="c-btn plug9" type="button" aria-label="${t("window.chat.composer.tools-label")}" data-tip="${t("dashboard.filter.tools")}" aria-haspopup="dialog" data-act="tools9">${ic("puzzle")}</button>
    ${dictating() ? dictRow() : ""}<textarea id="prompt" rows="1" placeholder="${words}" aria-label="${words}"${dictating() ? " hidden" : ""}>${esc(draft)}</textarea>${dictating() ? "" : `<span class="c-flags">${flags(temporaryNext(), asksFirst())}${practiceFlag()}${costLine(C.sessionId)}</span>`}
    ${chips()}
    ${dictating() ? "" : `${micButton()}<button class="c-btn" type="button" aria-label="${t("window.chat.composer.voice")}" data-act="voice">${ic("wave")}</button>`}
    ${!draft.trim() && (C.sending || stoppable()) ? `<button class="c-btn send stop" id="send" type="button" aria-label="${t("dashboard.stop")}" data-act="stop-run">${ic("stop")}</button>`
      : `<button class="c-btn send${draft.trim() || hasFiles() ? " ready" : ""}" id="send" type="submit" aria-label="${t("composer.send")}"${C.sessionId ? "" : ` data-tip="${esc(t("window.chat.bgsend.tip", { keys: spoken("Ctrl+Enter") }))}"`}>${ic("up")}</button>`}</form></div>`;
}

/* ---------- hook points for other batches (PARITY.md, batch B1's hook tasks) ---------- */
const OUT = { notes: [], dock: [] };
/** chat-060 (B3): a note at the end of the thread (a paused Trunk's note), drawn from the conversation's id. */
export const addThreadNote = (draw) => { OUT.notes.push(draw); };
/** setup-delight-024 (B5): something drawn by the message box (the pet walking there), from the conversation's id. */
export const addDockItem = (draw) => { OUT.dock.push(draw); };
/** RES-701: words that go in front of the next plain message here (the Home panel's "Working on", carried to the full
    page), from the conversation's id (null for a new one); each answers "" when it has nothing for this conversation. */
const PREFIX = [];
export const addSendPrefix = (take) => { PREFIX.push(take); };
const hooked = (list) => list.map((draw) => { try { return draw(C.sessionId) || ""; } catch (error) { toast(error.message); return ""; } }).join("");
/** pane-stage-006 (B2): who this conversation is (its Trunk, its room, its name), for the stage's name and dock. */
export const conversationWho = () => ({ sessionId: C.sessionId, trunk: speaker() ?? null, room: E.rooms.find((r) => r.sessionId === C.sessionId) ?? null, title: title() });
/** shell-002 (B6): "waiting" while a request of the conversation waits for the owner (GET /api/policy), "working" while
    one of its tasks runs (GET /api/state runs), else null: the list's copper dot and moving ring. */
export function conversationState(sid) {
  if (C.waiting.some((q) => q.sessionId === sid)) return "waiting";
  return (E.state?.runs ?? []).some((r) => r.sessionId === sid && ["running", "queued"].includes(r.status)) ? "working" : null;
}
/** shell-033 (B6): what a shortcut reaches in the conversation: the message box, and Stop. */
export const chatKeys = { focusBox: () => $("#prompt")?.focus(), stop: () => (viewingHelper() ? undefined : stopRun()) };

/* The words of the message being sent, so the side panel can follow a new conversation's first task before its id is known. */
export const sendingPrompt = () => (C.sending && !C.sessionId ? C.prompt : null);
export const sendingWithoutSession = () => C.sending && !C.sessionId;
/** Whether the open conversation's message is being answered now. */
export const sendingHere = () => C.sending && !!C.sessionId && C.sessionId === S.chat;

/* The conversation's box takes focus when it is clicked (tabindex -1: never a Tab stop), so Space, Shift+Space and
   the arrows keep scrolling it after a redraw: a click in it makes its part draw anew (main.js touched), and the box the
   browser's keys scrolled was the one taken away. Focused, it is found again by its id (core/dom.js keepFocus). */
export function draw() {
  LINE.now = null;
  /* pass 18a/18b: a helper's conversation (its own record) or a room member's (its thread), view only, with one way back
     in the composer's place */
  if (viewingHelper()) return `${besideWrap(`<div class="scroll" id="scroll" tabindex="-1"><div class="thread" id="conversation">${helperThread() || thread()}</div></div>`)}${jumpRow()}${helperDock()}`;
  /* trunk-one-row: a Trunk's conversation is drawn inside the Trunk's one timeline (chat/trunkline.js): its older
     conversations above it, under their own lines, and any written in since below it. #conversation stays the one the
     message box sends to; its own line names when it began, so its first message carries no stamp of its own. */
  const line = LINE.now = isEmpty() || whoHere()?.kind === "room" ? null : lineHTML(C.sessionId, C.messages, current());
  const above = line ? `<div class="thread tl-past19">${line.before}${line.sep}</div>` : "", below = line?.after ? `<div class="thread tl-past19 tl-after19" id="tl-now">${line.after}</div>` : "";
  return `${lockBanner()}${teachBar(C.sessionId)}${findBar()}${pinsBar()}${pathBar(C.sessionId)}${besideWrap(`<div class="scroll" id="scroll" tabindex="-1">${goalStrip(C.sessionId)}${isEmpty() ? emptyChat() : `${above}<div class="thread" id="conversation">${thread()}${pauseNote(C.sessionId)}</div>${below}`}</div>`)}${jumpRow()}${composer()}${agentWin(C.sessionId, C.sending)}`;
}
/* main.js draws the conversation in parts, keeping those whose markup is unchanged; not while Find is open, whose marks
   are written into the drawn thread and must start from a fresh one each time. */
export const inParts = () => !FIND.on;
const heard = new WeakSet();
export function after(main) {
  /* Newest at the bottom stays in view only while the reader is at the bottom; someone reading back keeps their place. */
  const box = $("#scroll", main);
  if (box) {
    const same = C.readSid === C.sessionId;
    if (!same || !selectionHeld(box)) box.scrollTop = !same || C.atBottom !== false ? box.scrollHeight : C.readTop ?? box.scrollHeight;
    /* trunk-one-row: a conversation opened with newer ones below it in the timeline opens at its own end. */
    const now = !same && $("#tl-now", box);
    if (now) box.scrollTop += now.getBoundingClientRect().top - box.getBoundingClientRect().bottom + 24;
    C.readSid = C.sessionId;
    // A scroll box kept from the last draw already has its listener. A box drawn over before the next frame is still sent
    // the scroll queued on it, and off the page it reads 0 for everything, which looked like a reader at the end: only
    // the box on screen says where the reader is.
    if (!heard.has(box)) box.addEventListener("scroll", () => { if (!box.isConnected) return; C.readTop = box.scrollTop; C.atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40; }, { passive: true });
    heard.add(box);
    stillOutOfSight(box);
    lineAfter(box);
  }
  applyFind();
  frameAfter(); // pass 18a: the helpers frame's clock, and the character window above it
  loadDictation();
  loadChips();
  loadGoal(C.sessionId);
  loadSummary(C.sessionId);
  loadCost(C.sessionId);
  loadLow();
  loadAskFirst();
  loadWho();
  loadSelfChange(C.sessionId, C.messages);
  loadPlan(liveRun());
  loadPaths(C.sessionId);
  const info = whoHere();
  watchRoom(info, rereadRoom); // the open room's refresh reads its conversation too, so new replies come with their tools
  if (info?.kind === "room" && !roomView(info)) readRoom(info).then((view) => { if (view) render(); });
}

/* The room's conversation read again (roomlook.js), kept only while it is still the one open. */
async function rereadRoom() {
  const sid = C.sessionId;
  let got;
  try { got = await api("sessions/" + encodeURIComponent(sid)); } catch (error) { toast(error.message); return C.messages; }
  if (C.sessionId === sid && got?.messages) C.messages = got.messages;
  return C.messages;
}

/* Opening a conversation closes the phone's list over it, as the prototype's openChat does. */
export async function openConversation(id) {
  C.seat += 1;
  S.view = "chat";
  $("#app")?.classList.remove("side-open");
  openLine();
  C.sessionId = id;
  S.chat = id;
  C.messages = [];
  leaveHelper();
  C.mark = openMark(id);
  renderNow();
  C.project = null;
  try { const got = await api("sessions/" + id); C.messages = got.messages ?? []; C.project = got.project ?? null; } catch (error) { toast(error.message); }
  await loadWaiting();
  await loadExtras(id);
  renderNow();
}
/* What the engine last said about the open conversation: its line in the list and its tasks. When it changes, something
   happened there that this window did not start (a new Trunk's hello, a schedule's run, an answer from another window). */
const openMark = (id) => JSON.stringify([E.sessions.find((s) => (s.sessionId ?? s.id) === id) ?? null,
  (E.state?.runs ?? []).filter((r) => r.sessionId === id).map((r) => [r.id, r.status, r.updatedAt ?? ""])]);

/* After the engine's state is read again (an event, or the engine coming back): the open conversation's messages are read
   again when its mark changed, or always with `force`. Not while this window's own send or follow is reading it. Answers
   whether it read them, so the caller draws. */
export async function rereadOpen(force = false) {
  const id = C.sessionId;
  if (S.view !== "chat" || !id || C.sending) return false;
  const mark = openMark(id);
  if (!force && mark === C.mark) return false;
  const got = await api("sessions/" + encodeURIComponent(id));
  if (C.sessionId !== id || C.sending) return false;
  C.mark = mark; // only once the read succeeded, so a failed read is tried again on the next event
  C.messages = got.messages ?? C.messages;
  C.project = got.project ?? C.project;
  return true;
}

export function startConversation(project = null) {
  C.seat += 1;
  S.view = "chat";
  $("#app")?.classList.remove("side-open");
  leaveLine();
  C.sessionId = null;
  S.chat = null;
  C.messages = [];
  C.project = project;
  leaveHelper();
  loadExtras(null);
  renderNow();
  $("#prompt")?.focus();
}

/* trunk-one-row: "New conversation" (the list's +, Ctrl+N, /new) inside a Trunk's timeline starts a fresh conversation
   with that Trunk, a new context shown as a new line at the end of the same timeline, never a row of its own. The
   default Trunk's is begun by its first message (POST /api/run names no conversation, so the engine gives it to the
   default Trunk); another Trunk's is made at once (POST /api/trunks/conversations). Anywhere else it is a new
   conversation as before. helper-lifecycle: the helpers the conversation left working are stopped, as typed /new stops
   them (src/commands/handlers.ts freshConversation); `stopped` says /new already did. */
export async function startFresh({ stopped = false } = {}) {
  if (!stopped && C.sessionId) void api("commands/run", { surface: "window", line: "/new", sessionId: C.sessionId }).catch(() => undefined);
  const trunk = S.view === "chat" ? lineTrunk() : undefined;
  if (!trunk) return startConversation();
  keepRead(C.sessionId, C.messages);
  if (trunk.id === E.defaultTrunkId) {
    startConversation();
    freshLine(trunk);
    renderNow();
    $("#prompt")?.focus();
    return;
  }
  try {
    const made = await api("trunks/conversations", { trunkId: trunk.id });
    await refresh();
    await openConversation(made.sessionId);
  } catch (error) { toast(error.message); startConversation(); }
}

/* Pass 17, Quick ask (chat/quick.js): a new conversation, or the one just made for a Trunk, that starts with these words. */
export async function startWith(words, sessionId) {
  if (sessionId) await openConversation(sessionId); else startConversation();
  await send(words);
}

/* While a task runs, what its model is thinking now (GET /api/activity; held in memory by the engine, never recorded),
   until the task is found: from then on its live steps (chat/livesteps.js) show the thinking and the work as they happen. */
let thinkTimer = null;
function watchThinking(on) {
  clearInterval(thinkTimer);
  C.thinking = "";
  if (!on) { stopLive(); return; }
  thinkTimer = setInterval(async () => {
    const live = await api("activity").catch(() => []);
    // Before a new conversation has its id, only the task this message started counts, found by its own words.
    const mine = (Array.isArray(live) ? live : []).find((a) => (C.sessionId ? a.sessionId === C.sessionId : a.prompt === C.prompt));
    if (mine?.runId) { clearInterval(thinkTimer); followLive(mine.runId); }
    if ((mine?.thinking ?? "") !== C.thinking) { C.thinking = mine?.thinking ?? ""; render(); }
  }, 1000);
}

async function loadWaiting() {
  try { C.waiting = (await api("policy")).waiting ?? []; } catch { C.waiting = []; }
}

/* A line starting with / is offered to the engine's commands first (POST /api/commands/run). One it runs shows its answer
   here and nothing goes to the model; a line it doesn't know is sent as a message. */
async function command(line) {
  let done;
  try { done = await api("commands/run", { surface: "window", line, ...(C.sessionId ? { sessionId: C.sessionId } : {}) }); } catch (error) { toast(error.message); return true; }
  if (!done?.handled) return false;
  C.messages.push({ role: "assistant", content: done.text ?? "" });
  S.drafts[C.sessionId ?? "new"] = "";
  const box = $("#prompt");
  if (box) box.value = "";
  renderNow();
  $("#prompt")?.focus();
  await carryOut(done.client);
  return true;
}

/* What the engine's answer asks the window to do (src/commands/handlers.ts ClientAction): open a place, open or start a
   conversation, put words in the box or send them, read the model again. */
async function carryOut(client) {
  if (!client?.do) return;
  if (client.do === "go") { if (goHome(client.home)) renderNow(); }
  else if (client.do === "open-session" && client.id) await openConversation(client.id);
  else if (client.do === "new") await startFresh({ stopped: true });
  else if (client.do === "fill" && typeof client.text === "string") {
    S.drafts[C.sessionId ?? "new"] = client.text;
    const box = $("#prompt");
    if (box) { box.value = client.text; box.focus(); }
  } else if (client.do === "send" && typeof client.text === "string") await send(client.text);
  else if (client.do === "refresh-model") { await refresh().catch((error) => toast(error.message)); renderNow(); }
  else if (client.do === "search" && typeof client.text === "string") await searchFor(client.text);
}
/* /find: the sidebar's search with these words, as if typed there (loaded when first used, as the shell loads it). */
async function searchFor(text) {
  const { SQ, askEngine } = await import("../shell/search.js");
  SQ.q = text; SQ.f = "all";
  renderNow();
  if (await askEngine(text.trim())) renderNow();
}

/* Sends what is in the box, or `words` when given (an earlier message edited and sent again). While a task works, the
   message joins the conversation's waiting line instead; a message for a room or naming a Trunk goes where the engine
   expects it (rooms.js). */
async function destinationReady(sid, prompt) {
  if (sid && ((ownerHere() && E.trunkModes?.trunks !== "off") || E.rooms.some((room) => room.sessionId === sid))) {
    if (routingSends.has(sid)) return false;
    routingSends.add(sid);
    try { await readyWho(); } catch (error) {
      if (!S.drafts[sid]) S.drafts[sid] = prompt;
      toast(error.message);
      if (C.sessionId === sid) renderNow();
      return false;
    } finally { routingSends.delete(sid); }
  }
  return true;
}

async function send(words, answered = false) {
  const box = $("#prompt");
  const prompt = (words ?? box?.value ?? "").trim();
  if (viewingHelper()) return; // pass 18a: a helper's conversation is view only
  if (!prompt && !(words === undefined && hasFiles())) return;
  sentMessage(); // whether these words were said or typed, for Answer aloud › When I talk
  const busy = C.sending || ["running", "queued"].includes(liveRun()?.status);
  if (refusePracticeRoute(prompt, busy, !!routeFor(prompt, C.sessionId, whoHere(), HOOKS))) return;
  /* While a task works, words join its waiting line; files wait on their chips for the next message. */
  if (C.sending || ["running", "queued"].includes(liveRun()?.status)) { if (prompt) await queueNext(prompt, words === undefined); return; }
  if (prompt.startsWith("/") && (await command(prompt))) return;
  if (!(await destinationReady(C.sessionId, prompt))) return;
  /* A message of files only (attach-followups): no command, no questions first, and a room takes words. */
  if (!prompt) { if (whoHere()?.kind !== "room") await sendPlain("", true); return; }
  /* Stress test B008: a Trunk never answers through a sign-in; the words stay in the box and the model menu says why. */
  if (trunkModelRefused()) { S.drafts[C.sessionId ?? "new"] = prompt; showModelMenu(); return; }
  /* Ask me questions first (chat/askfirst.js): the engine's questions come first, and their dialog sends the words. */
  if (!answered && whoHere()?.kind !== "room" && (await holdForQuestions(prompt))) return;
  const route = routeFor(prompt, C.sessionId, whoHere(), HOOKS);
  if (route) {
    clearBox(words === undefined);
    try { await route(); } catch (error) {
      toast(error.message);
      S.drafts[C.sessionId ?? "new"] = prompt;
      renderNow();
    }
    return;
  }
  await sendPlain(prompt, true);
}

/* A choice card's answer (chat/furniture.js) is this conversation's next message, word for word: an option's title is
   the model's words, so it never runs a command, is never held for Ask me questions first and never goes on to a Trunk
   it names. A second press while the first is sent is dropped. */
async function answerChoice(words) {
  const prompt = String(words ?? "").trim();
  if (!prompt || C.sending) return;
  if (refusePracticeRoute(prompt, ["running", "queued"].includes(liveRun()?.status), whoHere()?.kind === "room")) return;
  if (["running", "queued"].includes(liveRun()?.status)) { await queueNext(prompt, false); return; }
  const info = whoHere();
  if (info?.kind === "room") {
    try { await routeFor(prompt, C.sessionId, info, HOOKS)?.(); } catch (error) { toast(error.message); }
    return;
  }
  await sendPlain(prompt);
}

function clearBox(fromBox) {
  S.drafts[C.sessionId ?? "new"] = "";
  const box = $("#prompt");
  if (fromBox && box) box.value = "";
}

/* A message written while a task works goes through the engine's busy send (POST /api/flows-boards/busy/send), which
   does what the owner chose for typing while it works: wait in the line ("Waiting line · sent after this step"), steer the
   task, or stop it and go next. The engine's words say which; a refusal keeps the words in the box. The conversation
   keeps following until the line has moved on. */
async function queueNext(prompt, fromBox) {
  let sid = C.sessionId ?? liveRun()?.sessionId;
  /* A new conversation's first task may not be in the window's picture yet: read it once more before giving up. */
  if (!sid) { await refresh().catch(() => {}); sid = liveRun()?.sessionId; }
  if (!sid) return;
  let said;
  try { said = await api("flows-boards/busy/send", { sessionId: sid, prompt }); } catch (error) { toast(error.message); return; }
  if (said?.message) toast(said.message);
  clearBox(fromBox);
  C.queued = true;
  await loadExtras(sid);
  renderNow();
  if (!C.sending) await follow(sid);
}

/* The hooks rooms.js uses: open a conversation, send as usual, read who answers again, follow a room's answers. */
const HOOKS = {
  open: (id) => openConversation(id),
  sendPlain: (text) => sendPlain(text),
  after: async () => { forgetWho(); await loadWho(); },
  followRoom: (info) => followRoom(info),
  /* Answer aloud, for a message said to a Trunk in its own conversation: where the replies stood, then the new one. */
  mark: () => replyMark(C.messages),
  readAloud: (before) => readNewReply(before, C.messages),
};

/* A new conversation's box, typed in while its first message was answered, becomes the conversation's own. The caret it
   had is put back once, on the redraw that follows; a later call does nothing, so a caret the person moves after the
   answer shows is never taken back to where it was when the conversation got its id (desktop-hot-update on CI). */
function adoptDraft(sessionId) {
  if (C.sessionId) return () => undefined;
  const box = $("#prompt"), words = S.drafts.new;
  const caret = box ? [box.selectionStart, box.selectionEnd] : null;
  if (typeof words === "string") { S.drafts[sessionId] = words; delete S.drafts.new; }
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const after = $("#prompt");
    if (S.chat === sessionId && after && caret) after.setSelectionRange(...caret);
  };
}

/* The answered conversation becomes the one on screen: its id (a new conversation's first), its draft and its messages,
   unless another was opened while they were read. */
async function adopt(sessionId, before, keepDraft) {
  const seat = C.seat;
  keepDraft(adoptDraft(sessionId));
  C.sessionId = sessionId;
  S.chat = sessionId;
  teachAdopt(sessionId);
  const got = await api("sessions/" + sessionId);
  if (C.seat !== seat) return;
  C.messages = got.messages ?? C.messages;
  C.project = got.project ?? C.project;
  readNewReply(before, C.messages);
}

/* `withLead`: a message the person typed and sent carries the words hooked in front of it (addSendPrefix); a choice
   card's answer and a room's route are sent word for word. */
async function sendPlain(said, withLead = false) {
  const lead = withLead ? PREFIX.map((take) => take(C.sessionId ?? null)).filter(Boolean).join("\n") : "";
  const prompt = lead ? `${lead}\n\n${said}` : said;
  const before = replyMark(C.messages), seat = C.seat, from = C.sessionId ?? "new";
  /* Another conversation opened while this one's answer was on its way (search, the Inbox, a Trunk's row) stays open:
     the answer is this conversation's, read when it is opened again, never drawn over the one on screen. */
  const moved = () => C.seat !== seat;
  C.messages.push({ role: "user", content: prompt });
  C.atBottom = true;
  C.prompt = prompt;
  S.drafts[C.sessionId ?? "new"] = "";
  C.sending = true;
  watchThinking(true);
  renderNow();
  let started = false;
  let restoreDraft = () => undefined;
  try {
    const run = await api("run", { prompt, ...(C.sessionId ? { sessionId: C.sessionId } : {}), ...(await takePending(!C.sessionId)), ...(C.sessionId ? {} : { ...(await startMode()), ...newProject() }) });
    started = true;
    filesSent();
    practiceSent();
    // Gone and come back to it before the answer came: it is on screen again, so its answer is read here all the same.
    if (!moved() || C.sessionId === run.sessionId) await adopt(run.sessionId, before, (restore) => { restoreDraft = restore; });
    /* The task is over once its answer is read back: from here the window only reads what it left (its questions, the
       picture, the extras). Still "sending" meanwhile, a message sent after the answer showed went to the waiting line of
       a task that had ended, and in a new conversation, which has no line, it was left unsent in the box (D1 on CI). */
    C.sending = false;
    watchThinking(false);
    renderNow();
    restoreDraft(); // on this redraw, before the person can type in the box that now shows the answer
    await loadWaiting();
  } catch (error) {
    if (moved()) { toast(error.message); if (!started) S.drafts[from] = prompt; }
    else if (error.offline && !started) keepForLater(prompt);
    else {
      C.messages.push({ role: "assistant", content: error.message });
      if (!started) S.drafts[C.sessionId ?? "new"] = prompt;
    }
  } finally {
    C.sending = false;
    watchThinking(false);
    await refresh().catch(() => {});
    forgetMade();
    loadSummary(C.sessionId, true);
    loadCost(C.sessionId, true);
    await loadExtras(C.sessionId);
    renderNow();
    $("#prompt")?.focus();
    restoreDraft();
  }
  if (C.queued && C.sessionId) { C.queued = false; await follow(C.sessionId); }
}

/* RES-702: the new conversation's message, started in the background (chat/bgsend.js) with everything Enter would send
   with it, while the person stays here. A command, a room, Ask me questions first and a refused model go the usual way,
   which says why; files still arriving wait, as they do for Enter. */
let away = false;
async function sendAway() {
  const box = $("#prompt"), prompt = (box?.value ?? "").trim();
  if (!prompt || viewingHelper() || away) return;
  const routed = !!routeFor(prompt, null, whoHere(), HOOKS); // words that call a Trunk by its @name go its way
  if (prompt.startsWith("/") || asksFirst() || trunkModelRefused() || whoHere()?.kind === "room" || routed) { await send(); return; }
  if (!roomAway()) return; // before the files, Temporary and the mode pick are taken for it: refused, they all stay
  away = true; // a second press while files finish arriving starts nothing more
  let started = false;
  try { started = sendInBackground(prompt, { ...(await takePending(true)), ...(await startMode()), ...newProject() }); } finally { away = false; }
  if (!started) return;
  filesSent();
  practiceSent(); // a practice task was carried (takePending dryRun); the flag is used once, as Enter uses it
  clearBox(true);
  box?.dispatchEvent(new Event("input", { bubbles: true }));
  renderNow();
  $("#prompt")?.focus();
}

/* Q063: a message the engine never got (Branch was not running) goes back in the box, and is sent once the engine
   answers again, unless the person changed it or went elsewhere meanwhile. */
function keepForLater(prompt) {
  const sid = C.sessionId;
  C.messages.pop();
  S.drafts[sid ?? "new"] = prompt;
  const box = $("#prompt");
  if (box) box.value = prompt;
  /* Its files stay on their chips, and are sent ahead again once the engine answers (what it had waiting may be gone). */
  whenBack().then(async () => {
    if (C.sessionId !== sid || C.sending || ($("#prompt")?.value ?? "").trim() !== prompt) return;
    if (hasFiles()) await resendFiles();
    if (prompt || hasFiles()) return send();
  }).catch((error) => toast(error.message));
}

/* A room answers in the background (each member in its own conversation): its conversation is read again each second
   while the room is speaking (GET /api/trunks/rooms/<id> speaking), then once more. */
async function followRoom(info) {
  /* Answer aloud reads each member's reply as it arrives, while the person is in the room. */
  let heard = C.sessionId === info.sessionId ? replyMark(C.messages) : null;
  C.sending = true;
  renderNow();
  for (let waited = 0; waited < 600; waited++) {
    const view = await readRoom(info);
    try { C.messages = (await api("sessions/" + encodeURIComponent(info.sessionId))).messages ?? C.messages; } catch { /* the next second tries again */ }
    if (heard !== null && C.sessionId === info.sessionId && replyMark(C.messages) !== heard) {
      readNewReply(heard, C.messages, (m) => replyWords(m, info));
      heard = replyMark(C.messages);
    }
    renderNow();
    if (!view?.speaking) break;
    await pause(1000);
  }
  C.sending = false;
  renderNow();
}

/* A room member's question, answered once (the same guard as the conversation's own card). */
const roomKey = (room, member, fp) => `${room}\n${member}\n${fp || ""}`;
async function answerInRoom(el, decision) {
  const key = roomKey(el.dataset.room, el.dataset.member, el.dataset.fp);
  if (answering.has(key)) return;
  holdButtons(el, key, true);
  try { await answerRoom(el, decision); } catch (error) { toast(error.message); holdButtons(el, key, false); renderNow(); return; }
  answering.delete(key);
  const info = whoHere();
  if (info?.kind === "room") await followRoom(info);
}

/* One answer per request: every button of the card (or Inbox row) is disabled from the first press until the engine
   answers, and given back if the answer fails, so a double tap never sends a second, different answer. */
function holdButtons(el, key, on) {
  if (on) answering.add(key); else answering.delete(key);
  const box = el.closest(".card, .prow") ?? el;
  for (const b of box.querySelectorAll("button")) b.disabled = on;
  if (!box.querySelector("button")) el.disabled = on;
}
async function answer(el, decision, extra = {}) {
  if (!el.dataset.sid) return;
  const key = askKey(el.dataset.sid, el.dataset.fp);
  if (answering.has(key)) return;
  holdButtons(el, key, true);
  let said = null, q = null;
  try {
    await loadWaiting();
    q = C.waiting.find((w) => w.sessionId === el.dataset.sid && (w.fingerprint || "") === el.dataset.fp);
    // Q257: a question with no fingerprint is not answered from here: a yes without one is not bound to what was shown.
    if (!q || !exactAsk(q)) { holdButtons(el, key, false); renderNow(); return; }
    said = await api("policy/approve", { sessionId: q.sessionId, decision, remember: "never", ...extra, fingerprint: q.fingerprint, carryOn: true });
  } catch (error) {
    toast(error.message);
    holdButtons(el, key, false);
    renderNow();
    return;
  }
  answering.delete(key);
  if (said?.standingNote) toast(said.standingNote); // the engine kept the yes for this conversation only, and says why
  C.waiting = C.waiting.filter((w) => w !== q);
  if (said?.task === "carrying-on") await follow(q.sessionId);
  else await openConversation(q.sessionId);
}

/* The task this conversation is running now; before a new conversation has its id, the one its first message started. */
const LIVE = ["running", "queued", "waiting", "needs_input"];
const liveRun = () => (E.state?.runs ?? []).filter((r) => LIVE.includes(r.status) && (C.sessionId ? r.sessionId === C.sessionId : C.sending && r.prompt === C.prompt))
  .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
/* What Stop stops: that task, or the one the engine's activity list says works here (a household person's task works
   under the owner's name while lent, so the window's picture of tasks never holds it; chat/timeline.js reads it). */
const stoppable = () => liveRun() ?? (C.sessionId && engineRun()?.sessionId === C.sessionId ? engineRun() : undefined);

/* long-work: Resume carries a paused or cut-off task on (POST /api/runs/<id>/resume) in its own conversation, which
   shows its live steps while it works, as a sent message does. */
async function resumeRun(runId, sessionId) {
  // From the Inbox the conversation opens to follow the task, even when it was the last one open.
  if (sessionId && (sessionId !== C.sessionId || S.view !== "chat")) await openConversation(sessionId);
  if (C.sending) return;
  C.sending = true;
  C.prompt = "";
  watchThinking(true);
  renderNow();
  try {
    await api(`runs/${encodeURIComponent(runId)}/resume`, {});
    C.messages = (await api("sessions/" + C.sessionId)).messages ?? C.messages;
  } catch (error) { toast(error.message); } finally {
    C.sending = false;
    watchThinking(false);
    await refresh().catch((error) => toast(error.message));
    renderNow();
  }
}

/* Stop (the prototype puts it in Send's place while the conversation works): POST /api/runs/<id>/cancel. */
async function stopRun() {
  let run = stoppable();
  if (!run) { await refresh().catch((error) => toast(error.message)); run = stoppable(); }
  if (!run) return;
  try { await api(`runs/${encodeURIComponent(run.id)}/cancel`, {}); } catch (error) { toast(error.message); }
  await refresh().catch((error) => toast(error.message));
  renderNow();
}

const busy = (id) => (E.state?.runs ?? []).some((r) => r.sessionId === id && ["running", "queued", "waiting"].includes(r.status));
const pause = (ms) => new Promise((done) => setTimeout(done, ms));

/* A task carried on after a yes: show it working, re-read the conversation each second until it has finished. */
async function follow(id) {
  /* Answer aloud reads the reply this task ends with, when the person was already watching this conversation. */
  const before = C.sessionId === id ? replyMark(C.messages) : null;
  C.sessionId = id;
  C.sending = true;
  watchThinking(true);
  renderNow();
  for (let waited = 0; waited < 600; waited++) {
    await pause(1000);
    await refresh().catch(() => {});
    try { C.messages = (await api("sessions/" + id)).messages ?? C.messages; } catch { /* the next second tries again */ }
    await loadWaiting();
    renderNow();
    if (!busy(id)) break;
  }
  C.sending = false;
  watchThinking(false);
  forgetMade();
  renderNow();
  if (before !== null && C.sessionId === id) readNewReply(before, C.messages);
}

/* trunk-one-row: a conversation archived or deleted from its line: the timeline moves on to its Trunk's newest one. */
function putAway(id) {
  dropFromLine(id);
  if (id !== C.sessionId) return;
  const trunk = lineTrunk(), next = trunk && currentOf(trunk);
  if (next && next !== id) openConversation(next); else startConversation();
}

export function init() {
  initAgent17();
  initTrunkLine();
  document.addEventListener("conv-put-away", (e) => putAway(e.detail));
  initChips();
  initPane();
  initPlus();
  initFind();
  initToolsHub();
  initDictate();
  initTalkLive({ state: () => C, reopen: openConversation });
  initBg();
  initMedia();
  initBeside();
  initMessages({ state: () => C, sendText: (words) => send(words), reopen: openConversation });
  initScrollFollow(() => C);
  initInputHistory(() => C);
  initMore({ state: () => C });
  initLeaveOut({ state: () => C, reopen: openConversation });
  initBranches({ state: () => C, sendText: (words) => send(words), reopen: openConversation });
  initDiagram();
  initRemember();
  initFlag();
  initGoal();
  initRec();
  initCheckpoints();
  initSelfChange();
  initMkTrunk();
  initTeach({ start: startConversation });
  initSteer();
  initHelpFrame();
  initRoomLook();
  initSwitched();
  initFurniture({ send: (words) => answerChoice(words) });
  initComfort();
  // live steps: a question's card shows the moment it is asked; a stream refused for good gives the reply area back
  initLive({ onAsk: () => loadWaiting().then(render), onGone: render, onShow: render });
  initWork({ onResume: (runId, sessionId) => resumeRun(runId, sessionId) }); // long-work
  initAskFirst({ send: (words) => send(words, true) });
  onRender(drawPane);
  markLive(["ask", "ask-always", "room-ask", "send", "side", "stop-run", "sw:prompt", "sugg", "g-ans"]);
  on("sugg", (el) => send(el.dataset.v));
  on("stop-run", () => stopRun());
  on("ask", (el) => answer(el, el.dataset.v === "deny" ? "deny" : "allow"));
  on("room-ask", (el) => answerInRoom(el, el.dataset.v === "deny" ? "deny" : "allow"));
  on("g-ans", (el) => answerInRoom(el, el.dataset.v === "deny" ? "deny" : "allow"));
  on("ask-always", (el) => answer(el, "allow", { remember: "always" }));
  on("side", () => document.getElementById("app").classList.toggle("side-open"));
  document.addEventListener("submit", (e) => { if (e.target.id === "composer") { e.preventDefault(); send(); } });
  /* Enter sends; in a new conversation Ctrl+Enter (Cmd+Enter on a Mac) sends it to work in the background (RES-702). */
  document.addEventListener("keydown", (e) => {
    if (e.target.id !== "prompt" || e.key !== "Enter" || e.shiftKey) return;
    e.preventDefault();
    if ((e.ctrlKey || e.metaKey) && !C.sessionId && !C.sending) sendAway(); else send();
  });
  /* Page Up and Page Down with nothing focused move through the conversation, which scrolls inside its own box. */
  document.addEventListener("keydown", (e) => {
    if (S.view !== "chat" || (e.key !== "PageUp" && e.key !== "PageDown") || e.target !== document.body) return;
    const box = $("#scroll");
    if (!box) return;
    e.preventDefault();
    box.scrollBy({ top: (e.key === "PageUp" ? -0.9 : 0.9) * box.clientHeight });
  });
  document.addEventListener("input", (e) => {
    if (e.target.id !== "prompt") return;
    S.drafts[C.sessionId ?? "new"] = e.target.value;
    // Stop holds Send's place only while the box is empty: typing gives Send back, clearing the box brings Stop again.
    const stopNow = !e.target.value.trim() && (C.sending || !!liveRun());
    if (stopNow !== ($("#send")?.dataset.act === "stop-run")) renderNow();
    $("#send")?.classList.toggle("ready", !!e.target.value.trim() || hasFiles()); // pass 17: Send turns copper once there is something to send
  });
  setInterval(async () => {
    if (S.view !== "chat" || !C.sessionId || C.sending) return;
    const before = JSON.stringify(C.waiting);
    await loadWaiting();
    if (JSON.stringify(C.waiting) !== before) render();
  }, 4000);
}
