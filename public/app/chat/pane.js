/* The side panel beside a conversation (design doc 4.6), 1:1 with the prototype's: Activity (each tool the task used, from
   the conversation's own messages), Plan (GET /api/runs/<id>/plan), Files (what each task changed, from its run) and
   Memory, and Terminal (each command the tasks ran, from GET /api/panels/work: terminal.js). Browser opens the full-size
   view of the browser (stage.js), as the prototype's panel hands 'browser' to the stage.
   Pass 17: Timeline, right after Activity (timeline.js), and Helpers at the end of Activity (helpers.js). Another area
   adds its own tab through `extraTabs`: push [id, label, draw, shown], drawn after these while shown() is true. */

import { $, esc, applyCss, render } from "../core/dom.js";
import { ic } from "../core/ui.js";
import { S, E } from "../core/state.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive, greyOut } from "../core/features.js";
import { sendingPrompt } from "./chat.js";
import { initStage } from "./stage.js";
import { terminalBody, loadWork, initTerminal } from "./terminal.js";
import { pressed } from "../shell/keys.js";
import { timelineBody, initTimeline } from "./timeline.js";
import { helpersSection, initHelpers } from "./helpers.js";
import { t } from "../../i18n.js";
import { resizerHTML } from "../shell/resize.js";

const TABS = [["activity", "dashboard.area.activity"], ["tl17c", "window.chat.pane.timeline"], ["plan", "pane.plan"], ["files", "pane.files"], ["memory", "memory.movein.kind.memory"], ["browser", "pane.browser"], ["terminal", "pane.terminal"]];
const REAL = new Set(["activity", "tl17c", "plan", "files", "memory", "terminal"]);
const P = { sid: null, messages: [], plan: null, at: 0 };

/* This conversation's tasks; before a new conversation has its id, the task its first message started. */
const runsHere = () => {
  const first = sendingPrompt();
  return (E.state?.runs ?? []).filter((r) => (S.chat ? r.sessionId === S.chat : first && r.prompt === first));
};
const working = () => runsHere().some((r) => ["running", "queued", "waiting"].includes(r.status));
/* What was read for the open conversation only: a new conversation shows each tab's empty words, never the last one's. */
const mine = () => (P.sid && P.sid === S.chat ? P : { messages: [], plan: null });

function target(args) {
  try {
    const a = typeof args === "string" ? JSON.parse(args) : args ?? {};
    // A command shows as it was run: the program and its arguments.
    if (a.executable) return [a.executable, ...(Array.isArray(a.args) ? a.args : [])].join(" ");
    return a.path ?? a.url ?? a.command ?? a.query ?? a.name ?? "";
  } catch { return ""; }
}

function activity() {
  const { messages } = mine();
  const results = new Map(messages.filter((m) => m.role === "tool").map((m) => [m.toolCallId, m.content]));
  const steps = messages.flatMap((m) => m.toolCalls ?? []).map((c) => {
    let ok = null;
    try { ok = JSON.parse(results.get(c.id) ?? "null")?.ok ?? null; } catch { /* a result that is not JSON */ }
    return { name: c.name, detail: target(c.arguments), ok };
  });
  if (!steps.length && !working()) return `<p class="empty">${t("window.chat.pane.no-steps")}</p>`;
  const rows = steps.map((s, i) => `<li class="${s.ok === false ? "" : "ok"}">${ic(s.ok === false ? "x" : "check", "s")}<span>${esc(s.name)}<small>${esc(s.detail)}</small></span><time>${i + 1}</time></li>`).join("");
  const now = working() ? `<li class="run">${ic("spin", "s")}<span>${esc(runsHere().find((r) => r.status === "running")?.prompt?.split("\n")[0] ?? "")}</span><time>${t("window.chat.pane.now")}</time></li>` : "";
  return `<ol class="tl">${rows}${now}</ol>`;
}
const activityBody = () => activity() + helpersSection();

function plan() {
  const steps = mine().plan?.steps ?? [];
  if (!steps.length) return `<p class="empty">${t("window.chat.pane.no-plan")}</p>`;
  const cls = { done: "done", working: "now", failed: "bad", waiting: "" };
  return `<ul class="plan">${steps.map((s) => `<li class="${cls[s.status] ?? ""}"><span class="box">${s.status === "done" ? ic("check") : ""}</span><span>${esc(s.title)}</span></li>`).join("")}</ul>`;
}

function files() {
  const changed = runsHere().flatMap((r) => r.changes ?? []);
  if (!changed.length) return `<p class="empty">${t("window.chat.pane.no-files")}</p>`;
  return changed.map((f) => { const st = f.existed ? "Changed" : "Made"; const said = f.existed ? t("window.chat.pane.changed") : t("window.chat.pane.made"); return `<button class="memrow" type="button" data-css="text-align:left" data-act="fileopen" data-n="${esc(f.path)}"><span><b data-css="font-weight:500">${esc(f.path)}</b></span><small>+${Number(f.added) || 0} −${Number(f.removed) || 0}</small><span class="pill ${st === "Made" ? "done" : "warn"}" data-css="grid-row:1 / span 2;grid-column:2;align-self:center">${said}</span></button>`; }).join("");
}

const BODY = { activity: activityBody, tl17c: timelineBody, plan, files, memory: () => `<p class="empty">${t("window.chat.pane.no-memory")}</p>`, terminal: () => terminalBody(S.chat) };
/* Tabs other areas add (pass 17): [id, label, draw, shown]; each draws its own body and says when it is shown. */
export const extraTabs = [];
const extraShown = () => extraTabs.filter(([, , , shown]) => shown());
const tabAct = (id) => (REAL.has(id) || extraShown().some(([x]) => x === id) ? "ptabp" : id === "browser" ? "stage" : "ptabp-" + id);

/* A tab's button. Browser shows the full-size view of what this conversation's tasks opened (stage.js), so before a new
   conversation's first message it is drawn greyed with that reason as its tip. */
function ptabButton(id, label, tab) {
  if (id === "browser" && !S.chat) return `<button class="ptab soon" role="tab" type="button" aria-selected="false" aria-disabled="true" tabindex="-1" data-p="${id}" data-tip="${t("window.shell.extras.after-first-message")}">${t(label)}</button>`;
  return `<button class="ptab" role="tab" type="button" aria-selected="${tab === id}" data-act="${tabAct(id)}" data-p="${id}" data-v="${id}">${t(label)}</button>`;
}

export function drawPane() {
  const pane = $("#pane"), body = $("#body");
  // Open in every conversation, a new one too: each tab then says what it has (nothing yet, before the first message).
  const open = S.view === "chat" && !!S.pane;
  if (!pane) return;
  pane.hidden = !open;
  body?.classList.toggle("pane-on", open);
  if (!open) { pane.innerHTML = ""; return; }
  const extra = extraShown(), own = extra.find(([id]) => id === S.pane);
  const tab = REAL.has(S.pane) || own ? S.pane : "activity";
  pane.innerHTML = `${resizerHTML("pane")}<div class="pane-h"><div class="ptabs" role="tablist">${[...TABS, ...extra].map(([id, l]) => ptabButton(id, l, tab)).join("")}</div><button class="icon-btn" type="button" aria-label="${t("pane.close")}" data-act="pane" data-p="close">${ic("x")}</button></div><div class="pane-b">${own ? own[2]() : BODY[tab]()}</div>`;
  applyCss(pane);
  greyOut(pane);
  // The tab row scrolls when its tabs outgrow the card (pass 17 adds Timeline and Branches); keep the chosen one in view.
  const tabs = pane.querySelector(".ptabs"), on = tabs?.querySelector('[aria-selected="true"]');
  if (on && (on.offsetLeft + on.offsetWidth > tabs.scrollLeft + tabs.clientWidth || on.offsetLeft < tabs.scrollLeft)) tabs.scrollLeft = on.offsetLeft - 8;
  loadPane();
  if (tab === "terminal") loadWork(S.chat);
}

/* The open conversation's messages and its newest task's plan, read again at most every two seconds; the panel alone is
   drawn again when they change. */
async function loadPane() {
  const sid = S.chat;
  if (!sid || (sid === P.sid && Date.now() - P.at < 2000)) return;
  P.at = Date.now();
  const newest = runsHere().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
  const [session, planned] = await Promise.all([
    api(`sessions/${encodeURIComponent(sid)}`).catch(() => null),
    newest ? api(`runs/${encodeURIComponent(newest.id)}/plan`).catch(() => null) : null,
  ]);
  const messages = session?.messages ?? [], planNow = planned?.plan ?? null;
  const same = sid === P.sid && JSON.stringify(messages) === JSON.stringify(P.messages) && JSON.stringify(planNow) === JSON.stringify(P.plan);
  Object.assign(P, { sid, messages, plan: planNow });
  if (!same && S.chat === sid) drawPane();
}

/* The header's side panel button says whether the panel is open (the prototype's aria-pressed). */
function pressedNow() {
  for (const b of document.querySelectorAll('[data-act="pane"][data-p="activity"][aria-pressed]')) b.setAttribute("aria-pressed", String(!!S.pane && S.pane !== "browser"));
}
/* DG-114, DG-118: closing the panel (its close button or the shortcut) hands the keyboard back to the switch that opens it. */
function focusSwitch() {
  [...document.querySelectorAll('[data-act="pane"][data-p="activity"][aria-pressed]')].find((b) => b.offsetParent !== null)?.focus({ preventScroll: true });
}

export function initPane() {
  initStage();
  initTerminal();
  initTimeline({ redraw: drawPane, changed: render, messages: () => (P.sid === S.chat ? P.messages : []), first: sendingPrompt });
  initHelpers({ redraw: drawPane });
  markLive(["pane", "ptabp"]);
  on("pane", (el) => {
    const p = el.dataset.p, inHead = !!el.closest(".head");
    S.pane = p === "close" ? null : inHead && S.pane ? null : p;
    drawPane();
    pressedNow();
    if (!S.pane) focusSwitch();
  });
  on("ptabp", (el) => { S.pane = el.dataset.p; drawPane(); });
  document.addEventListener("keydown", (e) => {
    if (pressed(e, "sidePane")) { e.preventDefault(); S.pane = S.pane ? null : "activity"; drawPane(); pressedNow(); if (!S.pane) focusSwitch(); }
  });
}
