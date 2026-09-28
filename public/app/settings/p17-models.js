/* Settings › Models, pass 17 (prototype patch17b), from the engine:
   Compare models (Test suites › See history): the suites are GET /api/evaluation/suites; the table is the newest run
   of the chosen suite for each model choice, from GET /api/evaluation/history?suite=<id>; Run again is
   POST /api/evaluation/compare { suite, presets } over the connections set up, mixtures left out (GET
   /api/model-savings connections; it needs two, runs read-only and spends on each).
   Side by side: each task of the suite, with each model's own answer beside the others and whether it passed. Every
   task of a comparison is a task of its own (GET /api/evaluation/history runs[].tasks[].runId), so its answer is that
   task's own record (GET /api/runs/<id>, the last answer in its conversation), read only when Side by side is opened.
   What it saved: the current conversation's rounds (GET /api/model-savings/rounds?session=<id>), shown as the share of
   what was sent that the service's cache served. The engine keeps no before-and-after figures, so none are drawn.
   Mixing models needs a mixture chosen first (GET /api/model-savings), which the design has no way to pick: greyed.
   Model arena: two of the owner's connections answer one question without their names (POST /api/reach/arena/start
   { prompt }), the owner picks (POST /api/reach/arena/vote { id, winner }), and only then are the names and the
   standings shown (the vote's answer; GET /api/reach/arena before a round). The question box is the engine's own card's
   ("Question", "Ask two models"), since the design shows a question but not where it comes from. The arena's switch
   ships off (it spends on two connections at once) and is not turned on here: while it is off, or with fewer than two
   connections, the engine refuses in its own words, which are shown. */
import { esc, render } from "../core/dom.js";
import { S } from "../core/state.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { toast, openDlg, dialog, ic, $ } from "../core/ui.js";
import { seg15 } from "./rows15.js";
import { demos17, demo17, row17, sec17 } from "./rows17.js";
import { t, language } from "../../i18n.js";

const C = { suites: [], suite: null, runs: [], savings: null, rounds: null };

export function sections17(lv, tab) {
  if (lv < 1) return "";
  let html = sec17(t("window.settings.p17-models.mixtures-and-savings"),
    row17(t("window.settings.p17-models.see-what-it-saved"), t("window.settings.p17-models.round-by-round-figures-for-fewer"), t("window.settings.p17-models.see-the-savings"), "savingsb17")
    + demos17(["localroute", "jev"]));
  if (tab === "second") html += sec17(t("window.settings.p17-models.second-opinion-more"), demo17("debate"));
  if (lv >= 2 && tab === "connections") html += sec17(t("window.settings.p17-models.connections-technical"), demos17(["provplug", "retired"]));
  if (lv >= 2 && tab === "media") html += sec17(t("window.settings.p17-models.media-technical"), demo17("mediapaths"));
  return html;
}

/* ---------- compare models ---------- */
/* The connections set up, without mixtures (GET /api/model-savings leaves those out). */
const presets = () => C.savings?.connections ?? [];
const nameOf = (id) => presets().find((p) => p.id === id)?.name ?? id;
const time = (ms) => { const s = Math.round((ms ?? 0) / 1000); return s < 60 ? `${s} s` : `${Math.floor(s / 60)} m ${String(s % 60).padStart(2, "0")} s`; };
function newestPerModel() {
  const seen = new Set();
  return C.runs.filter((run) => !seen.has(run.preset) && seen.add(run.preset));
}
function cmpDlg() {
  const rows = newestPerModel();
  const seg = `<div class="seg" role="group" aria-label="${t("window.settings.p17-models.test-suite")}">${C.suites.map((s) => `<button type="button" data-act="cmpsuiteb17" data-v="${esc(s.id)}" aria-pressed="${C.suite === s.id}">${esc(s.name)} · ${esc(s.tasks?.length ?? 0)}</button>`).join("")}</div>`;
  const table = `<table class="tbl-b17"><thead><tr><th>${t("coding.ci.model")}</th><th>${t("window.settings.p17-models.right")}</th><th>${t("window.settings.p17-models.cost")}</th><th>${t("comfort.status.item.time")}</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${esc(nameOf(r.preset))}</td><td>${t("delight.ach.progress", { now: esc(r.summary.passed), goal: esc(r.summary.total) })}</td><td>${r.summary.dollars == null ? "" : `$${esc(r.summary.dollars.toFixed(2))}`}</td><td>${esc(time(r.summary.latencyMs?.mean))}</td></tr>`).join("")}</tbody></table>`;
  const last = C.runs[0] ? `<p class="hint" data-css="margin:0">${t("window.settings.p17-models.last-run-value-each-task-checked", { value: esc(new Date(C.runs[0].startedAt).toLocaleDateString(language(), { month: "short", day: "numeric" })) })}</p>` : "";
  openDlg({ title: t("window.settings.p17-models.compare-models"), wide: true, body: seg + table + last,
    foot: `<button class="btn ghost" type="button" data-act="cmpsideb17">${t("window.settings.p17-models.side-by-side")}</button><button class="btn pri" type="button" data-act="cmprunb17" ${presets().length >= 2 && C.suite ? "" : "disabled"}>${t("window.places.library17.run-again")}</button>` });
}
/* ---------- side by side ---------- */
async function openSide() {
  const rows = newestPerModel();
  if (!rows.length) { toast(t("window.settings.p17-models.side-none")); return; }
  const ids = [...new Set(rows.flatMap((r) => r.tasks.map((task) => task.runId)).filter(Boolean))]; // a skipped task ran nothing
  let answers;
  // The model's own words are the task's last answer in its conversation; a task whose answer failed its check keeps the
  // check's sentence as its output, so the output is only the fallback.
  const said = (rec) => [...(rec.messages ?? [])].reverse().find((m) => m.role === "assistant" && String(m.content ?? "").trim())?.content ?? rec.run?.output ?? "";
  try { answers = new Map(await Promise.all(ids.map(async (id) => [id, said(await api(`runs/${encodeURIComponent(id)}`))]))); }
  catch (error) { toast(error.message); return; }
  const taskIds = [...new Set(rows.flatMap((r) => r.tasks.map((task) => task.id)))];
  const cell = (r, id) => {
    const task = r.tasks.find((x) => x.id === id);
    if (!task) return `<td class="muted">—</td>`;
    const mark = task.passed ? `<span class="pill ok">${t("window.settings.p17-models.side-passed")}</span>` : `<span class="pill warn">${t("window.settings.p17-models.side-failed")}</span>`;
    const said = task.runId ? `<pre class="side-ans-b17">${esc(String(answers.get(task.runId) ?? "").slice(0, 2000))}</pre>` : "";
    return `<td>${mark}${said}${task.problem ? `<small>${esc(task.problem)}</small>` : ""}</td>`;
  };
  const head = `<tr><th>${t("window.settings.p17-models.side-task")}</th>${rows.map((r) => `<th>${esc(nameOf(r.preset))}</th>`).join("")}</tr>`;
  const body = taskIds.map((id) => `<tr><th>${esc(id)}</th>${rows.map((r) => cell(r, id)).join("")}</tr>`).join("");
  openDlg({ title: t("window.settings.p17-models.side-by-side"), wide: true, body: `<table class="tbl-b17 side-b17"><thead>${head}</thead><tbody>${body}</tbody></table>`,
    foot: `<button class="btn ghost" type="button" data-act="cmpback17">${t("window.settings.p17-models.compare-models")}</button><button class="btn" type="button" data-act="dlg-close">${t("delight.ach.close")}</button>` });
}
async function readRuns() {
  C.runs = C.suite ? (await api(`evaluation/history?suite=${encodeURIComponent(C.suite)}`)).runs ?? [] : [];
}
async function openCompare() {
  try {
    C.savings = await api("model-savings");
    C.suites = (await api("evaluation/suites")).suites ?? [];
    if (!C.suites.some((s) => s.id === C.suite)) C.suite = C.suites[0]?.id ?? null;
    await readRuns();
  } catch (error) { toast(error.message); return; }
  cmpDlg();
}
async function pickSuite(el) {
  C.suite = el.dataset.v;
  try { await readRuns(); } catch (error) { toast(error.message); }
  cmpDlg();
}
async function runCompare(el) {
  el.disabled = true;
  try {
    await api("evaluation/compare", { suite: C.suite, presets: presets().slice(0, 4).map((p) => p.id) });
    await readRuns();
  } catch (error) { toast(error.message); }
  if (dialog()) cmpDlg();
}

/* ---------- what it saved ---------- */
function cachedShare() {
  const rounds = C.rounds?.rounds ?? [];
  const sent = rounds.reduce((n, r) => n + (r.input ?? 0), 0);
  const cached = rounds.reduce((n, r) => n + (r.cached ?? 0), 0);
  return sent > 0 && rounds.some((r) => r.cached != null) ? Math.round((cached / sent) * 100) : null;
}
function savingsDlg() {
  const share = cachedShare();
  const tiles = share == null ? "" : `<div class="scope15 s3-b17"><div><small>${t("savings.chart.cached")}</small><b>${esc(share)}%</b></div></div>`;
  const mixing = (C.savings?.liveMixtures?.length ?? 0) > 0 ? "on" : C.savings ? "off" : null;
  openDlg({ title: t("window.settings.p17-models.what-it-saved"), wide: true, body: tiles + seg15(t("window.settings.p17-models.mix-models-on-hard-questions"), t("window.settings.p17-models.asks-two-models-and-merges-the"), [["off", t("accounts.switch.off")], ["on", t("accounts.switch.on")]], mixing, "mixb17", "f15-mix-models-on-hard-questions"),
    foot: `<button class="btn" type="button" data-act="dlg-close">${t("delight.ach.close")}</button>` });
}
async function openSavings() {
  try {
    const [savings, rounds] = await Promise.all([api("model-savings"), S.chat ? api(`model-savings/rounds?session=${encodeURIComponent(S.chat)}`) : null]);
    Object.assign(C, { savings, rounds });
  } catch (error) { toast(error.message); return; }
  savingsDlg();
}

/* ---------- model arena ---------- */
const A = { round: null, question: "", vote: null, names: null, board: [] };
const arenaTitle = () => t("reach.arena.title");
const arenaHint = () => `<p class="hint" data-css="margin:0">${t("window.settings.p17-models.same-question-two-models")}</p>`;
function askDlg() {
  openDlg({ title: arenaTitle(), wide: true,
    body: `<label class="fld"><span>${t("reach.arena.prompt")}</span><textarea class="inp" id="arena-q17" rows="3">${esc(A.question)}</textarea></label>${arenaHint()}`,
    foot: `<button class="btn ghost" type="button" data-act="dlg-close">${t("mode.cancel")}</button><button class="btn pri" type="button" data-act="arenaaskb17">${t("reach.arena.ask")}</button>` });
}
async function openArena() {
  try { A.board = (await api("reach/arena")).leaderboard ?? []; } catch (error) { toast(error.message); return; }
  Object.assign(A, { round: null, vote: null, names: null });
  askDlg();
}
function roundDlg() {
  const v = A.vote, answer = (k) => `<div class="ans-b17 ${v === k ? "won-b17" : ""}"><small>${esc(t("window.settings.p17-models.answer-k", { k: k.toUpperCase() }))}${A.names ? ` · ${esc(A.names[k])}` : ""}</small><p>${esc(A.round.answers[k])}</p></div>`;
  const votes = Math.round(A.board.reduce((n, m) => n + (m.games ?? 0), 0) / 2);
  const after = `<div class="elo-b17">${A.board.map((m) => `<span>${esc(m.name)} <b>${esc(m.rating)}</b></span>`).join("")}</div><p class="hint" data-css="margin:0">${t("window.settings.p17-models.from-n-of-your-votes", { n: votes })}</p>`;
  openDlg({ title: arenaTitle(), wide: true,
    body: `<p class="lead-b17">${esc(A.question)}</p><div class="duo-b17">${answer("a")}${answer("b")}</div>${A.names ? after : arenaHint()}`,
    foot: A.names ? `<button class="btn" type="button" data-act="dlg-close">${t("window.settings.self.done")}</button><button class="btn pri" type="button" data-act="arenanextb17">${t("window.settings.p17-models.next-pair")}</button>`
      : ["a", "b"].map((k) => `<button class="btn" type="button" data-act="arenavoteb17" data-v="${k}">${t(`window.settings.p17-models.k-is-better`, { k: k.toUpperCase() })}</button>`).join("")
        + `<button class="btn ghost" type="button" data-act="arenavoteb17" data-v="tie">${t("window.settings.p17-models.about-the-same")}</button>` });
}
async function askArena() {
  const q = ($("#arena-q17")?.value ?? "").trim();
  if (!q) return;
  A.question = q;
  const box = openDlg({ title: arenaTitle(), wide: true, body: `<p class="lead-b17">${esc(q)}</p><p class="hint ic-t">${ic("spin", "s spin")}</p>` });
  try { A.round = await api("reach/arena/start", { prompt: q }); } catch (error) { if (dialog() === box) askDlg(); toast(error.message); return; }
  if (dialog() !== box) return;
  A.vote = null; A.names = null;
  roundDlg();
}
async function voteArena(el) {
  if (!A.round || A.names) return;
  try {
    const said = await api("reach/arena/vote", { id: A.round.id, winner: el.dataset.v });
    Object.assign(A, { vote: el.dataset.v, names: { a: said.a, b: said.b }, board: said.leaderboard ?? A.board });
  } catch (error) { toast(error.message); return; }
  roundDlg();
}

let started = false;
export function init17() {
  if (started) return;
  started = true;
  on("compareb17", () => openCompare());
  on("cmpsuiteb17", (el) => pickSuite(el));
  on("cmpsideb17", () => openSide());
  on("cmpback17", () => cmpDlg());
  on("cmprunb17", (el) => runCompare(el));
  on("savingsb17", () => openSavings());
  on("arenab17", () => openArena());
  on("arenaaskb17", () => askArena());
  on("arenavoteb17", (el) => voteArena(el));
  on("arenanextb17", () => { Object.assign(A, { round: null, vote: null, names: null, question: "" }); askDlg(); });
  markLive(["compareb17", "cmpsuiteb17", "cmprunb17", "cmpsideb17", "cmpback17", "savingsb17", "arenab17", "arenaaskb17", "arenavoteb17", "arenanextb17", "sw:arena-q17"]);
  render();
}
