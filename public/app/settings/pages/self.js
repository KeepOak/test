/* Settings › Branch itself, 1:1 with the prototype. Check and fix (GET /api/deployment/doctor?fix=1) opens "Check and fix
   Branch": each check the engine ran, in its own words, with what it repaired or how to put it right; Restart the
   engine (POST /api/dashboard/restart) is live. "Updating itself" is the engine's update setting
   (POST /api/comfort { card: "notify", values: { autoUpdate } }: install = Allowed, check = Ask me first, off = Never).
   What it may change about itself and the gateway's timings are rules in the approval policy (a deny rule for
   settings.* / gateway.propose); taking one back loosens approvals, so those show the engine's state and stay greyed.
   Every change is the settings history (GET /api/settings-kit/history); Roll back undoes one
   (POST /api/settings-kit/undo { record }), and the engine refuses one that would make Branch less careful.
   selfdev: what it may do about itself (its own settings, the gateway's timings, restarting its own engine, working on
   its own code) is GET/POST /api/self-rules (src/self-rules.ts): each row the approval rule in force for its own tools.
   A change that makes Branch less careful shows the engine's words and waits for the owner's yes (confirmLoosening).
   Reload without dropping work is POST /api/dashboard/restart { whenIdle: true }: it waits until no task is working. */
import { E } from "../../core/state.js";
import { api } from "../../core/api.js";
import { esc, render } from "../../core/dom.js";
import { markLive } from "../../core/features.js";
import { on } from "../../core/actions.js";
import { toast, ic, openDlg, closeDlg, dialog } from "../../core/ui.js";
import { seg15 } from "../rows15.js";
import { self17 } from "../p17-more.js";
import { ciQueueSection, initCiQueue } from "../self-development-ci.js";
import { level as level17 } from "../../core/state.js";
import { t, language } from "../../../i18n.js";
import { continuousQaSection, initContinuousQa, loadContinuousQa } from "../continuous-qa.js";
import { initTestCopies, loadTestCopies, testCopySection } from "../self-development-test-copy.js";

const D = { history: [], names: {}, gw: null, policy: null, comfort: null, rules: null };
let pendingRule = null;

async function loadData() {
  await loadTestCopies();
  const [hist, kit, gw, pol, comfort, rules] = await Promise.all(["settings-kit/history", "settings-kit", "never-break", "policy", "comfort", "self-rules"]
    .map((path) => api(path).catch((error) => { toast(error.message); return null; })));
  D.rules = rules;
  D.history = hist?.records ?? [];
  D.names = Object.fromEntries((kit?.settings ?? []).map((s) => [s.key, s.name]));
  Object.assign(D, { gw, policy: pol?.policy ?? null, comfort: comfort?.values ?? null });
  render();
}

async function rollBack(id) {
  try { await api("settings-kit/undo", { record: id }); toast(t("window.settings.self.rolled-back-to-before-that-change")); } catch (error) { toast(error.message); }
  await loadData();
}

/* One row of what Branch may do about itself; a loosening waits for the owner's yes in a dialog with the engine's words. */
async function setRule(control, value, confirmLoosening = false) {
  try {
    D.rules = await api("self-rules", { control, value, ...(confirmLoosening ? { confirmLoosening } : {}) });
  } catch (error) {
    if (!confirmLoosening && /less careful/.test(error.message)) {
      pendingRule = { control, value };
      openDlg({ title: t("window.settings.self.what-branch-may-change-about-itself"), body: `<p data-css="margin:0">${esc(error.message)}</p>`,
        foot: `<button class="btn ghost" type="button" data-act="dlg-close">${t("mode.cancel")}</button><button class="btn pri" type="button" data-act="self-rule-yes">${t("settings-kit.confirm")}</button>` });
    } else toast(error.message);
  }
  await loadData();
}

async function reloadWhenIdle() {
  try {
    const done = await api("dashboard/restart", { whenIdle: true });
    toast(done.waiting ? t("window.settings.self.reload-waits", { working: done.working }) : t("window.settings.self.reloading"));
  } catch (error) { toast(error.message); }
}

async function setUpdating(v) {
  try { await api("comfort", { card: "notify", values: { autoUpdate: v } }); } catch (error) { toast(error.message); }
  await loadData();
}

/* ---------- Check and fix Branch ---------- */
const docItem = (c) => `<li class="${c.ok ? "ok" : ""}">${ic(c.ok ? "check" : "info", "s")}<span>${esc(c.name)}<small>${esc(c.ok ? c.summary : [c.summary, c.fix].filter(Boolean).join(" "))}</small></span></li>`;
function docDlg(body) {
  return openDlg({ title: t("window.settings.self.check-and-fix-branch"), body, foot: `<button class="btn pri" type="button" data-act="dlg-close">${t("window.settings.self.done")}</button>` });
}
async function doctor() {
  const box = docDlg(`<p class="hint ic-t">${ic("spin", "s spin")}${t("window.flows.setup.checking")}</p>`);
  let report;
  try { report = await api("deployment/doctor?fix=1"); } catch (error) { if (dialog() === box) closeDlg(); toast(error.message); return; }
  if (dialog() !== box) return;
  docDlg(`<ol class="tl">${(report.checks ?? []).map(docItem).join("")}</ol>${report.ok ? `<div class="doc-ok11"><span><b>${t("window.settings.self.everything-is-healthy")}</b></span></div>` : ""}`);
  loadData();
}

export function init() {
  initCiQueue();
  initContinuousQa();
  initTestCopies();
  loadData();
  on("doctor", () => doctor());
  on("self-rollback", (el) => rollBack(el.dataset.id));
  on("self-upd", (el) => setUpdating(el.dataset.v));
  on("self-own", (el) => setRule("ownSettings", el.dataset.v));
  on("self-timings", (el) => setRule("gatewayTimings", el.dataset.v));
  on("self-restart", (el) => setRule("restart", el.dataset.v));
  on("self-loosen", () => toast(t("window.why.f15-loosening-what-it-may-do")));
  on("self-rule-yes", () => { const rule = pendingRule; pendingRule = null; closeDlg(); if (rule) setRule(rule.control, rule.value, true); });
  on("self-reload", () => reloadWhenIdle());
  document.addEventListener("change", (e) => { if (e.target?.id === "self-dev") setRule("selfDev", e.target.checked ? "on" : "off"); });
  markLive(["doctor", "gw-restart", "self-rollback", "self-upd", "self-own", "self-timings", "self-restart", "self-loosen", "self-rule-yes", "self-reload", "sw:self-dev"]);
}

export async function load() {
  await loadContinuousQa();
  await loadData();
}

/* Restart the engine (POST /api/dashboard/restart), from this page or the Gateway's; registered once by settings.js so
   both pages' buttons work whichever was opened first (Q002). The engine refuses in its own words where it cannot. */
export function restart() {
  return api("dashboard/restart", {}).then(() => loadData(), (e) => toast(e.message));
}

export const live = {
  "doctor": true,
  "gw-restart": true,
  "self-rollback": true,
  "self-upd": true,
  "self-own": true,
  "self-timings": true,
  "self-restart": true,
  "self-loosen": true,
  "self-reload": true,
};

function statusSection() {
  const version = E.state?.version;
  let html = "<div class=\"status\"><span class=\"sdot \"></span><div>";
  html += `<b>${t("dashboard.running")}</b>`;
  // "the gateway watches it" only while the engine says the gateway is on or when-needed (GET /api/never-break).
  const watched = D.gw?.mode && D.gw.mode !== "off" ? ` · ${t("window.settings.self.the-gateway-watches-it-and-starts")}` : ".";
  if (version) html += `<p>${t("window.settings.self.engine")} ` + esc(version) + watched + "</p>";
  html += "</div></div>";
  html += `<div class="acts" data-css="margin-top:12px"><button class="btn" type="button" data-act="doctor">${ic("check", "s")}${t("window.settings.self.check-and-fix")}</button><button class="btn" type="button" data-act="gw-restart">${ic("retry", "s")}${t("window.settings.gateway.restart-the-engine")}</button><button class="btn ghost" type="button" data-act="self-reload">${t("window.settings.self.reload-without-dropping-work")}</button></div>`;
  return html;
}


/* A row of choices greys with its reason by an explicit key: the title is already translated, so id15(title) would
   differ by language (these are the English titles' ids, as the locale files keep them). */
function policySection() {
  const R = D.rules;
  const own = R?.ownSettings ?? null, timings = R?.gatewayTimings ?? null, restart = R?.restart ?? null;
  const upd = D.comfort?.notify?.autoUpdate ?? null;
  // Loosening always asks: the engine holds every less careful change for the owner's own yes.
  const loosen = R ? R.loosening : null;
  // Working on its own code needs sending Git work to a remote (GitHub) on; until then it says so in place.
  const dev = R?.selfDev ?? { on: false, available: false };
  const devBox = dev.available
    ? `<input class=\"sw\" type=\"checkbox\" id=\"self-dev\" aria-label=\"${t("window.settings.self.work-on-its-own-code-in")}\" data-sw=\"set\"${dev.on ? " checked" : ""}>`
    : `<input class=\"sw\" type=\"checkbox\" id=\"self-dev-remote\" aria-label=\"${t("window.settings.self.work-on-its-own-code-in")}\" data-why=\"self-dev-remote\">`;
  return `<div class=\"sec\"><h2>${t("window.settings.self.what-branch-may-change-about-itself")}</h2>`
    + seg15(t("window.settings.self.its-own-settings"), t("window.settings.self.it-shows-you-the-change-first"), [["ask", t("toolKinds.ask")], ["never", t("window.settings.advanced.never")]], own, "self-own", "f15-its-own-settings")
    + seg15(t("window.settings.self.loosening-what-it-may-do"), t("window.settings.self.asked-every-time-the-answer-is"), [["ask", t("window.settings.self.ask-every-time")]], loosen, "self-loosen", "f15-loosening-what-it-may-do")
    + seg15(t("window.settings.self.the-gateways-timings"), t("window.settings.self.it-can-suggest-you-decide"), [["suggest", t("window.settings.self.suggest")], ["never", t("window.settings.advanced.never")]], timings, "self-timings", "f15-the-gateway-s-timings")
    + seg15(t("window.settings.self.restarting-its-own-engine"), t("window.settings.self.when-its-stuck-safe-steps-carry"), [["allowed", t("window.settings.self.allowed")], ["ask", t("toolKinds.ask")]], restart, "self-restart", "f15-restarting-its-own-engine")
    + seg15(t("window.settings.self.updating-itself"), t("window.settings.self.only-when-nothing-is-working-with"), [["install", t("window.settings.self.allowed")], ["check", t("toolKinds.ask")], ["off", t("window.settings.advanced.never")]], upd, "self-upd")
    + `<div class=\"ctl\"><b>${t("window.settings.self.its-own-program-and-your-saved")}</b><span class=\"right\"><span class=\"pill idle\">${t("window.settings.self.never-by-itself")}</span></span><small>${t("window.settings.self.this-one-cant-be-switched-on")}</small></div>`
    + `<div class=\"ctl\"><b>${t("window.settings.self.work-on-its-own-code-in")}</b>${devBox}<small>${t("window.settings.self.a-private-copy-of-branchs-source")}</small></div></div>`;
}

function neverDiesSection() {
  const c = D.gw?.config;
  const hold = c ? t("window.settings.self.the-gateway-starts-it-again-holding", { seconds: esc(c.holdSeconds) }) : t("window.settings.self.the-gateway-starts-it-again");
  const crash = c ? `<dt>${t("window.settings.self.if-it-keeps-crashing")}</dt><dd>${t("window.settings.self.after-maxquickcrashes-quick-crashes-it-rolls", { maxQuickCrashes: esc(c.maxQuickCrashes) })}</dd>` : "";
  return `<div class="sec"><h2>${t("window.settings.self.never-dies")}</h2><dl class="kv"><dt>${t("window.settings.self.if-the-engine-stops")}</dt><dd>${hold}</dd>${crash}<dt>${t("window.settings.self.interrupted-work")}</dt><dd>${t("window.settings.self.safe-steps-carry-on-by-themselves")}</dd></dl></div>`;
}

function timelineSection() {
  const items = D.history.slice(0, 3).map((r) => {
    const when = new Date(r.at).toLocaleString(language(), { weekday: "short", hour: "2-digit", minute: "2-digit" });
    const back = r.undoneBy || r.undoes ? "" : `<button class="btn ghost sm" type="button" data-act="self-rollback" data-id="${esc(r.id)}">${t("window.places.customize17.roll-back")}</button>`;
    return `<li class="">${ic("info", "s")}<span>${esc(D.names[r.detail] ?? r.detail)}<small>${esc(when)}</small></span>${back}</li>`;
  }).join("");
  return `<div class="sec"><h2>${t("window.settings.self.every-change")}</h2><ol class="tl">${items}</ol></div>`;
}

export function draw() {
  let html = `<h1>${t("dashboard.computer.engine")}</h1><p class="lede">${t("window.settings.self.what-branch-may-change-about-itself-2")}</p>`;
  html += statusSection();
  html += policySection();
  html += ciQueueSection();
  html += neverDiesSection();
  html += testCopySection();
  html += timelineSection();
  return html + continuousQaSection() + self17(level17());
}
