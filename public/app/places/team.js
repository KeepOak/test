/* Team: people, shared work, usage, rules.
   The header follows the prototype's final renderTeam: "People", with the lede and the keepoak.com banner of the
   workspace's tabs (Live now, Teams of specialists, Activity, Usage, Rules), or the household lede and no banner (People,
   Groups, Shared, Signing in). The banner's Connect stays greyed: the engine does not reach keepoak.com.
   Live now: each task working on this computer (state.runs), under the person using Branch here (GET /api/profiles) and
   the Trunk whose conversation it is (its chatSessionId), else Branch's own assistant (state.identity); how long it has
   run, its model, and for a task with a plan (GET /api/runs/<id>/plan, read once when the tab opens) the step it is on
   and a meter; "shared" when the owner shares its conversation (the sign-in card's shares). Watch opens a read-only
   look at the task's steps (GET /api/runs/<id>/steps). Asking to join stays greyed (a keepoak.com team).
   People: the prototype's peopleTab, the same list and card as Settings › People (settings/pages/people.js peopleBody,
   from GET /api/profiles and the owner's sign-in card).
   Groups, Shared, Teams of specialists, Activity, Usage and Rules: places/team-tabs.js.
   Signing in: the prototype's signinTab, drawn from the owner's sign-in card (GET /api/people/settings: settings.mode,
   settings.chain, settings.sessionMinutes, waiting) and GET /api/profiles ownerPin; a profile always locks after five
   wrong PINs (src/profiles.ts maximumPinAttempts), so that switch only shows it. Who may sign in, how they prove it and
   how long they stay signed in are POST /api/people/settings {mode | chain | sessionMinutes} (it keeps the rest), and
   Confirm on a waiting account is POST /api/people/links/confirm {provider, profileId, subject}; both answer with the
   card again, which is drawn as the engine says. Only the owner reaches either (src/people/api.ts requireOwner, refused
   to short-lived keys). "Ask for my PIN when switching back to me" is wired in flows/people.js. The card is read when
   a tab that uses it is switched to or opened from Settings › People, and only the owner may read it. For anybody else
   the Signing in tab is not drawn at all (ownerHere(), the engine's isOwner): it is not theirs to use, not "coming soon". */

import { esc, render, renderNow } from "../core/dom.js";
import { S, E, personHere, ownerHere, ownName, trunkIntro, activeId, chatFace } from "../core/state.js";
import { face } from "../core/faces.js"; // your-profile
import { av, closePop, toast } from "../core/ui.js";
import { markLive } from "../core/features.js";
import { on } from "../core/actions.js";
import { tabBar } from "./parts.js";
import { ctl } from "../settings/parts.js";
import { people, peopleBody, startPeople, loadSignin } from "../settings/pages/people.js";
import { tabBody, readTab, setCard, initTeamTabs } from "./team-tabs.js";
import { api } from "../core/api.js";
import { t } from "../../i18n.js";
import { say } from "../core/words.js";
import { empty18 } from "../core/p18.js"; // pass 18: an empty list is a welcome
import { keepOakWorkspaceSection, initKeepOakWorkspace } from './keepoak-workspace.js';

const tabs = [["live", "Live now"], ["people", "People"], ["groups", "Groups"],
  ["shared", "Shared"], ["agents", "Teams of specialists"], ["activity", "Activity"],
  ["usage", "Usage"], ["rules", "Rules"], ["signin", "Signing in"]];
/* The workspace's tabs carry the keepoak.com banner and the "right now" lede; the household's the other lede. */
const WORKSPACE = new Set(["live", "agents", "activity", "usage", "rules"]);
/* The tabs drawn from the owner's sign-in card. */
const CARD = new Set(["live", "people", "groups", "shared", "activity", "signin"]);

const EYE = `<svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"></path><circle cx="12" cy="12" r="2.5"></circle></svg>`;
const firstLine = (text) => String(text ?? "").split("\n")[0].slice(0, 80);
/* The model a task used is the engine's {presetName, model, …} (src/server.ts modelUsed), named by its preset. Drawn
   as it was, it read "[object Object]". */
const modelName = (m) => (typeof m === "string" ? m : m?.presetName || m?.model || "");

function person() {
  const name = personHere();
  const version = E.state?.version ? ` · Branch ${esc(E.state.version)}` : "";
  return `${face(activeId(), { cls: "tav6", css: "--c:var(--accent);width:30px;height:30px;font-size:11px", extra: '<i class="st st-online"></i>' })}<span class="grow"><b>${esc(name)}</b><small>${t("window.places.team.this-computer-version", { version })}</small></span>`;
}

/* What a task is on: its conversation's opening, or for a Trunk's own conversation (which opens with the engine's ask,
   core/state.js trunkIntro) the task's own words, never that ask. */
const doing = (r, session) => {
  const said = ownName(r.sessionId) ? r.title ?? r.prompt : session?.opening || r.prompt; // DESIGN-DIRECTION PR 2: a room turn by its title
  return trunkIntro({ role: "user", content: said }) ? "" : firstLine(said);
};
const PLANS = new Map();
/* The step a task with a plan is on, as the prototype writes it, and how far through the plan it is. */
function planOf(r) {
  const steps = PLANS.get(r.id)?.steps ?? [];
  if (!steps.length) return null;
  const at = Math.max(0, steps.findIndex((s) => s.status === "working"));
  const done = steps.filter((s) => s.status === "done").length;
  return { line: t("window.places.team.step-n-of-count", { n: at + 1, count: steps.length, title: steps[at].title }), pct: Math.round((done / steps.length) * 100) };
}
const since = (r) => (r.createdAt ? t("window.chat.goal.minutes", { n: Math.max(1, Math.round((Date.now() - Date.parse(r.createdAt)) / 60000)) }) : "");
const shared = (r) => (card?.shares ?? []).some((x) => x.object === `conversation:${r.sessionId}`);
const trunkOf = (r) => (Array.isArray(E.trunks) ? E.trunks : []).find((tr) => tr.chatSessionId === r.sessionId);
const whoName = (r) => trunkOf(r)?.name ?? E.state?.identity?.name ?? "";

function liveRow(r) {
  const waiting = r.status === "needs_input";
  const trunk = trunkOf(r);
  const session = E.sessions.find((s) => (s.sessionId ?? s.id) === r.sessionId);
  const who = av(trunk ?? chatFace(r.sessionId), 30);
  const pill = waiting ? `<span class="pill work"><i></i>${t("window.places.team.waiting-for-them")}</span>` : `<span class="pill ok"><i></i>${t("window.shell.working")}</span>`;
  const plan = planOf(r);
  const small = [plan?.line, since(r), modelName(r.model)].filter(Boolean).join(" · ");
  const tag = shared(r) ? ` <span class="tag6">${t("window.places.team.shared-tag")}</span>` : "";
  return `<div class="run6 ${waiting ? "wait6" : ""}"><div class="run-h">${person()}${pill}</div>
    <div class="run-b">${who}<span class="grow"><b>${esc(whoName(r))}${tag}</b><span>${esc(doing(r, session))}</span>${small ? `<small>${esc(small)}</small>` : ""}${plan?.pct ? `<span class="meter6"><u data-css="width:${plan.pct}%"></u></span>` : ""}</span></div>
    <div class="acts"><button class="btn sm" type="button" data-act="run-watch" data-id="${esc(r.id)}">${EYE}${t("window.places.team.watch")}</button><button class="btn ghost sm" type="button" data-act="run-join">${t("window.places.team.ask-to-join")}</button></div></div>`;
}

const liveRuns = () => E.state.runs?.filter((r) => r.status === "running" || r.status === "needs_input") || [];
function liveTab() {
  const runs = liveRuns();
  return runs.length ? `<div class="runs6">${runs.map((r) => liveRow(r)).join("")}</div>` : empty18("team:live");
}
/* People: with nobody but the owner on this computer, the list says so under the owner's own card, with Invite. */
const peopleTab = () => peopleBody() + (ownerHere() && people().length === 1 ? empty18("team:people") : "");
/* Live now counts the tasks working here; People counts the rows its tab draws (everyone on this computer). */
const counts = () => ({ live: liveRuns().length, people: people().length });

let card = null, readFor = null;
const STAY = [[60, "1 hour"], [480, "8 hours"], [10080, "A week"]];
const PROVE = [["pin", "PIN"], ["passkey", "Passkey"], ["oidc", "An identity service"]];
/* The prototype's segmented control, with the engine's value pressed. */
const seg = (title, sub, opts, pressed, act) => `<div class="ctl"><b>${esc(title)}</b><span class="right"><span class="seg" role="group" aria-label="${esc(title)}">${opts.map(([v, l]) => `<button type="button" aria-pressed="${pressed(v)}" data-act="${act}" data-v="${esc(v)}">${esc(l)}</button>`).join("")}</span></span><small>${esc(sub)}</small></div>`;

function waitingRows(waiting) {
  if (!waiting?.length) return "";
  const name = (id) => E.profiles?.profiles?.find((p) => p.id === id)?.name ?? "";
  return `<div class="sec"><h2>${t("window.places.team.accounts-linked-by-email")}</h2>${waiting.map((w) => `<div class="prow"><span class="grow"><b>${esc(w.email)}</b><small>${t("window.places.team.wants-to-link-to-name-you", { name: esc(name(w.profileId)) })}</small></span><button class="btn sm" type="button" data-act="si-link" data-provider="${esc(w.provider)}" data-profile="${esc(w.profileId)}" data-subject="${esc(w.subject)}">${t("safety.codes.finish")}</button></div>`).join("")}</div>`;
}

function signinTab() {
  const s = card?.settings;
  if (!s || !ownerHere()) return "";
  const locks = true; // a profile always locks after five wrong PINs (src/profiles.ts maximumPinAttempts)
  return `${seg(t("people.admin.mode"), t("window.places.team.they-open-this-branchs-address-on"), [["off", t("accounts.switch.off")], ["when-needed", t("accounts.switch.when-needed")], ["on", t("accounts.switch.on")]], (v) => s.mode === v, "si-mode")}
    ${seg(t("window.places.team.how-they-prove-its-them"), t("window.places.team.everyone-passes-this-check"), PROVE.map(([v, l]) => [v, say(l)]), (v) => (s.chain ?? []).includes(v), "si-chain")}${seg(t("window.places.team.stay-signed-in-for"), t("window.places.team.then-they-sign-in-again"), STAY.map(([v, l]) => [v, say(l)]), (v) => s.sessionMinutes === v, "si-stay")}
    ${ctl("si-lock", t("window.places.team.lock-a-profile-after-five-wrong"), t("window.places.team.for-five-minutes"), locks)}${ctl("si-owner", t("window.places.team.ask-for-my-pin-when-switching"), t("window.places.team.off-by-default"), Boolean(E.profiles?.ownerPin))}
    ${waitingRows(card.waiting)}`;
}

/* A change to who may sign in; the engine answers with the whole card, which is drawn as it says. */
async function saveSignin(path, body) {
  try { card = await api(path, body); } catch (error) { toast(error.message); card = await loadSignin(); }
  setCard(card);
  render();
}
/* How they prove it's them: every person passes each check pressed; pressing one adds or takes it away. */
function toggleChain(v) {
  const now = card?.settings?.chain ?? [];
  return saveSignin("people/settings", { chain: now.includes(v) ? now.filter((x) => x !== v) : [...now, v] });
}

/* The card again after a group or a share changed, drawn at once. */
async function reloadCard() {
  card = await loadSignin();
  setCard(card);
  renderNow();
}

/* The plans of the tasks working now, read once each. */
async function readPlans() {
  const fresh = liveRuns().filter((r) => !PLANS.has(r.id));
  for (const r of fresh) PLANS.set(r.id, null);
  const got = await Promise.all(fresh.map((r) => api(`runs/${encodeURIComponent(r.id)}/plan`).then((x) => [r.id, x?.plan ?? null]).catch(() => [r.id, null])));
  for (const [id, plan] of got) PLANS.set(id, plan);
  return got.some(([, plan]) => plan?.steps?.length);
}

/* A tab's data, read once each time it is switched to (or opened from Settings › People), and again when Team is drawn
   more than half a minute after the last read (coming back to it); drawn again only when it changed. No timer of its own. */
let readAt = 0;
export async function after() {
  const tab = S.tabs.team || "live";
  if (readFor === tab && Date.now() - readAt < 30000) { if (tab === "live" && await readPlans()) render(); return; }
  readFor = tab;
  readAt = Date.now();
  let changed = false;
  if (CARD.has(tab) && ownerHere()) {
    const fresh = await loadSignin();
    if (JSON.stringify(fresh) !== JSON.stringify(card)) { card = fresh; changed = true; }
    setCard(card);
  }
  if (tab === "live") changed = (await readPlans()) || changed;
  changed = (await readTab(tab)) || changed;
  if (changed) render();
}

function head(tab) {
  const workspace = WORKSPACE.has(tab);
  const lede = workspace ? t("window.places.team.everyone-who-uses-branch-and-what") : t("window.places.team.everyone-who-uses-branch-on-this");
  const banner = workspace ? `<div class="ko-banner"><span class="ko-mark" aria-hidden="true"></span><span class="grow"><b>${t("window.places.team.your-keepoak-com-team-is-optional")}</b><small>${t("window.places.team.people-on-this-computer-and-on")}</small></span><button class="btn pri sm" type="button" data-act="ko-start">${t("action.connect")}</button></div>` : "";
  return `<div class="team-top"><h1>${t("people.admin.people")}</h1></div><p class="lede">${lede}</p>${banner}`;
}

export function draw() {
  const tab = S.tabs.team || "live";
  if (!E.state) return `<main class="main enter11" id="main"><div class="scroll"><div class="place"></div></div></main>`;

  let html = `<main class="main enter11" id="main"><div class="lock-banner"><svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l7.5 3v5.5c0 4.6-3.2 8.2-7.5 9.5-4.3-1.3-7.5-4.9-7.5-9.5V6z"></path></svg>${t("window.places.automations.lockdown-is-on-trunks-can-read")}<button type="button" data-act="lock">${t("lockdown.turnOff")}</button></div><div class="scroll"><div class="place">
      ${head(tab)}${keepOakWorkspaceSection()}
    ${tabBar(tabs.filter(([id]) => id !== "signin" || ownerHere()).map(([id, label]) => [id, say(label), counts()[id] ?? 0]), "team", tab)}`;

  if (tab === "live") html += liveTab();
  else if (tab === "people") html += peopleTab();
  else if (tab === "signin") html += signinTab();
  else html += tabBody(tab, card);

  html += `</div></div></main>`;
  return html;
}

export function init() {
  initKeepOakWorkspace();
  markLive(["ptab", "p-open-team", "si-mode", "si-chain", "si-stay", "si-link"]);
  on("si-mode", (el) => saveSignin("people/settings", { mode: el.dataset.v }));
  on("si-chain", (el) => toggleChain(el.dataset.v));
  on("si-stay", (el) => saveSignin("people/settings", { sessionMinutes: Number(el.dataset.v) }));
  on("si-link", (el) => saveSignin("people/links/confirm", { provider: el.dataset.provider, profileId: el.dataset.profile, subject: el.dataset.subject }));
  startPeople();
  initTeamTabs(reloadCard);
  /* From Settings › People: opens one of the Team tabs. */
  on("p-open-team", (el) => { S.view = "team"; S.tabs.team = el.dataset.v; readFor = null; closePop(); renderNow(); });
}
