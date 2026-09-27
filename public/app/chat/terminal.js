/* The side panel's Terminal tab (design doc 4.6, the prototype's terminalPane): each command the conversation's tasks ran,
   with what came back, read from the engine's GET /api/panels/work?session=<id> (src/panels-work.ts). The same answer
   carries the browser's pages and the last picture it took, which the full-size view (stage.js) shows.
   "Open a terminal for me" opens the prototype's terminal: a command typed there is split into a program and its arguments
   (never handed to a shell) and sent to the engine's one door for a tool pressed by hand, POST /api/tools/try with
   shell.execute, which judges it exactly as a command a task asked for: the owner's rules (a command no rule names asks
   first), Lockdown (refused without asking), the safety extras, a household person's role, and a short-lived key that can
   never confirm. When the engine asks, its own question is shown with No and Allow once; Allow once sends back exactly the
   command that was asked about, once. Nothing here keeps a yes for commands. The command's run is kept in this
   conversation (or, while a task is working or waiting in it, in one reused "Terminal" conversation), never a new one. */

import { esc, render } from "../core/dom.js";
import { ic, toast } from "../core/ui.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { t } from "../../i18n.js";

const W = { sid: null, work: null, at: 0, loading: false, said: "" };

/* What the engine said for this conversation, or null before the first answer. */
export const work = (sid) => (sid && sid === W.sid ? W.work : null);

/* Reads the conversation's work again at most every two seconds; the window is drawn again when the answer changes. */
export async function loadWork(sid) {
  if (!sid || W.loading || (sid === W.sid && Date.now() - W.at < 2000)) return;
  W.loading = true;
  W.at = Date.now();
  try {
    const next = await api(`panels/work?session=${encodeURIComponent(sid)}`);
    const same = sid === W.sid && JSON.stringify(next) === JSON.stringify(W.work);
    Object.assign(W, { sid, work: next, said: "" });
    if (!same) render();
  } catch (error) {
    if (sid !== W.sid) Object.assign(W, { sid, work: null });
    // Said once, not again every two seconds while the engine keeps refusing for the same reason.
    if (error.message !== W.said) toast(error.message);
    W.said = error.message;
  } finally {
    W.loading = false;
  }
}

/* The engine's own states, drawn as the Activity tab draws them: a tick, a cross, or a spinner. Only a command waiting on
   a yes has words of its own in the prototype. */
const MARK = { done: "check", practice: "check", failed: "x", refused: "x", stopped: "x", running: "spin" };

function row(entry) {
  const pill = entry.state === "waiting" ? `<span class="pill warn">${t("dashboard.needs.approval")}</span>` : ic(MARK[entry.state] ?? "info", entry.state === "running" ? "s spin" : "s");
  const out = entry.output ? `<pre>${esc(entry.output)}</pre>` : "";
  return `<div class="termrow"><div class="th2"><code>$ ${esc(entry.what)}</code>${pill}</div>${out}</div>`;
}

/* The terminal opened from the window: what was typed and what came back, the draft, and a question waiting on a yes. */
const T = { sid: null, open: false, lines: [], draft: "", pending: null, busy: false };

function shellBox() {
  if (!T.open) return "";
  const lines = T.lines.map(([k, text]) => `<div class="${k}">${esc(text)}</div>`).join("");
  const ask = T.pending ? `<div class="out">${esc(T.pending.question)}</div><div class="acts"><button class="btn ghost sm" type="button" data-act="shell-no">${t("window.chat.term.no")}</button><button class="btn pri sm" type="button" data-act="shell-yes">${t("window.chat.helpers.allow-once")}</button></div>` : "";
  return `<div class="shell"><div class="shell-out" id="shell-out">${lines}</div>${ask}<form data-form="shell" id="shell-form"><span>%</span><input id="shell-q" autocomplete="off" spellcheck="false" aria-label="${t("window.chat.term.type")}" value="${esc(T.draft)}"></form></div>`;
}

export function terminalBody(sid) {
  // The terminal belongs to the conversation it was opened in; another conversation starts with it closed.
  if (sid !== T.sid) Object.assign(T, { sid, open: false, lines: [], draft: "", pending: null });
  const entries = work(sid)?.terminal?.entries ?? [];
  const rows = entries.map(row).join("") || `<p class="empty">${t("window.chat.term.empty")}</p>`;
  // Drawn always and shown only while #app carries Lockdown's "locked" look (chat/approvals.js), as its banner is.
  const hint = `<p class="hint lockhint-u" data-css="margin:0;color:var(--bad)">${t("panels.terminal.lock")}</p>`;
  const btn = T.open ? `<button class="btn ghost sm" type="button" data-act="shell" data-v="close">${t("window.chat.term.close")}</button>` : `<button class="btn sm" type="button" data-act="shell" data-v="open">${t("panels.terminal.open")}</button>`;
  return `<div class="term7">${rows}${hint}<div class="acts">${btn}</div>${shellBox()}</div>`;
}

/* What the engine answered, as lines of the terminal. */
function said(outcome) {
  if (outcome.status === "refused") return outcome.reason;
  if (outcome.status === "failed") return outcome.error;
  const r = outcome.result ?? {};
  const text = [r.stdout, r.stderr].filter((x) => typeof x === "string" && x).join("\n");
  return text || JSON.stringify(r, null, 2);
}

async function send(request) {
  if (T.busy) return;
  T.busy = true;
  try {
    const outcome = await api("tools/try", request);
    if (outcome.status === "asked") T.pending = { question: outcome.question, request: { name: request.name, arguments: request.arguments, ...(request.sessionId ? { sessionId: request.sessionId } : {}) } };
    else T.lines.push(["out", said(outcome)]);
  } catch (error) { toast(error.message); }
  T.busy = false;
  render();
  setTimeout(() => document.getElementById("shell-q")?.focus(), 0);
}

/* A typed line: the program and its arguments, split on spaces; no shell ever reads it. */
function typed() {
  const words = T.draft.trim().split(/\s+/).filter(Boolean);
  if (!words.length || T.busy) return;
  T.lines.push(["in", "% " + words.join(" ")]);
  T.draft = "";
  T.pending = null;
  // The conversation is only where the engine keeps the command's run (never a new conversation per command).
  send({ name: "shell.execute", arguments: { executable: words[0], args: words.slice(1) }, confirm: false, ...(T.sid ? { sessionId: T.sid } : {}) });
}

export function initTerminal() {
  markLive(["shell", "shell-yes", "shell-no", "sw:shell-q"]);
  on("shell", (el) => { T.open = el.dataset.v === "open"; T.pending = null; render(); setTimeout(() => document.getElementById("shell-q")?.focus(), 0); });
  // Only the command that was asked about, once.
  on("shell-yes", () => { const asked = T.pending?.request; T.pending = null; if (asked) send({ ...asked, confirm: true }); });
  on("shell-no", () => { T.pending = null; render(); });
  document.addEventListener("input", (e) => { if (e.target.id === "shell-q") T.draft = e.target.value; });
  document.addEventListener("submit", (e) => { if (e.target.id === "shell-form") { e.preventDefault(); typed(); } });
}
