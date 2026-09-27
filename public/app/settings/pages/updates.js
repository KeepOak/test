/* Settings › Updates & about, for an owner who never presses Update (the owner's request, 2026-09-27): one status card
   that says what is happening now, from the desktop updater's own state (shell/updating.js, pushed as it changes) and
   update by itself's last look (shell/autoupdate.js, the engine's plan), with the one button that fits that moment.
   Under it the switch, whose line says how often it really looks, and a quieter More with the rest. */
import { E, level } from "../../core/state.js";
import { api } from "../../core/api.js";
import { esc, render } from "../../core/dom.js";
import { markLive } from "../../core/features.js";
import { toast } from "../../core/ui.js";
import { updates17 } from "../p17-more.js";
import { t } from "../../../i18n.js";
import { channelSection, initChannel, loadChannel, channelStatus } from "../updates-channel.js";
import { holdingTasks, lastLook, waitingLine } from "../../shell/autoupdate.js";
import { clock, installing, stageWords, targetWords, updateNow } from "../../shell/updating.js";

let comfortData = null;
/* What removing Branch would take away and keep, as the engine surveys it (POST /api/remove-branch/plan, which only
   looks; removing is POST /api/remove-branch and stays with the desktop app's own flow). The owner's alone. */
let plan = null;
const notOwner = () => E.profiles?.isOwner === false;
async function loadPlan() {
  if (notOwner()) { plan = null; return; }
  try { const got = await api("remove-branch/plan", { keepConversations: true }); plan = notOwner() ? null : got; } catch (e) { toast(e.message); }
  render();
}
const size = (n) => (n >= 2 ** 30 ? t("danger.size.gb", { gb: (n / 2 ** 30).toFixed(1) }) : n >= 2 ** 20 ? t("danger.size.mb", { mb: Math.round(n / 2 ** 20) }) : t("danger.size.nothing"));
function removalRows() {
  const goes = (plan?.items ?? []).filter((x) => x.goes && x.bytes > 0);
  const rows = goes.map((x) => `<div class="prow"><span class="grow"><b data-css="font-weight:500">${esc(x.what)}</b></span><span class="meta">${esc(t("danger.item.goes", { size: size(x.bytes) }))}</span></div>`).join("");
  return rows + (plan?.instead ? `<p class="hint">${esc(plan.instead)}</p>` : "");
}

async function loadComfort() {
  /* Q261: the update choice is kept in the owner's comfort card, which a household person may not read. */
  if (E.profiles?.isOwner === false) return;
  try {
    const res = await api("comfort");
    comfortData = res.values || {};
    render();
  } catch (e) {
    toast(e.message);
  }
  await loadChannel();
}

/* The switch is drawn after init, so its change is caught on the document (POST /api/comfort merges the one value
   into the notify card). */
async function saveAutoUpdate(on) {
  try {
    // "Keep Branch up to date by itself" installs (the plan still waits for idle tasks, Lockdown and a failed release).
    comfortData = (await api("comfort", { card: "notify", values: { autoUpdate: on ? "install" : "off" } })).values ?? comfortData;
  } catch (e) {
    toast(e.message);
  }
  render();
}

let moreOpen = false;
export function init() {
  loadComfort();
  loadPlan();
  document.addEventListener("change", (e) => { if (e.target.id === "u-auto") saveAutoUpdate(e.target.checked); });
  // More stays open or shut across redraws, as the owner left it.
  document.addEventListener("toggle", (e) => { if (e.target.id === "u-more") moreOpen = e.target.open; }, true);
  markLive(["sw:u-auto"]);
  initChannel();
}

export async function load() {
  loadPlan();
  await loadComfort();
}

/* The status card: one line for what is happening now, a second for detail, and the one button for this moment. Every
   value is the updater's or the engine's; nothing is drawn before either has said anything. */
const card = (title, sub, { bad = false, busy = false, button = "", extra = "" } = {}) =>
  `<div class="status upd18-status"><span class="sdot ${bad ? "bad" : busy ? "busy" : ""}"></span><div class="grow"><b>${title}</b>${sub ? `<p>${sub}</p>` : ""}${extra}</div>${button ? `<span class="right">${button}</span>` : ""}</div>`;
const btn = (act, words, pri = true) => `<button class="btn ${pri ? "pri" : "ghost"} sm" type="button" data-act="${act}">${esc(words)}</button>`;
/* What is offered: a Beta change by its id, a Stable release by its version. */
const offered = (r) => (r?.channel === "beta" && r.commit ? r.commit.slice(0, 7) : r?.latestVersion ?? "");
const bridgeHere = () => Boolean(window.branchDesktop);

function statusCard(autoUpdate) {
  const s = updateNow() ?? channelStatus(), problem = lastLook.problem, waiting = waitingLine(), look = lastLook.plan;
  if (!s && !problem && !look) return "";
  if (installing(s)) {
    const running = s.stages.find((stage) => stage.state === "running");
    return card(`${esc(stageWords(running))}… <time data-upd-since="${esc(running.startedAt)}">${clock(Date.now() - Date.parse(running.startedAt))}</time>`,
      esc(targetWords(s)), { busy: true, button: btn("upd18-open", t("window.updates.card.show-progress"), false) });
  }
  if (s?.phase === "error" || problem?.message) {
    const reason = s?.phase === "error" ? s.message : problem.message, line = s?.phase === "error" ? s.failure?.line : null;
    const kept = s?.outcome ? `<p>${esc(t("window.updates.screen.kept", { version: s.outcome.kept }))}</p>` : "";
    return card(esc(t("window.updates.card.failed", { reason })), line ? `<code class="upd18-line">${esc(line)}</code>` : "",
      { bad: true, extra: kept, button: s?.release?.available ? btn("u-now", t("window.updates.card.try-again")) : btn("u-check", t("window.settings.updates.check-now"), false) });
  }
  if (waiting) {
    const tasks = holdingTasks().filter((task) => task.name);
    const open = tasks.length ? `<div class="acts">${tasks.map((task) => `<button class="btn sm" type="button" data-act="chat" data-id="${esc(task.sessionId)}">${esc(task.name)}</button>`).join("")}</div>` : "";
    // Moving to another line of work is offered only when it diverged, never to a copy already ahead of it (#441).
    const other = s?.release?.otherLine === true && s.release.standing === "apart" && s.release.commit
      ? `<button class="btn ghost sm" type="button" data-act="u-other" data-commit="${esc(s.release.commit)}">${esc(t("window.settings.updates.move-to-line"))}</button>` : "";
    return card(esc(waiting), esc(look?.until ? look.reason : s?.message ?? ""), { extra: open, button: other });
  }
  if (s?.phase === "checking") return card(esc(t("window.updates.card.checking")), "", { busy: true });
  if (s?.phase === "available" && s.release?.available) {
    const what = offered(s.release);
    return autoUpdate
      ? card(esc(t("window.updates.card.next-ready", { what })), esc(t("window.updates.card.installs-by-itself")), { button: btn("u-now", t("window.updates.card.update-now")) })
      : card(esc(t("window.updates.card.ready", { what })), "", { button: btn("u-now", t("window.updates.card.update-now")) });
  }
  if (s?.phase === "current") return card(esc(t("window.updates.card.up-to-date")), esc(s.message), { button: btn("u-check", t("window.settings.updates.check-now"), false) });
  if (s?.phase === "unsupported") return card(esc(s.message), "");
  const said = s?.message ?? look?.reason ?? "";
  return said ? card(esc(said), "", { button: btn("u-check", t("window.settings.updates.check-now"), false) }) : "";
}

function draw() {
  const s = E.state || {};
  const version = s.version;
  const autoUpdate = comfortData?.notify?.autoUpdate === "install";
  const beta = comfortData?.notify?.releaseChannel === "beta";

  let html = `<h1>${esc(t("settings.page.about"))}</h1>`;
  if (version) html += "<p class=\"lede\">Branch Agent " + esc(version) + ".</p>";
  if (!notOwner() && bridgeHere()) html += statusCard(autoUpdate);

  // The switch says how often it really looks: every five minutes on Beta, once a day on Stable (src/comfort/auto-update.ts).
  html += `<div class="sec upd18-self"><div class="ctl"><b>${t("comfort.update.install")}</b><input class="sw" type="checkbox" id="u-auto" ${autoUpdate ? "checked" : ""} aria-label="${t("comfort.update.install")}" data-sw="set"><small>${t(beta ? "window.updates.card.checks-every-few-minutes" : "window.settings.updates.checks-every-day")}</small></div></div>`;

  /* The rest, quieter: What's new (the notes this build ships, flows/whatsnew.js), undoing an update (greyed: it goes
     through the desktop app's own flow), the channel, and the copy of the data folder. */
  html += `<details class="adv upd18-more" id="u-more"${moreOpen ? " open" : ""}><summary>${esc(t("window.updates.card.more"))}</summary>`;
  html += `<div class="ctl"><b>${t("window.settings.updates.whats-new")}</b><span class="right"><button class="btn sm" type="button" data-act="whatsnew13">${t("window.settings.updates.whats-new")}</button></span><small></small></div>`;
  html += `<div class="ctl"><b>${t("window.settings.updates.undo-the-last-update")}</b><span class="right"><button class="btn sm" type="button" data-act="soon">${t("strip.undo")}</button></span><small></small></div>`;
  html += channelSection();
  html += "</details>";

  if (notOwner()) plan = null; // switched to a household person: the owner's survey is not shown
  const kept = (plan?.items ?? []).find((x) => !x.goes);
  html += `<div class=\"sec danger8\"><h2>${t("window.settings.updates.remove-branch")}</h2><div class=\"rows\">${removalRows()}`;
  html += `<div class=\"ctl\"><b>${t("danger.field.keep")}</b><input class=\"sw\" type=\"checkbox\" id=\"dz-keep\" aria-label=\"${t("danger.field.keep")}\" data-sw=\"set\"><small>${kept ? `${esc(t("danger.item.kept", { size: size(kept.bytes) }))}. ` : ""}${t("window.settings.updates.branch-finds-them-again-if-you")}</small></div>`;
  html += "</div>";
  html += `<div class=\"ctl\"><b>${t("danger.field.confirm")}</b><span class=\"right\"><input class=\"inp\" id=\"dz-confirm\" data-sw=\"set\" disabled autocomplete=\"off\" data-css=\"width:180px\" aria-label=\"${t("danger.field.confirm")}\"></span><small>${t("window.settings.updates.it-is-there-so-a-misclick")}</small></div>`;
  html += `<div class=\"acts\"><button class=\"btn dz\" type=\"button\" id=\"dz-go\" data-act=\"uninstall\" disabled>${t("danger.action.remove")}</button></div>`;
  html += "</div>";

  return html + updates17(level());
}

export { draw };
