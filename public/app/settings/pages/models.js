import { fieldHelp } from "../field-help.js";
import { controlRow } from "../row-kit.js";
/* Settings › Models, 1:1 with the prototype's five tabs, each drawn from the engine:
   Connections: what runs on this computer (GET /api/state models, Q070), then every connection that can have several
   accounts, with its accounts (GET /api/accounts, flows/account.js);
   Defaults: the engine's model presets (GET /api/state models); On this computer: the shared local-model picker
   (flows/localpick.js): what Ollama and LM Studio have, the engine's pick for this hardware, its three sizes, and one
   click that installs, downloads with progress, connects and selects. */
import { esc, renderNow } from "../../core/dom.js";
import { gsel } from "../../core/gsel.js";
import { level, E, ownerHere, refresh, activeId } from "../../core/state.js";
import { api, token } from "../../core/api.js";
import { on } from "../../core/actions.js";
import { markLive } from "../../core/features.js";
import { ic, toast } from "../../core/ui.js";
import { logo } from "../../core/logos.js";
import { ctl } from "../parts.js";
import { A, loadAccounts, ownerOnly, accountDetail } from "../../flows/account.js";
import { localPicker, freshPick, initLocalPick } from "../../flows/localpick.js";
import { sections17, init17 } from "../p17-models.js";
import { t } from "../../../i18n.js";
import { say } from "../../core/words.js";
import { decisions17d, initDecisions17d, loadDecisions17d } from "../decisions17d.js"; // pass 17 part D §4

const TABS = [["connections", "Connections"], ["defaults", "Defaults"], ["local", "On this computer"], ["second", "Second opinion"], ["media", "Media"]];
let tab = "connections";

/* QA 2026-09-28: the model Codex answers with (GET/POST /api/codex-models, src/codex-models.ts), named on every call so
   the owner's own Codex settings never decide it. The list is the models Codex takes with this sign-in, most capable
   first; "The best it takes" follows it as it changes. Check asks Codex now, one tiny request per model it takes;
   a new Codex version is checked by itself. Saved at once. */
let codex = null;
async function loadCodex() {
  if (!ownerHere()) { codex = null; renderNow(); return; }
  try { codex = await api("codex-models"); } catch { codex = null; }
  renderNow();
}
function codexRow() {
  if (!codex) return "";
  const title = t("window.settings.models.codex-model"), cur = codex.chosen ?? "";
  const options = [["", t("window.settings.models.codex-best", { model: codex.offered[0] ?? codex.inUse })], ...codex.offered.map((m) => [m, m])];
  const checked = codex.checkedAt ? t("window.settings.models.codex-checked", { when: new Date(codex.checkedAt).toLocaleString(), version: codex.version ?? "" }) : t("window.settings.models.codex-unchecked");
  const select = ownerHere() ? gsel({ id: "m-codex", label: title, options, value: cur }) : "";
  return `${controlRow(`<b>${esc(title)}</b><span class="right">${select}<button class="btn sm ghost" type="button" data-act="m-codex-check" ${ownerOnly()}>${t("window.settings.models.codex-check")}</button></span><small>${esc(checked)}</small>`, { className: "ctl codex-model" })}`;
}
async function setCodexModel(el) {
  try { codex = await api("codex-models", { chosen: el.value || null }); } catch (error) { toast(error.message); }
  renderNow();
}
async function checkCodex(el) {
  el.disabled = true;
  try { codex = await api("codex-models/check", {}); if (codex.note) toast(codex.note); } catch (error) { toast(error.message); }
  renderNow();
}

/* QA retest 2026-09-28 pass 2: "Answers first" and "Next in line" are said only of the list the next answer comes from
   (GET /api/accounts pools[].answering, #748); a Claude Code list said "Answers first" while qwen on this computer answered. */
function group(p) {
  const n = p.accounts.length;
  const rows = p.accounts.map((a) => `<div class="acct-r"><span class="grow"><b>${esc(a.label)}</b><small>${esc(accountDetail(a, p.name ?? p.pool))}</small></span>${a.ready === true && p.answering === true ? p.defaultAccount === a.id ? `<span class="pill ok"><i></i>${t("window.settings.models.answers-first")}</span>` : `<span class="pill idle"><i></i>${t("window.settings.models.next-in-line")}</span>` : ""}<button class="icon-btn" type="button" aria-label="${t("window.settings.accounts.more-for-label", { label: esc(a.label) })}" data-act="acct-menu" data-pool="${esc(p.pool)}" data-id="${esc(a.id)}">${ic("more", "s")}</button></div>`).join("");
  return `<div class="acct-g"><div class="acct-gh">${logo(p.pool, p.name, 30)}<b>${esc(p.name ?? p.pool)}</b><span class="n6">${n ? `${n} ${n === 1 ? "account" : "accounts"}` : t("vault-autofill.managers.off")}</span></div>${rows}${p.pool === "cli-codex" ? codexRow() : ""}
    <button class="add-row" type="button" data-act="addacct" data-v="${esc(p.pool)}" ${ownerOnly()}>${ic("plus", "s")}${n ? t("window.settings.models.add-another-value-account", { value: esc(p.name ?? p.pool) }) : t("window.settings.models.sign-in-to-value", { value: esc(p.name ?? p.pool) })}</button></div>`;
}

/* Pass 18 (DESIGN-DIRECTION PR 11): the connection Branch was started with (the engine's "default" model preset, GET
   /api/state models, named as the status bar names it) is listed first, with its model and, when nothing else was
   chosen, Answers first. It has no account, so it has no account menu. */
function startedWith() {
  const m = E.state?.models, p = m?.presets?.find((x) => x.id === "default");
  if (!p) return "";
  const first = (m.activePreset || m.defaultPreset) === p.id;
  return `<div class="acct-g"><div class="acct-gh">${logo(p.provider, p.name, 30)}<b>${esc(p.name)}</b></div><div class="acct-r"><span class="grow"><b>${esc(p.modelName || p.model)}</b><small>${esc(p.provider)}</small></span>${first ? `<span class="pill ok"><i></i>${t("window.settings.models.answers-first")}</span>` : ""}</div></div>`;
}

/* Q070: the connections that run on this computer (GET /api/state models.presets, local), which no account list holds,
   so Connections never reads empty while one of them answers. Each says whether it answers first and says hello through
   that very connection (POST /api/models/test { preset }), its answer or refusal in the engine's words. */
function localGroup() {
  const m = E.state?.models, here = (m?.presets ?? []).filter((p) => p.local && p.id !== "default"); // the one Branch was started with is listed above
  if (!here.length) return "";
  const rows = here.map((p) => `<div class="acct-r"><span class="grow"><b>${esc(p.name)}</b><small>${esc(t("glance.local"))}</small></span>${(m.activePreset ?? m.defaultPreset) === p.id ? `<span class="pill ok"><i></i>${t("window.settings.models.answers-first")}</span>` : ""}<button class="btn ghost sm" type="button" data-act="m-hello" data-v="${esc(p.id)}">${t("window.flows.setup.say-hello")}</button></div>`).join("");
  return `<div class="acct-g"><div class="acct-gh">${logo(here[0].provider, t("glance.local"), 30)}<b>${t("glance.local")}</b><span class="n6">${here.length}</span></div>${rows}</div>`;
}
async function hello(el) {
  el.disabled = true;
  try {
    const said = await api("models/test", { preset: el.dataset.v });
    toast(t("window.local1c.hello", { s: (said.ms / 1000).toFixed(1), reply: said.reply }));
  } catch (error) { toast(error.message); } finally { el.disabled = false; }
}

function connections() {
  return `<p class="hint" data-css="margin:2px 0 12px">${t("window.settings.models.you-can-sign-in-to-the")} <button class="link" type="button" data-act="setpage" data-v="accounts">${t("window.settings.models.settings-accounts")}</button>.</p>
    <div class="acct-gs">${startedWith()}${localGroup()}${(A.view?.pools ?? []).map(group).join("")}</div>
    <div class="acts" data-css="margin-top:14px"><button class="btn pri" type="button" data-act="addacct" ${ownerOnly()}>${ic("plus", "s")}${t("window.settings.accounts.add-an-account")}</button></div>`;
}

/* Defaults: which connection does which kind of work, each the engine's own setting:
   Everyday answers: the connection that answers (POST /api/models { activePreset }; GET /api/state models);
   Planning and hard problems: the planning model (POST /api/model-savings { card: "phases", values: { planModel } });
   Quick and cheap jobs: the sub-task model (POST /api/knobs { card: "subtasks", values: { subtaskModel } });
   Summaries: the side-job model, which writes summaries and after-task reviews (knobs subtasks.sideJobModel).
   The last three with no pick use the conversation's own connection, so nothing is pressed; pressing the pressed one
   goes back to that. With "Pick the model per task" on, the quick and hard picks are also the ones it chooses between
   (model-savings difficulty easyModel / hardModel), so a new pick here is saved there too. */
const DEFAULTS = [
  ["everyday", "window.settings.models.everyday-answers", "window.settings.models.most-conversations"],
  ["planning", "window.settings.models.planning-and-hard-problems", "window.settings.models.when-a-task-has-many-steps"],
  ["quick", "window.settings.models.quick-and-cheap-jobs", "window.settings.models.sorting-tagging-short-replies"],
  ["summaries", "window.settings.models.summaries", "window.settings.models.keeping-long-conversations-short"],
];
function defaultOf(k) {
  const m = E.state?.models;
  if (k === "everyday") return m ? m.activePreset ?? m.defaultPreset : undefined;
  if (k === "planning") return X.savings ? X.savings.values.phases.planModel : undefined;
  return knobs ? knob("subtasks", k === "quick" ? "subtaskModel" : "sideJobModel") : undefined;
}
function defaults() {
  return DEFAULTS.map(([k, n, small]) => row(t(n), knobSeg(t(n), "m-def", (E.state?.models?.presets ?? []).map((p) => [p.id, esc(p.name)]), defaultOf(k), "", k), t(small))).join("");
}
async function setDefault(el) {
  const k = el.dataset.k, v = el.dataset.v, again = k !== "everyday" && defaultOf(k) === v, id = again ? null : v;
  try {
    if (k === "everyday") { await api("models", { activePreset: id }); await refresh(); }
    else if (k === "planning") X.savings = await api("model-savings", { card: "phases", values: { planModel: id } });
    else knobs = await api("knobs", { card: "subtasks", values: { [k === "quick" ? "subtaskModel" : "sideJobModel"]: id } });
    if ((k === "planning" || k === "quick") && byTask() && id) X.savings = await api("model-savings", { card: "difficulty", values: { [k === "quick" ? "easyModel" : "hardModel"]: id } });
  } catch (error) { toast(error.message); }
  renderNow();
}
/* Pick the model per task (model-savings difficulty): easy tasks go to the Quick and cheap jobs pick, hard ones to the
   Planning and hard problems pick. "On" is the engine's "when needed": the task's own length and tools decide when they
   can, and the small question is asked only when they cannot. It ships off: the question is a request that costs. */
const byTask = () => (X.savings?.values?.difficulty?.mode ?? "off") !== "off";
const byTaskReady = () => !!X.savings?.values?.phases?.planModel && !!knob("subtasks", "subtaskModel");
async function setByTask(on) {
  const values = on ? { mode: "when-needed", easyModel: knob("subtasks", "subtaskModel"), hardModel: X.savings.values.phases.planModel } : { mode: "off" };
  await setSavings("difficulty", values);
}

const local = () => localPicker();

const BODIES = {
  connections, defaults, local,
  second: () => secondTab(),
  media: () => mediaTab(),
};

/* Second opinion (src/second-opinion.ts, GET/POST /api/second-opinion): a second connection reads each finished answer and
   says whether it stands up; its note is kept beside the answer, never written into it, and Look inside shows it
   (chat/messages.js). The engine saves the whole card at once (every field it is not given goes back to its default), so
   each change is sent over what the engine said last. Off by default: every answer costs one more request. */
/* One save at a time, each over what the engine said after the one before, so two quick changes never undo each other. */
let secondSaving = Promise.resolve();
const setSecond = (change) => (secondSaving = secondSaving.then(() => saveSecond(change)));
async function saveSecond(change) {
  if (!X.second) { await loadMore(); return; } // never send a card the engine has not been read for
  try { X.second = await api("second-opinion", { ...X.second, ...change }); } catch (error) { toast(error.message); }
  renderNow();
}
/* A token box for one of the card's ceilings (advisorMaxTokens, debateMaxTokens), saved on change. */
function tokenBox(field, id, label) {
  const value = X.second?.[field];
  if (value == null) return "";
  return `<span class="right num15"><input class="inp" ${ownerHere() ? `id="${id}" data-field="${field}"` : 'data-why="knobs-owner-only"'} value="${esc(value)}" aria-label="${label}"><small>${t("window.settings.models.second-tokens")}</small></span>`;
}
const secondCeiling = () => tokenBox("advisorMaxTokens", "m-second-max", t("window.settings.models.second-ceiling"));
/* Debate (the delegate.debate tool, src/second-opinion-tools.ts): two connections argue a hard question when a task asks
   for it. Its limits are the same card's: how many times each side answers, and the most the whole debate may spend. */
function debateRows() {
  const rounds = t("window.settings.models.debate-rounds"), most = t("window.settings.models.debate-ceiling");
  return `<div class="sec x15-sec"><h2>${t("window.settings.models.debate")}</h2>`
    + row(rounds, knobSeg(rounds, "m-debate-rounds", [[1, "1"], [2, "2"], [3, "3"]], X.second?.debateExchanges), t("window.settings.models.debate-rounds-sub"))
    + row(most, tokenBox("debateMaxTokens", "m-debate-max", most), t("window.settings.models.debate-ceiling-sub")) + "</div>";
}
/* Who checks: the same model or one of the connections, one choice per connection, so a glass list: as a row of buttons
   it wrapped onto two lines at 1400 px (QA pass 2). Drawn once the engine has said which it is; a household person
   sees it greyed with why. */
function whoChecks(by) {
  if (by === undefined) return "";
  const owner = ownerHere(), label = t("window.settings.models.second-who");
  const options = [["", t("window.settings.models.second-same")], ...(E.state?.models?.presets ?? []).map((p) => [p.id, p.name])]; // gsel escapes them
  return `<span class="right">${gsel({ id: owner ? "m-second-by" : "m-second-by-owner", label, options, value: by, attrs: owner ? "" : 'data-why="knobs-owner-only"' })}</span>`;
}
function secondTab() {
  const by = X.second ? X.second.advisorPreset ?? "" : undefined;
  return swRow("m-second", esc(t("window.settings.models.second-check")), esc(t("window.settings.models.second-check-sub")), SW["m-second"][0]())
    + row(t("window.settings.models.second-who"), whoChecks(by), t("window.settings.models.second-who-sub"))
    + row(t("window.settings.models.second-ceiling"), secondCeiling(), t("window.settings.models.second-ceiling-sub"))
    + debateRows();
}
async function saveSecondCeiling(box) {
  const typed = box.value.trim();
  if (!/^\d+$/.test(typed)) { renderNow(); return; }
  await setSecond({ [box.dataset.field]: Number(typed) }); // the engine refuses a figure outside its limits, in its own words
}

/* Media. Pictures (src/media.ts): the connection making pictures now is the owner's own (GET /api/media/settings pictures:
   its name and the kind of picture route it has, or null when it has none, as a ChatGPT sign-in or a Claude connection);
   the picture model is the engine's imageModel (empty is that route's own default), offered from the models Branch knows
   for that kind of route, plus whatever the owner saved before. The engine saves the whole media card at once, so the
   change is sent over what it said last. Videos are the reach part "video" (a paid service, off until switched on), and
   its service is the engine's video settings (POST /api/reach/video/settings { service }), which it takes only while
   videos are on. */
async function setPictureModel(v) {
  if (!X.media) { await loadMore(); return; }
  try { X.media = { ...X.media, ...(await api("media/settings", { ...X.media.settings, imageModel: v })) }; } catch (error) { toast(error.message); }
  renderNow();
}
function pictureRow() {
  const m = X.media, where = m?.pictures, title = t("window.settings.models.make-pictures");
  if (!m) return row(title, "", "");
  if (!where) return ctl("m-img", title, "", false); // greyed with its reason (window.why.m-img)
  const saved = m.settings.imageModel ?? "", known = m.pictureModels?.[where.kind] ?? [];
  /* The route's own model is the first choice already; it is listed again only when the owner saved it by name. */
  const models = [...new Set([...known, ...(saved ? [saved] : [])])].filter((v) => v !== where.defaultModel || v === saved).map((v) => [v, esc(v)]);
  const own = t("window.settings.models.picture-own", { model: where.defaultModel });
  return row(title, knobSeg(title, "m-img", [["", esc(own)], ...models], saved), esc(t("window.settings.models.picture-through", { name: where.connection })));
}
function videoRow() {
  const on = SW["m-vid"][0](), cur = X.reach?.video?.service, title = t("window.settings.models.video-service");
  const opts = [["openai", "OpenAI"], ["google", "Google"]];
  const seg = on ? knobSeg(title, "m-vid-svc", opts, cur) : knobSeg(title, "seg", opts, cur, "m-vid-svc-off");
  return swRow("m-vid", esc(t("window.settings.models.make-short-videos")), esc(t("window.settings.models.video-costs")), on) + row(title, seg, t("window.settings.models.video-service-sub"));
}
async function setVideoService(v) {
  try { await api("reach/video/settings", { service: v }); X.reach = await api("reach"); } catch (error) { toast(error.message); }
  renderNow();
}
const mediaTab = () => pictureRow() + videoRow();

export function draw() {
  const lv = level();
  let html = `<h1>${t("layout.modelTabs")}</h1><p class="lede">${t("window.settings.models.which-models-answer-and-where-they")}</p><div class="tabs" role="tablist">${TABS.map(([id, l]) => `<button class="tab" role="tab" type="button" aria-selected="${tab === id}" data-act="mtab" data-v="${id}">${say(l)}</button>`).join("")}</div>${BODIES[tab]()}`;
  if (lv >= 1) html += advanced();
  if (lv >= 2) html += TECHNICAL();
  return html + sections17(lv, tab) + decisions17d(lv);
}

/* Most steps in one task: the engine's own limit (GET /api/knobs values.limits.maxSteps), saved with
   POST /api/knobs { card: "limits", values: { maxSteps } }, which keeps the card's other values. */
let knobs = null;
async function loadKnobs() {
  /* Q261: the engine's limits are the owner's, which a household person may not read. */
  if (E.profiles?.isOwner === false) { knobs = null; renderNow(); return; }
  try { knobs = await api("knobs"); } catch (error) { knobs = null; toast(error.message); }
  renderNow();
}
async function saveSteps(box) {
  if (!/^\d+$/.test(box.value.trim())) { renderNow(); return; }
  try { knobs = await api("knobs", { card: "limits", values: { maxSteps: Number(box.value) } }); } catch (error) { toast(error.message); }
  renderNow();
}

export function init() {
  initLocalPick();
  freshPick();
  init17();
  initDecisions17d();
  loadAccounts();
  loadKnobs();
  loadMore();
  document.addEventListener("change", (e) => {
    if (e.target.id === "m-steps") saveSteps(e.target);
    else if (e.target.id === "m-second-max" || e.target.id === "m-debate-max") saveSecondCeiling(e.target);
    else if (e.target.id === "m-second-by") setSecond({ advisorPreset: e.target.value || null });
    else if (KNOB[e.target.id]) saveKnob(e.target);
    else if (SW[e.target.id]) SW[e.target.id][1](e.target.checked);
  });
  on("mtab", (el) => { tab = el.dataset.v; renderNow(); });
  on("m-hello", (el) => hello(el));
  on("m-par", (el) => setKnob("subtasks", { parallelSubtasks: Number(el.dataset.v) }));
  on("m-sub", (el) => setKnob("subtasks", { subtaskModel: el.dataset.v || null }));
  on("m-tier", (el) => setKnob("reasoning", { serviceTier: el.dataset.v }));
  on("m-effort", (el) => setEffort(el.dataset.v));
  on("m-planning", (el) => setSavings("phases", { planModel: el.dataset.v || null }));
  on("m-openrouter", (el) => { if (OR.saving) return; OR.open = false; setSavings("openrouter", { mode: "on", sort: el.dataset.v, only: [] }); });
  on("m-orlist", () => { companyScope(); OR.open = true; if (OR.list) renderNow(); else loadCompanies(); });
  document.addEventListener("change", event => { if (event.target.dataset.sw === "or-company") toggleCompany(event.target.dataset.v); });
  document.addEventListener("input", event => {
    if (event.target.id !== "or-company-search") return;
    OR.query = event.target.value;
    const list = document.getElementById("or-companies"), query = OR.query.trim().toLocaleLowerCase();
    list?.querySelectorAll("[data-company-name]").forEach(row => { row.hidden = !row.dataset.companyName.toLocaleLowerCase().includes(query); });
    const empty = document.getElementById("or-company-empty");
    if (empty && list) empty.hidden = !!list.querySelector("[data-company-name]:not([hidden])");
  });
  const app = document.getElementById("app");
  if (app) new MutationObserver(() => { if (companyLocked()) { OR.scope = null; OR.list = null; OR.query = ""; Object.assign(X, { savings:null, coding:null, reach:null, second:null, media:null }); } }).observe(app, {attributes:true, attributeFilter:["class"]});
  on("m-def", (el) => setDefault(el));
  on("m-codex-check", (el) => checkCodex(el));
  document.addEventListener("change", (e) => { if (e.target.id === "m-codex") setCodexModel(e.target); });
  markLive(["m-codex-check", "sw:m-codex"]);
  loadCodex();
  on("m-debate-rounds", (el) => setSecond({ debateExchanges: Number(el.dataset.v) }));
  on("m-img", (el) => setPictureModel(el.dataset.v));
  on("m-vid-svc", (el) => setVideoService(el.dataset.v));
  markLive(["sw:m-second-by", "m-img", "m-vid-svc", "sw:m-second-max", "m-debate-rounds", "sw:m-debate-max"]);
  markLive(["mtab", "m-hello", "m-def", "m-par", "m-sub", "m-tier", "m-effort", "m-planning", "m-openrouter", "m-orlist", "sw:or-company", "sw:or-company-search", ...Object.keys(KNOB).map((id) => "sw:" + id), ...Object.keys(SW).map((id) => "sw:" + id)]);
}

export function load() { loadAccounts(); loadKnobs(); loadMore(); loadCodex(); loadDecisions17d(); return freshPick(); }

export const live = { "sw:f15-mix-models-on-hard-questions": true, "m-orlist": true, "sw:or-company": true, "sw:or-company-search": true, "m-codex-check": true, "sw:m-codex": true, mtab: true, "m-hello": true, "m-def": true, "sw:f15-pick-the-model-per-task": true, "sw:m-steps": true, "m-par": true, "m-sub": true, "m-tier": true, "m-effort": true, "m-planning": true, "m-openrouter": true,
  "sw:f15-keep-claude-s-cache-warm": true, "sw:f15-fewer-rounds": true, "sw:m-vid": true, "sw:m-second": true, "sw:m-second-max": true, "sw:m-second-by": true, "m-debate-rounds": true, "sw:m-debate-max": true, "m-img": true, "m-vid-svc": true, "sw:f15-slow-down-near-a-rate-limit": true };

/* Q002: the engine's other settings these rows keep, each the owner's: the R17-E cards (GET /api/model-savings: the
   planning model, OpenRouter's picks, keeping Claude's cache warm), each saved alone with POST /api/model-savings
   { card, values }, which keeps the card's other values; the coding part "fewer-rounds" (GET /api/coding, POST
   /api/coding/switch) and the reach part "video" (GET /api/reach, POST /api/reach/switch). */
const X = { savings: null, coding: null, reach: null, second: null, media: null };
async function loadMore() {
  if (!ownerHere()) { Object.assign(X, { savings: null, coding: null, reach: null, second: null, media: null }); renderNow(); return; }
  const state = companyScope();
  const read = (path) => api(path).catch((error) => { if (companyValid(state)) toast(error.message); return null; });
  const [savings, coding, reach, second, media] = await Promise.all([read("model-savings"), read("coding"), read("reach"), read("second-opinion"), read("media/settings")]);
  if (!companyValid(state)) return;
  Object.assign(X, { savings, coding, reach, second, media });
  renderNow();
  if (savings?.values?.openrouter?.only?.length) loadCompanies(); // a saved list shows its chips
}
async function setSavings(card, values) {
  try { X.savings = await api("model-savings", { card, values }); } catch (error) { toast(error.message); }
  renderNow();
}
/* A coding or reach part: "when needed" is on (its tools load when the work calls for them), as Settings › Computer does. */
async function setPart(area, part, on) {
  try { await api(`${area}/switch`, { part, mode: on ? "when-needed" : "off" }); X[area] = await api(area); } catch (error) { toast(error.message); }
  renderNow();
}
const onMode = (mode) => (mode ? mode !== "off" : false);
/* Each live switch: its value from the engine, and the route that changes it. */
const SW = {
  /* Mix models on hard questions (difficulty.mixHard): a hard task is asked of both picks, the hard one writes the answer. */
  "f15-mix-models-on-hard-questions": [() => X.savings?.values?.difficulty?.mixHard === true, (on) => setSavings("difficulty", { mixHard: on })],
  "f15-keep-claude-s-cache-warm": [() => X.savings?.values?.keepAlive?.mode === "on", (on) => setSavings("keepAlive", { mode: on ? "on" : "off" })],
  "f15-fewer-rounds": [() => onMode(X.coding?.modes?.["fewer-rounds"]), (on) => setPart("coding", "fewer-rounds", on)],
  "m-vid": [() => onMode(X.reach?.modes?.video), (on) => setPart("reach", "video", on)],
  "m-second": [() => !!X.second?.advisor, (on) => setSecond({ advisor: on })],
  "f15-pick-the-model-per-task": [byTask, setByTask],
  /* The engine's pacing card (src/model-savings/pacing.ts): below a tenth of a service's allowance, requests are spread out. */
  "f15-slow-down-near-a-rate-limit": [() => X.savings?.values?.pacing?.mode === "on", (on) => setSavings("pacing", { mode: on ? "on" : "off" })],
};
/* Mixing needs Pick the model per task on, with two different connections picked for easy and hard tasks. */
const mixReady = () => { const d = X.savings?.values?.difficulty; return byTask() && !!d?.easyModel && !!d?.hardModel && d.easyModel !== d.hardModel; };
/* Only the connections the engine keeps warm (keptWarmProviders: Claude with an API key) can be; with none set up the
   switch is greyed with that reason. */
const noneKeptWarm = () => !!X.savings && !X.savings.connections.some((c) => (X.savings.keptWarmProviders ?? []).includes(c.provider));
/* OpenRouter's picks: Cheapest is sort "price", Fastest is sort "throughput" (OpenRouter's own fastest), each with the card
   on and no list; "Only ones I list" opens OpenRouter's companies below (companiesRow). With no OpenRouter connection it
   stays greyed with that reason. */
function openRouterSeg() {
  const o = X.savings?.values?.openrouter, cur = o?.mode === "on" ? (o.sort ?? (o.only?.length ? "only" : null)) : null;
  const label = t("window.settings.models.openrouter-picks");
  const opts = [["price", t("settings-kit.preset.cheapest")], ["throughput", t("window.settings.models.fastest")], ["only", t("window.settings.models.only-ones-i-list")]];
  const actOf = (v) => (!ownerHere() ? ["seg", "knobs-owner-only"] : v === "only" ? (X.savings?.openRouter ? ["m-orlist", ""] : ["seg", "m-openrouter-only"]) : ["m-openrouter", ""]);
  return `<span class="right"><span class="seg" role="group" aria-label="${label}">${opts.map(([v, w]) => { const [act, why] = actOf(v); return `<button type="button" aria-pressed="${cur === v}" data-act="${act}" data-v="${v}"${why ? ` data-why="${why}"` : ""}>${w}</button>`; }).join("")}</span></span>`;
}
/* Only ones I list: OpenRouter's own list of companies (POST /api/model-savings/companies, asked only when this is
   pressed, or when a list is already saved), as grouped searchable checkboxes. A choice adds it to or takes it from the card's `only`
   (POST /api/model-savings { card: "openrouter", values: { mode: "on", sort: null, only } }). A saved company OpenRouter
   no longer lists is still shown, by its slug, so it can be taken off. */
const OR = { open: false, list: null, busy: false, saving: false, query: "", scope: null };
const companyLocked = () => ["locked", "locked-b17"].some(name => document.getElementById("app")?.classList.contains(name));
const companyValid = state => state === OR.scope && state.id === activeId() && state.credential === token.get() && ownerHere() && !companyLocked();
function companyScope() {
  if (!OR.scope || !companyValid(OR.scope)) {
    if (OR.scope) Object.assign(X, { savings:null, coding:null, reach:null, second:null, media:null });
    Object.assign(OR, { open:false, list:null, busy:false, saving:false, query:"", scope:{ id:activeId(), credential:token.get() } });
  }
  return OR.scope;
}
async function companyOwner(state) {
  if (!companyValid(state)) throw new Error(t("settings.catalogue.changed"));
  const profiles = await api("profiles");
  if (!companyValid(state) || !profiles.isOwner || (profiles.active?.id ?? null) !== state.id) throw new Error(t("settings.catalogue.changed"));
}
async function loadCompanies() {
  const state = companyScope();
  if (!companyValid(state) || OR.list || OR.busy || !X.savings?.openRouter) return;
  OR.busy = true;
  try { await companyOwner(state); const got = await api("model-savings/companies", {}); if (companyValid(state)) OR.list = got.companies; }
  catch (error) { if (companyValid(state)) { OR.open = false; toast(error.message); } }
  finally { if (companyValid(state)) { OR.busy = false; renderNow(); } }
}
function companiesRow() {
  companyScope();
  const only = X.savings?.values?.openrouter?.only ?? [];
  if (!ownerHere() || !X.savings?.openRouter || !(OR.open || only.length) || !OR.list) return "";
  const known = new Set(OR.list.map((c) => c.slug)), all = [...OR.list, ...only.filter((slug) => !known.has(slug)).map((slug) => ({ slug, name: slug }))];
  const query = OR.query.trim().toLocaleLowerCase();
  const rows = selected => all.filter(c => only.includes(c.slug) === selected).map(c => `<label class="or-company" data-company-name="${esc(c.name + " " + c.slug)}"${!(c.name + " " + c.slug).toLocaleLowerCase().includes(query) ? " hidden" : ""}><input type="checkbox" class="chk15" data-sw="or-company" data-v="${esc(c.slug)}"${selected ? " checked" : ""}${OR.saving || (!selected && only.length >= 16) ? " disabled" : ""}><span>${esc(c.name)}${!known.has(c.slug) ? `<small>${esc(t("settings.models.company-unlisted"))}</small>` : ""}</span></label>`).join("");
  const search = `<label for="or-company-search">${esc(t("settings.models.company-search"))}</label><input class="inp" type="search" id="or-company-search" value="${esc(OR.query)}" aria-label="${esc(t("settings.models.company-search"))}">`;
  const groups = `<div id="or-companies" class="or-companies">${search}<p role="status">${esc(t("settings.models.company-count", {count:only.length}))}</p><h3>${esc(t("settings.models.company-selected"))}</h3>${rows(true)}<h3>${esc(t("settings.models.company-available"))}</h3>${rows(false)}<p id="or-company-empty"${all.some(c => (c.name + " " + c.slug).toLocaleLowerCase().includes(query)) ? " hidden" : ""}>${esc(t("settings.models.company-empty"))}</p></div>`;
  return controlRow(`<b>${esc(t("window.settings.models.only-ones-i-list"))}</b><div class="or-company-controls">${groups}</div><small>${esc(t("settings.models.company-help"))}</small>`, {help:t("settings.models.company-help")});
}
async function toggleCompany(slug) {
  const state = companyScope(), displayed = X.savings?.values?.openrouter, only = displayed?.only ?? [];
  if (!companyValid(state) || OR.saving || !OR.list || (!only.includes(slug) && !OR.list.some(c => c.slug === slug))) return;
  if (!only.includes(slug) && only.length >= 16) { toast(t("settings.models.company-count", {count:16})); renderNow(); return; }
  OR.saving = true; renderNow();
  try {
    await companyOwner(state);
    const fresh = await api("model-savings");
    if (!companyValid(state)) return;
    if (!fresh.openRouter || JSON.stringify(fresh.values.openrouter) !== JSON.stringify(displayed)) { X.savings = fresh; throw new Error(t("settings.models.company-changed")); }
    const next = only.includes(slug) ? only.filter(value => value !== slug) : [...only, slug];
    const got = await api("model-savings", {card:"openrouter", values:{mode:"on", sort:null, only:next}});
    if (companyValid(state)) X.savings = got;
  } catch (error) { if (companyValid(state)) toast(error.message); }
  finally {
    if (companyValid(state)) {
      OR.saving = false; renderNow();
      [...document.querySelectorAll('[data-sw="or-company"]')].find(box => box.dataset.v === slug)?.focus({preventScroll:true});
    }
  }
}

/* Q002: the knobs the engine keeps for these rows (GET /api/knobs), each saved alone with POST /api/knobs { card,
   values: { field } }, which keeps the card's other values. An empty box is null: the engine's launch setting, shown
   as the box's placeholder (GET /api/knobs launched). */
const KNOB = {
  "m-spend": ["limits", "spendCapDollars", 1], "m-retries": ["limits", "apiRetries", 1], "m-first": ["limits", "localFirstReplySeconds", 1],
  "m-rounds": ["limits", "maxModelRounds", 1], "m-tooltime": ["commands", "toolTimeoutSeconds", 1], "m-toolkb": ["commands", "toolAnswerChars", 1000],
};
const knob = (card, field) => knobs?.values?.[card]?.[field];
/* A knob's figure in the box's unit: as the engine keeps it when the unit is its own (a $2.50 cap shows 2.5, so retyping it
   is not a raise), else rounded to whole units. */
const shown = (value, per) => (value == null ? "" : per === 1 ? value : Math.round(value / per));
/* Q261: a household person's box is drawn without its id, so it is never live, greyed with the owner-only reason. */
const num = (label, unit, id) => {
  const [card, field, per] = KNOB[id], value = knob(card, field), launched = knobs?.launched?.[field];
  return `<span class="right num15"><input class="inp" ${ownerHere() ? `id="${id}"` : 'data-why="knobs-owner-only"'} value="${esc(shown(value, per))}" placeholder="${esc(shown(launched, per))}" aria-label="${label}">${unit ? `<small>${unit}</small>` : ""}</span>`;
};
async function saveKnob(box) {
  const [card, field, per] = KNOB[box.id], typed = box.value.trim();
  if (typed !== "" && !Number.isFinite(Number(typed))) { renderNow(); return; } // not a number: the box shows the engine's value again
  try { knobs = await api("knobs", { card, values: { [field]: typed === "" ? null : per === 1 ? Number(typed) : Math.round(Number(typed) * per) } }); } catch (error) { toast(error.message); }
  renderNow();
}
/* A row of choices saved as one knob: [value, words] pairs, pressed from the engine's value (none while it is unknown).
   Q261: a household person's row is greyed with the owner-only reason (the engine refuses them these settings). */
const knobSeg = (label, act, opts, cur, why = "", k = "") => {
  const [a, reasonKey] = ownerHere() ? [act, why] : ["seg", "knobs-owner-only"];
  return `<span class="right"><span class="seg" role="group" aria-label="${label}">${opts.map(([v, w]) => `<button type="button" aria-pressed="${cur != null && String(cur) === String(v)}" data-act="${a}"${k ? ` data-k="${k}"` : ""} data-v="${esc(v)}"${reasonKey ? ` data-why="${reasonKey}"` : ""}>${w}</button>`).join("")}</span></span>`;
};
/* Thinking effort for the connection in use. The engine refuses the whole map when it names a connection that is no longer
   set up (src/knobs/api.ts checkValues), so only current connections' efforts are sent with it. */
function setEffort(level) {
  const p = inUse(), ids = new Set((E.state?.models?.presets ?? []).map((x) => x.id));
  if (!p) return;
  const kept = Object.fromEntries(Object.entries(knob("reasoning", "effortByModel") ?? {}).filter(([id]) => ids.has(id)));
  setKnob("reasoning", { effortByModel: { ...kept, [p.id]: level } });
}
async function setKnob(card, values) {
  try { knobs = await api("knobs", { card, values }); } catch (error) { toast(error.message); }
  renderNow();
}
/* The connection in use: the one the engine says answers now (GET /api/state activeModel, which counts a project's own
   connection), else the owner's active one, else the default. */
const inUse = () => {
  const m = E.state?.models, id = E.state?.activeModel?.presetId ?? m?.activePreset ?? m?.defaultPreset;
  return (m?.presets ?? []).find((p) => p.id === id) ?? null;
};
const steps = () => {
  const value = knobs?.values?.limits?.maxSteps;
  /* A plain box, as the prototype's num15; nothing is shown until the engine has said what it keeps. */
  return value == null ? ""
    : `<span class="right num15"><input class="inp" id="m-steps" value="${esc(value)}" aria-label="${t("knobs.field.maxSteps")}"><small>${t("window.settings.models.steps")}</small></span>`;
};
const row = (b, right, small = "", configPath = "") => `${controlRow(`<b>${b}</b>${right}<small>${small}</small>`, {configPath, help: fieldHelp(configPath)})}`;
/* A switch, checked from the engine's value. One the owner alone changes is greyed for a household person, and one that
   cannot act here is greyed with its reason (off: the reason's key); either is drawn without its id, so it is never live.
   A switch with no engine setting keeps its id and is greyed by it (core/why.js). */
const swRow = (id, title, small, on = false, off = "") => {
  const why = SW[id] && !ownerHere() ? "knobs-owner-only" : off;
  return `${controlRow(`<b>${title}</b><input class="sw" type="checkbox" ${why ? `data-why="${why}"` : `id="${id}" data-sw="set"`} ${on ? "checked" : ""} aria-label="${title}"><small>${small}</small>`)}`;
};
const sw = (id, b, small, on = false, off = "") => swRow(id, esc(say(b)), esc(say(small)), on, off);

/* The model choices are "Same model" and the engine's own model presets (GET /api/state models). */
const presetChoices = () => (E.state?.models?.presets ?? []).map((p) => [p.id, esc(p.name)]);
/* Thinking effort for the connection in use (reasoning.effortByModel, by connection id); the efforts it takes are the
   engine's (thinking.levels). A connection that takes none keeps the row greyed, with that reason under it. */
function effortSeg() {
  const p = inUse(), levels = p?.thinking?.levels ?? [];
  const words = { low: t("knobs.option.effort-low"), medium: t("appearance.textSize.medium"), high: t("knobs.option.effort-high") };
  return knobSeg(t("window.settings.models.thinking-effort"), levels.length ? "m-effort" : "seg", ["low", "medium", "high"].filter((v) => !levels.length || levels.includes(v)).map((v) => [v, words[v]]), p ? knob("reasoning", "effortByModel")?.[p.id] : null, levels.length ? "" : "m-effort-none");
}
const advanced = () => `<div class="sec x15-sec"><h2>${t("window.settings.models.budgets")}</h2>${row(t("knobs.field.maxSteps"), steps(), t("window.settings.models.it-stops-and-asks-when-it"), "knobs.limits.maxSteps")}${row(t("window.settings.models.spend-cap-per-task"), num(t("window.settings.models.spend-cap-per-task"), "USD", "m-spend"), t("window.settings.models.only-for-accounts-that-bill-per"))}${row(t("window.settings.models.sub-tasks-at-once"), knobSeg(t("window.settings.models.sub-tasks-at-once"), "m-par", [[1, "1"], [3, "3"], [5, "5"]], knob("subtasks", "parallelSubtasks")), t("window.settings.models.parts-of-a-big-task-that"))}</div>`
  + `<div class="sec x15-sec"><h2>${t("window.settings.models.models-for-smaller-jobs")}</h2>${row(t("knobs.subtasks.title"), knobSeg(t("knobs.subtasks.title"), "m-sub", [["", t("window.settings.models.same-model")], ...presetChoices()], knobs ? knob("subtasks", "subtaskModel") ?? "" : undefined), t("window.settings.models.titles-summaries-and-searches-inside-a"))}${sw("f15-pick-the-model-per-task", "Pick the model per task", "Easy tasks go to a quick model, hard ones to the best you have.", byTask(), X.savings && knobs && (byTask() || byTaskReady()) ? "" : "f15-pick-the-model-per-task")}${row(t("window.settings.models.planning-model"), knobSeg(t("window.settings.models.planning-model"), "m-planning", [["", t("window.settings.models.same-model")], ...presetChoices()], X.savings ? X.savings.values.phases.planModel ?? "" : undefined), t("window.settings.models.writes-the-plan-in-plan-first"))}${sw("f15-mix-models-on-hard-questions", "Mix models on hard questions", "Asks two and merges the best of each. Off until you choose: it doubles the cost.", SW["f15-mix-models-on-hard-questions"][0](), mixReady() ? "" : "f15-mix-models-on-hard-questions")}</div>`
  + `<div class="sec x15-sec"><h2>${t("window.settings.p17-models.compare-models")}</h2>${row(t("reach.arena.title"), `<span class="right"><button class="btn sm" type="button" data-act="arenab17">${t("window.settings.models.open-the-arena")}</button></span>`, t("window.settings.models.the-same-task-to-two-models"))}${ownerHere() ? row(t("window.settings.models.test-suites"), `<span class="right"><button class="btn sm" type="button" data-act="compareb17">${t("window.settings.models.see-history")}</button></span>`, t("window.settings.models.your-own-tasks-with-a-check")) : ""}</div>`; // Q262: the test suites are the owner's

const TECHNICAL = () => `<div class="sec x15-sec"><h2>${t("window.settings.models.retries-and-timeouts")}</h2>${row(t("window.settings.models.retries-when-a-service-fails"), num(t("window.settings.models.retries-when-a-service-fails"), "", "m-retries"))}${row(t("window.settings.models.wait-for-the-first-word"), num(t("window.settings.models.wait-for-the-first-word"), "s", "m-first"), t("window.settings.models.then-it-tries-the-next-account"))}${row(t("window.settings.models.model-rounds-per-step"), num(t("window.settings.models.model-rounds-per-step"), "", "m-rounds"))}${row(t("window.settings.models.tool-and-command-timeout"), num(t("window.settings.models.tool-and-command-timeout"), "s", "m-tooltime"))}${row(t("window.settings.models.largest-tool-answer-kept-whole"), num(t("window.settings.models.largest-tool-answer-kept-whole"), "KB", "m-toolkb"), t("window.settings.models.bigger-answers-are-saved-to-a"))}</div>`
  + `<div class="sec x15-sec"><h2>${t("window.settings.models.per-connection")}</h2>${row(t("window.settings.models.thinking-effort"), effortSeg(), t("window.settings.models.for-the-connection-in-use-others"))}${row(t("window.settings.models.service-tier"), knobSeg(t("window.settings.models.service-tier"), "m-tier", [["standard", t("window.settings.models.standard")], ["priority", t("window.settings.models.priority")], ["flex", t("window.settings.models.flex")]], knob("reasoning", "serviceTier")), t("window.settings.models.priority-costs-more-flex-is-cheaper"))}${sw("f15-slow-down-near-a-rate-limit", "Slow down near a rate limit", "Spreads requests out instead of hitting the wall.", SW["f15-slow-down-near-a-rate-limit"][0]())}${sw("f15-keep-claude-s-cache-warm", "Keep Claude’s cache warm", "A tiny request every 4 minutes during long tasks, so repeats cost less.", SW["f15-keep-claude-s-cache-warm"][0](), noneKeptWarm() ? "keep-warm-no-claude" : "")}${row(t("window.settings.models.openrouter-picks"), openRouterSeg(), t("window.settings.models.which-provider-serves-an-openrouter-model"))}${companiesRow()}${sw("f15-fewer-rounds", "Fewer rounds", "Groups tool calls that don’t depend on each other.", SW["f15-fewer-rounds"][0]())}</div>`;

/* Settings search (settings/find.js) reads every tab's rows, and a found row opens its tab. */
export const TAB_LIST = () => TABS.map(([id, l]) => ({ id, name: say(l) }));
export function drawTab(id) {
  const was = tab;
  tab = id;
  try { return draw(); } finally { tab = was; }
}
export function showTab(id) { if (TABS.some(([known]) => known === id)) tab = id; }
