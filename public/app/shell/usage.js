/* The status bar's version popover says what the engine plans to do about updates (POST /api/comfort/update-plan);
   installing goes through the desktop app's updater, so Install stays greyed here. Its usage popover is 1:1 with the
   prototype's "What each connection has left": one row per connection from GET /api/usage/glance, a bar only where the service gave a limit, and the engine's own sentence when it gave none.
   Accounts are shown side by side, never added together.
   Near a limit (a window the service measured at 95% used) while tasks run, and only while the owner leaves the offer on
   (GET /api/usage/glance settings.saveProgress "ask"), the prototype's save-progress offer: Save progress asks every
   running task to write down where it is (POST /api/usage/save-progress), Not now dismisses it. Each window is offered once. */

import { $, esc, render, renderNow } from "../core/dom.js";
import { openPop, closePop, mi, toast, app, ic } from "../core/ui.js";
import { ACT } from "./activity.js";
import { holdingTasks, lastLook, waitingLine } from "./autoupdate.js";
import { S, E } from "../core/state.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { logo } from "../core/logos.js";
import { t, language } from "../../i18n.js";

const CHIP = () => ({ measured: `<span class="pill ok">${t("glance.measured")}</span>`, estimated: `<span class="pill warn">${t("glance.estimate")}</span>`, not_published: `<span class="pill idle">${t("glance.notPublished")}</span>` });
const clock = (iso) => new Date(iso).toLocaleTimeString(language(), { hour: "numeric", minute: "2-digit" });

/* The share of a window left, 0 to 100, or null where the service gave no limit and remainder (money never is one).
   The list and the status bar's line both use it, so they never disagree. */
const pctLeft = (w) => (w.kind === "money" || !w.limit || w.remaining == null ? null : Math.max(0, Math.min(100, Math.round((w.remaining / w.limit) * 100))));

function windowRow(w, estimated) {
  const pct = pctLeft(w);
  if (pct === null) return `<div class="lim-w"><span>${esc(w.title)}</span><span></span><span>${w.remaining == null ? "" : esc(String(w.remaining))}</span></div>`;
  return `<div class="lim-w"><span>${esc(w.title)}</span><span class="lim-bar ${estimated ? "est" : ""}"><i data-css="width:${pct}%;${pct < 15 ? "background:var(--warn)" : ""}"></i></span><span>${t("glance.left", { percent: pct })}${w.resetAt ? ` · ${t("window.shell.usage.resets-time", { time: esc(clock(w.resetAt)) })}` : ""}</span></div>`;
}

function limitRow(r) {
  const body = r.windows?.length
    ? r.windows.map((w) => windowRow(w, w.state === "estimated")).join("") + `<small>${esc(r.note)}</small>`
    : `<small>${esc(r.note)}</small>`;
  return `<div class="lim">${logo(r.connection, r.connectionName, 28)}<div><div class="lim-h"><b>${esc(r.connectionName)}</b><span class="muted">${esc(r.accountLabel ?? "")}</span>${CHIP()[r.state] ?? ""}${r.inUse ? `<span class="pill ok">${t("glance.usedNext")}</span>` : ""}</div>${body}</div></div>`;
}

function popHTML(g) {
  const month = g?.month?.pricedRuns ? `<span>${t("glance.thisMonth")} <b>$${Number(g.month.cost).toFixed(2)}</b></span>` : "";
  return `<div class="lims"><div class="ph" data-css="padding:4px 6px 6px">${t("glance.title")}</div>${(g?.rows ?? []).map(limitRow).join("")}
    <p data-css="font-size:12px;color:var(--ink-3);margin:8px 6px 4px">${esc(g?.summary ?? "")}</p>
    <div class="lim-foot">${month}<span class="tb-grow"></span><button class="btn sm" type="button" data-act="setgo" data-v="usage">${t("glance.openUsage")}</button></div></div>`;
}

/* The version popover: while update by itself holds a ready update, its title is "Update ready, installs when …" in the
   engine's words and the owner's tasks holding it are listed, each opening its conversation; the last failure, in the
   updater's or engine's words, is said under it (shell/autoupdate.js lastLook). */
function updatePop(plan) {
  const version = E.state?.version ?? "";
  const waiting = waitingLine(), problem = lastLook.problem?.message;
  const tasks = waiting ? holdingTasks().filter((task) => task.name)
    .map((task) => mi("chat", task.state === "working" ? "spin" : "clock", esc(task.name), "", `data-id="${esc(task.sessionId)}"`)).join("") : "";
  return `<div class="pt">${esc(waiting ?? `Branch ${version}`)}</div><p class="pp">${esc(plan?.reason ?? "")}</p>${problem ? `<p class="pp">${esc(problem)}</p>` : ""}${tasks}${mi("install", "check", t("window.settings.updates.install-when-nothing-is-running"))}${mi("closepop", "clock", t("window.shell.usage.remind-me-tomorrow"))}`;
}

/* ---------- the save-progress offer ---------- */
const OFFERED = "branch-save-progress-asked"; // the key the old window kept, so a window asked about there is not asked again
function offered() {
  try { return JSON.parse(localStorage.getItem(OFFERED) ?? "[]"); } catch (error) { console.warn(error.message); return []; }
}
function remember(key) {
  try { localStorage.setItem(OFFERED, JSON.stringify([...offered(), key].slice(-50))); } catch (error) { console.warn(error.message); }
}
/* "as of just now" only when the window was read in the last 90 seconds, the engine's own cut-off for those words. */
function fresh(g, key) {
  const [connection, , id] = key.split("|");
  const w = g.rows?.find((r) => r.connection === connection)?.windows?.find((x) => x.id === id);
  return w?.measuredAt ? Date.now() - Date.parse(w.measuredAt) < 90_000 : false;
}
function offerHTML(c, justNow) {
  return `<svg class="ck-ring" width="36" height="36" viewBox="0 0 36 36" aria-hidden="true"><circle cx="18" cy="18" r="15" fill="none" stroke="var(--line-2)" stroke-width="3"/><circle class="ck-arc" cx="18" cy="18" r="15" fill="none" stroke="var(--accent)" stroke-width="3" stroke-linecap="round" stroke-dasharray="94.2" stroke-dashoffset="0" transform="rotate(-90 18 18)"/><text x="18" y="22" text-anchor="middle" class="ck-n">5</text></svg>
    <div class="grow"><b>${t("glance.almostOut", { name: esc(c.connectionName) })}</b><small>${justNow ? t("window.shell.usage.percent-used-measured-just-now", { percent: esc(String(c.percentUsed)) }) : t("window.shell.usage.percent-used-measured", { percent: esc(String(c.percentUsed)) })}</small></div>
    <button class="btn pri sm" type="button" data-act="ckpt-save">${t("glance.save")}</button><button class="btn ghost sm" type="button" data-act="ckpt-no">${t("updates.busy.cancel")}</button>`;
}
/* The prototype's five-second ring: the offer goes away by itself when it runs out. */
function countDown(el) {
  const t0 = Date.now(), total = 5000;
  const tick = () => {
    if (!el.isConnected) return;
    const left = Math.max(0, total - (Date.now() - t0));
    el.querySelector(".ck-arc").setAttribute("stroke-dashoffset", String(94.2 * (1 - left / total)));
    el.querySelector(".ck-n").textContent = String(Math.ceil(left / 1000));
    if (left <= 0) el.remove(); else setTimeout(tick, 100);
  };
  tick();
}
/* ---------- the plan meter in the status bar (prototype renderStatus, the CodexBar) ----------
   The ring and "<connection> · N% left · resets at <time>" for the account the active model uses next (GET /api/usage/glance
   row whose connection is E.state.activeModel.presetId and inUse), from its tightest window the service gave as a share.
   Nothing is drawn (the button keeps the model's name) when the engine has no such figure, the owner hid the ring in
   Settings › Data & usage, or the window is not the owner's. It is read again every 20 seconds and whenever the engine's
   state is read again (each event), and the bar is drawn again only when the line changed. */
let glance = null, readFor = null, reading = false, again = false;
function planOf(g) {
  const id = E.state?.activeModel?.presetId;
  if (!g?.available || g.settings?.ring === "hidden" || !id) return null;
  const row = (g.rows ?? []).find((r) => r.connection === id && r.inUse);
  let best = null;
  for (const w of row?.windows ?? []) { const pct = pctLeft(w); if (pct !== null && (!best || pct < best.pct)) best = { pct, w }; }
  return best && { name: row.connectionName, ...best };
}
function ringSVG(pct, dashed) {
  const r = 9, c = 2 * Math.PI * r, col = pct < 15 ? "var(--warn)" : "var(--accent)";
  return `<svg width="18" height="18" viewBox="0 0 22 22" aria-hidden="true"><circle cx="11" cy="11" r="${r}" fill="none" stroke="var(--line-2)" stroke-width="3"/><circle class="ring-arc" cx="11" cy="11" r="${r}" fill="none" stroke="${col}" stroke-width="3" stroke-linecap="round" stroke-dasharray="${dashed ? "2.5 2.5" : c}" ${dashed ? "" : `stroke-dashoffset="${c * (1 - pct / 100)}"`} transform="rotate(-90 11 11)"/></svg>`;
}
const hour = (iso) => { const d = new Date(iso); return d.toLocaleTimeString(language(), d.getMinutes() ? { hour: "numeric", minute: "2-digit" } : { hour: "numeric" }); };
/** The button's inside: the ring and the line, or the model's name alone when there is no figure. */
export function planMeter(label) {
  if (E.state && E.state !== readFor) { readFor = E.state; readGlance(); }
  const p = planOf(glance);
  if (!p) return `<span class="hide-sm">${esc(label)}</span>`;
  const reset = p.w.resetAt && Date.parse(p.w.resetAt) > Date.now() ? t("terminal.usage.resetsAt", { time: hour(p.w.resetAt) }) : "";
  const words = [esc(p.name), t("glance.left", { percent: p.pct }), esc(reset)].filter(Boolean).join(" · ");
  return `${ringSVG(p.pct, p.w.state === "estimated")}<span class="hide-sm">${words}</span>`;
}
/* The every-few-seconds re-read stays quiet when it fails: the status bar already says the engine is not answering. */
async function readGlance() {
  if (reading) { again = true; return; } // a read asked for while one is on its way runs once it is back
  reading = true;
  try { keep(await api("usage/glance")); } catch (error) { console.warn(error.message); } finally { reading = false; }
  if (again) { again = false; readGlance(); }
}
function keep(g) {
  const before = JSON.stringify(planOf(glance));
  glance = g;
  if (JSON.stringify(planOf(glance)) !== before) render();
}

async function checkLimits() {
  if (!E.state || document.querySelector(".ckpt-q")) return; // nothing is asked before sign-in
  const g = await api("usage/glance").catch(() => null);
  if (g) keep(g);
  if (!g?.available || g.settings?.saveProgress !== "ask" || !g.running) return;
  const seen = offered(), c = (g.crossings ?? []).find((x) => !seen.includes(x.key));
  if (!c) return;
  remember(c.key);
  const el = document.createElement("div");
  el.className = "ckpt-q";
  el.setAttribute("role", "alertdialog");
  el.setAttribute("aria-label", t("window.usage.save-progress"));
  el.innerHTML = offerHTML(c, fresh(g, c.key));
  app().appendChild(el);
  countDown(el);
}
async function saveProgress() {
  document.querySelector(".ckpt-q")?.remove();
  try {
    const { asked } = await api("usage/save-progress", {});
    toast((asked === 1 ? t("window.shell.usage.asked-one-running-task") : t("window.shell.usage.asked-count-running-tasks", { count: asked })));
  } catch (error) { toast(error.message); }
}

/* "Running in the background": each task the engine lists, named by its Trunk or conversation, with the engine's own
   words for what it is doing (for one that waits, why: its question); a spinner while it works, a clock while it waits. "Start something in the background"
   puts /bg in the message box, as the prototype does; sending it goes to the engine's /bg (chat.js, POST
   /api/commands/run). It stays greyed while the engine's command list for this window has no /bg (GET /api/commands). */
function tasksPop(bgListed) {
  const rows = ACT.list.map((a) => {
    const s = E.sessions.find((x) => (x.sessionId ?? x.id) === a.sessionId), t = E.trunks.find((x) => x.id === s?.trunkId || (x.chatSessionId && x.chatSessionId === a.sessionId));
    // A task that waits is listed with the engine's words for why: the question it asked (task.reason, Q51).
    const on = (a.task?.state ?? "working") === "working", said = (on ? "" : a.task?.reason) || a.current || a.working ||String(a.prompt ?? "").split("\n")[0];
    return `<div class="mi" role="menuitem"><span class="ico">${ic(on ? "spin" : "clock", on ? "s spin" : "s")}</span><span><span class="mi-t">${esc(t?.name || s?.opening || s?.title || "")}</span><span class="mi-s">${esc(said)}</span></span></div>`;
  }).join("");
  return `<div class="ph">${t("window.shell.usage.running-in-the-background")}</div>${rows}<hr>${mi(bgListed ? "bg-new" : "bg-new-off", "plus", t("window.shell.usage.start-something-in-the-background"), "<kbd>/bg</kbd>")}`;
}
async function openTasks(el) {
  let listed = false;
  try { listed = ((await api("commands?surface=window")).commands ?? []).some((c) => c.name === "bg"); } catch (error) { toast(error.message); }
  openPop(el, tasksPop(listed));
}
function startInBackground() {
  closePop();
  S.view = "chat";
  S.drafts[S.chat ?? "new"] = "/bg ";
  renderNow();
  const box = $("#prompt");
  box?.focus();
  box?.setSelectionRange(box.value.length, box.value.length);
}

export function initUsage() {
  markLive(["usagepop", "updmenu", "ckpt-save", "ckpt-no", "tasks10", "bg-new"]);
  on("tasks10", (el) => openTasks(el));
  on("bg-new", () => startInBackground());
  on("ckpt-save", saveProgress);
  on("ckpt-no", () => document.querySelector(".ckpt-q")?.remove());
  checkLimits();
  setInterval(checkLimits, 20000);
  // The last look's plan when update by itself has looked (it knows what the updater said); otherwise the engine is asked.
  on("updmenu", async (el) => openPop(el, updatePop(lastLook.plan ?? await api("comfort/update-plan", {}).catch((error) => ({ reason: error.message }))), { right: true }));
  on("usagepop", async (el) => openPop(el, popHTML(await api("usage/glance").catch(() => null)), { right: true }));
}
