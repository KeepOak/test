/* Pass 17 part D §4: decision models in Settings › Models, 1:1 with the prototype's patch17d.js. Everything is the engine's
   (src/decision-models.ts): the connections it can use and the one chosen (GET /api/decisions, POST /api/decisions/settings),
   the last 24 hours in numbers, and each decision, asked of that model and checked against what was offered
   (POST /api/decisions/decide). The answer, how sure it was, the time and the model are the engine's; $0.00 is said only
   for a model on this computer. The question and the list start empty: the prototype's are example data.
   The three "used for" switches stay greyed: the engine does not yet route messages, sort the Inbox or filter lists with it.
   Every word goes through t() (public/locales); a switch keeps its English title (its id) and shows through say(). */

import { esc, render, $ } from "../core/dom.js";
import { E } from "../core/state.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { ic, toast } from "../core/ui.js";
import { sw15 } from "./rows15.js";
import { t } from "../../i18n.js";

const KINDS = () => [["yes", t("dashboard.needs.yes")], ["pick", t("savings.option.pick")], ["score", t("window.p17d.score")], ["filter", t("window.p17d.filter")]];
const D = { data: null, kind: "pick", q: "", o: "", out: "", busy: false };

async function loadDecisions() {
  if (E.profiles?.isOwner === false) return; // the owner's alone: the engine refuses anyone else
  D.data = await api("decisions").catch((error) => { toast(error.message); return null; });
  render();
}
const chosen = () => D.data?.models.find((m) => m.id === (D.data.settings.model || D.data.taskModel)) ?? null;

function modelRow() {
  const s = D.data.settings, local = chosen()?.local;
  const opts = [...D.data.models.map((m) => [m.id, m.local ? t("window.p17d.model-here", { name: m.name }) : m.name]), ["", t("window.p17d.same-as-task")]];
  return `<div class="ctl"><b>${esc(t("window.p17d.model-for-decisions"))}</b><span class="right"><span class="seg" role="group" aria-label="${esc(t("window.p17d.model-for-decisions"))}">${opts.map(([v, l]) => `<button type="button" aria-pressed="${s.model === v}" data-act="dmmodel17d" data-v="${esc(v)}">${esc(l)}</button>`).join("")}</span></span><small>${local ? esc(t("window.p17d.free-here")) : ""}</small></div>`;
}
function lastDay() {
  const d = D.data.lastDay;
  return t("window.p17d.last-day", { count: d.decisions }) + (d.averageMs === null ? "" : t("window.p17d.average-ms", { ms: d.averageMs })) + (chosen()?.local ? " · $0.00" : "");
}
function tryIt() {
  const listField = D.kind === "filter" ? `<label class="fld"><span>${esc(t("window.p17d.list-per-line"))}</span><textarea class="inp" id="dm-o17d" rows="5">${esc(D.o)}</textarea></label>`
    : D.kind === "pick" ? `<label class="fld"><span>${esc(t("window.p17d.choices-commas"))}</span><input class="inp" id="dm-o17d" value="${esc(D.o)}"></label>` : "";
  return `<div class="dm-try17d"><div class="dm-h17d"><b>${esc(t("prompts.action.try"))}</b><span class="seg" role="group" aria-label="${esc(t("window.p17d.kind-of-decision"))}">${KINDS().map(([v, l]) => `<button type="button" data-act="dmkind17d" data-v="${v}" aria-pressed="${D.kind === v}">${esc(l)}</button>`).join("")}</span></div>
    <label class="fld"><span>${esc(t("asks.answer.question"))}</span><textarea class="inp" id="dm-q17d" rows="2">${esc(D.q)}</textarea></label>${listField}
    <div class="acts"><button class="btn pri sm" type="button" data-act="dmrun17d" ${D.busy ? "disabled" : ""}>${esc(t("window.p17d.decide"))}</button><span class="hint" data-css="margin:0">${esc(lastDay())}</span></div>
    <div class="dm-out17d" id="dm-out17d" aria-live="polite">${D.out}</div></div>`;
}

/** Settings › Models: "Decision models" at Advanced, its technical group at Technical. */
export function decisions17d(lv) {
  if (lv < 1) return "";
  if (!D.data) return "";
  const s = D.data.settings;
  const main = `<div class="sec x15-sec dm17d"><h2>${esc(t("window.p17d.decision-models"))}</h2><p class="hint">${esc(t("window.p17d.decision-models-hint"))}</p>
    ${modelRow()}${sw15("Send each message to the right Trunk", "When you don’t say who, it picks from their jobs.")}${sw15("Sort the Inbox by urgency", "Deadlines and money first.")}${sw15("Filter long lists before a Trunk reads them", "Mail, files and search results it clearly doesn’t need are dropped.")}
    ${tryIt()}</div>`;
  if (lv < 2) return main;
  const num = (id, title, sub, value, unit) => `<div class="ctl"><b>${esc(title)}</b><span class="right num15"><input class="inp" id="${id}" value="${esc(value)}" aria-label="${esc(title)}" inputmode="decimal">${unit ? `<small>${esc(unit)}</small>` : ""}</span><small>${esc(sub)}</small></div>`;
  return main + `<div class="sec x15-sec"><h2>${esc(t("window.p17d.decision-technical"))}</h2>${num("dm-sure17d", t("window.p17d.less-sure"), t("window.p17d.less-sure-hint"), s.minConfidence, t("window.p17d.sure-unit"))}${num("dm-max17d", t("window.p17d.longest-list"), t("window.p17d.longest-list-hint"), s.maxList, t("window.p17d.lines-unit"))}</div>`;
}

/* The answer as the engine gave it. */
function answerHtml(r) {
  const meta = `<span class="dm-m17d">${esc(t("window.p17d.percent-sure", { percent: Math.round(r.confidence * 100) }))} · ${esc(t("window.p17d.ms", { ms: r.ms }))} · ${esc(r.model.name)}${r.model.local ? ` ${esc(t("window.p17d.on-this-computer"))} · $0.00` : ""}</span>`;
  if (r.kind === "filter") {
    const all = [...r.kept.map((l) => [l, true]), ...r.dropped.map((l) => [l, false])];
    return `<div class="dm-r17d"><b>${esc(t("window.p17d.kept-of", { kept: r.kept.length, count: all.length }))}</b><ul class="dm-f17d">${all.map(([l, k]) => `<li class="${k ? "k" : "d"}">${ic(k ? "check" : "x", "s")}${esc(l)}</li>`).join("")}</ul>${meta}</div>`;
  }
  const head = r.kind === "yes" ? t(r.verdict === "yes" ? "suggest.yes" : "live.no") : r.kind === "score" ? t("window.p17d.score-of-ten", { score: r.score }) : r.choice;
  return `<div class="dm-r17d"><b>${esc(head)}</b>${r.why ? `<small>${esc(r.why)}</small>` : ""}${meta}</div>`;
}

function body() {
  const question = D.q.trim(), o = D.o;
  if (D.kind === "pick") return { kind: "pick", question, options: o.split(",").map((s) => s.trim()).filter(Boolean) };
  if (D.kind === "filter") return { kind: "filter", question, items: o.split("\n").map((s) => s.trim()).filter(Boolean) };
  return { kind: D.kind, question };
}
async function decide() {
  D.q = $("#dm-q17d")?.value ?? D.q;
  D.o = $("#dm-o17d")?.value ?? D.o;
  D.busy = true;
  D.out = `<span class="hint ic-t">${ic("spin", "s spin")}${esc(t("window.p17d.deciding"))}</span>`;
  render();
  try {
    D.out = answerHtml(await api("decisions/decide", body()));
    await loadDecisions();
  } catch (error) { D.out = ""; toast(error.message); }
  D.busy = false;
  render();
}
async function saveSettings(change) {
  try { await api("decisions/settings", change); } catch (error) { toast(error.message); }
  await loadDecisions();
}

export function initDecisions17d() {
  markLive(["dmmodel17d", "dmkind17d", "dmrun17d", "sw:dm-q17d", "sw:dm-o17d", "sw:dm-sure17d", "sw:dm-max17d"]);
  on("dmkind17d", (el) => { D.q = $("#dm-q17d")?.value ?? D.q; D.kind = el.dataset.v; D.o = ""; D.out = ""; render(); });
  on("dmrun17d", () => decide());
  on("dmmodel17d", (el) => saveSettings({ model: el.dataset.v }));
  document.addEventListener("input", (e) => {
    if (e.target.id === "dm-q17d") D.q = e.target.value;
    else if (e.target.id === "dm-o17d") D.o = e.target.value;
  });
  document.addEventListener("change", (e) => {
    const n = Number(e.target.value);
    if (e.target.id === "dm-sure17d") saveSettings({ minConfidence: n });
    else if (e.target.id === "dm-max17d") saveSettings({ maxList: n });
  });
  loadDecisions();
}
export const loadDecisions17d = loadDecisions;
