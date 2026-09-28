/* Watch Branch think and work, live: while a task runs, the reply area shows its steps as they happen, from the engine's
   own stream (GET /api/runs/<id>/live, src/live-steps.ts): each reasoning summary the model streams, each tool call from
   the moment it starts ("Searching the web for …") with a spinner, then what it came to ("Found 8 results") and its time,
   a question waiting on the owner (answered on the card below, as always), and each helper's steps indented under it.
   Every line carries the emoji the engine chose for its kind of step and opens on a tap to what it was given and what
   came back (scrubbed by the engine). Updates are drawn at most once a frame and only into this block, never the whole
   window; the newest lines show, with "Show all" for the rest. When the task ends the block goes and the reply's folded
   steps line (chat/furniture.js) takes its place.
   RES-703: a pane beside the conversation (chat/panes.js) follows its own task the same way, through a follower of its
   own (liveFollower): its block has its own id and its own scroll box. The conversation's follower is the first one. */

import { $, esc } from "../core/dom.js";
import { streamOnce } from "../core/api.js";
import { on } from "../core/actions.js";
import { t, language, formatNumber } from "../../i18n.js";
import { liveHead } from "../places/inboxwork.js"; // long-work: time so far and Pause

const SHOWN = 8;
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const waitingAsk = (snap) => (snap?.steps ?? []).some((s) => s.kind === "ask" && s.state === "waiting");
const FOLLOWERS = new Map(); // block id → its follower, for "Show all"
/* Lines opened by the person, by step id, across every follower (a step id belongs to one task). */
const OPENED = new Set();

/**
 * A follower of one task's live steps at a time, drawn into the block with id `block` inside the scroll box `scroll`
 * (a selector). onAsk runs when a question starts waiting, onGone when the task's steps can no longer be read, onShow
 * when the first steps have no block to go in yet.
 */
export function liveFollower({ block, scroll, onAsk = () => {}, onGone = () => {}, onShow = onGone }) {
  const L = { runId: null, snap: null, ctl: null, all: false, frame: 0, block, scroll, onAsk, onGone, onShow };
  FOLLOWERS.set(block, L);
  const me = {
    follow(runId) {
      if (!runId || L.runId === runId) return;
      me.stop();
      L.runId = runId;
      L.ctl = new AbortController();
      follow(L, runId, L.ctl.signal);
    },
    stop() {
      L.ctl?.abort();
      if (L.frame) cancelAnimationFrame(L.frame);
      Object.assign(L, { runId: null, snap: null, ctl: null, all: false, frame: 0 });
    },
    shown: () => Boolean(L.snap?.steps?.length),
    block: () => `<div class="steps live-steps" id="${esc(L.block)}" aria-live="polite">${lines(L)}</div>`,
    runId: () => L.runId,
    set(hooks) { Object.assign(L, hooks); },
    forget() { me.stop(); FOLLOWERS.delete(L.block); },
  };
  return me;
}
const MAIN = liveFollower({ block: "live-steps", scroll: "#scroll" });

/* Follows one task's live steps until it ends (the engine closes a stream after a while; the next one carries on). */
export const followLive = (runId) => MAIN.follow(runId);
async function follow(L, runId, signal) {
  let wait = 300;
  while (!signal.aborted && L.runId === runId) {
    let ended = false;
    try {
      await streamOnce(`runs/${encodeURIComponent(runId)}/live`, (kind, data) => {
        if (kind === "steps") take(L, data);
        else if (kind === "end") ended = data?.reason === "profile" ? "moved" : true;
      }, signal);
      wait = 300;
    } catch (error) {
      if (error.name === "AbortError") return;
      // Refused for good (not this person's task, not theirs to read): nothing more to follow, and the last list goes
      // with it, so no step is left spinning. Anything else (locked for now, the engine restarting, the network): try
      // again, a little later.
      if ([400, 401, 403, 404].includes(error.status)) { gone(L, runId); return; }
      wait = Math.min(wait * 2, 5000);
    }
    if (ended === "moved") gone(L, runId); // the window moved to somebody else: nothing of this task stays drawn
    if (ended) return;
    await pause(wait);
  }
}
function gone(L, runId) {
  if (L.runId !== runId || !L.snap) return;
  L.snap = null;
  L.onGone();
}
function take(L, snap) {
  if (snap?.runId !== L.runId) return;
  const asked = waitingAsk(snap) && !waitingAsk(L.snap);
  L.snap = snap;
  if (asked) L.onAsk();
  if (!L.frame) L.frame = requestAnimationFrame(() => draw(L));
}
/* Only this block is drawn again; a reader at the bottom stays at the bottom. */
function draw(L) {
  L.frame = 0;
  const block = document.getElementById(L.block);
  // The first steps have no block to go in yet: the view is drawn again with it, rather than waiting for something
  // else to redraw (on a slow machine nothing may, and the steps never showed).
  if (!block) { if (L.snap?.steps?.length) L.onShow(); return; }
  const box = block.closest(L.scroll) ?? $(L.scroll);
  const atEnd = box && box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  block.innerHTML = lines(L);
  if (atEnd) box.scrollTop = box.scrollHeight;
}
export function stopLive() {
  MAIN.stop();
  OPENED.clear();
}
/* Whether there is anything to show yet (until the first step, the reply area keeps its thinking line or dots). */
export const liveShown = () => MAIN.shown();
export const liveBlock = () => MAIN.block();

/* The engine's words for a line in the language chosen: a line that comes with its words' key (src/live-steps.ts
   `Said`) is said from the locale files, a number `count` picking the plural form and a length of time said with the
   language's own unit names; in English, or for a key this window does not have, the engine's English stays. */
const inUnits = (v) => (v && typeof v === "object" && Number.isFinite(v.amount) && (v.unit === "second" || v.unit === "minute")
  ? new Intl.NumberFormat(language(), { style: "unit", unit: v.unit, unitDisplay: "long" }).format(v.amount) : "");
export function said(say, english) {
  if (!say || typeof say.key !== "string" || language() === "en") return english;
  const values = {};
  for (const [name, value] of Object.entries(say.values ?? {}))
    values[name] = typeof value === "number" ? formatNumber(value) : typeof value === "string" ? value : inUnits(value);
  const count = say.values?.count;
  const keys = typeof count === "number" ? [`${say.key}.${new Intl.PluralRules(language()).select(count)}`, `${say.key}.other`] : [say.key];
  for (const key of keys) {
    const words = t(key, values);
    if (words !== key) return words;
  }
  return english;
}

const dur = (s) => (s >= 60 ? `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, "0")}s` : `${s < 10 ? s.toFixed(1) : Math.round(s)}s`);
/* Consecutive finished lines that say the same thing are one line with "(×N)" after it, as the chat apps show them
   (src/channels/progress-render.ts, after Hermes Agent); the newest of them keeps its details to open. */
export function foldSteps(steps) {
  const out = [];
  for (const s of steps) {
    const last = out.at(-1);
    const same = last && last.state === "done" && s.state === "done" && last.kind === s.kind && last.depth === s.depth
      && last.icon === s.icon && last.label === s.label && last.result === s.result;
    if (same) out[out.length - 1] = { ...s, times: (last.times ?? 1) + 1 };
    else out.push(s);
  }
  return out;
}
function line(s) {
  const busy = s.state === "running";
  const end = busy ? `<span class="ls-spin" role="img" aria-label="${esc(t("window.chat.live.working"))}"></span>`
    : s.state === "waiting" ? `<span class="pill work"><i></i>${t("dashboard.needs.title")}</span>`
      : typeof s.seconds === "number" && s.kind !== "think" ? `<span class="ls-time">${esc(dur(s.seconds))}</span>` : "";
  const came = s.result ? `<small>${esc(said(s.say?.result, s.result))}</small>` : "";
  // long-work: a wait says when it ends, in the owner's own clock.
  const until = s.until && Number.isFinite(Date.parse(s.until)) ? `<span class="ls-time">${esc(new Date(s.until).toLocaleTimeString(language(), { hour: "numeric", minute: "2-digit" }))}</span>` : "";
  const times = s.times > 1 ? ` <span class="ls-times">(×${formatNumber(s.times)})</span>` : "";
  const head = `<span class="ls-t">${esc(said(s.say?.label, s.label))}${times}</span>${came}${until}${end}`;
  const more = [s.kind === "think" && s.label.length > 140 ? `<p>${esc(s.label)}</p>` : "", s.input ? `<pre>${esc(s.input)}</pre>` : "", s.output ? `<pre>${esc(s.output)}</pre>` : ""].join("");
  const body = more ? `<details data-ls="${esc(s.id)}"${OPENED.has(s.id) ? " open" : ""}><summary>${head}</summary>${more}</details>` : `<div class="ls-row">${head}</div>`;
  return `<li class="ls-${esc(s.state)} ls-${esc(s.kind)}${s.depth ? " ls-in" : ""}"><span class="ls-ic" aria-hidden="true">${esc(s.icon)}</span>${body}</li>`;
}
function lines(L) {
  const steps = foldSteps(L.snap?.steps ?? []);
  const cut = !L.all && steps.length > SHOWN;
  const shown = cut ? steps.slice(-SHOWN) : steps;
  const all = cut ? `<button type="button" class="btn ghost sm ls-all" data-act="live-all" data-v="${esc(L.block)}">${esc(t("window.chat.live.show-all", { count: L.snap.total ?? steps.length }))}</button>` : "";
  const running = L.snap?.status === "running" ? liveHead(L.snap.runId, L.snap.startedAt) : "";
  return `${running}${all}<ol>${shown.map(line).join("")}</ol>`;
}

/* The chat hands in what to do when a question appears (read the waiting questions, so its card shows). */
export function initLive({ onAsk, onGone, onShow }) {
  MAIN.set({ onAsk, onGone, onShow: onShow ?? onGone });
  on("live-all", (el) => { const L = FOLLOWERS.get(el.dataset.v || "live-steps"); if (L) { L.all = true; draw(L); } });
  // A line opened stays open while the list is drawn again (toggle does not bubble, so it is heard on the way down).
  document.addEventListener("toggle", (event) => {
    const id = event.target?.dataset?.ls;
    if (!id) return;
    if (event.target.open) OPENED.add(id); else OPENED.delete(id);
  }, true);
}
