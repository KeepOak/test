/* What the prototype's thread draws between and around the messages (block kinds stamp, steps, done, file, choice,
   roomline, a2a and pass, and the pass-15 summary card), each from the engine's own record:
   - day stamps: when each message was written (GET /api/sessions/<id> messages[].at);
   - the steps a reply took, folded to one line: the reply's tool calls in the conversation, named and timed by the
     task's own steps (GET /api/runs/<id>/steps, the same read as the Timeline);
   - a question the task asked, once answered, as a decided line (the steps' ask state: allowed or refused);
   - "Done in …": the finished task's own start and end (GET /api/state runs);
   - the files a task made, as file chips opening Library › Made for you (GET /api/artifacts, kept under the task);
   - "Earlier in this conversation": the summary the engine kept when it folded older turns (GET /api/sessions/<id>/summary);
   - a question with lettered options (the engine's user.ask with options): picking one, or typing an answer, is the
     owner's next message, which is how the engine takes the answer;
   - Trunk-to-Trunk messages (the engine's own "Message from …" and "Reply from …" words in a Trunk's conversation) as
     the prototype's folded card. */

import { esc, render } from "../core/dom.js";
import { S, E } from "../core/state.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { ic, av, toast } from "../core/ui.js";
import { markLive } from "../core/features.js";
import { stepsOf, loadSteps } from "./timeline.js";
import { said } from "./livesteps.js";
import { t, language } from "../../i18n.js";
import { browserProofHTML } from "./browser-proof.js";
import { stepSummary } from "./step-summary.js";

const F = { own: new Map(), summaries: new Map(), asked: new Set(), artifacts: null, artAsked: 0, stepsAsked: new Set(), later: new Map(), send: async () => {} };

/* ---------- when ---------- */
const day = (d) => d.toDateString();
const clock = (d) => d.toLocaleTimeString(language(), { hour: "numeric", minute: "2-digit" });
export const sentAt = (m) => { const d = new Date(m?.at ?? ""); return Number.isNaN(d.getTime()) ? "" : clock(d); };
/* A stamp before a message when the day changes or half an hour has passed since the last message that has a time. */
export function stampBefore(m, prev) {
  const d = new Date(m?.at ?? "");
  if (Number.isNaN(d.getTime())) return "";
  const p = new Date(prev?.at ?? "");
  if (!Number.isNaN(p.getTime()) && day(p) === day(d) && d - p < 30 * 60000) return "";
  return `<div class="stamp">${esc(stampWords(d))}</div>`;
}
/* A stamp's words: "Today 3:04 PM", "Yesterday 9:10 AM", else the date and the time (trunk-one-row's separators too). */
export function stampWords(d) {
  const today = new Date(), yesterday = new Date(Date.now() - 86400000);
  return day(d) === day(today) ? t("window.chat.stamp.today", { time: clock(d) })
    : day(d) === day(yesterday) ? t("window.chat.stamp.yesterday", { time: clock(d) })
      : `${d.toLocaleDateString(language(), { month: "short", day: "numeric" })} ${clock(d)}`;
}

/* ---------- the task behind a message ---------- */
const runs = (sid) => (E.state?.runs ?? []).filter((r) => r.sessionId === sid);
/** The task a message of the owner's started: the conversation's task with those very words that started nearest to
    when the message was written (the newest one when the message has no time). */
export function runOfPrompt(sid, content, at) {
  const same = runs(sid).filter((r) => r.prompt === content);
  const when = Date.parse(at ?? "");
  if (Number.isNaN(when)) return same.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0] ?? null;
  return same.sort((a, b) => Math.abs(Date.parse(a.createdAt) - when) - Math.abs(Date.parse(b.createdAt) - when))[0] ?? null;
}
const dur = (s) => (s >= 60 ? `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, "0")}s` : `${s < 10 ? s.toFixed(1) : Math.round(s)}s`);
/* The task's steps, read once when first drawn (and again by the Timeline's own reads); the thread is drawn again when
   they arrive. */
/* A task with a question not yet answered is read again a few seconds later, so its answer shows once given. */
const open = (body) => (body?.steps ?? []).some((s) => s.kind === "ask" && s.state !== "allowed" && s.state !== "refused");
function reread(runId, was) {
  if (F.later.has(runId)) return;
  F.later.set(runId, setTimeout(() => {
    F.later.delete(runId);
    loadSteps(runId).then((body) => { if (body && open(body) !== was) render(); });
  }, 3000));
}
function steps(runId) {
  if (!runId) return null;
  const got = stepsOf(runId);
  if (!got && !F.stepsAsked.has(runId)) { F.stepsAsked.add(runId); loadSteps(runId).then((body) => { if (body) render(); }); }
  if (open(got) || got?.status === "running") reread(runId, open(got));
  return got;
}

/* ---------- the steps a reply took ---------- */
const firstLine = (s) => String(s ?? "").split("\n")[0].slice(0, 140);
/** One folded line for the tool calls between two replies: "<n> steps · <time>", opening to each step and what it did. */
export function stepsBlock(calls, runId, face) {
  if (!calls.length) return "";
  const body = steps(runId), byCall = new Map((body?.steps ?? []).filter((s) => s.callId).map((s) => [s.callId, s]));
  const shown = calls.map((c) => byCall.get(c.id) ?? { title: c.name, happened: "", seconds: 0 });
  // How long it worked: from the task's start to the end of this block's last one (thinking included), as the task's
  // own record timed them; before the record is read, the steps' own times.
  const first = Date.parse((E.state?.runs ?? []).find((r) => r.id === runId)?.createdAt ?? body?.steps?.[0]?.at ?? ""), ends = shown.map((s) => Date.parse(s.at ?? "") + (Number(s.seconds) || 0) * 1000).filter((n) => !Number.isNaN(n));
  // The task's last steps, once it has finished, take in the answer written after them: its own start to its finish.
  const calledLast = (body?.steps ?? []).filter((s) => s.callId).at(-1)?.callId;
  // Timed as the task's "Done in" line below it is (afterEnd), so the two never disagree.
  const run = (E.state?.runs ?? []).find((r) => r.id === runId);
  const ran = run && run.status !== "running" ? (Date.parse(run.updatedAt) - Date.parse(run.createdAt)) / 1000 : body && body.status !== "running" ? body.seconds : null;
  const whole = typeof ran === "number" && ran > 0 && calledLast && calls.some((c) => c.id === calledLast) ? ran : null;
  const secs = whole ?? (!Number.isNaN(first) && ends.length ? Math.max(0, (Math.max(...ends) - first) / 1000) : shown.reduce((n, s) => n + (Number(s.seconds) || 0), 0));
  const one = shown.length === 1;
  // Known completed outcomes describe the work; missing status retains the time/step fallback.
  const summary = stepSummary(calls, byCall) || (secs ? t(one ? "window.chat.live.worked-one" : "window.chat.live.worked", { count: shown.length, time: dur(secs) })
    : t(one ? "window.chat.steps.one" : "window.chat.steps.count", { count: shown.length }));
  // What a step came to, in words: a tool's raw answer (JSON) is left to the Timeline.
  const said = (s) => (s.happened && !/^\s*[[{]/.test(s.happened) ? `<small>${esc(firstLine(s.happened))}</small>` : "");
  // Each step with the emoji the engine gave its kind (src/live-steps.ts), the same as while it ran; a step not yet read
  // back keeps the check.
  const mark = (s) => (s.icon ? `<span class="ls-ic" aria-hidden="true">${esc(s.icon)}</span>` : ic("check", "s"));
  const items = shown.map((s) => `<li>${mark(s)}<span>${esc(s.title || "")}${said(s)}</span></li>`).join("");
  return `<div class="b"><div class="gut">${face ? av(face, 28) : ""}</div><div><details class="steps"><summary>${ic("chev", "s chev")}${esc(summary)}</summary><ol>${items}</ol></details></div></div>`;
}

/* ---------- where a task ended: its answered questions, how long it took, and the files it made ---------- */
const SENT = (tool) => String(tool ?? "").startsWith("channels.");
function decided(body, keep = () => true) {
  return (body?.steps ?? []).filter((s) => s.kind === "ask" && (s.state === "allowed" || s.state === "refused") && keep(s)).map((s) => {
    const yes = s.state === "allowed", sent = SENT(s.detail);
    const words = sent ? t(yes ? "window.chat.ask.sent" : "window.chat.ask.not-sent") : t(yes ? "window.chat.tl.allowed" : "panels.state.refused");
    return `<div class="b"><div class="gut"></div><div><div class="decided"><span class="pill ${yes ? "done" : "no"}"><i></i>${esc(words)}</span><span>${esc(s.title)}</span></div></div></div>`;
  }).join("");
}
function madeFiles(run) {
  if (!F.artifacts && Date.now() - F.artAsked > 15000) {
    F.artAsked = Date.now();
    api("artifacts").then((got) => { F.artifacts = got.artifacts ?? []; render(); }, (error) => toast(error.message));
  }
  return (F.artifacts ?? []).filter((a) => a.runId === run.id).map((a) => `<div class="b"><div class="gut"></div><div><button class="file" type="button" data-act="view" data-v="library" data-tab="made"><span class="fi">${esc(a.name.split(".").pop())}</span><span><b>${esc(a.name)}</b><small>${t("window.chat.plus.kb", { n: Math.max(1, Math.round((a.bytes ?? 0) / 1024)) })}</small></span></button></div></div>`).join("");
}
/* Where the work moved to another account after a plan limit, one quiet line each, in the engine's own words (GET
   /api/runs/<id>/steps `switched`, said in the language chosen): the live steps said it while it happened; this keeps it once the task has ended. */
const switched = (body) => (body?.switched ?? []).map((s) => `<div class="b"><div class="gut"></div><div><div class="switched18"><span class="ls-ic" aria-hidden="true">${esc(s.icon)}</span><span>${esc(said(s.say, s.sentence))}</span></div></div></div>`).join("");
/** A task's answered questions, as decided lines: those not already drawn where they were asked (`placed`, by call id);
    then any move to another account. */
export const beforeEnd = (run, placed = new Set()) => (run ? decided(steps(run.id), (s) => !placed.has(s.askedCall)) + switched(steps(run.id)) : "");
/**
 * Q050: the answered questions about these calls (the engine's ask step `askedCall`), drawn right after the steps that
 * made them: a task that asked carries on as itself, so its question stays where it was asked, before what came after.
 */
export const decidedAt = (run, callIds) => (run && callIds.length ? decided(steps(run.id), (s) => !!s.askedCall && callIds.includes(s.askedCall)) : "");
/** After it: the files the task made, and, for a finished task that did work, how long it took. */
export function afterEnd(run, worked, face, messages = []) {
  if (!run) return "";
  const secs = (Date.parse(run.updatedAt) - Date.parse(run.createdAt)) / 1000;
  const done = worked && run.status === "completed" && secs > 0 ? `<div class="b"><div class="gut"></div><div><div class="done-line">${face ? av(face, 20) : ""}${esc(t("window.chat.done-in", { time: dur(secs) }))}</div></div></div>` : "";
  return browserProofHTML(run, messages, F.artifacts ?? []) + madeFiles(run) + done;
}
/** The files kept by tasks change as tasks finish: read them again on the next draw. */
export function forgetMade() { F.artifacts = null; F.artAsked = 0; }

/* ---------- the approval card's request ---------- */
/** The exact request as the prototype's labelled rows: each field of the call as the engine showed it (its bytes), the
   longest words as the body. Bytes that are not a whole JSON object of plain values are shown as they are. */
export function requestRows(bytes) {
  let args = null;
  try { args = JSON.parse(bytes); } catch { args = null; } // cut or not JSON: shown as the bytes themselves
  const plainValue = (v) => ["string", "number", "boolean"].includes(typeof v);
  // Q069: a call with nothing in it has no rows; "{}" on its own says nothing to a person.
  if (args && typeof args === "object" && !Array.isArray(args) && !Object.keys(args).length) return "";
  if (!args || typeof args !== "object" || Array.isArray(args) || !Object.values(args).every(plainValue) || !Object.keys(args).length)
    return `<dd class="mailbody">${esc(bytes)}</dd>`;
  const entries = Object.entries(args).map(([k, v]) => [k, String(v)]);
  const body = entries.reduce((a, e) => (e[1].length > (a?.[1].length ?? 0) ? e : a), null);
  const rows = entries.filter((e) => e !== body || body[1].length <= 80).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("");
  return rows + (body && body[1].length > 80 ? `<dt>${esc(body[0])}</dt><dd class="mailbody">${esc(body[1])}</dd>` : "");
}

/* ---------- earlier in this conversation ---------- */
export function summaryCard(sid) {
  const s = sid ? F.summaries.get(sid) : null;
  if (!s) return "";
  const rows = [["window.chat.sum.doing", s.goals], ["window.chat.sum.decided", s.decisions], ["window.chat.sum.open", s.openQuestions], ["window.chat.sum.files", s.filesTouched]]
    .filter(([, v]) => v?.length).map(([k, v]) => `<dt>${t(k)}</dt><dd>${esc(v.join(k === "window.chat.sum.files" ? " · " : "; "))}</dd>`).join("");
  return rows ? `<details class="sum15"><summary>${ic("layers", "s")}<b>${t("window.chat.sum.earlier")}</b><small>${t("window.chat.sum.kept")}</small></summary><dl>${rows}</dl></details>` : "";
}
export async function loadSummary(sid, again = false) {
  if (!sid || (F.asked.has(sid) && !again)) return;
  F.asked.add(sid);
  let got;
  try { got = await api(`sessions/${encodeURIComponent(sid)}/summary`); } catch (error) { toast(error.message); return; }
  const before = JSON.stringify(F.summaries.get(sid) ?? null);
  F.summaries.set(sid, got.summary ?? null);
  if (JSON.stringify(got.summary ?? null) !== before) render();
}

/* ---------- a question with lettered options ---------- */
const LETTERS = "ABCDE";
/** The options a user.ask call offered, or null. */
export function choiceOf(call) {
  if (call?.name !== "user.ask") return null;
  let args;
  try { args = JSON.parse(call.arguments || "{}"); } catch { return null; } // not JSON: no options to draw
  const options = (Array.isArray(args?.options) ? args.options : []).map((o) => ({ title: String(o?.title ?? ""), hint: String(o?.hint ?? "") })).filter((o) => o.title).slice(0, 5);
  return options.length ? { question: String(args.question ?? ""), sub: String(args.sub ?? ""), options } : null;
}
/** The card, with the owner's answer (the next message) marking the option it picked and locking the rest. */
export function choiceCard(choice, answer, id, face) {
  const picked = answer == null ? null : choice.options.findIndex((o) => o.title === answer.trim());
  const locked = answer != null ? " disabled" : "";
  const opts = choice.options.map((o, i) => `<button class="opt ${picked === i ? "picked" : ""}" type="button" data-act="pick" data-v="${esc(o.title)}"${locked}><kbd>${LETTERS[i]}</kbd><b>${esc(o.title)}</b><small>${esc(o.hint)}</small></button>`).join("");
  const own = answer == null ? `<form class="own" data-form="own"><input class="inp" data-sw="own" data-id="${esc(id)}" value="${esc(F.own.get(String(id)) ?? "")}" placeholder="${t("window.chat.choice.own")}" aria-label="${t("window.chat.choice.own-label")}"><button class="btn sm" type="submit">${t("window.chat.choice.reply")}</button></form>` : "";
  return `<div class="b"><div class="gut">${face ? av(face, 28) : ""}</div><div><div class="card choice"><div class="q">${esc(choice.question)}</div>${choice.sub ? `<div class="sub">${esc(choice.sub)}</div>` : ""}<div class="opts">${opts}</div>${own}</div></div></div>`;
}

/* ---------- Trunks talking to each other ---------- */
const A2A = /^(Message|Reply) from (.+?) \(@([a-z0-9][\w-]*)\)( to your message)?:\n([\s\S]*)$/i;
const mention = (s) => esc(s).replace(/@([a-z0-9][\w-]*)/gi, '<span class="mention">@$1</span>');
/** A message one Trunk sent another, drawn as the prototype's folded card; null when the words are not the engine's. */
export function a2aOf(m) {
  if (m.role !== "user") return null;
  const hit = A2A.exec(String(m.content ?? ""));
  return hit ? { kind: hit[1].toLowerCase(), name: hit[2], handle: hit[3], words: hit[5] } : null;
}
export function a2aCard(msg, lines, here) {
  const other = E.trunks.find((tr) => tr.handle === msg.handle) ?? { name: msg.name };
  const me = here ?? { kind: "main" };
  const rows = lines.map(([who, words]) => `<div class="a2a-l">${av(who, 22)}<span><b>${esc(who.name ?? "Branch")}</b> ${mention(words)}</span></div>`).join("");
  return `<div class="b"><div class="gut">${av(other, 28)}</div><div><details class="a2a10" open><summary>${ic("branch", "s")}${esc(t(lines.length === 1 ? "window.chat.a2a.talked-one" : "window.chat.a2a.talked", { a: other.name, b: me.name ?? "Branch", count: lines.length }))}</summary>${rows}</details></div></div>`;
}

/* ---------- a room ---------- */
export function roomLine(members) {
  const list = (members ?? []).map((m) => E.trunks.find((tr) => tr.id === (m.id ?? m)) ?? m).filter((m) => m?.name);
  if (list.length < 2) return "";
  const names = list.map((m) => `${av(m, 14)}${esc(m.name)}`).join(` ${t("window.chat.room.and")} `);
  return `<div class="roomline">${t("window.chat.room.from", { names })}</div>`;
}
async function pick(words) {
  if (!words) return;
  await F.send(words);
}

export function initFurniture({ send }) {
  F.send = send;
  markLive(["pick", "sw:own"]);
  document.addEventListener("branch-summary", () => loadSummary(S.chat, true)); // after Tidy up folds the conversation
  on("pick", (el) => pick(el.dataset.v));
  /* What is typed as one's own answer is kept in window state, so a redraw while the task waits keeps it. */
  document.addEventListener("input", (e) => { if (e.target.dataset?.sw === "own") F.own.set(e.target.dataset.id, e.target.value); });
  document.addEventListener("submit", (e) => {
    if (e.target.dataset?.form !== "own") return;
    e.preventDefault();
    const box = e.target.querySelector("input");
    const words = (box?.value ?? "").trim();
    if (!words) return;
    F.own.delete(box.dataset.id);
    pick(words);
  });
}
