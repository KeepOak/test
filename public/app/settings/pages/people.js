/* Settings › People, 1:1 with the prototype's card, from the engine's own list (GET /api/profiles): you, the owner,
   then everyone with a profile on this computer, each with the role and what the role lets them have Branch do
   (roles[].effective, roles[].categories). Picking a person to look at is window state. Switching person, roles,
   one-time codes, signing out and removing somebody are wired in flows/people.js, through the engine's own guards.
   The same list and card are Team › People (places/team.js draws peopleBody()), both from the list the window holds
   (E.profiles, the same GET /api/profiles, read again when this page opens). "Signed in on" names the devices each
   person is signed in on now, from the owner's sign-in card (GET /api/people/settings people[].signedIn[].device).
   A person's Trunks are the Trunks in the rooms they were let into (GET /api/trunks rooms[].people and members, named
   from the Trunk list; a household person's own answer names them in rooms[].roster). Only the owner is offered the
   owner-only actions (invite, role, one-time code, signing out, removing, signing in from other devices); for anybody
   else they are not drawn at all (ownerHere(), the engine's isOwner). */
import { esc, render } from "../../core/dom.js";
import { api } from "../../core/api.js";
import { on, has } from "../../core/actions.js";
import { markLive } from "../../core/features.js";
import { toast } from "../../core/ui.js";
import { E, refresh, ownerHere, roleLabel } from "../../core/state.js";
import { people17 } from "../p17-more.js";
import { face, nameOf } from "../../core/faces.js"; // your-profile
import { level as level17 } from "../../core/state.js";
import { t, language } from "../../../i18n.js";
import { say } from "../../core/words.js";

/* The prototype's words for the engine's seven kinds (src/tool-categories.ts), in the prototype's order. */
const KINDS = [["read", "Look things up"], ["browse", "Use web pages"], ["files", "Write files"], ["commands", "Run commands"], ["message", "Send messages"], ["spend", "Spend money"], ["settings", "Change how Branch is set up"]];
const OWNER = "owner";

/* The owner's sign-in card (GET /api/people/settings), or null until read; only the owner may read it. */
let signin = null;
/* Who is being looked at: as in the prototype, somebody other than you when there is anybody else. */
let picked = null;
const profiles = () => E.profiles;

function pickDefault() {
  const ids = (profiles()?.profiles ?? []).map((p) => p.id);
  if (picked !== OWNER && !ids.includes(picked)) picked = ids[0] ?? OWNER;
}

/* The owner's sign-in card, shared with Team › Signing in. Answers what the engine said, or null when it refused. */
export async function loadSignin() {
  if (!ownerHere()) { signin = null; return signin; }
  try { signin = await api("people/settings"); } catch (error) { toast(error.message); }
  return signin;
}

/* The profiles, and the rooms and Trunks with them: a person's card names the Trunks in the rooms they were let into. */
async function loadProfiles() {
  try { await refresh(); } catch (error) { toast(error.message); }
  await loadSignin();
  render();
}

const label = (role) => roleLabel(role);
const roleOf = (id) => (profiles()?.roles ?? []).find((r) => r.profileId === id);

/* Everyone on this computer: the owner first, then each profile the engine keeps. */
export function people() {
  const data = profiles();
  if (!data) return [];
  const owner = { id: OWNER, name: nameOf(null), role: OWNER, you: data.isOwner }; // your-profile: the owner's own name once given
  return [owner, ...(data.profiles ?? []).map((p) => ({ id: p.id, name: p.name, role: roleOf(p.id)?.grant?.role ?? "adult", lastUsedAt: p.lastUsedAt, you: (data.active?.id ?? data.active) === p.id }))];
}
/* The devices a person is signed in on now, as the owner's sign-in card lists them. */
const devices = (id) => [...new Set((signin?.people ?? []).find((x) => x.id === id)?.signedIn?.map((k) => k.device).filter(Boolean) ?? [])];

/* your-profile: each person's own face (core/faces.js), the owner's too. */
const avatar = (p, size, font) => face(p.id === OWNER ? null : p.id, { cls: "tav6", css: `--c:#56616B;width:${size}px;height:${size}px;font-size:${font}px` });
/* The weekday within the last week, as the prototype writes it ("Sun"); the date before that. */
const when = (at) => {
  if (!at) return "";
  const d = new Date(at);
  return d.toLocaleDateString(language(), Date.now() - d.getTime() < 6 * 86400000 ? { weekday: "short" } : { day: "numeric", month: "short" });
};

function item(p) {
  const small = [label(p.role), p.lastUsedAt ? t("window.settings.people.last-used-when", { when: when(p.lastUsedAt) }) : ""].filter(Boolean).join(" · ");
  return `<button type="button" class="t9-item" data-act="p-sel" data-v="${esc(p.id)}" aria-current="${picked === p.id}">${avatar(p, 34, 13)}<span class="grow"><b>${esc(p.name)}${p.you ? ` · ${t("window.settings.people.you")}` : ""}</b><small>${esc(small)}</small></span></button>`;
}

function list(all) {
  const invite = ownerHere() ? `<button type="button" class="btn pri" data-css="margin-top:10px;justify-self:start" data-act="p-invite"><svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg>${t("household.invite")}</button>` : "";
  return `<div class="t9-list">${all.length ? `<div class="grp8">${t("glance.local")}</div>${all.map(item).join("")}` : ""}${invite}</div>`;
}

/* What the person may have Branch do: the engine's effective kinds for a profile, every kind for the owner. */
function mayRows(p) {
  const kinds = p.id === OWNER ? KINDS.map(([k]) => k) : roleOf(p.id)?.categories ?? [];
  return KINDS.map(([k, l]) => { const yes = kinds.includes(k); return `<label class="chk ${yes ? "" : "no10"}"><input type="checkbox" ${yes ? "checked" : ""} disabled aria-label="${esc(say(l))}"> ${esc(say(l))}</label>`; }).join("");
}

/* The Trunks in the rooms this person was let into, each once, in the order the rooms seat them. The owner's answer seats
   Trunks by id (members, named from E.trunks); a household person's names them (roster). A Trunk with no name is left out. */
function trunksOf(id) {
  const named = new Map((Array.isArray(E.trunks) ? E.trunks : []).map((t) => [t.id, t.name]));
  const names = [];
  for (const room of E.rooms ?? []) {
    if (!(room.people ?? []).includes(id)) continue;
    const seated = room.roster ?? (room.members ?? []).map((m) => ({ name: named.get(m) }));
    for (const one of seated) if (one?.name && !names.includes(one.name)) names.push(one.name);
  }
  return names;
}

function facts(p) {
  // Whole dollars as the prototype writes them ("$5 a day"), cents when there are any ("$2.50 a day").
  const money = (n) => `$${Number.isInteger(n) ? n : Number(n).toFixed(2)}`;
  if (p.id === OWNER) return `<dt>${t("settingsDirectory.trunks")}</dt><dd>${t("look.filter.all")}</dd><dt>${t("memory.movein.kind.project")}</dt><dd>${t("look.filter.all")}</dd><dt>${t("household.allowance")}</dt><dd>${t("window.settings.people.no-limit")}</dd><dt>PIN</dt><dd>${profiles()?.ownerPin ? t("household.pin.isSet") : "—"}</dd><dt>${t("household.devices")}</dt><dd>${t("dashboard.computer.title")}</dd>`;
  const g = roleOf(p.id)?.effective ?? roleOf(p.id)?.grant ?? {};
  const projects = (g.projects ?? []).length ? g.projects.join(", ") : t("look.filter.all");
  const allowance = g.dailySpendLimit > 0 ? t("window.settings.people.amount-a-day", { amount: money(g.dailySpendLimit) }) : t("window.settings.people.no-limit");
  const on = devices(p.id), trunks = trunksOf(p.id);
  return `<dt>${t("settingsDirectory.trunks")}</dt><dd>${trunks.length ? esc(trunks.join(", ")) : "—"}</dd><dt>${t("memory.movein.kind.project")}</dt><dd>${esc(projects)}</dd><dt>${t("household.allowance")}</dt><dd>${esc(allowance)}</dd><dt>PIN</dt><dd>${t("household.pin.isSet")}</dd>${on.length ? `<dt>${t("household.devices")}</dt><dd>${esc(on.join(", "))}</dd>` : ""}`;
}

/* Switching to somebody is anybody's, with that person's PIN (never to yourself); the rest only the owner is offered. */
function actions(p) {
  const owner = ownerHere();
  const mine = p.you ? `<div class="acts" data-css="margin-top:14px"><button class="btn sm" type="button" data-act="yp-open">${t("window.profile.title")}</button></div>` : ""; // your-profile
  if (p.id === OWNER) return owner ? `<p class="hint">${t("window.settings.people.youre-the-owner-only-you-change")}</p>${mine}` : "";
  if (p.you) return mine;
  const first = String(p.name ?? "").split(" ")[0];
  const switchTo = p.you ? "" : `<button class="btn sm" type="button" data-act="p-switch" data-v="${esc(p.id)}">${t("household.switchTo", { name: esc(first) })}</button>`;
  if (!owner) return switchTo ? `<div class="acts" data-css="margin-top:14px">${switchTo}</div>` : "";
  const roles = ["adult", "child"].map((r) => `<button type="button" data-act="p-role" data-v="${r}" data-id="${esc(p.id)}" aria-pressed="${p.role === r}">${esc(label(r))}</button>`).join("");
  return `<div class="acts" data-css="margin-top:14px">${switchTo}<span class="seg">${roles}</span><button class="btn ghost sm" type="button" data-act="p-code" data-id="${esc(p.id)}">${t("people.admin.code")}</button><button class="btn ghost sm" type="button" data-act="p-signout" data-id="${esc(p.id)}">${t("people.admin.sign-out")}</button><button class="btn ghost sm" type="button" data-act="p-remove" data-id="${esc(p.id)}">${t("accounts.action.remove")}</button></div>`;
}

function card(p) {
  if (!p) return "";
  const where = p.id === OWNER ? t("dashboard.computer.title") : t("window.settings.people.this-computer-pin");
  return `<div class="t9-detail pcard10"><div class="t9-dh">${avatar(p, 44, 17)}<span class="grow"><b>${esc(p.name)}</b><small>${where}</small></span><span class="pill ${p.role === OWNER ? "ok" : "idle"}">${esc(label(p.role))}</span></div>
    <div class="sec"><h2>${t("window.settings.people.may")}</h2><div class="acts10">${mayRows(p)}</div></div>
    <dl class="kv" data-css="margin-top:14px">${facts(p)}</dl>${actions(p)}</div>`;
}

/* Both are how the engine always works (greyed: PINs are for review): a profile cannot be made without a PIN
   (ProfileSchema), and each profile's records are its own (profiles.scope()). */
function eachPerson() {
  const pin = `<input class="sw" type="checkbox" id="pp-pin" checked aria-label="${t("window.settings.people.ask-for-a-pin-when-switching")}" data-sw="set">`; // state: every profile has a PIN
  const own = `<input class="sw" type="checkbox" id="pp-own" checked aria-label="${t("window.settings.people.keep-conversations-separate")}" data-sw="set">`; // state: each profile's records are its own
  return `<div class="sec"><h2>${t("window.settings.people.each-person")}</h2><div class="ctl"><b>${t("window.settings.people.ask-for-a-pin-when-switching")}</b>${pin}<small>${t("window.settings.people.four-to-eight-digits-kept-on")}</small></div><div class="ctl"><b>${t("window.settings.people.keep-conversations-separate")}</b>${own}<small>${t("window.settings.people.people-cant-read-each-others-conversations")}</small></div></div>`;
}

/* The prototype's peopleTab(): the list, the card of whoever is picked, and the hint. Settings › People and Team › People. */
export function peopleBody() {
  pickDefault();
  const all = people();
  return `<div class="t10">${list(all)}${card(all.find((p) => p.id === picked))}</div>
    <p class="hint">${t("window.settings.people.separation-on-one-computer-not-separate")}</p>`;
}

export function draw() {
  return `<h1>${t("people.admin.people")}</h1><p class="lede">${t("window.settings.people.everyone-who-uses-branch-on-this")}</p>
  ${peopleBody()}
  ${eachPerson()}
  <div class="acts" data-css="margin-top:12px"><button class="btn ghost sm" type="button" data-act="p-open-team" data-v="groups">${t("people.admin.groups")}</button>${ownerHere() ? `<button class="btn ghost sm" type="button" data-act="p-open-team" data-v="signin">${t("people.admin.title")}</button>` : ""}<button class="btn ghost sm" type="button" data-act="p-open-team" data-v="shared">${t("window.settings.people.what-you-share")}</button></div>${people17(level17())}`;
}

export function load() { return loadProfiles(); }

/* flows/people.js: after adding somebody, the card shows them. */
export function pickPerson(id) { picked = id; }

/* Picking whom to look at, for both pages; registered once, by whichever starts first. */
export function startPeople() {
  if (has("p-sel")) return;
  on("p-sel", (el) => { picked = el.dataset.v; render(); });
  markLive(["p-sel"]);
}

export function init() {
  loadProfiles();
  startPeople();
}

export const live = { "p-sel": true };
