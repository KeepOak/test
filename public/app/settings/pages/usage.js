/* Settings › Data & usage. The report card adds up the engine's own usage for the last 7, 30 or 90 days
   (GET /api/usage?range=&by=day). "Open the report" is that stretch in the prototype's form, from the same day rows:
   four tiles (spent, tasks, the model cheapest per task, the busiest day), bars by model and by where each task came
   from, and "Save as a spreadsheet", which saves those day rows as a CSV file. The engine keeps no spend per person by
   day, so no person bars are drawn.
   "Test the model you use" lists the engine's ready-made suites (GET /api/evaluation/suites), runs the chosen one
   against the model in use (POST /api/evaluation/run { suite }), and shows the last run the engine recorded for it
   (GET /api/evaluation/history?suite=, newest first).
   Keeping conversations is the engine's retention setting (POST /api/retention, the whole record: enabled and keepDays);
   the engine proposes old conversations and deletes nothing by itself. Checkpoints lists the snapshots taken before a
   Trunk changed files (GET /api/history/snapshots); Put back is POST /api/history/snapshots/<id>/restore, which keeps
   what the files hold now as a snapshot of its own first.
   Flagged replies (the owner's): GET /api/reply-flags lists each flag's reasons and conversation; Remove is
   POST /api/reply-flags/<id>/remove. The reply's words leave the engine only through its audited export, so they are
   not drawn, and sending a flag to the Branch team has no engine route, so that switch stays greyed.
   "Show usage in the tray" is the glance setting tray (the desktop app's icon rings with the same share as the ring,
   src/desktop/tray-ring.ts); it ships on and is not drawn on a phone. */
import { on } from "../../core/actions.js";
import { markLive } from "../../core/features.js";
import { api } from "../../core/api.js";
import { toast, openDlg, closeDlg, ic } from "../../core/ui.js";
import { esc, renderNow } from "../../core/dom.js";
import { statusBox } from "../parts.js";
import { seg15 } from "../rows15.js";
import { logo } from "../../core/logos.js";
import { level, E, S, ownerHere } from "../../core/state.js";
import { sections17, init17 } from "../p17-usage.js";
import { onPhone } from "../surface17.js";
import { updatedWords } from "../../shell/usage.js"; // the status bar's "Updated 3 min ago", the same on both lists
import { resetWords } from "../../core/usage-reset.js";
import { t, language, plural } from "../../../i18n.js";

let usage = null;
let range = "30";
/* The read in flight, if any: "Open the report" waits for it, so a report opened as the page arrives (or just after
   a new period was chosen) adds up the engine's numbers, never an empty or older stretch. */
let reading = null;

function loadUsage() {
  const read = (async () => {
    try { usage = await api(`usage?range=${range}d&by=day`); } catch (error) { usage = null; toast(error.message); }
    renderNow();
  })();
  reading = read;
  return read;
}

function reportCard() {
  const days = usage?.data ?? [];
  const cost = days.reduce((sum, d) => sum + (d.estimatedCost ?? 0), 0);
  const tasks = days.reduce((sum, d) => sum + (d.runs ?? 0), 0);
  const head = usage ? `<b>$${cost.toFixed(2)}</b><em>${t("window.settings.usage.tasks-tasks-estimated-from-each-models", { tasks })}</em>` : "";
  return `<div class="rep15"><div class="rep-h15"><span><small>${t("window.settings.usage.last-range-days", { range })}</small>${head}</span><span class="seg" role="group" aria-label="${t("window.settings.usage.period")}">${["7", "30", "90"].map((d) => `<button type="button" aria-pressed="${range === d}" data-act="rep15" data-v="${d}">${t("window.settings.usage.value-days", { value: d })}</button>`).join("")}</span></div><button class="btn sm" type="button" data-act="repopen15">${t("window.settings.usage.open-the-report")}</button></div>`;
}

/* ---------- the report ---------- */
/* The engine's day rows for the stretch, added up the way the prototype's report shows them. */
function figures() {
  const days = usage?.data ?? [];
  const add = (map, key, cost, runs) => { const x = map.get(key) ?? { cost: 0, runs: 0 }; x.cost += cost ?? 0; x.runs += runs ?? 0; map.set(key, x); };
  const models = new Map(), sources = new Map();
  const presetName = (id, model) => (E.state?.models?.presets ?? []).find((p) => p.id === id)?.name ?? model ?? id;
  /* "web" is this window; any other source is named as the engine names it (a chat app, a schedule). */
  const sourceName = (s) => (s === "web" ? t("more.window") : s);
  for (const d of days) {
    for (const m of d.presets ?? []) add(models, presetName(m.id, m.model), m.cost, m.runs);
    for (const c of d.byChannel ?? []) add(sources, sourceName(c.source), c.cost, c.runs);
  }
  const busiest = days.reduce((a, d) => (!a || (d.runs ?? 0) > (a.runs ?? 0) ? d : a), null);
  const cheapest = [...models].filter(([, x]) => x.runs > 0).sort((a, b) => a[1].cost / a[1].runs - b[1].cost / b[1].runs)[0];
  return { days, models, sources, busiest, cheapest,
    cost: days.reduce((n, d) => n + (d.estimatedCost ?? 0), 0), tasks: days.reduce((n, d) => n + (d.runs ?? 0), 0) };
}
const dollars = (v) => (v ? `$${v.toFixed(2)}` : t("window.settings.usage.free"));
function bars(title, rows, unit) {
  if (!rows.length) return "";
  const most = Math.max(...rows.map((r) => r[1]), 0);
  return `<div class="rp-g15"><h3>${esc(title)}</h3>${rows.map(([n, v]) => `<div class="rp-r15"><span>${esc(n)}</span><span class="rp-b15"><u data-css="width:${most ? Math.max(1.5, (v / most) * 100) : 1.5}%"></u></span><b>${esc(unit(v))}</b></div>`).join("")}</div>`;
}
function openReport() {
  const f = figures();
  const day = f.busiest?.runs ? new Date(`${f.busiest.date}T12:00:00`).toLocaleDateString(language(), { weekday: "long", month: "short", day: "numeric" }) : "";
  const tiles = [[t("window.settings.usage.spent"), `$${f.cost.toFixed(2)}`], [t("window.settings.usage.tasks"), String(f.tasks)],
    [t("window.settings.usage.cheapest-per-task"), f.cheapest ? `${f.cheapest[0]} · ${dollars(f.cheapest[1].cost / f.cheapest[1].runs)}` : ""], [t("window.settings.usage.busiest-day"), day]];
  const total = [...f.sources.values()].reduce((n, x) => n + x.runs, 0) || 1;
  openDlg({ title: t("window.settings.usage.usage-last-range-days", { range }), wide: true,
    body: `<div class="rp-top15">${tiles.map(([a, b]) => `<div><small>${esc(a)}</small><b>${esc(b)}</b></div>`).join("")}</div>
      ${bars(t("window.settings.usage.by-model"), [...f.models].map(([n, x]) => [n, x.cost]), dollars)}
      ${bars(t("window.settings.usage.by-where-it-came-from"), [...f.sources].map(([n, x]) => [n, x.runs / total]), (v) => `${Math.round(v * 100)}%`)}
      <p class="hint">${t("window.settings.usage.estimated-from-each-models-published")}</p>`,
    foot: `<button class="btn ghost" type="button" data-act="repcsv15" ${f.days.length ? "" : "disabled"}>${t("window.settings.usage.save-as-a-spreadsheet")}</button><button class="btn" type="button" data-act="dlg-close">${t("delight.ach.close")}</button>` });
}
/* The same day rows the dialog adds up, one line each, as a spreadsheet file. The desktop app keeps downloads blocked, so
   there the engine writes the sheet into the workspace's usage folder (POST /api/usage/metering/now { range }) and says
   where; a browser downloads it. Usage itself is always counted in Branch's own data; a sheet is written only here. */
async function saveCsv() {
  if (window.branchDesktop) {
    try { const { path } = await api("usage/metering/now", { range: `${range}d` }); toast(t("window.settings.usage.saved-sheet-at", { path })); }
    catch (error) { toast(error.message); }
    return;
  }
  const cell = (v) => `"${String(v ?? "").replaceAll('"', '""')}"`;
  const lines = [["date", "tasks", "tool calls", "input tokens", "output tokens", "estimated cost (USD)", "failures"].map(cell).join(",")]
    .concat((usage?.data ?? []).map((d) => [d.date, d.runs, d.toolCalls, d.tokens?.input, d.tokens?.output, (d.estimatedCost ?? 0).toFixed(4), d.failures].map(cell).join(",")));
  const url = URL.createObjectURL(new Blob([lines.join("\r\n")], { type: "text/csv" }));
  Object.assign(document.createElement("a"), { href: url, download: `usage-report-${range}d.csv` }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
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
  if (!ownerHere()) return; // Q262: as the card above, the owner's alone
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
  const missed = (run.tasks ?? []).filter((x) => !x.passed).map((x) => x.problem ?? x.id);
  const text = [said, missed.length ? t("window.settings.usage.missed-list", { list: missed.join("; ") }) : ""].filter(Boolean).join(" ");
  return statusBox(title, text, regressions.length > 0);
}

function evalCard() {
  /* Q262: the test suites and their runs are the owner's; a household person is not shown the card. */
  if (!ownerHere()) return "";
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
let identityTimer = null;
let loadingGlance = false;
const CHIP = () => ({ measured: `<span class="pill ok">${t("glance.measured")}</span>`, estimated: `<span class="pill warn">${t("glance.estimate")}</span>`, not_published: `<span class="pill idle">${t("glance.notPublished")}</span>` });

function windowRow(w, estimated) {
  const reset = `<small class="lim-reset">${esc(resetWords(w.resetAt))}</small>`;
  if (w.kind === "money" || !w.limit || w.remaining == null) return `<div class="lim-w"><span>${esc(w.title)}</span><span></span><span class="lim-share">${w.remaining == null ? "" : esc(String(w.remaining))}</span>${reset}</div>`;
  const pct = Math.max(0, Math.min(100, Math.round((w.remaining / w.limit) * 100)));
  return `<div class="lim-w"><span>${esc(w.title)}</span><span class="lim-bar ${estimated ? "est" : ""}"><i data-css="width:${pct}%;${pct < 15 ? "background:var(--warn)" : ""}"></i></span><span class="lim-share">${t("glance.left", { percent: pct })}</span>${reset}</div>`;
}

export function limitRow(r) {
  const said = [updatedWords(r), r.note].filter(Boolean).join(" ");
  const body = (r.windows ?? []).map((w) => windowRow(w, w.state === "estimated")).join("") + `<small>${esc(said)}</small>`;
  return `<div class="lim">${logo(r.connection, r.connectionName, 28)}<div><div class="lim-h"><b>${esc(r.connectionName)}</b><span class="muted">${esc(r.accountLabel ?? "")}</span>${CHIP()[r.state] ?? ""}${r.inUse ? `<span class="pill ok">${t("glance.usedNext")}</span>` : ""}</div>${body}</div></div>`;
}

async function loadGlance() {
  if (loadingGlance) return;
  loadingGlance = true;
  const [g, l] = await Promise.all(["usage/glance", "usage/limits/settings"].map((path) => api(path).catch((error) => { toast(error.message); return null; })));
  loadingGlance = false;
  glance = g; limits = l?.usageLimits ?? null;
  renderNow();
  clearTimeout(identityTimer);
  const visible = () => ownerHere() && !document.querySelector(".lockscreen") && S.view === "settings" && S.setPage === "usage";
  if (g?.identitiesPending && visible()) identityTimer = setTimeout(() => { if (visible()) loadGlance(); }, 1000);
}

/* The ring and the save-progress offer (POST /api/usage/glance/settings, merged) and asking a service what is left
   (POST /api/usage/limits/settings, a three-way switch: on unless "off", turned on as "when-needed"). The prototype's
   "Show me" only played its own demo, so it is not drawn. */
const WIRES = {
  "u-ring": [() => glance?.settings?.ring === "shown", (on) => api("usage/glance/settings", { ring: on ? "shown" : "hidden" })],
  "u-tray": [() => glance?.settings?.tray === "shown", (on) => api("usage/glance/settings", { tray: on ? "shown" : "hidden" })],
  "u-ckpt": [() => glance?.settings?.saveProgress === "ask", (on) => api("usage/glance/settings", { saveProgress: on ? "ask" : "off" })],
  "u-ask": [() => Boolean(limits?.mode) && limits.mode !== "off", (on) => api("usage/limits/settings", { mode: on ? "when-needed" : "off" })],
};
const checked = (id) => (WIRES[id][0]() ? "checked" : "");

function limitsSec() {
  const tray = onPhone() ? "" : `<div class="ctl"><b>${t("window.settings.usage.show-usage-in-the-tray")}</b><input class="sw" type="checkbox" id="u-tray" ${checked("u-tray")} aria-label="${t("window.settings.usage.show-usage-in-the-tray")}" data-sw="set"><small>${t("window.settings.usage.tray-ring")}</small></div>`;
  return `<div class="sec"><h2>${t("glance.title")}</h2><p class="hint" data-css="margin:0 0 6px">${t("window.settings.usage.how-much-of-each-services-allowance")}</p><div class="lims flat">${(glance?.rows ?? []).map(limitRow).join("")}</div>
    <div class="ctl"><b>${t("window.settings.usage.the-ring-bottom-right")}</b><input class="sw" type="checkbox" id="u-ring" ${checked("u-ring")} aria-label="${t("window.settings.usage.show-the-ring")}" data-sw="ring"><small>${t("window.settings.usage.the-connection-used-next-how-much")}</small></div>
    <div class="ctl"><b>${t("window.settings.usage.offer-to-save-progress-at-95")}</b><input class="sw" type="checkbox" id="u-ckpt" ${checked("u-ckpt")} aria-label="${t("window.settings.usage.offer-to-save-progress-at-95")}" data-sw="ckpt"><small>${t("window.settings.usage.it-only-asks-once-per-connection")}</small></div>
    <div class="ctl"><b>${t("settings-kit.name.usage-limits")}</b><input class="sw" type="checkbox" id="u-ask" ${checked("u-ask")} aria-label="${t("settings-kit.name.usage-limits")}" data-sw="set"><small>${t("window.settings.usage.only-openrouter-documents-a-way-to")}</small></div>
    ${tray}</div>`;
}

/* models-ui (MODEL-052): who spent what over the last 7 days (GET /api/usage/by-trunk): the owner's own tasks and each
   Trunk's, a bar by tasks, the cost where a price is on file (a plan sign-in has none, and says so), and the
   accounts each answered through. The month's total is the engine's too. */
let byTrunk = null;
async function loadByTrunk() {
  if (E.profiles?.isOwner === false) { byTrunk = null; return; } // the owner's alone
  byTrunk = await api("usage/by-trunk?days=7").catch(() => null);
  renderNow();
}
function spendRow(r, most) {
  const name = r.trunk ? r.trunk.name : t("window.settings.usage.by-you");
  const cost = r.cost === null ? t("window.settings.usage.by-plan") : `$${r.cost.toFixed(2)}${r.unpricedTasks ? ` ${t("window.settings.usage.by-plus-plan", { count: r.unpricedTasks })}` : ""}`;
  const accounts = r.accounts.map((a) => `${a.label} (${a.calls})`).join(", ");
  return `<div class="brow spend-row"><span><b>${esc(name)}</b></span><span class="track"><u data-css="width:${Math.max(3, Math.round((r.tasks / most) * 100))}%"></u></span><span class="v">${esc(cost)}</span><small class="spend-sub">${esc(t("window.settings.usage.by-tasks", { count: r.tasks, tokens: r.tokens.toLocaleString() }))}${accounts ? ` · ${esc(accounts)}` : ""}</small></div>`;
}
function spendSec() {
  const month = glance?.month?.pricedRuns ? `<p class="hint">${t("window.settings.usage.this-month-value-plans-are-billed", { value: Number(glance.month.cost).toFixed(2) })}</p>` : "";
  const rows = byTrunk?.rows ?? [], most = Math.max(1, ...rows.map((r) => r.tasks));
  const bars = rows.length ? rows.map((r) => spendRow(r, most)).join("") : byTrunk ? `<p class="hint">${t("window.settings.usage.by-none")}</p>` : "";
  return `<div class="sec"><h2>${t("window.settings.usage.spend-last-7-days")}</h2><div class="bars spend-bars">${bars}</div>${month}</div>`;
}

/* ---------- keeping things ---------- */
let retention = null;
let snapshots = [];
function keeping() {
  const r = retention;
  const cur = !r ? null : !r.enabled || !r.keepDays ? "forever" : r.keepDays === 30 ? "30" : r.keepDays === 365 ? "365" : null;
  return `<div class="sec"><h2>${t("window.settings.usage.keeping-things")}</h2>${seg15(t("window.settings.usage.keep-conversations"), t("window.settings.usage.older-ones-are-deleted-for-good"), [["30", t("window.settings.usage.30-days")], ["365", t("window.settings.usage.1-year")], ["forever", t("window.settings.usage.forever")]], cur, "keep15", "f15-keep-conversations")}<div class="ctl"><b>${t("window.settings.usage.checkpoints")}</b><span class="right"><button class="btn sm" type="button" data-act="ckpts15">${t("window.settings.usage.see-all")}</button></span><small>${t("window.settings.usage.kept-before-a-trunk-changes-files")}</small></div></div>`;
}
async function loadRetention() {
  try { retention = (await api("retention")).settings ?? null; } catch (error) { toast(error.message); }
  renderNow();
}
/* Keeping conversations longer is refused by the engine until the owner says yes: its words are shown in a confirm, and
   only "Yes, make it less careful" sends the same choice again with confirmLoosening. Lockdown refuses in its own words. */
let keepAsked = null;
async function keep(v, confirmLoosening = false) {
  if (!retention) return;
  const next = v === "forever" ? { ...retention, enabled: false, keepDays: 0 } : { ...retention, enabled: true, keepDays: Number(v) };
  try { retention = (await api("retention", { ...next, ...(confirmLoosening ? { confirmLoosening } : {}) })).settings ?? retention; } catch (error) {
    if (!confirmLoosening && error.status === 409 && /less careful/.test(error.message)) {
      keepAsked = v;
      openDlg({ title: t("settings-kit.loosens"), body: `<p>${esc(error.message)}</p>`,
        foot: `<button class="btn ghost" type="button" data-act="dlg-close">${t("mode.cancel")}</button><button class="btn pri" type="button" data-act="keeploosen15">${t("settings-kit.confirm")}</button>` });
    } else toast(error.message);
  }
  renderNow();
}
function ckptDlg() {
  const when = (at) => new Date(at).toLocaleString(language(), { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const rows = snapshots.map((x) => `<div class="prow"><span class="grow"><b>${esc(x.label)}</b><small>${esc(when(x.createdAt))} · ${esc(plural(x.files, { one: "window.settings.usage.files-count.one", other: "window.settings.usage.files-count" }))}</small></span><button class="btn ghost sm" type="button" data-act="ckptback15" data-id="${esc(x.id)}">${t("window.settings.usage.put-back")}</button></div>`).join("");
  openDlg({ title: t("window.settings.usage.checkpoints"), body: `<div class="rows demo-b17">${rows || `<p class="empty">${esc(t("inspector.nothing"))}</p>`}</div>`, foot: `<button class="btn" type="button" data-act="dlg-close">${t("delight.ach.close")}</button>` });
}
async function openCkpts() {
  try { snapshots = (await api("history/snapshots")).snapshots ?? []; } catch (error) { toast(error.message); return; }
  ckptDlg();
}
async function putBack(el) {
  try { await api(`history/snapshots/${encodeURIComponent(el.dataset.id)}/restore`, {}); toast(t("window.settings.usage.rolled-back")); } catch (error) { toast(error.message); }
  await openCkpts();
}

/* ---------- Flagged replies (the owner's) ---------- */
let flags = null;
const REASONS = ["wrong", "ignored", "unasked", "unsafe", "unclear", "other"];
async function loadFlags() {
  if (E.profiles?.isOwner === false) { flags = null; return; }
  try { flags = (await api("reply-flags")).flags ?? []; } catch (error) { flags = null; toast(error.message); }
  renderNow();
}
function flagsSec() {
  if (!flags) return "";
  const chat = (id) => { const s = E.sessions.find((x) => (x.sessionId ?? x.id) === id); return s?.title ?? s?.opening ?? ""; };
  const when = (at) => new Date(at).toLocaleDateString(language(), { month: "short", day: "numeric" });
  const why = (f) => f.reasons.map((r) => (REASONS.includes(r) ? t(`window.chat.flag.reason.${r}`) : r)).join(", ");
  const rows = flags.map((f) => `<div class="prow">${ic("flag", "s")}<span class="grow"><b>${esc(why(f))}</b><small>${esc([chat(f.sessionId), when(f.at), t("window.settings.usage.kept-here")].filter(Boolean).join(" · "))}</small></span><button class="btn ghost sm" type="button" data-act="flforget17c" data-v="${esc(f.id)}">${t("accounts.action.remove")}</button></div>`).join("");
  return `<div class="sec x15-sec"><h2>${t("window.settings.usage.flagged-replies")}</h2><div class="ctl"><b>${t("window.chat.flag.send")}</b><input class="sw" type="checkbox" id="fl-send-set17c" aria-label="${esc(t("window.chat.flag.send"))}" data-sw="set"><small>${t("window.settings.usage.off-until-you-turn-it-on")}</small></div>${flags.length ? `<p class="hint" data-css="margin:6px 0">${t("window.settings.usage.flagged-count-kept", { count: flags.length })}</p><div class="rows">${rows}</div>` : ""}</div>`;
}
async function forgetFlag(el) {
  try { toast((await api(`reply-flags/${encodeURIComponent(el.dataset.v)}/remove`, {})).said); } catch (error) { toast(error.message); }
  await loadFlags();
}

export function draw() {
  return `<h1>${esc(t("settings.page.data"))}</h1><p class="lede">${t("window.settings.usage.what-each-connection-has-left-what")}</p>` + reportCard() + limitsSec() + spendSec() + keeping() + evalCard() + flagsSec() + sections17(level());
}

export function init() {
  init17();
  loadUsage();
  loadSuites();
  loadGlance();
  loadByTrunk();
  loadRetention();
  loadFlags();
  markLive(["sw:u-ring", "sw:u-tray", "sw:u-ckpt", "sw:u-ask"]);
  document.addEventListener("change", async (e) => {
    const wire = WIRES[e.target.id];
    if (!wire) return;
    try { await wire[1](e.target.checked); } catch (error) { toast(error.message); }
    await loadGlance();
  });
  on("rep15", (el) => { range = el.dataset.v; loadUsage(); });
  on("repopen15", async () => { await reading; openReport(); });
  on("repcsv15", () => saveCsv());
  on("keep15", (el) => keep(el.dataset.v));
  on("keeploosen15", () => { const v = keepAsked; keepAsked = null; closeDlg(); if (v) keep(v, true); });
  on("ckpts15", () => openCkpts());
  on("ckptback15", (el) => { closeDlg(); putBack(el); });
  on("flforget17c", (el) => forgetFlag(el));
  on("eval-set", (el) => { if (running) return; suiteId = el.dataset.v; lastRun = null; loadLastRun(); });
  on("eval-run", () => runTest());
  markLive(["rep15", "repopen15", "eval-set", "eval-run"]);
}

export function load() { loadSuites(); loadGlance(); loadByTrunk(); loadRetention(); loadFlags(); return loadUsage(); }

export const live = { "rep15": true, "repopen15": true, "eval-set": true, "eval-run": true, "repcsv15": true, "keep15": true, "keeploosen15": true, "ckpts15": true, "ckptback15": true, "flforget17c": true };
