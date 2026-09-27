/* Settings › Models, 1:1 with the prototype's five tabs, each drawn from the engine:
   Connections: every connection that can have several accounts, with its accounts (GET /api/accounts, flows/account.js);
   Defaults: the engine's model presets (GET /api/state models); On this computer: the shared local-model picker
   (flows/localpick.js): what Ollama and LM Studio have, the engine's pick for this hardware, its three sizes, and one
   click that installs, downloads with progress, connects and selects. */
import { esc, renderNow } from "../../core/dom.js";
import { level, E, ownerHere } from "../../core/state.js";
import { api } from "../../core/api.js";
import { on } from "../../core/actions.js";
import { markLive } from "../../core/features.js";
import { ic, toast } from "../../core/ui.js";
import { logo } from "../../core/logos.js";
import { ctl } from "../parts.js";
import { A, loadAccounts, ownerOnly } from "../../flows/account.js";
import { localPicker, freshPick, initLocalPick } from "../../flows/localpick.js";
import { sections17, init17 } from "../p17-models.js";
import { t } from "../../../i18n.js";
import { say } from "../../core/words.js";
import { decisions17d, initDecisions17d, loadDecisions17d } from "../decisions17d.js"; // pass 17 part D §4

const TABS = [["connections", "Connections"], ["defaults", "Defaults"], ["local", "On this computer"], ["second", "Second opinion"], ["media", "Media"]];
let tab = "connections";

function group(p) {
  const n = p.accounts.length;
  const rows = p.accounts.map((a) => `<div class="acct-r"><span class="grow"><b>${esc(a.label)}</b><small>${esc(p.name ?? p.pool)}</small></span>${p.defaultAccount === a.id ? `<span class="pill ok"><i></i>${t("window.settings.models.answers-first")}</span>` : `<span class="pill idle"><i></i>${t("window.settings.models.next-in-line")}</span>`}<button class="icon-btn" type="button" aria-label="${t("window.settings.accounts.more-for-label", { label: esc(a.label) })}" data-act="acct-menu" data-pool="${esc(p.pool)}" data-id="${esc(a.id)}">${ic("more", "s")}</button></div>`).join("");
  return `<div class="acct-g"><div class="acct-gh">${logo(p.pool, p.name, 30)}<b>${esc(p.name ?? p.pool)}</b><span class="n6">${n ? `${n} ${n === 1 ? "account" : "accounts"}` : t("vault-autofill.managers.off")}</span></div>${rows}
    <button class="add-row" type="button" data-act="addacct" data-v="${esc(p.pool)}" ${ownerOnly()}>${ic("plus", "s")}${n ? t("window.settings.models.add-another-value-account", { value: esc(p.name ?? p.pool) }) : t("window.settings.models.sign-in-to-value", { value: esc(p.name ?? p.pool) })}</button></div>`;
}

function connections() {
  return `<p class="hint" data-css="margin:2px 0 12px">${t("window.settings.models.you-can-sign-in-to-the")} <button class="link" type="button" data-act="setpage" data-v="accounts">${t("window.settings.models.settings-accounts")}</button>.</p>
    <div class="acct-gs">${(A.view?.pools ?? []).map(group).join("")}</div>
    <div class="acts" data-css="margin-top:14px"><button class="btn pri" type="button" data-act="addacct" ${ownerOnly()}>${ic("plus", "s")}${t("window.settings.accounts.add-an-account")}</button></div>`;
}

function defaults() {
  const m = E.state?.models;
  const presets = m?.presets ?? [];
  return [[t("window.settings.models.everyday-answers"), t("window.settings.models.most-conversations")], [t("window.settings.models.planning-and-hard-problems"), t("window.settings.models.when-a-task-has-many-steps")], [t("window.settings.models.quick-and-cheap-jobs"), t("window.settings.models.sorting-tagging-short-replies")], [t("window.settings.models.summaries"), t("window.settings.models.keeping-long-conversations-short")]]
    .map(([n, s], i) => `<div class="ctl"><b>${n}</b><span class="right"><span class="seg">${presets.map((p) => `<button type="button" data-act="seg" aria-pressed="${i === 0 && p.id === m.defaultPreset}">${esc(p.name)}</button>`).join("")}</span></span><small>${s}</small></div>`).join("");
}

const local = () => localPicker();

const BODIES = {
  connections, defaults, local,
  second: () => ctl("m-second", t("window.settings.models.ask-a-second-model-on-hard"), t("window.settings.models.shows-both-answers-side-by-side"), false),
  media: () => ctl("m-img", t("window.settings.models.make-pictures"), t("window.settings.models.uses-your-chatgpt-account"), false) + ctl("m-vid", t("window.settings.models.make-short-videos"), t("window.settings.models.off-until-you-choose-a-service"), false),
};

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
  document.addEventListener("change", (e) => { if (e.target.id === "m-steps") saveSteps(e.target); else if (KNOB[e.target.id]) saveKnob(e.target); });
  on("mtab", (el) => { tab = el.dataset.v; renderNow(); });
  on("m-par", (el) => setKnob("subtasks", { parallelSubtasks: Number(el.dataset.v) }));
  on("m-sub", (el) => setKnob("subtasks", { subtaskModel: el.dataset.v || null }));
  on("m-tier", (el) => setKnob("reasoning", { serviceTier: el.dataset.v }));
  on("m-effort", (el) => { const p = inUse(); if (p) setKnob("reasoning", { effortByModel: { ...(knob("reasoning", "effortByModel") ?? {}), [p.id]: el.dataset.v } }); });
  markLive(["mtab", "m-par", "m-sub", "m-tier", "m-effort", ...Object.keys(KNOB).map((id) => "sw:" + id)]);
}

export function load() { loadAccounts(); loadKnobs(); loadDecisions17d(); return freshPick(); }

export const live = { mtab: true, "sw:m-steps": true, "m-par": true, "m-sub": true, "m-tier": true, "m-effort": true };

/* The Advanced and Technical sections: drawn in place and greyed until each has its engine setting wired. */
const seg = (label, opts, why) => `<span class="right"><span class="seg" role="group" aria-label="${label}">${opts.map((o) => `<button type="button" aria-pressed="false" data-act="seg" data-why="${why}">${o}</button>`).join("")}</span></span>`;
/* Q002: the knobs the engine keeps for these rows (GET /api/knobs), each saved alone with POST /api/knobs { card,
   values: { field } }, which keeps the card's other values. An empty box is null: the engine's launch setting, shown
   as the box's placeholder (GET /api/knobs launched). */
const KNOB = {
  "m-spend": ["limits", "spendCapDollars", 1], "m-retries": ["limits", "apiRetries", 1], "m-first": ["limits", "localFirstReplySeconds", 1],
  "m-rounds": ["limits", "maxModelRounds", 1], "m-tooltime": ["commands", "toolTimeoutSeconds", 1], "m-toolkb": ["commands", "toolAnswerChars", 1000],
};
const knob = (card, field) => knobs?.values?.[card]?.[field];
const num = (label, unit, id) => {
  const [card, field, per] = KNOB[id], value = knob(card, field), launched = knobs?.launched?.[field];
  return `<span class="right num15"><input class="inp" id="${id}" value="${esc(value == null ? "" : Math.round(value / per))}" placeholder="${esc(launched == null ? "" : Math.round(launched / per))}" aria-label="${label}">${unit ? `<small>${unit}</small>` : ""}</span>`;
};
async function saveKnob(box) {
  const [card, field, per] = KNOB[box.id], typed = box.value.trim();
  if (typed !== "" && !Number.isFinite(Number(typed))) { renderNow(); return; } // not a number: the box shows the engine's value again
  try { knobs = await api("knobs", { card, values: { [field]: typed === "" ? null : Number(typed) * per } }); } catch (error) { toast(error.message); }
  renderNow();
}
/* A row of choices saved as one knob: [value, words] pairs, pressed from the engine's value. */
const knobSeg = (label, act, opts, cur, why = "") => `<span class="right"><span class="seg" role="group" aria-label="${label}">${opts.map(([v, w]) => `<button type="button" aria-pressed="${String(cur) === String(v)}" data-act="${act}" data-v="${esc(v)}"${why ? ` data-why="${why}"` : ""}>${w}</button>`).join("")}</span></span>`;
async function setKnob(card, values) {
  try { knobs = await api("knobs", { card, values }); } catch (error) { toast(error.message); }
  renderNow();
}
/* The connection in use (GET /api/state models: the active one, else the default). */
const inUse = () => { const m = E.state?.models; return (m?.presets ?? []).find((p) => p.id === (m.activePreset ?? m.defaultPreset)) ?? null; };
const steps = () => {
  const value = knobs?.values?.limits?.maxSteps;
  /* A plain box, as the prototype's num15; nothing is shown until the engine has said what it keeps. */
  return value == null ? ""
    : `<span class="right num15"><input class="inp" id="m-steps" value="${esc(value)}" aria-label="${t("knobs.field.maxSteps")}"><small>${t("window.settings.models.steps")}</small></span>`;
};
const row = (b, right, small = "") => `<div class="ctl"><b>${b}</b>${right}<small>${small}</small></div>`;
const sw = (id, b, small) => `<div class="ctl"><b>${esc(say(b))}</b><input class="sw" type="checkbox" id="${id}" aria-label="${esc(say(b))}" data-sw="set"><small>${esc(say(small))}</small></div>`;

/* The model choices are "Same model" and the engine's own model presets (GET /api/state models). */
const presetNames = () => (E.state?.models?.presets ?? []).map((p) => esc(p.name));
const presetChoices = () => (E.state?.models?.presets ?? []).map((p) => [p.id, esc(p.name)]);
/* Thinking effort for the connection in use (reasoning.effortByModel, by connection id); the efforts it takes are the
   engine's (thinking.levels). A connection that takes none keeps the row greyed, with that reason under it. */
function effortSeg() {
  const p = inUse(), levels = p?.thinking?.levels ?? [];
  const words = { low: t("knobs.option.effort-low"), medium: t("appearance.textSize.medium"), high: t("knobs.option.effort-high") };
  return knobSeg(t("window.settings.models.thinking-effort"), levels.length ? "m-effort" : "seg", ["low", "medium", "high"].filter((v) => !levels.length || levels.includes(v)).map((v) => [v, words[v]]), p ? knob("reasoning", "effortByModel")?.[p.id] : null, levels.length ? "" : "m-effort-none");
}
const advanced = () => `<div class="sec x15-sec"><h2>${t("window.settings.models.budgets")}</h2>${row(t("knobs.field.maxSteps"), steps(), t("window.settings.models.it-stops-and-asks-when-it"))}${row(t("window.settings.models.spend-cap-per-task"), num(t("window.settings.models.spend-cap-per-task"), "USD", "m-spend"), t("window.settings.models.only-for-accounts-that-bill-per"))}${row(t("window.settings.models.sub-tasks-at-once"), knobSeg(t("window.settings.models.sub-tasks-at-once"), "m-par", [[1, "1"], [3, "3"], [5, "5"]], knob("subtasks", "parallelSubtasks")), t("window.settings.models.parts-of-a-big-task-that"))}</div>`
  + `<div class="sec x15-sec"><h2>${t("window.settings.models.models-for-smaller-jobs")}</h2>${row(t("knobs.subtasks.title"), knobSeg(t("knobs.subtasks.title"), "m-sub", [["", t("window.settings.models.same-model")], ...presetChoices()], knob("subtasks", "subtaskModel") ?? ""), t("window.settings.models.titles-summaries-and-searches-inside-a"))}${sw("f15-pick-the-model-per-task", "Pick the model per task", "Easy tasks go to a quick model, hard ones to the best you have.")}${row(t("window.settings.models.planning-model"), seg(t("window.settings.models.planning-model"), [t("window.settings.models.same-model"), ...presetNames()], "m-planning"), t("window.settings.models.writes-the-plan-in-plan-first"))}${sw("f15-mix-models-on-hard-questions", "Mix models on hard questions", "Asks two and merges the best of each. Off until you choose: it doubles the cost.")}</div>`
  + `<div class="sec x15-sec"><h2>${t("window.settings.p17-models.compare-models")}</h2>${row(t("reach.arena.title"), `<span class="right"><button class="btn sm" type="button" data-act="arenab17">${t("window.settings.models.open-the-arena")}</button></span>`, t("window.settings.models.the-same-task-to-two-models"))}${ownerHere() ? row(t("window.settings.models.test-suites"), `<span class="right"><button class="btn sm" type="button" data-act="compareb17">${t("window.settings.models.see-history")}</button></span>`, t("window.settings.models.your-own-tasks-with-a-check")) : ""}</div>`; // Q262: the test suites are the owner's

const TECHNICAL = () => `<div class="sec x15-sec"><h2>${t("window.settings.models.retries-and-timeouts")}</h2>${row(t("window.settings.models.retries-when-a-service-fails"), num(t("window.settings.models.retries-when-a-service-fails"), "", "m-retries"))}${row(t("window.settings.models.wait-for-the-first-word"), num(t("window.settings.models.wait-for-the-first-word"), "s", "m-first"), t("window.settings.models.then-it-tries-the-next-account"))}${row(t("window.settings.models.model-rounds-per-step"), num(t("window.settings.models.model-rounds-per-step"), "", "m-rounds"))}${row(t("window.settings.models.tool-and-command-timeout"), num(t("window.settings.models.tool-and-command-timeout"), "s", "m-tooltime"))}${row(t("window.settings.models.largest-tool-answer-kept-whole"), num(t("window.settings.models.largest-tool-answer-kept-whole"), "KB", "m-toolkb"), t("window.settings.models.bigger-answers-are-saved-to-a"))}</div>`
  + `<div class="sec x15-sec"><h2>${t("window.settings.models.per-connection")}</h2>${row(t("window.settings.models.thinking-effort"), effortSeg(), t("window.settings.models.for-the-connection-in-use-others"))}${row(t("window.settings.models.service-tier"), knobSeg(t("window.settings.models.service-tier"), "m-tier", [["standard", t("window.settings.models.standard")], ["priority", t("window.settings.models.priority")], ["flex", t("window.settings.models.flex")]], knob("reasoning", "serviceTier")), t("window.settings.models.priority-costs-more-flex-is-cheaper"))}${sw("f15-slow-down-near-a-rate-limit", "Slow down near a rate limit", "Spreads requests out instead of hitting the wall.")}${sw("f15-keep-claude-s-cache-warm", "Keep Claude’s cache warm", "A tiny request every 4 minutes during long tasks, so repeats cost less.")}${row(t("window.settings.models.openrouter-picks"), seg(t("window.settings.models.openrouter-picks"), [t("settings-kit.preset.cheapest"), t("window.settings.models.fastest"), t("window.settings.models.only-ones-i-list")], "m-openrouter"), t("window.settings.models.which-provider-serves-an-openrouter-model"))}${sw("f15-fewer-rounds", "Fewer rounds", "Groups tool calls that don’t depend on each other.")}</div>`;
