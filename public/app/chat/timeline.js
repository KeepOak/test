/* The side panel's Timeline (pass 17, part C §1; the prototype's tlHTML17c): every model call, tool step, question,
   helper and steering note of one task, from GET /api/runs/<id>/steps, which reads the task's own record. Step back and
   forward, Play (one step every 0.9 s, 1.4 s with reduced motion, re-drawing only the panel's body), a tick per step to
   jump, "At step N of M" with each step's time and price, and "Check the record", which walks the activity chain
   (POST /api/safety-extras/activity/verify) holding it to this task's own latest link. It opens at the newest task of the
   conversation, or at the task behind a reply from "Look inside". Which step is shown and the replay are window state. */

import { $, esc, applyCss } from "../core/dom.js";
import { ic, mi, toast, closePop, closeDlg } from "../core/ui.js";
import { ICONS } from "../core/icons.js";
import { S, E, level } from "../core/state.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive, greyOut } from "../core/features.js";
import { t, language } from "../../i18n.js";

/* The pass-17 icons this panel draws, as patch17c.js draws them. */
Object.assign(ICONS, {
  tl17c: '<path d="M4 12h16"/><circle cx="6.5" cy="12" r="2.2"/><circle cx="12" cy="12" r="2.2"/><circle cx="17.5" cy="12" r="2.2"/>',
  back17c: '<path d="M7 5.5v13M18 5.5v13L9.5 12z"/>', fwd17c: '<path d="M17 5.5v13M6 5.5v13l8.5-6.5z"/>',
  helper17c: '<circle cx="8" cy="8" r="3"/><circle cx="17" cy="15.5" r="2.5"/><path d="M3.5 19a4.5 4.5 0 0 1 9 0M10.5 10.5l4.5 3"/>',
});

const T = { pick: null, run: null, at: 0, on: false, timer: null, ver: 0, check: null, cache: new Map(), redraw: () => {}, changed: () => {}, messages: () => [] };
const KIND = { model: "model", tool: "tool", ask: "ok", helper: "help", you: "you" };
const WORD = { model: "window.chat.tl.model-call", tool: "field.tool", ask: "window.chat.tl.approval", helper: "window.chat.tl.helper", you: "lmore.meaning.you" };
const ICON = { model: "spark", tool: "check", ask: "shield", helper: "helper17c", you: "retry" };
const calm = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/* This conversation's tasks, newest first. */
const runsHere = () => (E.state?.runs ?? []).filter((r) => S.chat && r.sessionId === S.chat)
  .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
/* The task the panel shows: the one opened from a reply, while it belongs to this conversation, else the newest; while a
   new conversation's first task runs (before the window has its id), that task. */
export function timelineRun() {
  const here = runsHere();
  return here.find((r) => r.id === T.pick)?.id ?? here[0]?.id ?? (S.chat ? null : L.run?.id) ?? null;
}

/* The task working in this conversation now, from GET /api/activity (the window's picture of tasks is read again only
   once a first message's task has finished). Asked every 1.5 s, only while something here is working. */
const L = { run: null, first: () => null };
export const liveRun = () => L.run;
async function pollLive() {
  const first = L.first();
  if (S.view !== "chat" || (!first && !L.run && !runsHere().some((r) => r.status === "running"))) { if (L.run) { L.run = null; T.changed(); } return; }
  const list = await api("activity").catch(() => null);
  const mine = (Array.isArray(list) ? list : []).find((a) => a.status === "running" && (S.chat ? a.sessionId === S.chat : a.prompt === first));
  const next = mine ? { id: mine.runId, sessionId: mine.sessionId } : null;
  if ((next?.id ?? null) !== (L.run?.id ?? null)) { L.run = next; T.changed(); }
}

/* One task's steps, read again at most every two seconds; the Helpers section and the thread's chip read the same. */
export function stepsOf(runId) { return T.cache.get(runId)?.body ?? null; }
export async function loadSteps(runId) {
  if (!runId) return null;
  const kept = T.cache.get(runId);
  if (kept && (kept.busy || Date.now() - kept.at < 2000)) {
    // Asked again too soon: read once more when the two seconds are up, so the last draw never keeps an old answer.
    if (!kept.busy && !kept.later) kept.later = setTimeout(() => loadSteps(runId), 2000 - (Date.now() - kept.at) + 10);
    return kept.body;
  }
  T.cache.set(runId, { at: Date.now(), body: kept?.body ?? null, busy: true });
  let body = kept?.body ?? null;
  try { body = await api(`runs/${encodeURIComponent(runId)}/steps`); } catch (error) { if (error.message !== kept?.said) toast(error.message); T.cache.set(runId, { at: Date.now(), body, said: error.message }); return body; }
  T.cache.set(runId, { at: Date.now(), body });
  // The thread is drawn again only when what it shows changed (the helpers chip, the steering lines); else the panel alone.
  if (JSON.stringify(inThread(body)) !== JSON.stringify(inThread(kept?.body))) T.changed();
  else if (JSON.stringify(body) !== JSON.stringify(kept?.body)) T.redraw();
  return body;
}
export function forgetSteps(runId) { T.cache.delete(runId); }
const inThread = (body) => [(body?.helpers ?? []).map((h) => [h.runId, h.waiting?.length ?? 0]), (body?.steps ?? []).filter((s) => s.kind === "you").map((s) => s.title)];

/* The More menu's row for a reply (chat/more.js registers it with addMoreItem): the task's every step. */
export const everyStepItem = (runId) => (runId ? mi("tlopen17c", "tl17c", t("window.chat.tl.every-step"), "", `data-run="${esc(runId)}"`) : "");

const dur = (s) => (s >= 60 ? `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, "0")}s` : `${s < 10 ? s.toFixed(1) : Math.round(s)} s`);
const money = (n) => `$${n.toFixed(2)}`;
const clock = (at) => { const d = new Date(at); return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString(language(), { hour: "numeric", minute: "2-digit", second: "2-digit" }); };
const nums = (n) => (typeof n === "number" ? n.toLocaleString(language()) : "");

/* Who took a step: a helper by its name, the owner as "You", everything else the conversation's Trunk or Branch. */
function author() {
  const s = E.sessions.find((x) => (x.sessionId ?? x.id) === S.chat);
  return E.trunks.find((tr) => tr.id === s?.trunkId || tr.id === s?.trunk?.id)?.name || E.state?.identity?.name || "";
}
function view(step, data) {
  const helper = step.kind === "helper" ? data.helpers?.find((h) => h.runId === step.helperRunId) : null;
  const tokens = step.tokens && (step.tokens.input != null || step.tokens.output != null) ? t("window.chat.tl.tokens", { in: nums(step.tokens.input), out: nums(step.tokens.output) }) : "";
  const title = step.kind === "helper" ? t("window.chat.tl.started-helper", { title: step.title }) : step.title;
  const detail = step.kind === "model" ? [step.detail, tokens].filter(Boolean).join(" · ") : step.detail;
  const who = step.kind === "you" ? t("lmore.meaning.you") : helper ? helper.name || "" : author();
  return { title, detail, who, helper, secs: Number(step.seconds) || 0, amount: typeof step.cost?.amount === "number" ? step.cost.amount : null };
}

function head(data, steps) {
  const time = steps.reduce((a, s) => a + (Number(s.seconds) || 0), 0);
  const live = ["running", "queued", "waiting"].includes(data.status);
  const cost = data.cost?.display ? ` · ${esc(data.cost.display)}` : "";
  const ticks = steps.map((s, i) => `<button type="button" class="tk17c k${KIND[s.kind]}17c ${i === T.at ? "on17c" : ""} ${i > T.at ? "later17c" : ""}" data-act="tlgo17c" data-v="${i}" aria-label="${t("window.chat.tl.step-label", { n: i + 1, title: esc(view(s, data).title) })}"></button>`).join("");
  return `<div class="tlh17c"><b>${esc(data.title)}</b><small>${live ? t("window.chat.tl.steps-so-far", { count: steps.length, time: dur(time) }) : t("window.chat.tl.steps-time", { count: steps.length, time: dur(time) })}${cost}</small></div>
    <div class="tlctl17c"><button type="button" class="icon-btn" data-act="tlstep17c" data-v="-1" aria-label="${t("recording.page.back")}" ${T.at <= 0 ? "disabled" : ""}>${ic("back17c", "s")}</button><button type="button" class="btn sm tlplay17c" data-act="tlplay17c" aria-pressed="${T.on}">${ic(T.on ? "pause15" : "play15", "s")}${T.on ? t("autonomy.pause") : t("recording.page.play")}</button><button type="button" class="icon-btn" data-act="tlstep17c" data-v="1" aria-label="${t("window.chat.tl.forward")}" ${T.at >= steps.length - 1 ? "disabled" : ""}>${ic("fwd17c", "s")}</button><span class="tkrow17c" role="group" aria-label="${t("window.chat.msg.steps")}">${ticks}</span></div>`;
}

const PILL = { waiting: ["work", "task.owner"], refused: ["no", "window.chat.tl.refused"], allowed: ["done", "window.chat.tl.allowed"] };
/* The message a step came from: a tool step's call is on the assistant message that asked for it. */
function messageOf(step) {
  if (!step.callId) return null;
  return T.messages().find((m) => (m.toolCalls ?? []).some((c) => c.id === step.callId))?.messageId ?? null;
}
function atCard(data, steps) {
  const s = steps[T.at], v = view(s, data), upto = steps.slice(0, T.at + 1);
  const known = upto.filter((x) => typeof x.cost?.amount === "number"), tot = known.reduce((a, x) => a + x.cost.amount, 0);
  const time = upto.reduce((a, x) => a + (Number(x.seconds) || 0), 0);
  const p = s.kind === "ask" && PILL[s.state] ? `<span class="pill ${PILL[s.state][0]}"><i></i>${t(PILL[s.state][1])}</span>` : `<span class="pill idle">${t(WORD[s.kind])}</span>`;
  const cost = [s.cost?.display ?? "", known.length ? t("window.chat.tl.cost-so-far", { amount: money(tot), time: dur(time) }) : t("window.chat.tl.time-in", { time: dur(time) })].filter(Boolean).join(" · ");
  const mid = messageOf(s);
  const jump = mid != null && document.querySelector(`#conversation [data-i15="${CSS.escape(String(mid))}"]`) ? `<button type="button" class="btn ghost sm" data-act="tljump17c" data-mid="${esc(mid)}">${t("window.chat.tl.show-it")}</button>` : "";
  const answer = v.helper?.waiting?.length ? `<button type="button" class="btn sm" data-act="hpopen17c">${t("window.chat.tl.answer")}</button>` : "";
  return `<div class="tlat17c" aria-live="polite"><div class="tla-h17c"><b>${t("window.chat.tl.at-step", { n: T.at + 1, total: steps.length })}</b>${p}</div><h3>${esc(v.title)}</h3><dl class="kv"><dt>${t("window.chat.tl.who")}</dt><dd>${esc(v.who)}</dd><dt>${t("first-run-trouble.details")}</dt><dd>${esc(v.detail)}</dd><dt>${t("window.chat.tl.took")}</dt><dd>${v.secs ? dur(v.secs) : t("window.chat.tl.no-time")}${s.at ? ` · ${t("window.chat.tl.at", { time: esc(clock(s.at)) })}` : ""}</dd><dt>${t("window.chat.msg.cost")}</dt><dd>${esc(cost)}</dd></dl>
    ${s.had ? `<p><b>${t("window.chat.tl.had")}</b>${esc(s.had)}</p>` : ""}${s.happened ? `<p><b>${t("inspector.summary")}</b>${esc(s.happened)}</p>` : ""}
    <div class="acts">${jump}${answer}</div></div>`;
}

function list(data, steps) {
  const tech = level() >= 2;
  return `<ol class="tll17c">${steps.map((s, i) => { const v = view(s, data); return `<li class="k${KIND[s.kind]}17c ${i === T.at ? "on17c" : ""} ${i > T.at ? "later17c" : ""}"><button type="button" data-act="tlgo17c" data-v="${i}"><span class="tli17c">${ic(ICON[s.kind], "s")}</span><span class="grow"><b>${esc(v.title)}</b><small>${esc([v.who, v.detail].filter(Boolean).join(" · "))}${tech && s.hash ? ` · <code>${esc(s.hash.slice(0, 8))}</code>` : ""}</small></span><span class="tlm17c">${v.secs ? dur(v.secs) : ""}${s.cost?.display && v.amount ? `<br>${esc(s.cost.display)}` : ""}</span></button></li>`; }).join("")}</ol>`;
}

/* "Check the record": the chain's own answer. "Record intact" only when this task's steps are in it and it is unbroken. */
function verify(data, steps) {
  const c = T.check, first = steps.find((s) => s.at)?.at;
  let msg = `<b>${t("safety.chain.verify")}</b><small>${t("window.chat.tl.check-hint")}</small>`;
  if (T.ver === 1) msg = `<b>${t("window.chat.tl.checking")}</b><small>${t("window.chat.tl.checking-hint")}</small>`;
  const intact = T.ver === 2 && c?.ok && data.chain?.entries > 0;
  if (intact) msg = `<b>${t("window.inbox.intact")}</b><small>${t("window.chat.tl.link-up", { count: data.chain.entries, time: esc(clock(first)) })}${level() >= 2 ? `<br><code>chain head ${esc(String(c.tip).slice(0, 8))}…${esc(String(c.tip).slice(-4))} · sha-256</code>` : ""}</small>`;
  else if (T.ver === 2 && c) msg = `<b>${esc(c.reason)}</b>`;
  return `<div class="tlver17c ${intact ? "ok17c" : ""}">${ic(intact ? "check" : "shield", "s")}<span class="grow">${msg}</span>${T.ver === 1 ? "" : `<button type="button" class="btn sm" data-act="tlver17c">${T.ver === 2 ? t("autonomy.readiness.check") : t("safety.scan.run")}</button>`}</div>`;
}

/* The panel's body. With no task yet, the prototype's own empty line. */
export function timelineBody() {
  const runId = timelineRun();
  if (runId !== T.run) Object.assign(T, { run: runId, at: Infinity, len: 0, ver: 0, check: null });
  loadSteps(runId);
  const data = stepsOf(runId), steps = data?.steps ?? [];
  if (!steps.length) { stop(); return `<div data-art17="art17-timeline"></div><p class="empty">${t("window.chat.tl.empty")}</p>`; }
  // At the newest step, a new step keeps the card on the newest; anywhere earlier, it stays where the owner put it.
  if (!T.on && T.at >= (T.len ?? 0) - 1) T.at = steps.length - 1;
  T.len = steps.length;
  T.at = Math.max(0, Math.min(T.at, steps.length - 1));
  return `<div class="tl17c">${head(data, steps)}${atCard(data, steps)}${list(data, steps)}${verify(data, steps)}</div>`;
}

/* Play re-draws only the panel's body, never the whole window. */
function drawBody() {
  const b = $("#pane .pane-b");
  if (!b || S.pane !== "tl17c") return;
  const y = b.scrollTop;
  b.innerHTML = timelineBody();
  applyCss(b);
  greyOut(b);
  b.scrollTop = y;
}
function stop() { clearInterval(T.timer); T.timer = null; T.on = false; }
function tick() {
  const n = stepsOf(T.run)?.steps?.length ?? 0;
  if (S.pane !== "tl17c" || S.view !== "chat" || timelineRun() !== T.run || T.at >= n - 1) { stop(); drawBody(); return; }
  T.at++;
  if (T.at >= n - 1) stop();
  drawBody();
}
function play() {
  if (T.on) { stop(); drawBody(); return; }
  if (T.at >= (stepsOf(T.run)?.steps?.length ?? 0) - 1) T.at = 0;
  T.on = true;
  drawBody();
  T.timer = setInterval(tick, calm() ? 1400 : 900);
}

async function check() {
  const tip = stepsOf(T.run)?.chain?.tip;
  Object.assign(T, { ver: 1, check: null });
  drawBody();
  try { T.check = (await api("safety-extras/activity/verify", tip ? { tip } : {})).check; T.ver = 2; } catch (error) { toast(error.message); T.ver = 0; }
  drawBody();
}

/* Opens the Timeline at the task behind a reply (or the newest task), at its newest step. */
export function openTimeline(runId) {
  closePop();
  closeDlg();
  stop();
  Object.assign(T, { pick: runId || null, run: null });
  S.pane = "tl17c";
  T.redraw();
}

function jump(el) {
  if (innerWidth <= 1100) { S.pane = null; T.redraw(); }
  const target = document.querySelector(`#conversation [data-i15="${CSS.escape(el.dataset.mid)}"]`);
  if (!target) return;
  target.scrollIntoView({ block: "center", behavior: calm() ? "auto" : "smooth" });
  target.classList.add("flash15");
  setTimeout(() => target.classList.remove("flash15"), 1400);
}

/* A step counts as the owner leaving the tab: replay stops on a tab, conversation or view change (tick checks). */
export function initTimeline({ redraw, changed, messages, first }) {
  T.redraw = redraw;
  T.changed = changed;
  L.first = first;
  setInterval(pollLive, 1500);
  T.messages = messages;
  markLive(["tlgo17c", "tlstep17c", "tlplay17c", "tlver17c", "tljump17c", "tlopen17c"]);
  on("tlgo17c", (el) => { stop(); T.at = Number(el.dataset.v) || 0; drawBody(); });
  on("tlstep17c", (el) => { stop(); T.at += Number(el.dataset.v) || 0; drawBody(); });
  on("tlplay17c", () => play());
  on("tlver17c", () => check());
  on("tljump17c", (el) => jump(el));
  on("tlopen17c", (el) => openTimeline(el.dataset.run));
}
