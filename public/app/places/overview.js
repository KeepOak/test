/* Overview: the prototype's renderOverview (Now, Health, Spend this week, Recent activity, Controls, Who is using Branch,
   Milestones) on the engine's data, given structure: a status summary on top (what is running, what waits, and health in
   one line with every check behind Details), then two columns sized to what they hold. Nothing is cut off: long words
   wrap. Tasks the engine marks `aside` in GET /api/state (what setup started, #386, and its own asks in a Trunk's
   conversation) are not activity and are left out. */

import { esc } from "../core/dom.js";
import { E, activeId, ownerHere, ownName, chatFace, needsYou } from "../core/state.js";
import { face, nameOf } from "../core/faces.js"; // your-profile
import { ic, av, toast } from "../core/ui.js";
import { markLive } from "../core/features.js";
import { api } from "../core/api.js";
import { renderNow } from "../core/dom.js";
import { recBar, updateCard } from "../chat/rec.js";
import { allPaused } from "../flows/pause.js";
import { look17, figure17 } from "../core/art17.js";
import { restOf } from "../core/sleep.js";
import { agentState } from "../chat/agent17.js";
import { modeLabel } from "../chat/chips.js";
import { lockdownOn } from "../chat/approvals.js";
import { t, language } from "../../i18n.js";
import { say } from "../core/words.js";
import { on, run } from "../core/actions.js";
import { FINISH, saveProgress } from "../flows/setup.js"; // pass 18c: the setup steps that wait on Overview
import { keepLines, loadKeep, initKeep } from "../flows/keep18.js"; // Keep it running: one line each to turn it off
import { nameField } from "../flows/profile.js"; // the owner's name, asked here now that setup is three steps
import { restoredTile, loadRestored, initRestored } from "./restored484.js"; // #484: Trunks a restore brought back cut down
import { canopyTile, loadCanopy, initCanopy } from "./canopy.js";

let lastHealthCheck = 0;
let cachedHealth = null;
let conversationMode = null;
let achievements = null;
let achievementsIn = "";

const formatSpend = (amount) => "$" + (amount ?? 0).toFixed(2);
/* A task's own words for a person: its whole first line (the section wraps it; nothing is cut off). */
const firstLine = (text) => String(text ?? "").split("\n")[0].trim();
/* Who a task was for: the Trunk or room whose conversation it is in, else Branch itself. */
const whoFor = (run) => ownName(run.sessionId) || E.state?.identity?.name || "";
const shown = () => (E.state.runs ?? []).filter((r) => !r.aside);

/* Pass 17: a running task in a Trunk's own conversation shows the character it wears, at work (chat/agent17.js). */
function liveFace(run) {
  const trunk = E.trunks.find((tr) => tr.chatSessionId === run.sessionId), look = look17(trunk?.character);
  if (!look) return av(chatFace(run.sessionId), 34);
  const st = agentState(trunk) === "idle" ? "work" : agentState(trunk);
  return `<span class="live-fig12" data-rk="t:${esc(trunk.id)}">${figure17(look, st, "", 56, restOf(`t:${trunk.id}`, st))}</span>`;
}

function nowPart() {
  const running = (E.state.runs ?? []).filter((r) => r.status === "running" || r.status === "needs_input");
  const waiting = needsYou(); // Q050: the engine's one count, never a task and its own question twice
  const rows = running.slice(0, 3).map((r) => `<button class="row" type="button" data-act="chat" data-id="${esc(r.sessionId || "")}"><span class="avw">${liveFace(r)}</span><b>${esc(whoFor(r))}</b>${r.aside ? "" : `<p>${esc(r.title ?? firstLine(r.prompt))}</p>`}</button>`).join("");
  const act = waiting ? `<button class="btn pri sm" type="button" data-act="view" data-v="inbox">${t("window.places.overview.answer-waiting-waiting", { waiting })}</button>` : `<span class="pill done"><i></i>${t("ov.calm")}</span>`;
  return `<div class="ovs-now"><h2>${t("dashboard.area.now")}</h2>${rows || `<p>${t("ov.now.none")}</p>`}<div class="acts">${act}</div></div>`;
}

/* GET /api/health in one line: "All N checks OK", or only the checks that need attention, each with what to do; every
   check, with the engine's own summary, sits behind Details. */
function healthPart() {
  const items = cachedHealth?.items ?? [];
  if (!items.length) return "";
  const bad = items.filter((i) => !i.ok);
  const check = (i) => `<div class="ovs-check"><span class="dot ${i.ok ? "" : "bad"}"></span><b>${esc(say(i.name || ""))}</b><span>${esc(say(i.summary || ""))}</span></div>`;
  const line = bad.length ? bad.map((i) => `${check(i)}${i.fix ? `<p class="ovs-fix">${esc(say(i.fix))}</p>` : ""}`).join("")
    : `<div class="ovs-check"><span class="dot"></span><b>${t("window.places.overview.all-checks-ok", { n: items.length })}</b></div>`;
  return `<div class="ovs-health"><h2>${t("dashboard.area.health")}</h2>${line}<details class="ovs-details"><summary>${t("window.places.overview.details")}</summary><div class="ovs-checks">${items.map(check).join("")}</div></details></div>`;
}

/* This week's tasks with a price, by who they were for (the prototype's bars); with none priced, a plain sentence. Every
   task counts here, the ones set aside from recent activity too: a helper's or an introduction's model calls are charged
   to its own task, and they cost the owner all the same. */
function spendTile() {
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const week = (E.state.runs ?? []).filter((r) => new Date(r.createdAt).getTime() > weekAgo);
  const priced = week.filter((r) => typeof r.cost?.amount === "number");
  const unpriced = week.filter((r) => typeof r.cost?.amount !== "number" && (r.cost?.model || r.model?.model)).length;
  const byWho = {};
  priced.forEach((r) => { byWho[whoFor(r)] = (byWho[whoFor(r)] || 0) + r.cost.amount; });
  const sorted = Object.entries(byWho).sort((a, b) => b[1] - a[1]).slice(0, 3);
  const most = Math.max(...sorted.map((e) => e[1]), 0.01);
  const bars = sorted.map(([who, cost]) => `<div class="brow"><span>${esc(who)}</span><span class="track"><u data-css="width:${(cost / most) * 100}%"></u></span><span class="v">${formatSpend(cost)}</span></div>`).join("");
  const note = unpriced ? `<p>${t("dashboard.spend.unpriced", { count: unpriced })}</p>` : priced.length ? "" : `<p>${t("dashboard.spend.noneTitle")}</p>`;
  const total = priced.length ? `<div class="big-n">${formatSpend(priced.reduce((sum, r) => sum + r.cost.amount, 0))}</div><div class="bars" data-css="margin:0">${bars}</div>` : "";
  return `<section class="tile"><h2>${t("window.places.overview.spend-this-week")}</h2>${total}${note}</section>`;
}

function duration(r) {
  const secs = r.updatedAt && r.createdAt ? Math.max(0, Math.round((new Date(r.updatedAt).getTime() - new Date(r.createdAt).getTime()) / 1000)) : 0;
  return Math.floor(secs / 60) > 0 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`;
}
function recentTile() {
  const rows = shown().slice(0, 4).map((r) => `<div class="ovs-act">${av(chatFace(r.sessionId), 20)}<span>${esc(r.title ?? firstLine(r.prompt))}</span><span class="ovs-dur">${duration(r)}</span></div>`).join("");
  return `<section class="tile"><h2>${t("window.places.overview.recent-activity")}</h2>${rows}<div class="acts"><button class="btn sm" type="button" data-act="ptab" data-place="inbox" data-v="history">${t("window.places.overview.all-history")}</button></div></section>`;
}

/* One mode, as the prototype's tile names it: Lockdown while it is on; else what a new conversation, a new Trunk and a new
   room start on (GET /api/conversation-mode newConversation, the chip's own words), or the owner's setting when they
   follow it (newConversation null). Lockdown's button is the prototype's: "Turn Lockdown off" while it is on. */
function modeName() {
  if (lockdownOn()) return t("lockdown.label");
  const cm = conversationMode;
  return cm ? (cm.newConversation ? modeLabel(cm.newConversation) : cm.following?.label ?? "") : "";
}

function controlsTile() {
  const locked = lockdownOn();
  return `<section class="tile"><h2>${t("dashboard.area.controls")}</h2><p>${t("window.places.overview.mode")} <b data-css="font-weight:600">${esc(modeName())}</b> · <button class="link" type="button" data-act="setgo" data-v="permissions">${t("window.places.overview.change")}</button></p><div class="acts"><button class="btn${locked ? "" : " bad"} sm" type="button" data-act="lock" aria-pressed="${locked}">${t(locked ? "dashboard.controls.lockdownOff" : "lockdown.label")}</button><button class="btn sm" type="button" data-act="pauseall">${allPaused() ? t("window.places.overview.resume-all-trunks") : t("window.places.overview.pause-all-trunks")}</button></div></section>`;
}

/* Everyone on this computer (GET /api/profiles: the owner, then each profile), as the prototype's tile lists them; the
   person here now is marked so. Switching person stays in the person menu, greyed. */
function usersTile() {
  const everyone = [null, ...(E.profiles?.profiles ?? []).map((p) => p.id)]; // your-profile: each person's own face and name
  const rows = everyone.map((id) => `<div class="ovs-who">${face(id, { css: "width:26px;height:26px;font-size:11px" })}<span>${esc(nameOf(id))}</span>${activeId() === id ? `<span class="ovs-here">${t("window.places.overview.here-now")}</span>` : ""}</div>`).join("");
  return `<section class="tile"><h2>${t("strip.who")}</h2>${rows}${ownerHere() ? `<div class="acts"><button class="btn sm" type="button" data-act="invite">${t("household.invite")}</button></div>` : ""}</section>`;
}

function milestonesTile() {
  /* GET /api/delight/achievements: the ones earned first, then the next ones it names, four in all. */
  const list = (achievements?.list ?? []).filter((a) => a.name && a.name !== "???");
  const four = [...list.filter((a) => a.got), ...list.filter((a) => !a.got)].slice(0, 4);
  if (!four.length) return "";
  const count = four.filter((a) => a.got).length;
  const badges = four.map((a) => {
    const tip = a.got ?? (typeof a.now === "number" ? t("delight.ach.progress", { now: a.now, goal: a.goal }) : "");
    return `<span class="badge ${a.got ? "" : "locked"}" title="${esc(tip)}"><span class="bi">${ic(a.got ? "star" : "lock", "s")}</span>${esc(a.name)}</span>`;
  }).join("");
  return `<section class="tile"><h2>${t("window.places.overview.milestones")}</h2><div class="badges">${badges}</div><p>${t("window.places.overview.count-of-count2-just-for-fun", { count, count2: four.length })}</p></section>`;
}

/* Pass 18c, "Finish setting up": the setup steps the three-step wizard leaves for later, each ticked only when the
   engine's setup record (GET /api/state onboarding.completed) has it as done. The owner's alone; gone once hidden
   (onboarding.finishHidden) or once every step is done. Each: [its name, its line, where Open goes].
   What setup's old steps did for a new person stays one tap away in its row: Keep it running has a line each to turn off
   the gateway, starting at sign-in and updating by itself (on for a new install, src/keep-running.ts; flows/keep18.js),
   People asks the owner's name (flows/profile.js nameField, POST /api/profiles/owner/about), and Reach it anywhere
   pairs a phone (flows/pair.js "pair"). */
const FIN = {
  where: ["window.flows.setup.step-where", "window.p18.ob.fin-where", "general"],
  yours: ["window.flows.setup.step-yours", "window.p18.ob.fin-yours", "appearance"],
  reach: ["window.flows.setup.step-reach", "window.p18.ob.fin-reach", "chatapps"],
  tools: ["dashboard.filter.tools", "window.p18.ob.fin-tools", "tools"],
  keep: ["window.flows.setup.step-keep", "window.shell.shell.the-gateway-keeps-branch-running-in", "gateway"],
  people: ["people.admin.people", "window.p18.ob.fin-people", "people"],
  more: ["window.flows.setup.step-more", "window.p18.ob.fin-more", "accounts"],
  check: ["settings.card.health-check", "window.p18.ob.fin-check", "self"],
};
const EXTRA = {
  keep: () => keepLines(),
  people: () => nameField(),
  reach: () => `<button class="btn sm" type="button" data-act="pair">${ic("phone", "s")}${t("studio.tab.phone")}</button>`,
};
function finishShown() {
  const p = E.state?.onboarding;
  if (!p?.mine || p.finishHidden) return false;
  return FINISH.some((id) => !(p.completed ?? []).includes(id));
}
function finishTile() {
  if (!finishShown()) return "";
  const completed = new Set(E.state.onboarding.completed ?? []);
  const done = FINISH.filter((id) => completed.has(id)).length;
  const row = (id) => {
    const [name, line] = FIN[id], ok = completed.has(id);
    return `<li class="${ok ? "ok18" : ""}"><span class="tick18">${ok ? ic("check", "s") : ""}</span><div class="grow"><b>${t(name)}</b><small>${t(line)}</small>${EXTRA[id]?.() ?? ""}</div>${ok ? "" : `<button class="btn sm" type="button" data-act="fin18c" data-v="${esc(id)}">${t("ov.open")}</button>`}</li>`;
  };
  return `<div class="tile fin18c"><div class="th"><b>${t("window.p18.ob.fin-title")}</b><span class="hint ml">${t("window.shell.shell.steps-done", { done, total: FINISH.length })}</span><button class="btn ghost sm" type="button" data-act="finhide18c">${t("goal.action.dismiss")}</button></div><p>${t("window.p18.ob.fin-lede")}</p><ol>${FINISH.map(row).join("")}</ol></div>`;
}

/* Open: the engine records the step as done, then its page opens the way the window opens any Settings page (setgo)
   or Customize tab (ptab). A refused write says why and still opens the page. */
async function openFinishStep(id) {
  const to = FIN[id]?.[2];
  if (!to || !FINISH.includes(id)) return;
  await saveProgress({ completed: [id] }).catch((error) => toast(error.message));
  if (to === "tools") run("ptab", { dataset: { place: "customize", v: "tools" } });
  else run("setgo", { dataset: { v: to } });
}

/* Hide: kept in the engine's record, so the card stays away on every window and after a restart. */
async function hideFinish() {
  try { await saveProgress({ finishHidden: true }); } catch (error) { toast(error.message); return; }
  renderNow();
  toast(t("window.p18.ob.hidden"));
}

export function draw() {
  if (!E.state) return `<main class="main enter11" id="main"><div class="scroll"><div class="place"></div></div></main>`;
  return `<main class="main enter11" id="main"><div class="lock-banner"><svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l7.5 3v5.5c0 4.6-3.2 8.2-7.5 9.5-4.3-1.3-7.5-4.9-7.5-9.5V6z"></path></svg>${t("window.places.automations.lockdown-is-on-trunks-can-read")}<button type="button" data-act="lock">${t("lockdown.turnOff")}</button></div><div class="scroll"><div class="place ovs" data-css="max-width:1000px">
    ${recBar()}${updateCard()}
    <h1>${t("strip.menu.overview")}</h1><p class="lede">${t("window.places.overview.whats-happening-across-your-trunks-at")} <button class="link15 wc-go" type="button" data-act="whatcan">${t("window.what.title")}</button></p>
    ${finishTile()}${restoredTile()}<section class="tile ovs-status">${nowPart()}${healthPart()}</section>${canopyTile()}
    <div class="ovs-cols"><div class="ovs-col">${recentTile()}${milestonesTile()}</div><div class="ovs-col">${spendTile()}${controlsTile()}${usersTile()}</div></div>
  </div></div></main>`;
}

export function init() {
  markLive(["ptab", "chat", "fin18c", "finhide18c"]);
  on("fin18c", (el) => openFinishStep(el.dataset.v));
  on("finhide18c", () => hideFinish());
  initKeep();
  initRestored();
  initCanopy();
}

export async function after() {
  let needsRender = false;
  const now = Date.now();

  // Health check: at most every 30 seconds
  if (now - lastHealthCheck > 30000) {
    lastHealthCheck = now;
    const health = await api("health").catch(() => null);
    if (health && JSON.stringify(health?.items) !== JSON.stringify(cachedHealth?.items)) {
      cachedHealth = health;
      needsRender = true;
    }
  }

  // What new conversations start on, read each time Overview is drawn: it changes from setup and the owner's setting
  const mode = await api("conversation-mode").catch(() => null);
  if (mode && JSON.stringify(mode) !== JSON.stringify(conversationMode)) { conversationMode = mode; needsRender = true; }

  // Fetch achievements if not yet cached, or cached in another language (their names are the engine's words)
  if (!achievements || achievementsIn !== language()) {
    achievementsIn = language();
    achievements = await api(`delight/achievements?lang=${achievementsIn}`).catch(() => null);
    if (achievements) needsRender = true;
  }

  // Keep it running's lines in "Finish setting up", read while that card is shown
  if (finishShown() && await loadKeep()) needsRender = true;
  if (await loadRestored()) needsRender = true; // #484
  if (await loadCanopy()) needsRender = true;

  if (needsRender) renderNow();
}
