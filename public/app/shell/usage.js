/* The status bar's version popover says what the engine plans to do about updates (POST /api/comfort/update-plan);
   installing goes through the desktop app's updater, so Install stays greyed here. Its usage popover is 1:1 with the
   prototype's "What each connection has left": one row per connection from GET /api/usage/glance, a bar only where the service gave a limit, and the engine's own sentence when it gave none.
   Accounts are shown side by side, never added together.
   Near a limit (a window the service measured at 95% used) while tasks run, and only while the owner leaves the offer on
   (GET /api/usage/glance settings.saveProgress "ask"), the prototype's save-progress offer: Save progress asks every
   running task to write down where it is (POST /api/usage/save-progress), Not now dismisses it. Each window is offered once. */

import { $, esc, render, renderNow, pressIn, whenReleased } from "../core/dom.js";
import { openPop, closePop, mi, toast, app, ic } from "../core/ui.js";
import { ACT } from "./activity.js";
import { todayActivityHTML } from "./today-activity.js";
import { holdingTasks, lastLook, waitingLine } from "./autoupdate.js";
import { S, E, refresh, ownerHere } from "../core/state.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { logo } from "../core/logos.js";
import { waiting } from "../flows/whatsnew.js";
import { snoozeUpdate } from "../chat/rec.js";
import { allPaused } from "../flows/pause.js";
import { t } from "../../i18n.js";
import { resetWords } from "../core/usage-reset.js";

const CHIP = () => ({ measured: `<span class="pill ok">${t("glance.measured")}</span>`, estimated: `<span class="pill warn">${t("glance.estimate")}</span>`, not_published: `<span class="pill idle">${t("glance.notPublished")}</span>` });
/* "Updated 3 min ago", from the newest window's own time of measuring; the row's header names whose account it is (the
   engine's accountLabel: the sign-in's email where the service said it). How it was measured is never said here (the
   owner, 2026-09-27: no header names, no plumbing words). Settings › Usage draws the same line. */
export function updatedWords(r) {
  return agoWords(Math.max(...(r.windows ?? []).map((w) => Date.parse(w.measuredAt ?? "")).filter(Number.isFinite)));
}
function agoWords(at) {
  if (!Number.isFinite(at)) return "";
  const min = Math.round((Date.now() - at) / 60000);
  return t("dashboard.updated", { time: min < 2 ? t("glance.justNow") : min < 90 ? t("glance.minAgo", { count: min }) : t("glance.hAgo", { count: Math.round(min / 60) }) });
}

/* The share of a window left, 0 to 100, or null where the service gave no limit and remainder (money never is one).
   The list and the status bar's line both use it, so they never disagree. */
const pctLeft = (w) => (w.kind === "money" || !w.limit || w.remaining == null || refilled(w) ? null : Math.max(0, Math.min(100, Math.round((w.remaining / w.limit) * 100))));
/* A window whose refill time has passed was measured before it refilled: its old share is known to be wrong now, so it is
   not drawn as current (reading it again gives the real one). */
const refilled = (w) => !!w.resetAt && Date.parse(w.resetAt) <= Date.now();

/* ---------- reading plans again: on each look at the popover, Check now, and the status bar's own cadence ----------
   Only rows the engine says it can read (row.readable: a ChatGPT or Claude Code sign-in, read from the service itself
   with no message sent, POST /api/usage/limits/refresh) say "Checking…" while their read is on its way. */
const checking = new Set();
const rowKey = (r) => `${r.connection}|${r.account ?? "primary"}`;
let looks = 0;
async function checkRows(rows) {
  const look = ++looks, mine = rows.filter((r) => r.readable);
  for (const r of mine) checking.add(rowKey(r));
  redrawPop(look);
  await Promise.all(mine.map(async (r) => {
    try { keep(await api("usage/limits/refresh", { connection: r.connection, account: r.account ?? "primary" })); }
    catch (error) { toast(error.message); }
    finally { checking.delete(rowKey(r)); redrawPop(look); }
  }));
}
/* The popover is drawn again only while it is still the one these reads were started for. */
function redrawPop(look) {
  const at = document.querySelector('#statusbar [data-act="usagepop"]');
  if (look !== looks || !at || !document.querySelector(".pop .lims")) return;
  // A press inside the popover (Check now, Open Usage) would be lost if its button were replaced mid-press: draw after it.
  if (pressIn(document.querySelector(".pop"))) { whenReleased(() => redrawPop(look)); return; }
  const scroll = document.querySelector(".pop .lim-list")?.scrollTop ?? 0;
  openPop(at, popHTML(glance), { right: true, force: true });
  const list = document.querySelector(".pop .lim-list");
  if (list) list.scrollTop = scroll;
}

function windowRow(w, estimated) {
  const pct = pctLeft(w);
  const reset = `<small class="lim-reset">${esc(resetWords(w.resetAt))}</small>`;
  if (pct === null) return `<div class="lim-w"><span>${esc(w.title)}</span><span></span><span class="lim-share">${w.remaining == null || refilled(w) ? "" : esc(String(w.remaining))}</span>${reset}</div>`;
  return `<div class="lim-w"><span>${esc(w.title)}</span><span class="lim-bar ${estimated ? "est" : ""}"><i data-css="width:${pct}%;${pct < 15 ? "background:var(--warn)" : ""}"></i></span><span class="lim-share">${t("glance.left", { percent: pct })}</span>${reset}</div>`;
}

/* A sign-in never measured yet says so, and offers Measure now (POST /api/usage/limits/measure): one tiny real message. */
/* models-ui (owner 2026-09-27, per-Trunk subscriptions): the Trunks that answer with this very account (their pick in
   Edit Trunk › Accounts, keys.accounts). A Trunk that copies the owner's accounts and picked none follows the owner's
   order, so it is named under no account in particular. */
const rowAccount = (r) => r.account ?? "primary";
const trunksOn = (r) => (E.trunks ?? []).filter((tr) => tr.keys?.accounts?.[r.connection] === rowAccount(r));
function trunkLine(r) {
  const names = trunksOn(r).map((tr) => tr.name);
  return names.length ? `<small class="lim-trunks">${esc(t("glance.trunksOn", { names: names.join(", ") }))}</small>` : "";
}
function limitRow(r) {
  const busy = checking.has(rowKey(r)), said = busy ? t("glance.checking") : updatedWords(r);
  const measure = r.signIn && !r.windows?.length && !busy ? `<small>${esc(t("glance.measureNote"))}</small><button class="btn sm" type="button" data-act="limmeasure" data-id="${esc(r.connection)}" data-v="${esc(r.account ?? "primary")}">${esc(t("glance.measureNow"))}</button>` : "";
  const body = r.windows?.length
    ? r.windows.map((w) => windowRow(w, w.state === "estimated")).join("") + `<small>${esc(said)}${r.note ? ` ${esc(r.note)}` : ""}</small>`
    : `<small>${esc(busy ? said : r.note)}</small>${measure}`;
  return `<div class="lim">${logo(r.connection, r.connectionName, 28)}<div><div class="lim-h"><b>${esc(r.connectionName)}</b><span class="muted">${esc(r.accountLabel ?? "")}</span>${CHIP()[r.state] ?? ""}${r.inUse ? `<span class="pill ok">${t("glance.usedNext")}</span>` : ""}</div>${trunkLine(r)}${body}${offerBlock(r)}</div></div>`;
}

/* ---------- more usage, where the service offers it (src/usage-offers.ts) ----------
   The engine attaches row.offer only where the service sells more usage and this account is at or near its limit, and
   row.limitNear with row.switches where its list moves on to the next account by itself. The button opens the
   service's own page in the owner's browser; nothing is bought here, and the owner decides there. */
const siteOf = (url) => { try { return new URL(url).hostname; } catch { return ""; } };
function offerBlock(r) {
  const pool = r.limitNear && r.switches ? `<small class="lim-pool">${esc(t("glance.poolSwitches"))}</small>` : "";
  const offer = r.offer?.url ? r.offer : null;
  if (!offer) return pool ? `<div class="lim-offer">${pool}</div>` : "";
  const key = `glance.offer.${offer.id}`, label = t(key) === key ? offer.option : t(key), site = siteOf(offer.url);
  // The account is named only when its label is who the service said it is, never a name like "Your sign-in".
  const note = r.verified && r.accountLabel ? t("glance.offerNoteFor", { site, account: r.accountLabel }) : t("glance.offerNote", { site });
  return `<div class="lim-offer"><button class="btn sm" type="button" data-act="limoffer" data-id="${esc(r.connection)}" data-v="${esc(r.account ?? "")}">${esc(label)}</button><small>${esc(note)}</small>${pool}</div>`;
}
/* The desktop window opens the page in the owner's browser (it accepts only the catalogue's pages); a browser tab opens a new tab. */
function openOutside(url) {
  const desktop = globalThis.branchDesktop;
  if (typeof desktop?.openExternal === "function") return Promise.resolve(desktop.openExternal(url));
  window.open(url, "_blank", "noopener");
  return Promise.resolve();
}
/* When the owner comes back from the provider's page, that one row is read again, once, and shown in the popover: opened
   again first if it was closed while the owner was away, so the new state is in front of them. */
let returning = null;
function leftForPage() { if (returning) returning.left = true; }
async function cameBack() {
  if (!returning?.left || document.visibilityState !== "visible") return;
  const row = returning.row, at = document.querySelector('#statusbar [data-act="usagepop"]');
  returning = null;
  if (at && glance && !document.querySelector(".pop .lims")) openPop(at, popHTML(glance), { right: true });
  if (row.readable) { checkRows([row]); return; }
  const look = looks;
  try { keep(await api("usage/glance")); } catch (error) { toast(error.message); return; }
  redrawPop(look);
}
async function openOffer(el) {
  const row = (glance?.rows ?? []).find((r) => r.connection === el.dataset.id && (r.account ?? "") === el.dataset.v);
  if (!row?.offer?.url) return;
  returning = { row, left: false };
  try { await openOutside(row.offer.url); toast(t("glance.offerOpened", { site: siteOf(row.offer.url) })); }
  catch (error) { returning = null; toast(error.message); }
}

/* A plan signed in on this computer that is not a connection yet (GET/POST glance `addable`, the engine's own sentence):
   one Connect adds it, as Add an account does (POST /api/providers/cli-agents), and its plan is read at once. */
function addRow(a) {
  return `<div class="lim">${logo(`cli-${a.program}`, a.connectionName, 28)}<div><div class="lim-h"><b>${esc(a.connectionName)}</b></div><small>${esc(a.note)}</small><button class="btn sm" type="button" data-act="limconnect" data-v="${esc(a.program)}">${t("action.connect")}</button></div></div>`;
}

function popHTML(g) {
  const month = g?.month?.pricedRuns ? `<span>${t("glance.thisMonth")} <b>$${Number(g.month.cost).toFixed(2)}</b></span>` : "";
  return `<div class="lims"><div class="ph" data-css="padding:4px 6px 6px">${t("glance.title")}</div><div class="lim-list">${(g?.rows ?? []).map(limitRow).join("")}${(g?.addable ?? []).map(addRow).join("")}</div><div class="lim-actions">
    <p data-css="font-size:12px;color:var(--ink-3);margin:8px 6px 4px">${esc(g?.summary ?? "")}</p>
    <div class="lim-foot">${month}<span class="tb-grow"></span>${(g?.rows ?? []).some((r) => r.readable) ? `<button class="btn sm" type="button" data-act="limcheck">${t("action.check-now")}</button>` : ""}<button class="btn sm" type="button" data-act="setgo" data-v="usage">${t("glance.openUsage")}</button></div></div></div>`;
}

/* The version popover: while update by itself holds a ready update, its title is "Update ready, installs when …" in the
   engine's words and the owner's tasks holding it are listed, each opening its conversation; the last failure, in the
   updater's or engine's words, is said under it (shell/autoupdate.js lastLook). Otherwise, the prototype's update menu:
   "Branch <new> is ready" and the first three lines of its notes when the desktop's updater has found one
   (flows/whatsnew.js waiting), else the installed version. Then the engine's plan and Read the release notes. */
function updatePop(plan, next) {
  const version = E.state?.version ?? "";
  const held = waitingLine(), problem = lastLook.problem?.message;
  const tasks = held ? holdingTasks().filter((task) => task.name)
    .map((task) => mi("chat", task.state === "working" ? "spin" : "clock", esc(task.name), "", `data-id="${esc(task.sessionId)}"`)).join("") : "";
  const title = held ?? (next ? t("window.flows.whatsnew.is-ready", { version: next.version }) : `Branch ${version}`);
  const lines = next?.lines.length ? `<ul class="steps-list" data-css="padding:0 10px 8px 28px;font-size:12.5px">${next.lines.slice(0, 3).map((l) => `<li>${esc(l)}</li>`).join("")}</ul>` : "";
  return `<div class="pt">${esc(title)}</div><p class="pp">${esc(plan?.reason ?? "")}</p>${problem ? `<p class="pp">${esc(problem)}</p>` : ""}${tasks}${lines}${mi("relnotes17d", "news17d", t("window.flows.whatsnew.read"), "", next ? 'data-v="ready"' : "")}${mi("install", "check", t("window.settings.updates.install-when-nothing-is-running"))}${next ? mi("upd-snooze", "clock", t("window.shell.usage.remind-me-tomorrow"), "", `data-v="${esc(next.version)}" data-why="update-remind"`) : ""}`;
}
/* The last look's plan when update by itself has looked (it knows what the updater said); otherwise the engine is asked. */
async function openUpdates(el) {
  const [plan, next] = await Promise.all([lastLook.plan ?? api("comfort/update-plan", {}).catch((error) => ({ reason: error.message })), waiting().catch((error) => { toast(error.message); return null; })]);
  openPop(el, updatePop(plan, next), { right: true });
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
let identityTimer = null;
const STALE_MS = 15 * 60_000, METER_EVERY_MS = 5 * 60_000;
/* In a Trunk's own conversation the meter is that Trunk's: its own model (else the owner's), and the account it picked
   for that connection (else the one used next), so its own window and reset are what the bar says. */
const trunkHere = () => (S.chat ? (E.trunks ?? []).find((tr) => tr.chatSessionId === S.chat) ?? null : null);
const inUseRow = (g) => {
  const tr = trunkHere(), id = tr?.model || E.state?.activeModel?.presetId;
  if (!id) return null;
  const rows = (g?.rows ?? []).filter((r) => (r.presets ?? [r.connection]).includes(id));
  const picked = tr ? rows.find((r) => tr.keys?.accounts?.[r.connection] === rowAccount(r)) : null;
  return picked ?? rows.find((r) => r.inUse) ?? null;
};
function planOf(g) {
  if (!g?.available || g.settings?.ring === "hidden") return null;
  const row = inUseRow(g);
  if (!row) return null;
  let best = null;
  for (const w of row.windows ?? []) { const pct = pctLeft(w); if (pct !== null && (!best || pct < best.pct)) best = { pct, w }; }
  /* Nothing measured yet: the plan's name and an empty ring, never the model's name. */
  if (!best && row.state === "not_published" && !row.signIn && !/No limit/.test(row.note ?? "")) return null;
  const tr = trunkHere(), own = tr && tr.keys?.accounts?.[row.connection] === rowAccount(row);
  const name = own ? t("glance.trunkMeter", { name: row.connectionName, trunk: tr.name, account: row.accountLabel ?? "" }) : row.connectionName;
  return { name, signIn: row.signIn, ...(best ?? { pct: null, w: null }) };
}
function ringSVG(pct, dashed) {
  if (pct === null) return `<svg width="18" height="18" viewBox="0 0 22 22" aria-hidden="true"><circle cx="11" cy="11" r="9" fill="none" stroke="var(--line-2)" stroke-width="3"/></svg>`;
  const r = 9, c = 2 * Math.PI * r, col = pct < 15 ? "var(--warn)" : "var(--accent)";
  return `<svg width="18" height="18" viewBox="0 0 22 22" aria-hidden="true"><circle cx="11" cy="11" r="${r}" fill="none" stroke="var(--line-2)" stroke-width="3"/><circle class="ring-arc" cx="11" cy="11" r="${r}" fill="none" stroke="${col}" stroke-width="3" stroke-linecap="round" stroke-dasharray="${dashed ? "2.5 2.5" : c}" ${dashed ? "" : `stroke-dashoffset="${c * (1 - pct / 100)}"`} transform="rotate(-90 11 11)"/></svg>`;
}
/** The button's inside: the ring and the line, or the model's name alone when there is no figure. */
export function planMeter(label) {
  if (E.state && E.state !== readFor) { readFor = E.state; readGlance(); }
  const p = planOf(glance);
  if (!p) return `<span class="hide-sm">${esc(label)}</span>`;
  if (p.pct === null) return `${ringSVG(null, false)}<span class="hide-sm">${esc(p.name)} · ${esc(p.signIn ? t("glance.measuring") : t("glance.noLimit"))}</span>`;
  const reset = resetWords(p.w.resetAt, true), fullReset = resetWords(p.w.resetAt);
  /* A figure older than a quarter of an hour says how old it is. */
  const at = Date.parse(p.w.measuredAt ?? ""), old = Number.isFinite(at) && Date.now() - at > STALE_MS ? agoWords(at) : "";
  const words = [esc(p.name), t("glance.left", { percent: p.pct }), esc(reset), esc(old)].filter(Boolean).join(" · ");
  return `${ringSVG(p.pct, p.w.state === "estimated")}<span class="hide-sm" title="${esc(fullReset)}">${words}</span>`;
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
  const rowsBefore = JSON.stringify(glance?.rows);
  glance = g;
  if (JSON.stringify(planOf(glance)) !== before) render();
  if (JSON.stringify(g?.rows) !== rowsBefore) redrawPop(looks);
  hydrateIdentities();
}
function hydrateIdentities() {
  clearTimeout(identityTimer);
  const visible = () => ownerHere() && !document.querySelector(".lockscreen") && document.querySelector(".pop .lims");
  if (!glance?.identitiesPending || !visible()) return;
  identityTimer = setTimeout(() => { if (visible()) readGlance(); }, 1000);
}

/* The status bar's own cadence: a ChatGPT plan in use is read again every five minutes while this window is in front (and
   when it comes back to the front after that long). Claude Code is not on this cadence, since reading it starts the
   program: it is read when the popover opens or on Check now, and each of its replies says what is left anyway. Every
   model reply that says what is left updates the meter through the engine's state. */
let meterAt = 0; // the first look comes within a minute of opening
function meterCheck() {
  if (document.visibilityState !== "visible" || !document.hasFocus() || Date.now() - meterAt < METER_EVERY_MS) return;
  const row = inUseRow(glance);
  if (!row?.readable || row.connection !== "chatgpt") return;
  meterAt = Date.now();
  api("usage/limits/refresh", { connection: row.connection, account: row.account ?? "primary" }).then(keep).catch((error) => console.warn(error.message));
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
  /* pass 17c: the last row pauses or resumes every Trunk (flows/pause.js pauseall: POST /api/trunks/pause-all, resume-all). */
  const all = allPaused();
  const pause = E.trunks.length ? mi("pauseall", all ? "play" : "pause", all ? t("window.places.overview.resume-all-trunks") : t("window.places.overview.pause-all-trunks")) : "";
  return `<div class="ph">${t("window.shell.usage.running-in-the-background")}</div>${rows}<hr>${mi(bgListed ? "bg-new" : "bg-new-off", "plus", t("window.shell.usage.start-something-in-the-background"), "<kbd>/bg</kbd>")}${pause}`;
}
async function openTasks(el) {
  let listed = false;
  try { listed = ((await api("commands?surface=window")).commands ?? []).some((c) => c.name === "bg"); } catch (error) { toast(error.message); }
  const today = await todayActivityHTML();
  openPop(el, tasksPop(listed) + today);
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
  markLive(["usagepop", "limmeasure", "limcheck", "limconnect", "limoffer", "updmenu", "ckpt-save", "ckpt-no", "tasks10", "bg-new"]);
  on("limoffer", (el) => openOffer(el));
  window.addEventListener("blur", leftForPage);
  window.addEventListener("focus", cameBack);
  document.addEventListener("visibilitychange", () => (document.visibilityState === "hidden" ? leftForPage() : cameBack()));
  on("tasks10", (el) => openTasks(el));
  on("bg-new", () => startInBackground());
  on("ckpt-save", saveProgress);
  on("ckpt-no", () => document.querySelector(".ckpt-q")?.remove());
  checkLimits();
  setInterval(checkLimits, 20000);
  setInterval(meterCheck, 60_000);
  window.addEventListener("focus", meterCheck);
  for (const event of ["click", "keydown"]) document.addEventListener(event, () => queueMicrotask(hydrateIdentities));
  on("limcheck", () => checkRows(glance?.rows ?? []));
  on("updmenu", (el) => openUpdates(el));
  on("upd-snooze", (el) => { closePop(); snoozeUpdate(el.dataset.v); });
  on("limmeasure", async (el) => {
    el.disabled = true;
    try { await api("usage/limits/measure", { connection: el.dataset.id, account: el.dataset.v }); }
    catch (error) { toast(error.message); }
    const g = await api("usage/glance").catch(() => null);
    if (g) keep(g);
    const pop = el.closest(".pop");
    if (pop && g) redrawPop(looks);
  });
  /* Opening the popover reads every plan it can again at once; each row says "Checking…" until its answer is back. */
  on("usagepop", async (el) => {
    const g = await api("usage/glance").catch((error) => { toast(error.message); return null; });
    if (g) keep(g);
    openPop(el, popHTML(g), { right: true });
    if (!g || !document.querySelector(".pop .lims")) return;
    hydrateIdentities();
    checkRows(g.rows ?? []);
    const look = looks;
    api("usage/limits/look", {}).then((next) => { keep(next); redrawPop(look); }).catch((error) => toast(error.message));
  });
  on("limconnect", async (el) => {
    el.disabled = true;
    try { await api("providers/cli-agents", { id: el.dataset.v }); await refresh(); }
    catch (error) { toast(error.message); el.disabled = false; return; }
    const g = await api("usage/glance").catch((error) => { toast(error.message); return null; });
    if (g) { keep(g); checkRows(g.rows ?? []); }
  });
}
