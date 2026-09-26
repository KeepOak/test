/* Settings › Data & usage. The report card adds up the engine's own usage for the last 7, 30 or 90 days
   (GET /api/usage?range=), and "Open the report" shows the engine's usage report for that stretch
   (POST /api/usage/report { range, format }), which answers only while the usage-report switch is on.
   "Test the model you use" lists the engine's ready-made suites (GET /api/evaluation/suites), runs the chosen one
   against the model in use (POST /api/evaluation/run { suite }), and shows the last run the engine recorded for it
   (GET /api/evaluation/history?suite=, newest first). */
import { on } from "../../core/actions.js";
import { markLive } from "../../core/features.js";
import { api } from "../../core/api.js";
import { toast, openDlg, ic } from "../../core/ui.js";
import { esc, renderNow } from "../../core/dom.js";
import { statusBox } from "../parts.js";
import { seg15 } from "../rows15.js";
import { logo } from "../../core/logos.js";
import { level } from "../../core/state.js";
import { sections17, init17 } from "../p17-usage.js";
import { t, language } from "../../../i18n.js";

let usage = null;
let range = "30";

async function loadUsage() {
  try { usage = await api(`usage?range=${range}d&by=day`); } catch (error) { usage = null; toast(error.message); }
  renderNow();
}

function reportCard() {
  const days = usage?.data ?? [];
  const cost = days.reduce((sum, d) => sum + (d.estimatedCost ?? 0), 0);
  const tasks = days.reduce((sum, d) => sum + (d.runs ?? 0), 0);
  const head = usage ? `<b>$${cost.toFixed(2)}</b><em>${t("window.settings.usage.tasks-tasks-estimated-from-each-models", { tasks })}</em>` : "";
  return `<div class="rep15"><div class="rep-h15"><span><small>${t("window.settings.usage.last-range-days", { range })}</small>${head}</span><span class="seg" role="group" aria-label="${t("window.settings.usage.period")}">${["7", "30", "90"].map((d) => `<button type="button" aria-pressed="${range === d}" data-act="rep15" data-v="${d}">${t("window.settings.usage.value-days", { value: d })}</button>`).join("")}</span></div><button class="btn sm" type="button" data-act="repopen15">${t("window.settings.usage.open-the-report")}</button></div>`;
}

async function openReport() {
  try {
    const report = await api("usage/report", { range: `${range}d`, format: "markdown" });
    openDlg({ title: t("window.settings.usage.usage-last-range-days", { range }), wide: true, body: `<pre class="code6" data-css="white-space:pre-wrap;margin:0">${esc(report.body)}</pre>`, foot: `<button class="btn" type="button" data-act="dlg-close">${t("delight.ach.close")}</button>` });
  } catch (error) { toast(error.message); }
}

/* ---------- Test the model you use ---------- */
let suites = null;
let suiteId = null;
let lastRun = null;
let running = false;

async function loadLastRun() {
  if (!suiteId) return;
  try { lastRun = (await api(`evaluation/history?suite=${encodeURIComponent(suiteId)}`)).runs?.[0] ?? null; } catch (error) { lastRun = null; toast(error.message); }
  renderNow();
}

async function loadSuites() {
  try {
    suites = (await api("evaluation/suites")).suites ?? [];
    if (!suites.some((s) => s.id === suiteId)) suiteId = suites[0]?.id ?? null;
  } catch (error) { suites = null; toast(error.message); }
  await loadLastRun();
}

async function runTest() {
  if (running || !suiteId) return;
  running = true;
  renderNow();
  try { lastRun = await api("evaluation/run", { suite: suiteId }); } catch (error) { toast(error.message); }
  running = false;
  renderNow();
}

/* The time the run took, from the engine's own start and finish. */
function took(run) {
  const ms = Date.parse(run.finishedAt) - Date.parse(run.startedAt);
  if (!(ms >= 0)) return "";
  return ms < 10000 ? `${(ms / 1000).toFixed(1)} s` : ms < 60000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60000)} min`;
}

function result(run) {
  const s = run.summary ?? {};
  /* The engine never lets a figure worked out from its own token count read as a bill; the page's own words say so. */
  const cost = s.dollars == null ? "" : ` · ${t("window.settings.usage.cost-amount", { amount: `$${s.dollars.toFixed(2)}` })}${run.costBasis === "reported" ? "" : ` · ${t("window.settings.usage.estimated-from-each-models-price")}`}`;
  const time = took(run);
  const title = `${t("window.settings.usage.passed-of-total-right", { passed: s.passed, total: s.total })}${cost}${time ? ` · ${time}` : ""}`;
  const regressions = run.regressions ?? [];
  const said = run.regressionNote ? run.regressionNote : regressions.length ? "" : t("window.settings.usage.nothing-that-used-to-work-stopped");
  const missed = (run.tasks ?? []).filter((t) => !t.passed).map((t) => t.problem ?? t.id);
  const text = [said, missed.length ? t("window.settings.usage.missed-list", { list: missed.join("; ") }) : ""].filter(Boolean).join(" ");
  return statusBox(title, text, regressions.length > 0);
}

function evalCard() {
  const current = (suites ?? []).find((s) => s.id === suiteId);
  const picks = (suites ?? []).map((s) => `<button type="button" aria-pressed="${s.id === suiteId}" data-act="eval-set" data-v="${esc(s.id)}">${esc(s.name)} · ${s.tasks.length}</button>`).join("");
  const state = running && current ? `<p class="hint ic-t">${ic("spin", "s spin")}${t("window.settings.usage.running-tasks-tasks", { tasks: current.tasks.length })}</p>` : lastRun && !running ? result(lastRun) : "";
  return `<div class="sec"><h2>${t("window.settings.usage.test-the-model-you-use")}</h2><p class="hint" data-css="margin:0 0 6px">${t("window.settings.usage.run-a-ready-made-set-of")}</p>
  <div class="ctl ev15"><b>${t("window.settings.usage.test-set")}</b><span class="right"><span class="seg" role="group" aria-label="${t("window.settings.usage.test-set")}">${picks}</span></span><small>${t("window.settings.usage.each-task-is-checked-the-same")}</small></div>
  ${state}
  <div class="acts" data-css="margin-top:8px"><button class="btn" type="button" data-act="eval-run" ${running || !suiteId ? "disabled" : ""}>${lastRun ? t("window.places.library17.run-again") : t("window.settings.usage.run-the-test")}</button></div></div>`;
}

/* ---------- What each connection has left (GET /api/usage/glance), 1:1 with the status bar's list ---------- */
let glance = null;
let limits = null;
const CHIP = () => ({ measured: `<span class="pill ok">${t("glance.measured")}</span>`, estimated: `<span class="pill warn">${t("glance.estimate")}</span>`, not_published: `<span class="pill idle">${t("glance.notPublished")}</span>` });
const clock = (iso) => new Date(iso).toLocaleTimeString(language(), { hour: "numeric", minute: "2-digit" });

function windowRow(w, estimated) {
  if (w.kind === "money" || !w.limit || w.remaining == null) return `<div class="lim-w"><span>${esc(w.title)}</span><span></span><span>${w.remaining == null ? "" : esc(String(w.remaining))}</span></div>`;
  const pct = Math.max(0, Math.min(100, Math.round((w.remaining / w.limit) * 100)));
  return `<div class="lim-w"><span>${esc(w.title)}</span><span class="lim-bar ${estimated ? "est" : ""}"><i data-css="width:${pct}%;${pct < 15 ? "background:var(--warn)" : ""}"></i></span><span>${t("glance.left", { percent: pct })}${w.resetAt ? ` · ${t("window.shell.usage.resets-time", { time: esc(clock(w.resetAt)) })}` : ""}</span></div>`;
}

function limitRow(r) {
  const body = (r.windows ?? []).map((w) => windowRow(w, w.state === "estimated")).join("") + `<small>${esc(r.note)}</small>`;
  return `<div class="lim">${logo(r.connection, r.connectionName, 28)}<div><div class="lim-h"><b>${esc(r.connectionName)}</b><span class="muted">${esc(r.accountLabel ?? "")}</span>${CHIP()[r.state] ?? ""}${r.inUse ? `<span class="pill ok">${t("glance.usedNext")}</span>` : ""}</div>${body}</div></div>`;
}

async function loadGlance() {
  const [g, l] = await Promise.all(["usage/glance", "usage/limits/settings"].map((path) => api(path).catch((error) => { toast(error.message); return null; })));
  glance = g; limits = l?.usageLimits ?? null;
  renderNow();
}

/* The ring and the save-progress offer (POST /api/usage/glance/settings, merged) and asking a service what is left
   (POST /api/usage/limits/settings, a three-way switch: on unless "off", turned on as "when-needed"). The tray has no
   route, so it stays greyed; the prototype's "Show me" only played its own demo, so it is not drawn. */
const WIRES = {
  "u-ring": [() => glance?.settings?.ring === "shown", (on) => api("usage/glance/settings", { ring: on ? "shown" : "hidden" })],
  "u-ckpt": [() => glance?.settings?.saveProgress === "ask", (on) => api("usage/glance/settings", { saveProgress: on ? "ask" : "off" })],
  "u-ask": [() => Boolean(limits?.mode) && limits.mode !== "off", (on) => api("usage/limits/settings", { mode: on ? "when-needed" : "off" })],
};
const checked = (id) => (WIRES[id][0]() ? "checked" : "");

function limitsSec() {
  return `<div class="sec"><h2>${t("glance.title")}</h2><p class="hint" data-css="margin:0 0 6px">${t("window.settings.usage.how-much-of-each-services-allowance")}</p><div class="lims flat">${(glance?.rows ?? []).map(limitRow).join("")}</div>
    <div class="ctl"><b>${t("window.settings.usage.the-ring-bottom-right")}</b><input class="sw" type="checkbox" id="u-ring" ${checked("u-ring")} aria-label="${t("window.settings.usage.show-the-ring")}" data-sw="ring"><small>${t("window.settings.usage.the-connection-used-next-how-much")}</small></div>
    <div class="ctl"><b>${t("window.settings.usage.offer-to-save-progress-at-95")}</b><input class="sw" type="checkbox" id="u-ckpt" ${checked("u-ckpt")} aria-label="${t("window.settings.usage.offer-to-save-progress-at-95")}" data-sw="ckpt"><small>${t("window.settings.usage.it-only-asks-once-per-connection")}</small></div>
    <div class="ctl"><b>${t("settings-kit.name.usage-limits")}</b><input class="sw" type="checkbox" id="u-ask" ${checked("u-ask")} aria-label="${t("settings-kit.name.usage-limits")}" data-sw="set"><small>${t("window.settings.usage.only-openrouter-documents-a-way-to")}</small></div>
    <div class="ctl"><b>${t("window.settings.usage.show-usage-in-the-tray")}</b><input class="sw" type="checkbox" id="u-tray" aria-label="${t("window.settings.usage.show-usage-in-the-tray")}" data-sw="set"><small>${t("window.settings.usage.a-small-ring-by-the-clock")}</small></div></div>`;
}

/* Spend by Trunk: the engine keeps no spend per Trunk, so no bars are drawn; the month's total is the engine's. */
function spendSec() {
  const month = glance?.month?.pricedRuns ? `<p class="hint">${t("window.settings.usage.this-month-value-plans-are-billed", { value: Number(glance.month.cost).toFixed(2) })}</p>` : "";
  return `<div class="sec"><h2>${t("window.settings.usage.spend-last-7-days")}</h2><div class="bars"></div>${month}</div>`;
}

/* Keeping conversations deletes older ones for good, and checkpoints have no list here yet, so both stay greyed; the
   pressed choice is the engine's own retention setting (GET /api/retention). */
let retention = null;
function keeping() {
  const r = retention;
  const cur = !r ? null : !r.enabled || !r.keepDays ? "forever" : r.keepDays === 30 ? "30" : r.keepDays === 365 ? "365" : null;
  return `<div class="sec"><h2>${t("window.settings.usage.keeping-things")}</h2>${seg15(t("window.settings.usage.keep-conversations"), t("window.settings.usage.older-ones-are-deleted-for-good"), [["30", t("window.settings.usage.30-days")], ["365", t("window.settings.usage.1-year")], ["forever", t("window.settings.usage.forever")]], cur)}<div class="ctl"><b>${t("window.settings.usage.checkpoints")}</b><span class="right"><button class="btn sm" type="button" data-act="soon">${t("window.settings.usage.see-all")}</button></span><small>${t("window.settings.usage.kept-before-a-trunk-changes-files")}</small></div></div>`;
}

async function loadRetention() {
  try { retention = (await api("retention")).settings ?? null; } catch (error) { toast(error.message); }
  renderNow();
}

export function draw() {
  return `<h1>${esc(t("settings.page.data"))}</h1><p class="lede">${t("window.settings.usage.what-each-connection-has-left-what")}</p>` + reportCard() + limitsSec() + spendSec() + keeping() + evalCard() + sections17(level());
}

export function init() {
  init17();
  loadUsage();
  loadSuites();
  loadGlance();
  loadRetention();
  markLive(["sw:u-ring", "sw:u-ckpt", "sw:u-ask"]);
  document.addEventListener("change", async (e) => {
    const wire = WIRES[e.target.id];
    if (!wire) return;
    try { await wire[1](e.target.checked); } catch (error) { toast(error.message); }
    await loadGlance();
  });
  on("rep15", (el) => { range = el.dataset.v; loadUsage(); });
  on("repopen15", () => openReport());
  on("eval-set", (el) => { if (running) return; suiteId = el.dataset.v; lastRun = null; loadLastRun(); });
  on("eval-run", () => runTest());
  markLive(["rep15", "repopen15", "eval-set", "eval-run"]);
}

export function load() { loadSuites(); loadGlance(); loadRetention(); return loadUsage(); }

export const live = { "rep15": true, "repopen15": true, "eval-set": true, "eval-run": true };
