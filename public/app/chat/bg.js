/* Conversations that run in the background (design doc 4.3, pass 15). + › Run it in the background sends the draft as
   /bg to the engine (POST /api/commands/run), which starts it in its own conversation (at most three at once). The chip
   over the box counts what is working in other conversations (GET /api/activity, with tasks waiting for a yes); its
   list stops one (POST /api/runs/{runId}/cancel) or opens a finished one (GET /api/sessions/{id}). The engine keeps its
   /bg set in memory only, so the chip counts every task working away from this conversation, not only /bg ones.
   The dock row over the box also carries the draft's @ material chips (media.js). */

import { $, esc, applyCss } from "../core/dom.js";
import { S, E } from "../core/state.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { ic, av, mi, openPop, closePop, toast } from "../core/ui.js";
import { markLive } from "../core/features.js";
import { materials } from "./media.js";
import { openConversation, sendingPrompt } from "./chat.js";
import { t } from "../../i18n.js";

const B = { items: new Map(), listed: false, polls: 0 };
/* A background check that fails because the engine answered no is said; one that fails because the engine is
   unreachable is already shown by the window's connection line, so it is not said again every few seconds. */
const said = (error) => { if (error.status) toast(error.message); };

/* The + menu row. Greyed while the engine's command list for this window has no /bg (GET /api/commands). */
export function bgMenuItem() {
  return mi(B.listed ? "bgrun15" : "bgrun15-off", "bg15", t("window.chat.bg.run"), "/bg");
}

const shown = () => [...B.items.values()];

/* The dock row over the box: the background chip and the material chips. Drawn inside the composer's markup. */
export function dockRow() {
  return `<div id="dockrow">${rowInner()}</div>`;
}
function rowInner(draft) {
  const all = shown();
  const run = all.filter((x) => x.state === "working").length;
  const chip = all.length ? `<button type="button" class="bgchip15" data-act="bglist15" aria-haspopup="menu">${run ? '<i class="bgdot15"></i>' : ic("check", "s")}${run ? t("window.chat.bg.running", { count: run }) : t("window.chat.bg.finished", { count: all.length })}</button>` : "";
  const mats = materials(draft);
  return chip || mats ? `<div class="dockrow15">${chip}${mats}</div>` : "";
}
function repaintRow(draft) {
  const box = $("#dockrow");
  if (!box) return;
  box.innerHTML = rowInner(draft);
  applyCss(box);
}

function listPop() {
  const rows = shown().map((x) => `<div class="mi bgrow15">${av({ kind: "main" }, 22)}<span class="grow"><span class="mi-t">${esc(x.prompt)}</span><span class="mi-s">${x.state === "working" ? esc(x.step) : t("window.chat.bg.ready")}</span></span>${x.state === "working" ? `<button type="button" class="btn ghost sm" data-act="bgstop15" data-id="${esc(x.runId)}">${t("dashboard.stop")}</button>` : `<button type="button" class="btn sm" data-act="bgopen15" data-id="${esc(x.runId)}">${t("ov.open")}</button>`}</div>`).join("");
  return `<div class="ph">${t("window.chat.bg.title")}</div>${rows}<p class="hint" data-css="margin:6px 10px">${t("window.chat.bg.hint", { code: "<code>/bg</code>" })}</p>`;
}

/* What the engine says is working (or waiting for a yes) away from the open conversation. One that was working here
   and is no longer in the engine's list has finished; it stays until it is opened. */
async function poll() {
  const live = await api("activity?waiting=1");
  const mine = sendingPrompt();
  const now = new Map();
  for (const a of Array.isArray(live) ? live : []) {
    if (!a.runId || a.sessionId === S.chat || (mine && a.prompt === mine) || a.task?.state === "queued") continue;
    now.set(a.runId, { runId: a.runId, sessionId: a.sessionId, prompt: a.prompt ?? "", step: a.task?.reason || a.steps?.at(-1)?.label || a.current || "", state: "working" });
  }
  const before = JSON.stringify(shown());
  for (const [id, x] of B.items) if (!now.has(id)) { if (x.sessionId === S.chat) B.items.delete(id); else x.state = "done"; }
  for (const [id, x] of now) B.items.set(id, x);
  if (JSON.stringify(shown()) !== before) repaintRow($("#prompt")?.value);
}
async function loadCatalog() {
  const list = await api("commands?surface=window");
  B.listed = (list.commands ?? []).some((c) => c.name === "bg");
}

async function runInBackground() {
  const box = $("#prompt");
  const draft = (box?.value ?? "").trim();
  closePop();
  if (!draft) { toast(t("window.chat.bg.type-first")); return; }
  let done;
  try { done = await api("commands/run", { surface: "window", line: `/bg ${draft}`, ...(S.chat ? { sessionId: S.chat } : {}) }); } catch (error) { toast(error.message); return; }
  if (!done?.handled) { B.listed = false; return; }
  toast(done.text ?? "");
  if (box) { box.value = ""; box.dispatchEvent(new Event("input", { bubbles: true })); }
  await poll().catch((error) => toast(error.message));
}

async function stop(el) {
  const x = B.items.get(el.dataset.id);
  if (!x) return;
  try {
    const said = await api(`runs/${encodeURIComponent(x.runId)}/cancel`, {});
    if (said.cancelled) B.items.delete(x.runId);
  } catch (error) { toast(error.message); }
  closePop();
  await poll().catch((error) => toast(error.message));
  repaintRow($("#prompt")?.value);
}

function open(el) {
  const x = B.items.get(el.dataset.id);
  if (!x) return;
  B.items.delete(x.runId);
  closePop();
  openConversation(x.sessionId);
}

export function initBg() {
  markLive(["bgrun15", "bglist15", "bgstop15", "bgopen15"]);
  on("bgrun15", () => runInBackground());
  on("bglist15", (el) => openPop(el, listPop()));
  on("bgstop15", (el) => stop(el));
  on("bgopen15", (el) => open(el));
  document.addEventListener("input", (e) => { if (e.target.id === "prompt") repaintRow(e.target.value); });
  document.addEventListener("branch-dock", () => repaintRow($("#prompt")?.value));
  setInterval(() => {
    if (!E.loaded || S.view !== "chat" || document.hidden) return;
    if (B.polls++ % 10 === 0) loadCatalog().catch(said);
    poll().catch(said);
  }, 3000);
}
