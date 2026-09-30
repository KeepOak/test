/* The helpers frame and the view-only helper conversation (pass 18a; the prototype's frame18, helperRow18, helperCard18,
   helperThread18 and dressViewOnly18). The helpers are the tasks the conversation's newest task started, from
   GET /api/runs/<id>/steps `helpers` (runId, sessionId, name, job, status, model, provider, thinking, steps, cost,
   waiting, startedAt, lastStep), read through the Timeline's shared, throttled read and drawn again when the engine's
   events bring a change (chat/timeline.js).
   - The frame sits at the top of the dock, above the chips row, only while a helper works or needs you. Its header has
     up to three faces, "N helpers · N need(s) you" and the time since the first of them started (`startedAt`, ticked
     in place each second, never drawn into the markup so it causes no redraw). Up to three rows, needs-you first: face,
     name, the live line (the helper's newest step, `lastStep`), its model and Stop (Look when it needs you).
   - Opened, a roster card per helper: its job (two lines, tap for all), "What it's thinking", the exact request with No
     and Allow once (chat/helpers.js answers it by conversation and fingerprint, as pass 17), steps and cost, Steer
     (POST /api/runs/<helper>/steer {text}), Stop (POST /api/runs/<helper>/cancel) and Open.
   - Open shows that helper's own record view only: what the parent asked for, its steps (GET /api/runs/<helper>/steps),
     its thinking and its request. The composer's place holds "View only" and one "Back to <parent>"; nothing can be
     sent. Helpers never join the sidebar (the engine keeps their conversations out of the list).
   - The lead's workbench: the conversation's other open work shows here too, from GET /api/open-work?session=<id>
     (read at most every two seconds, drawn again only on a change): the helpers still working that an earlier task of
     this conversation started (read through their task's own steps, so Steer and Stop are the same), its wake-ups with
     Cancel (DELETE /api/open-work/wakeups/<id>) and its programs left running with Stop (POST /api/processes).
   A helper is not a Trunk: it shows its specialist's face, or its parent Trunk's, dimmed and badged (never the mascot). The engine decides who may steer or stop a helper
   (src/helper-control.ts); its refusal is shown in its own words. */

import { $, esc, render, renderNow, composing } from "../core/dom.js";
import { ic, av, faceOf, toast } from "../core/ui.js";
import { figureFace } from "../core/figures.js";
import { look17 } from "../core/art17.js";
import { S, E } from "../core/state.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { stepsOf, loadSteps, forgetSteps, liveRun } from "./timeline.js";
import { openConversation } from "./chat.js";
import { t, plural } from "../../i18n.js";

const F = { open: false, steer: null, drafts: {}, full: new Set(), busy: new Set(), view: null };
/* Other places that draw helper cards with Steer and Stop (the team run board, places/team-tabs.js): each gives its
   helpers ({ runId, name }) and how to read them again after one is steered or stopped. */
const sources = [];
/** Another place's helpers, so the one Steer and Stop reach them too. */
export function helperSource(list, reread) { sources.push({ list, reread }); }

/* ---------- which helpers, and where each stands ---------- */
const runsHere = () => (E.state?.runs ?? []).filter((r) => S.chat && r.sessionId === S.chat)
  .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
/* The conversation's newest task (the one working now, else the last one), never a task picked in the Timeline. */
const frameRun = () => liveRun()?.id ?? runsHere()[0]?.id ?? null;
/* The lead's workbench: what else the conversation has going (earlier tasks' helpers, wake-ups, programs left running). */
const OW = { sid: null, body: null, at: 0, seen: "" };
function openWork() {
  if (!S.chat) return null;
  if (OW.sid !== S.chat) Object.assign(OW, { sid: S.chat, body: null, at: 0, seen: "" });
  if (Date.now() - OW.at > 2000) {
    const sid = S.chat;
    OW.at = Date.now();
    api(`open-work?session=${encodeURIComponent(sid)}`).then((body) => {
      if (OW.sid !== sid) return;
      OW.body = body;
      const seen = JSON.stringify(body);
      if (seen !== OW.seen) { OW.seen = seen; render(); }
    }).catch(() => undefined);
  }
  return OW.body;
}
const wakeupsHere = () => openWork()?.wakeups ?? [];
const programsHere = () => openWork()?.programs ?? [];
function helpersHere() {
  const runId = frameRun();
  loadSteps(runId);
  const list = [...(stepsOf(runId)?.helpers ?? [])];
  for (const other of openWork()?.helperRuns ?? []) {
    if (other === runId) continue;
    loadSteps(other);
    for (const h of stepsOf(other)?.helpers ?? []) if (["run", "wait"].includes(helperState(h)) && !list.some((x) => x.runId === h.runId)) list.push(h);
  }
  return list;
}
export const helperState = (h) => (h.waiting?.length || h.status === "needs_input" ? "wait"
  : ["running", "queued"].includes(h.status) ? "run" : h.status === "completed" ? "done" : "stopped");
const RANK = { wait: 0, run: 1, done: 2, stopped: 3 };
const sorted = (list) => list.slice().sort((a, b) => RANK[helperState(a)] - RANK[helperState(b)]);
const active = (list) => list.filter((h) => ["wait", "run"].includes(helperState(h)));
/** Whether the frame shows now: a helper of the newest task works or needs you (the thread's chip steps aside). */
export const frameShowing = () => S.view === "chat" && !!S.chat
  && (active(helpersHere()).length > 0 || wakeupsHere().length > 0 || programsHere().length > 0);

function parent() {
  const s = E.sessions.find((x) => (x.sessionId ?? x.id) === S.chat);
  return E.trunks.find((tr) => tr.chatSessionId === S.chat || tr.id === s?.trunkId || tr.id === s?.trunk?.id) ?? null;
}
const parentName = () => parent()?.name || E.state?.identity?.name || "";
/* A helper is not a Trunk, and never Branch's mascot (the owner's faces rule). A specialist the owner saved shows the
   specialist's face, as Customize › Specialists draws it; a helper in a Trunk's conversation shows that Trunk's
   character, dimmed and badged as a helper, acting out the helper's own state (work while it runs, else idle; the
   prototype's hFace18), never the parent's. A Trunk with no character (a pebble, a photo) shows its own face, badged. A
   helper with neither (in Branch's own conversation or a room) shows the specialist face too. */
const specialistNamed = (name) => !!name && (E.state?.specialists ?? []).some((sp) => sp.data?.definition?.name === name);
function face(s, h) {
  const who = parent();
  if (!who || specialistNamed(h?.name)) return `<span class="face18 hs18c" data-css="--s:${s}px" aria-hidden="true">${ic("bolt", "s")}</span>`;
  const f = faceOf(who), look = !f.photo && !f.lookStill ? look17(f.character) : null;
  const st = h && helperState(h) === "run" ? "work" : "idle";
  const drawn = look ? figureFace(look, st, `--s:${s}px;--c:${f.color}`, "", s) : av(who, s, S.chat);
  return `<span class="face18 hb18c" data-css="--s:${s}px" aria-hidden="true"><span class="in18c dim18">${drawn}</span><i class="b18c">${ic("bolt", "s")}</i></span>`;
}
const firstLine = (text) => String(text ?? "").split(/\r?\n/)[0];
function liveLine(h) {
  const st = helperState(h);
  if (st === "wait") return t("window.chat.hf.needs-you-line", { what: firstLine(h.waiting?.[0]?.question || h.waiting?.[0]?.label || h.lastStep?.title) });
  if (st === "run") return firstLine(h.lastStep?.title);
  return t(st === "done" ? "first-run-steps.done" : "panels.state.stopped");
}
/* The live line carries the emoji the engine chose for the helper's newest step (src/live-steps.ts), as the live steps do. */
const lineHTML = (h) => {
  const icon = ["run", "wait"].includes(helperState(h)) && h.lastStep?.icon ? `<span class="ls-ic" aria-hidden="true">${esc(h.lastStep.icon)}</span> ` : "";
  return `<span class="live18${helperState(h) === "wait" ? " you18" : ""}">${icon}${esc(liveLine(h))}</span>`;
};
const nameOf = (h) => h.name || firstLine(h.job);
const meta = (h) => [Number(h.steps) === 1 ? t("window.chat.steps.one") : t("window.chat.helpers.steps", { count: Number(h.steps) || 0 }), h.cost?.amount != null ? h.cost.display : ""].filter(Boolean).join(" · ");

/* ---------- the frame ---------- */
function row(h) {
  const id = esc(h.runId), off = F.busy.has(h.runId) ? " disabled" : "";
  const act = helperState(h) === "wait" ? `<button class="btn pri sm" type="button" data-act="hf18a">${t("window.chat.hf.look")}</button>`
    : `<button class="btn ghost sm" type="button" data-act="hfstop18a" data-id="${id}"${off}>${t("dashboard.stop")}</button>`;
  return `<div class="hfr18a">${face(28, h)}<span class="nm18"><b>${esc(nameOf(h))}</b>${lineHTML(h)}</span>${h.model ? `<span class="chip18">${esc(h.model)}</span>` : ""}${act}</div>`;
}
function ask(h, q) {
  const ids = `data-sid="${esc(q.sessionId)}" data-fp="${esc(q.fingerprint)}"`;
  const where = [q.bytes || q.target, t("window.chat.helpers.asked-by", { name: nameOf(h), parent: parentName() })].filter(Boolean).join(" · ");
  return `<div class="ask18a"><span class="chip18">${esc(q.tool)}</span><span class="q18"><b>${esc(q.question || q.label)}</b><small>${esc(where)}</small></span><button class="btn ghost sm" type="button" data-act="hpdo17c" data-v="deny" ${ids}>${t("autonomy.needs.no")}</button><button class="btn pri sm" type="button" data-act="hpdo17c" data-v="allow" ${ids}>${t("window.chat.helpers.allow-once")}</button></div>`;
}
const thinking = (h, open = "") => (h.thinking ? `<details class="hpth17c"${open}><summary>${ic("chev", "s chev")}${t("window.chat.helpers.thinking")}</summary><p>${esc(h.thinking)}</p></details>` : "");
function steerBox(h) {
  if (F.steer !== h.runId) return "";
  const off = F.busy.has(h.runId) ? " disabled" : "";
  return `<div class="steer18a"><input id="steer18" type="text" maxlength="2000" value="${esc(F.drafts[h.runId] ?? "")}" placeholder="${esc(t("window.chat.hf.steer-placeholder", { name: nameOf(h) }))}" aria-label="${esc(t("window.chat.hf.steer-label", { name: nameOf(h) }))}" data-id="${esc(h.runId)}"><button class="btn pri sm" type="button" data-act="hfsend18a" data-id="${esc(h.runId)}"${off}>${t("composer.send")}</button></div>`;
}
const controls = (h) => {
  const id = esc(h.runId), off = F.busy.has(h.runId) ? " disabled" : "";
  return `<button class="btn sm" type="button" data-act="hfsteer18a" data-id="${id}"${off}>${t("window.chat.hf.steer")}</button><button class="btn ghost sm" type="button" data-act="hfstop18a" data-id="${id}"${off}>${t("dashboard.stop")}</button>`;
};
/** Steer and Stop for one helper another place draws ({ runId, name }), with its steering box while open. */
export const helperControls = (h) => ({ box: steerBox(h), acts: controls(h) });
function card(h) {
  const st = helperState(h), id = esc(h.runId), live = st === "run" || st === "wait";
  const via = [h.model, h.provider].filter(Boolean).join(" · ");
  const acts = live ? controls(h) : "";
  return `<div class="card18a${st === "wait" ? " wait18" : live ? "" : " done18"}"><div class="ch18a">${face(36, h)}<span class="grow"><b>${esc(nameOf(h))}</b>${lineHTML(h)}</span>${via ? `<span class="chip18">${esc(via)}</span>` : ""}</div>
    <p class="job18a${F.full.has(h.runId) ? " full18" : ""}" data-act="hfjob18a" data-id="${id}">${esc(h.job)}</p>${thinking(h)}${(h.waiting ?? []).map((q) => ask(h, q)).join("")}${steerBox(h)}
    <div class="acts18a"><span class="chip18">${esc(meta(h))}</span><span class="grow"></span>${acts}<button class="btn sm" type="button" data-act="hfopen18a" data-id="${id}">${t("window.chat.hf.open")}</button></div></div>`;
}
/* A wake-up or a program left running, as one row: what it is, when, and the one thing to do with it. */
const clockOf = (at) => { const d = new Date(at); return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); };
function wakeRow(w) {
  const time = clockOf(w.nextAt), off = F.busy.has(w.id) ? " disabled" : "";
  const when = w.cron ? t("window.chat.hf.wakeup-cron", { time, cron: w.cron })
    : w.everyMinutes ? t("window.chat.hf.wakeup-every", { time, minutes: w.everyMinutes }) : t("window.chat.hf.wakeup-at", { time });
  return `<div class="hfr18a"><span class="face18 hs18c" data-css="--s:28px" aria-hidden="true">${ic("clock", "s")}</span><span class="nm18"><b>${esc(firstLine(w.message))}</b><span class="live18">${esc(when)}</span></span><button class="btn ghost sm" type="button" data-act="owcancel19" data-id="${esc(w.id)}"${off}>${t("window.chat.hf.wakeup-cancel")}</button></div>`;
}
function programRow(p) {
  const off = F.busy.has(p.id) ? " disabled" : "";
  return `<div class="hfr18a"><span class="face18 hs18c" data-css="--s:28px" aria-hidden="true">${ic("term", "s")}</span><span class="nm18"><b>${esc(p.name)}</b><span class="live18">${esc(t("window.chat.hf.program-running", { time: clockOf(p.startedAt) }))}</span></span><button class="btn ghost sm" type="button" data-act="owstop19" data-id="${esc(p.id)}"${off}>${t("dashboard.stop")}</button></div>`;
}
/** The frame at the top of the dock; nothing while no helper works or needs you and nothing else is open. */
export function helpFrame() {
  if (S.view !== "chat" || !S.chat) return "";
  const list = sorted(helpersHere()), now = active(list), wakes = wakeupsHere(), progs = programsHere();
  if (!now.length && !wakes.length && !progs.length) return "";
  const wait = list.filter((h) => helperState(h) === "wait").length;
  const others = [...wakes.map(wakeRow), ...progs.map(programRow)];
  const rows = now.slice(0, 3), extra = others.slice(0, Math.max(0, 3 - rows.length));
  const need = wait ? ` · <span class="need18">${t(wait > 1 ? "window.chat.helpers.need-you" : "window.chat.helpers.needs-you", { count: wait })}</span>` : "";
  const counts = [list.length ? plural(list.length, { one: "window.chat.helpers.count.one", other: "window.chat.helpers.count" }) + need : "",
    wakes.length ? plural(wakes.length, { one: "window.chat.hf.wakeups.one", other: "window.chat.hf.wakeups" }) : "",
    progs.length ? plural(progs.length, { one: "window.chat.hf.programs.one", other: "window.chat.hf.programs" }) : ""].filter(Boolean).join(" · ");
  const since = [...now.map((h) => h.startedAt), ...progs.map((p) => p.startedAt)].filter(Boolean).sort()[0] ?? "";
  const shown = rows.length + extra.length, all = list.length + others.length;
  const more = all > shown ? `<div class="hfr18a"><button class="more18" type="button" data-act="hf18a">${t("window.chat.hf.show-all", { count: all })}</button></div>` : "";
  const again = document.querySelector(".hf18a") ? " again18" : ""; // drawn before: it does not rise in again on a redraw
  return `<section class="hf18a${F.open ? " open" : ""}${again}" aria-label="${t("window.chat.helpers.title")}">
    <button class="hfh18a" type="button" data-act="hf18a" aria-expanded="${F.open}"><span class="stack18">${rows.map((h) => face(24, h)).join("")}</span><span class="grow">${counts}</span><span class="time18" data-since="${esc(since)}"></span><span class="chev18">${ic("down", "s")}</span></button>
    ${rows.map(row).join("")}${extra.join("")}${more}
    <div class="hfb18a"><div><div class="roster18a">${list.map(card).join("")}${others.join("")}${list.length ? `<p class="hint">${t("window.chat.helpers.hint")}</p>` : ""}</div></div></div></section>`;
}

/* The time since the first working helper started, as m:ss, written in place (no redraw). */
function tick() {
  for (const el of document.querySelectorAll(".time18[data-since]")) {
    const s = Math.max(0, Math.floor((Date.now() - Date.parse(el.dataset.since)) / 1000));
    const text = Number.isFinite(s) ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : "";
    if (el.textContent !== text) el.textContent = text;
  }
}
/* The character window by the conversation moves up by the frame's height, so it never covers a helper's Stop. */
function lift() {
  const agent = $(".agent12"), frame = $(".hf18a");
  if (!agent) return;
  agent.style.removeProperty("bottom");
  if (frame) agent.style.bottom = `${parseFloat(getComputedStyle(agent).bottom) + frame.offsetHeight + 8}px`;
}
/** After each draw of the conversation: the clock and the character window's place. */
export function frameAfter() { tick(); lift(); }

/* ---------- the view-only helper conversation, and a room member's (pass 18b lane18b) ---------- */
const viewed = () => (F.view?.kind === "helper" && S.view === "chat" && S.chat === F.view.parent ? helpersHere().find((h) => h.runId === F.view.runId) ?? null : null);
/* A room member's own conversation in the room (the room's memberSessions), opened from its lane: read, never sent to. */
const member = () => (F.view?.kind === "member" && S.view === "chat" && S.chat === F.view.sid ? F.view : null);
const roomOfView = (v) => E.rooms?.find((r) => r.sessionId === v.parent) ?? null;
const memberTrunk = (v) => E.trunks.find((tr) => tr.id === v.memberId) ?? roomOfView(v)?.roster?.find((tr) => tr.id === v.memberId) ?? null;
/** Whether a helper's or a room member's conversation is open view only (the composer is not drawn, nothing can be sent). */
export const viewingHelper = () => !!(viewed() || member());
/** Leaving the conversation leaves the view only too. */
export function leaveHelper() { F.view = null; }

/** The header's name in view only: the helper and whose it is, or the member and its room. */
export function helperWho() {
  const h = viewed(), m = member();
  if (m) {
    const tr = memberTrunk(m);
    return `<div class="who vo18h" role="heading" aria-level="1">${tr ? av({ ...tr, chatSessionId: m.sid }, 32) : ""}<span><b>${esc(tr?.name ?? "")}</b><small>${esc(t("window.chat.hf.member-in", { room: roomOfView(m)?.name ?? "" }))}</small></span></div>`;
  }
  return h ? `<div class="who vo18h" role="heading" aria-level="1">${face(32, h)}<span><b>${esc(nameOf(h))}</b><small>${esc(t("window.chat.hf.helper-for", { name: parentName() }))}</small></span></div>` : "";
}
/** The helper's own record: what it was asked, its steps, its thinking, its request. */
export function helperThread() {
  const h = viewed();
  if (!h) return "";
  /* Its own steps are read (shared and throttled with the Timeline); the view is drawn again only when they changed. */
  loadSteps(h.runId).then((body) => {
    const seen = JSON.stringify(body?.steps ?? null);
    if (F.view && F.view.runId === h.runId && seen !== F.view.seen) { F.view.seen = seen; render(); }
  });
  const steps = (stepsOf(h.runId)?.steps ?? []).filter((s) => ["tool", "ask", "you"].includes(s.kind));
  const st = helperState(h);
  const items = steps.map((s, i) => `<li class="${st === "run" && i === steps.length - 1 ? "now18" : ""}">${esc(firstLine(s.title))}</li>`).join("");
  return `<div class="voh18">${face(28, h)}<span>${esc(t("window.chat.hf.asked-for", { name: parentName(), job: h.job }))}</span></div>
    <div class="b"><div class="gut">${face(28, h)}</div><div>${items ? `<ol class="vosteps18">${items}</ol>` : ""}${thinking(h, " open")}${(h.waiting ?? []).map((q) => ask(h, q)).join("")}
    <p class="hint">${esc([liveLine(h), meta(h)].filter(Boolean).join(" · "))}</p></div></div>`;
}
/** The composer's place in view only: "View only" and one way back, to the helper's parent or the member's room. */
export function helperDock() {
  const m = member();
  if (!m && !viewed()) return "";
  const back = m ? roomOfView(m)?.name ?? "" : parentName();
  return `<div class="dock"><div class="vo18"><span class="grow">${t("window.chat.hf.view-only")}</span><button class="btn pri sm" type="button" data-act="voback18">${ic("back", "s")}${esc(t("window.chat.hf.back", { name: back }))}</button></div></div>`;
}
/* lane18b: a room member's lane opens its conversation in the room, view only, with Back to the room. */
function openMember(el) {
  const room = S.chat, sid = el.dataset.id, memberId = el.dataset.m;
  if (!room || !sid) return undefined;
  const opening = openConversation(sid); // it leaves any view only first, so the member's view is set after
  F.view = { kind: "member", parent: room, sid, memberId };
  renderNow();
  return opening;
}
function back() {
  const v = F.view;
  F.view = null;
  if (v?.kind === "member") return openConversation(v.parent);
  renderNow();
  return undefined;
}

/* ---------- Steer and Stop, one helper at a time (the frame's, or another place's) ---------- */
async function rereadFrame() {
  const runId = frameRun();
  forgetSteps(runId);
  await loadSteps(runId);
  renderNow();
}
function byId(id) {
  const here = helpersHere().find((h) => h.runId === id);
  if (here) return { h: here, reread: rereadFrame };
  for (const source of sources) { const h = source.list().find((x) => x.runId === id); if (h) return { h, reread: source.reread }; }
  return null;
}
/* One request at a time per helper: its buttons stay disabled until the engine answered, so a second press sends nothing. */
async function once(h, work) {
  if (F.busy.has(h.runId)) return false;
  F.busy.add(h.runId);
  renderNow();
  try { await work(); return true; } catch (error) { toast(error.message); return false; } finally { F.busy.delete(h.runId); }
}
async function stop(el) {
  const found = byId(el.dataset.id);
  if (!found) return;
  const { h, reread } = found;
  if (await once(h, () => api(`runs/${encodeURIComponent(h.runId)}/cancel`, {}))) toast(t("window.chat.hf.stopped", { name: nameOf(h) }));
  await reread();
}
async function steer(el) {
  const found = byId(el.dataset.id), text = ($("#steer18")?.value ?? "").trim();
  if (!found || F.busy.has(found.h.runId)) return;
  if (!text) { $("#steer18")?.focus(); return; }
  const { h, reread } = found;
  if (!(await once(h, () => api(`runs/${encodeURIComponent(h.runId)}/steer`, { text })))) { renderNow(); return; }
  F.steer = null;
  delete F.drafts[h.runId];
  toast(t("window.chat.hf.sent", { name: nameOf(h) }));
  await reread();
}

/* The lead's workbench: cancel a wake-up, stop a program left running; each button waits for the engine's answer. */
async function openWorkAct(id, work, said) {
  if (!id || F.busy.has(id)) return;
  F.busy.add(id);
  renderNow();
  try { await work(); toast(said); } catch (error) { toast(error.message); } finally { F.busy.delete(id); OW.at = 0; openWork(); renderNow(); }
}
const cancelWakeup = (el) => openWorkAct(el.dataset.id,
  () => api(`open-work/wakeups/${encodeURIComponent(el.dataset.id)}?session=${encodeURIComponent(S.chat)}`, undefined, "DELETE"), t("window.chat.hf.wakeup-cancelled"));
const stopProgram = (el) => {
  const p = programsHere().find((x) => x.id === el.dataset.id);
  return openWorkAct(el.dataset.id, () => api("processes", { id: el.dataset.id }), t("window.chat.hf.program-stopped", { name: p?.name ?? "" }));
};

export function initHelpFrame() {
  markLive(["hf18a", "hfjob18a", "hfsteer18a", "hfsend18a", "hfstop18a", "hfopen18a", "voback18", "lane18b", "sw:steer18", "owcancel19", "owstop19"]);
  on("owcancel19", (el) => cancelWakeup(el));
  on("owstop19", (el) => stopProgram(el));
  on("hf18a", () => { F.open = !F.open; renderNow(); });
  on("hfjob18a", (el) => { const id = el.dataset.id; if (F.full.has(id)) F.full.delete(id); else F.full.add(id); renderNow(); });
  on("hfsteer18a", (el) => { F.steer = F.steer === el.dataset.id ? null : el.dataset.id; if (S.view === "chat") F.open = true; renderNow(); $("#steer18")?.focus(); });
  on("hfsend18a", (el) => steer(el));
  on("hfstop18a", (el) => stop(el));
  on("hfopen18a", (el) => { F.view = { kind: "helper", parent: S.chat, runId: el.dataset.id }; F.open = false; renderNow(); });
  on("lane18b", (el) => openMember(el));
  on("voback18", () => back());
  document.addEventListener("input", (e) => { if (e.target.id === "steer18") F.drafts[e.target.dataset.id] = e.target.value; });
  document.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.id === "steer18" && !composing(e)) { e.preventDefault(); $('[data-act="hfsend18a"]')?.click(); } });
  setInterval(tick, 1000);
  /* While the frame or a helper's view shows, its helpers are read again every two seconds (the read is shared and
     throttled; the conversation is drawn again only when what the frame shows changed, chat/timeline.js). */
  setInterval(() => { if (S.view === "chat" && !document.hidden && document.querySelector(".hf18a, .vo18")) { loadSteps(frameRun()); openWork(); } }, 2000);
}
