/* Team: people, shared work, usage, rules (greyed until KeepOak connects).
   Live now: each task working on this computer (state.runs), under the person using Branch here (GET /api/profiles) and
   the Trunk whose conversation it is (its chatSessionId), else Branch's own assistant (state.identity). Watching, asking
   to join and inviting stay greyed.
   People: the prototype's peopleTab, the same list and card as Settings › People (settings/pages/people.js peopleBody,
   from GET /api/profiles and the owner's sign-in card).
   Signing in: the prototype's signinTab, drawn from the owner's sign-in card (GET /api/people/settings: settings.mode,
   settings.chain, settings.sessionMinutes, waiting) and GET /api/profiles ownerPin; a profile always locks after five
   wrong PINs (src/profiles.ts maximumPinAttempts), so that switch only shows it. Who may sign in, how they prove it and
   how long they stay signed in are POST /api/people/settings {mode | chain | sessionMinutes} (it keeps the rest), and
   Confirm on a waiting account is POST /api/people/links/confirm {provider, profileId, subject}; both answer with the
   card again, which is drawn as the engine says. Only the owner reaches either (src/people/api.ts requireOwner, refused
   to short-lived keys). "Ask for my PIN when switching back to me" is wired in flows/people.js. The card is read when
   either tab is switched to or opened from Settings › People, and only the owner may read it. For anybody else the
   Signing in tab is not drawn at all (ownerHere(), the engine's isOwner): it is not theirs to use, not "coming soon". */

import { esc, render, renderNow } from "../core/dom.js";
import { S, E, personHere, ownerHere, ownName, trunkIntro, activeId } from "../core/state.js";
import { face } from "../core/faces.js"; // your-profile
import { av, closePop, toast } from "../core/ui.js";
import { markLive } from "../core/features.js";
import { on } from "../core/actions.js";
import { tabBar } from "./parts.js";
import { ctl } from "../settings/parts.js";
import { people, peopleBody, startPeople, loadSignin } from "../settings/pages/people.js";
import { api } from "../core/api.js";
import { t } from "../../i18n.js";
import { say } from "../core/words.js";

const tabs = [["live", "Live now"], ["people", "People"], ["groups", "Groups"],
  ["shared", "Shared"], ["agents", "Teams of specialists"], ["activity", "Activity"],
  ["usage", "Usage"], ["rules", "Rules"], ["signin", "Signing in"]];

const EYE = `<svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"></path><circle cx="12" cy="12" r="2.5"></circle></svg>`;
const firstLine = (text) => String(text ?? "").split("\n")[0].slice(0, 80);

function person() {
  const name = personHere();
  const version = E.state?.version ? ` · Branch ${esc(E.state.version)}` : "";
  return `${face(activeId(), { cls: "tav6", css: "--c:var(--accent);width:30px;height:30px;font-size:11px", extra: '<i class="st st-online"></i>' })}<span class="grow"><b>${esc(name)}</b><small>${t("window.places.team.this-computer-version", { version })}</small></span>`;
}

/* What a task is on: its conversation's opening, or for a Trunk's own conversation (which opens with the engine's ask,
   core/state.js trunkIntro) the task's own words, never that ask. */
const doing = (r, session) => {
  const said = ownName(r.sessionId) ? r.prompt : session?.opening || r.prompt;
  return trunkIntro({ role: "user", content: said }) ? "" : firstLine(said);
};
function liveRow(r, i) {
  const waiting = r.status === "needs_input";
  const trunk = (Array.isArray(E.trunks) ? E.trunks : []).find((t) => t.chatSessionId === r.sessionId);
  const session = E.sessions.find((s) => (s.sessionId ?? s.id) === r.sessionId);
  const who = trunk ? av(trunk, 30) : av({ kind: "main" }, 30);
  const name = trunk?.name ?? E.state?.identity?.name ?? "";
  const pill = waiting ? `<span class="pill work"><i></i>${t("dashboard.needs.title")}</span>` : `<span class="pill ok"><i></i>${t("window.shell.working")}</span>`;
  return `<div class="run6 ${waiting ? "wait6" : ""}"><div class="run-h">${person()}${pill}</div>
    <div class="run-b">${who}<span class="grow"><b>${esc(name)}</b><span>${esc(doing(r, session))}</span>${r.model ? `<small>${esc(r.model)}</small>` : ""}</span></div>
    <div class="acts"><button class="btn sm" type="button" data-act="run-watch" data-i="${i}">${EYE}${t("window.places.team.watch")}</button><button class="btn ghost sm" type="button" data-act="toast">${t("window.places.team.ask-to-join")}</button></div></div>`;
}

const liveRuns = () => E.state.runs?.filter((r) => r.status === "running" || r.status === "needs_input") || [];
function liveTab() {
  return `<div class="runs6">${liveRuns().map(liveRow).join("")}</div>`;
}
/* Live now counts the tasks working here; People counts the rows its tab draws (everyone on this computer). */
const counts = () => ({ live: liveRuns().length, people: people().length });

let signin = null, signinFor = null;
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
  const s = signin?.settings;
  if (!s || !ownerHere()) return "";
  const locks = true; // a profile always locks after five wrong PINs (src/profiles.ts maximumPinAttempts)
  return `${seg(t("people.admin.mode"), t("window.places.team.they-open-this-branchs-address-on"), [["off", t("accounts.switch.off")], ["when-needed", t("accounts.switch.when-needed")], ["on", t("accounts.switch.on")]], (v) => s.mode === v, "si-mode")}
    ${seg(t("window.places.team.how-they-prove-its-them"), t("window.places.team.everyone-passes-this-check"), PROVE.map(([v, l]) => [v, say(l)]), (v) => (s.chain ?? []).includes(v), "si-chain")}${seg(t("window.places.team.stay-signed-in-for"), t("window.places.team.then-they-sign-in-again"), STAY.map(([v, l]) => [v, say(l)]), (v) => s.sessionMinutes === v, "si-stay")}
    ${ctl("si-lock", t("window.places.team.lock-a-profile-after-five-wrong"), t("window.places.team.for-five-minutes"), locks)}${ctl("si-owner", t("window.places.team.ask-for-my-pin-when-switching"), t("window.places.team.off-by-default"), Boolean(E.profiles?.ownerPin))}
    ${waitingRows(signin.waiting)}`;
}

/* A change to who may sign in; the engine answers with the whole card, which is drawn as it says. */
async function saveSignin(path, body) {
  try { signin = await api(path, body); } catch (error) { toast(error.message); signin = await loadSignin(); }
  render();
}
/* How they prove it's them: every person passes each check pressed; pressing one adds or takes it away. */
function toggleChain(v) {
  const now = signin?.settings?.chain ?? [];
  return saveSignin("people/settings", { chain: now.includes(v) ? now.filter((x) => x !== v) : [...now, v] });
}

/* The owner's sign-in card, read once each time People or Signing in is opened; drawn again only when it changed. */
export async function after() {
  const tab = S.tabs.team || "live";
  if (tab !== "people" && tab !== "signin") { signinFor = null; return; }
  if (signinFor === tab) return;
  signinFor = tab;
  const fresh = await loadSignin();
  if (JSON.stringify(fresh) !== JSON.stringify(signin)) { signin = fresh; render(); }
}

export function draw() {
  const tab = S.tabs.team || "live";
  if (!E.state) return `<main class="main enter11" id="main"><div class="scroll"><div class="place"></div></div></main>`;

  let html = `<main class="main enter11" id="main"><div class="lock-banner"><svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l7.5 3v5.5c0 4.6-3.2 8.2-7.5 9.5-4.3-1.3-7.5-4.9-7.5-9.5V6z"></path></svg>${t("window.places.automations.lockdown-is-on-trunks-can-read")}<button type="button" data-act="lock">${t("lockdown.turnOff")}</button></div><div class="scroll"><div class="place">
    <div class="team-top"><h1>${t("people.admin.people")}</h1></div>
    <p class="lede">${t("window.places.team.everyone-who-uses-branch-and-what")}</p>
    <div class="ko-banner"><span class="ko-mark" aria-hidden="true"></span><span class="grow"><b>${t("window.places.team.your-keepoak-com-team-is-optional")}</b><small>${t("window.places.team.people-on-this-computer-and-on")}</small></span><button class="btn pri sm" type="button" data-act="ko-start">${t("action.connect")}</button></div>
    ${tabBar(tabs.filter(([id]) => id !== "signin" || ownerHere()).map(([id, label]) => [id, say(label), counts()[id] ?? 0]), "team", tab)}`;

  if (tab === "live") html += liveTab();
  else if (tab === "people") html += peopleBody();
  else if (tab === "signin") html += signinTab();
  else html += `<div class="runs6"></div>`;

  html += `</div></div></main>`;
  return html;
}

export function init() {
  markLive(["ptab", "p-open-team", "si-mode", "si-chain", "si-stay", "si-link"]);
  on("si-mode", (el) => saveSignin("people/settings", { mode: el.dataset.v }));
  on("si-chain", (el) => toggleChain(el.dataset.v));
  on("si-stay", (el) => saveSignin("people/settings", { sessionMinutes: Number(el.dataset.v) }));
  on("si-link", (el) => saveSignin("people/links/confirm", { provider: el.dataset.provider, profileId: el.dataset.profile, subject: el.dataset.subject }));
  startPeople();
  /* From Settings › People: opens one of the Team tabs. */
  on("p-open-team", (el) => { S.view = "team"; S.tabs.team = el.dataset.v; signinFor = null; closePop(); renderNow(); });
}
