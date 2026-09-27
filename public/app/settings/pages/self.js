/* Settings › Branch itself, 1:1 with the prototype. Check and fix (GET /api/deployment/doctor?fix=1) opens "Check and fix
   Branch": each check the engine ran, in its own words, with what it repaired or how to put it right; Restart the
   engine (POST /api/dashboard/restart) is live. "Updating itself" is the engine's update setting
   (POST /api/comfort { card: "notify", values: { autoUpdate } }: install = Allowed, check = Ask me first, off = Never).
   What it may change about itself and the gateway's timings are rules in the approval policy (a deny rule for
   settings.* / gateway.propose); taking one back loosens approvals, so those show the engine's state and stay greyed.
   Every change is the settings history (GET /api/settings-kit/history); Roll back undoes one
   (POST /api/settings-kit/undo { record }), and the engine refuses one that would make Branch less careful. */
import { E } from "../../core/state.js";
import { api } from "../../core/api.js";
import { esc, render } from "../../core/dom.js";
import { markLive } from "../../core/features.js";
import { on } from "../../core/actions.js";
import { toast, ic, openDlg, closeDlg, dialog } from "../../core/ui.js";
import { seg15 } from "../rows15.js";
import { self17 } from "../p17-more.js";
import { level as level17 } from "../../core/state.js";
import { t, language } from "../../../i18n.js";

const D = { history: [], names: {}, gw: null, policy: null, comfort: null };

async function loadData() {
  const [hist, kit, gw, pol, comfort] = await Promise.all(["settings-kit/history", "settings-kit", "never-break", "policy", "comfort"]
    .map((path) => api(path).catch((error) => { toast(error.message); return null; })));
  D.history = hist?.records ?? [];
  D.names = Object.fromEntries((kit?.settings ?? []).map((s) => [s.key, s.name]));
  Object.assign(D, { gw, policy: pol?.policy ?? null, comfort: comfort?.values ?? null });
  render();
}

async function rollBack(id) {
  try { await api("settings-kit/undo", { record: id }); toast(t("window.settings.self.rolled-back-to-before-that-change")); } catch (error) { toast(error.message); }
  await loadData();
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
  loadData();
  on("doctor", () => doctor());
  on("gw-restart", () => {
    api("dashboard/restart", {}).then(() => loadData(), (e) => toast(e.message));
  });
  on("self-rollback", (el) => rollBack(el.dataset.id));
  on("self-upd", (el) => setUpdating(el.dataset.v));
  markLive(["doctor", "gw-restart", "self-rollback", "self-upd"]);
}

export async function load() {
  await loadData();
}

export const live = {
  "doctor": true,
  "gw-restart": true,
  "self-rollback": true,
  "self-upd": true,
};

function statusSection() {
  const version = E.state?.version;
  let html = "<div class=\"status\"><span class=\"sdot \"></span><div>";
  html += `<b>${t("dashboard.running")}</b>`;
  // "the gateway watches it" only while the engine says the gateway is on or when-needed (GET /api/never-break).
  const watched = D.gw?.mode && D.gw.mode !== "off" ? ` · ${t("window.settings.self.the-gateway-watches-it-and-starts")}` : ".";
  if (version) html += `<p>${t("window.settings.self.engine")} ` + esc(version) + watched + "</p>";
  html += "</div></div>";
  html += `<div class="acts" data-css="margin-top:12px"><button class="btn" type="button" data-act="doctor">${ic("check", "s")}${t("window.settings.self.check-and-fix")}</button><button class="btn" type="button" data-act="gw-restart">${ic("retry", "s")}${t("window.settings.gateway.restart-the-engine")}</button><button class="btn ghost" type="button" data-act="soon">${t("window.settings.self.reload-without-dropping-work")}</button></div>`;
  return html;
}

const denied = (tool) => (D.policy?.rules ?? []).some((r) => r.decision === "deny" && (r.tool === tool || r.tool === tool.split(".")[0] + ".*"));

function policySection() {
  const own = D.policy ? (denied("settings.change") ? "never" : "ask") : null;
  const timings = D.policy ? (denied("gateway.propose") ? "never" : "suggest") : null;
  const upd = D.comfort?.notify?.autoUpdate ?? null;
  // Loosening always asks, but the engine returns no value for it, so no choice is shown pressed.
  const loosen = null;
  return `<div class=\"sec\"><h2>${t("window.settings.self.what-branch-may-change-about-itself")}</h2>`
    + seg15(t("window.settings.self.its-own-settings"), t("window.settings.self.it-shows-you-the-change-first"), [["ask", t("toolKinds.ask")], ["never", t("window.settings.advanced.never")]], own)
    + seg15(t("window.settings.self.loosening-what-it-may-do"), t("window.settings.self.asked-every-time-the-answer-is"), [["ask", t("window.settings.self.ask-every-time")]], loosen)
    + seg15(t("window.settings.self.the-gateways-timings"), t("window.settings.self.it-can-suggest-you-decide"), [["suggest", t("window.settings.self.suggest")], ["never", t("window.settings.advanced.never")]], timings)
    + seg15(t("window.settings.self.restarting-its-own-engine"), t("window.settings.self.when-its-stuck-safe-steps-carry"), [["allowed", t("window.settings.self.allowed")], ["ask", t("toolKinds.ask")]], null)
    + seg15(t("window.settings.self.updating-itself"), t("window.settings.self.only-when-nothing-is-working-with"), [["install", t("window.settings.self.allowed")], ["check", t("toolKinds.ask")], ["off", t("window.settings.advanced.never")]], upd, "self-upd")
    + `<div class=\"ctl\"><b>${t("window.settings.self.its-own-program-and-your-saved")}</b><span class=\"right\"><span class=\"pill idle\">${t("window.settings.self.never-by-itself")}</span></span><small>${t("window.settings.self.this-one-cant-be-switched-on")}</small></div>`
    + `<div class=\"ctl\"><b>${t("window.settings.self.work-on-its-own-code-in")}</b><input class=\"sw\" type=\"checkbox\" id=\"self-dev\" aria-label=\"${t("window.settings.self.work-on-its-own-code-in")}\" data-sw=\"set\"><small>${t("window.settings.self.a-private-copy-of-branchs-source")}</small></div></div>`;
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
  html += neverDiesSection();
  html += timelineSection();
  return html + self17(level17());
}
