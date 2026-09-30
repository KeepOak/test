/* Who is using Branch, 1:1 with the prototype, against the engine's household routes (src/collab-server.ts,
   src/profiles.ts, src/people/api.ts). The engine keeps every guard: switching to a person needs that person's PIN,
   switching back to the owner needs the owner's PIN once it is set, and only the owner adds people, sets roles, makes
   one-time codes, signs people out or removes them (requireOwner, the household route table, the short-lived-key table).
   The window only asks for what the engine asks for and shows the engine's refusal as it is.
   A PIN is read from its field once, the field is emptied, and it goes straight to the engine: it is never kept in a
   variable beyond that call, saved, drawn back or written to the console.
     switchto (the person menu), p-switch (the person's card) and pin-ok: POST /api/profiles/switch {profileId, pin}.
     invite, p-invite, p-inv-tab, p-inv-role, p-inv-go: the invite dialog; "On this computer" is POST /api/profiles
       {name, pin, role}; "On their own device" adds them the same way, then shows the engine's one-time code (POST
       /api/people/<id>/reset-code) and the sign-in page's address. keepoak.com teams stay greyed (no keepoak.com).
     si-owner (Team › Signing in, "Ask for my PIN when switching back to me") and owner-pin-set: POST
       /api/profiles/owner-pin {pin} to set it, {pin: null} to switch it off. The engine asks for it on every switch back
       once it is set, so setting it is what turns the switch on.
     QA Q001: every way of adding somebody (Team, Settings › People, the person menu, Overview, where setup's
       People step now waits) opens the one invite dialog, which asks for the owner's own PIN too while none is set; left empty,
       it says plainly that anyone at this computer can switch back to the owner. A household already here with no owner
       PIN gets one notice in the person menu (owner-pin-ask, owner-pin-later), until a PIN is set or "Not now".
       Switching back re-reads GET /api/profiles first, so a PIN set elsewhere is always asked for.
     p-role: POST /api/profiles/<id>/role {role}. p-code: POST /api/people/<id>/reset-code. p-signout: POST
       /api/people/<id>/sign-out. p-remove: POST /api/profiles/<id>/remove. */
import { $, esc, render, renderNow } from "../core/dom.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { openDlg, closeDlg, closePop, toast } from "../core/ui.js";
import { S, E, activeId, ownerHere, roleLabel } from "../core/state.js";
import { pickPerson } from "../settings/pages/people.js";
import { nameOf } from "../core/faces.js";
import { t } from "../../i18n.js";

const ownerName = () => nameOf(null); // your-profile: the owner's own name once given, else the role's
const personOf = (id) => (E.profiles?.profiles ?? []).find((p) => p.id === id);
const first = (name) => String(name ?? "").split(" ")[0];
const PIN = /^\d{4,8}$/;

async function reread() {
  try { E.profiles = await api("profiles"); } catch (error) { toast(error.message); }
  render();
}

/* ---------- switching person ---------- */

/* The PIN field, as the prototype draws it; four to eight digits, as the engine takes them. */
const pinField = '<div class="field"><label for="pin-try">PIN</label><input class="inp" id="pin-try" type="password" inputmode="numeric" maxlength="8" autocomplete="off"></div>';

/* Back to the owner asks for the owner's PIN only when the engine says one is set; a person always has a PIN. */
function askPin(id, from) {
  if (id === null) {
    const owner = ownerName();
    return openDlg({ title: "The owner’s PIN", body: `<p data-css="margin:0;color:var(--ink-2)">Switching back to ${esc(owner)} asks for this PIN. Five wrong tries wait five minutes.</p>${pinField}`,
      foot: `<button class="btn ghost" type="button" data-act="dlg-close">Cancel</button><button class="btn pri" type="button" data-act="pin-ok" data-v="" data-from="${esc(from)}">Back to ${esc(owner)}</button>` });
  }
  const person = personOf(id);
  if (!person) return;
  openDlg({ title: person.name, body: `<p data-css="margin:0;color:var(--ink-2)">Four to eight digits, kept on this computer. Five wrong tries lock the profile for five minutes.</p>${pinField}`,
    foot: `<button class="btn ghost" type="button" data-act="dlg-close">Cancel</button><button class="btn pri" type="button" data-act="pin-ok" data-v="${esc(id)}" data-from="${esc(from)}">Switch to ${esc(first(person.name))}</button>` });
}

async function startSwitch(el, from) {
  closePop();
  const id = el.dataset.v || null;
  if (id === activeId()) return;
  if (id === null) {
    // What the engine says now, not what this window read earlier: a PIN set since is asked for.
    try { E.profiles = await api("profiles"); } catch (error) { toast(error.message); return; }
    if (!E.profiles?.ownerPin) return switchTo(null, undefined, from);
  }
  askPin(id, from);
}

/* The window starts again as the new person once the engine answers (main.js watchPerson reads GET /api/profiles). */
async function switchTo(id, pin, from) {
  const name = id === null ? ownerName() : personOf(id)?.name ?? "";
  try {
    await api("profiles/switch", pin === undefined ? { profileId: id } : { profileId: id, pin });
  } catch (error) { toast(error.message); return false; }
  closeDlg();
  if (id === null) toast(`Welcome back, ${ownerName()}.`);
  else toast(from === "card" ? `Switched to ${first(name)}. Their conversations only.` : `Switched to ${name}.`);
  await reread();
  return true;
}

function pinOk(el) {
  const field = $("#pin-try");
  const typed = field?.value ?? "";
  if (field) field.value = "";
  if (!PIN.test(typed)) { field?.setAttribute("aria-invalid", "true"); return; }
  field?.removeAttribute("aria-invalid");
  switchTo(el.dataset.v || null, typed, el.dataset.from);
}

/* ---------- the owner's PIN for switching back ---------- */

/* Turning it on asks for the PIN the engine needs; the switch then shows what the engine says (E.profiles.ownerPin). */
function ownerPinSwitch(e) {
  if (e.target.id !== "si-owner") return;
  const on = e.target.checked;
  e.target.checked = !on;
  if (!on) return saveOwnerPin(null);
  ownerPinDlg();
}

function ownerPinDlg() {
  closePop();
  const owner = ownerName();
  openDlg({ title: "The owner’s PIN", body: `<p data-css="margin:0;color:var(--ink-2)">Switching back to ${esc(owner)} asks for this PIN. Five wrong tries wait five minutes.</p><div class="field"><label for="owner-pin-new">PIN</label><input class="inp" id="owner-pin-new" type="password" inputmode="numeric" maxlength="8" autocomplete="off"></div>`,
    foot: '<button class="btn ghost" type="button" data-act="dlg-close">Cancel</button><button class="btn pri" type="button" data-act="owner-pin-set">Save</button>' });
}

/* ---------- QA Q001: a household here and no owner PIN ---------- */

/* "Not now" is remembered in this window only; setting a PIN ends the notice everywhere. */
const NOTICE = "branch-owner-pin-notice";
const noticeSeen = () => { try { return localStorage.getItem(NOTICE) === "seen"; } catch { return false; } };

/* True when the owner is here, somebody else uses this computer, no owner PIN is set, and the notice was not put away. */
export function pinNoticeDue() {
  return ownerHere() && !E.profiles?.ownerPin && (E.profiles?.profiles ?? []).length > 0 && !noticeSeen();
}

function noticeLater() {
  try { localStorage.setItem(NOTICE, "seen"); } catch (error) { toast(error.message); }
  closePop();
  render();
}

function ownerPinSet() {
  const field = $("#owner-pin-new");
  const typed = field?.value ?? "";
  if (field) field.value = "";
  if (!PIN.test(typed)) { field?.setAttribute("aria-invalid", "true"); return; }
  saveOwnerPin(typed);
}

async function saveOwnerPin(pin) {
  try { await api("profiles/owner-pin", { pin }); closeDlg(); } catch (error) { toast(error.message); }
  await reread();
}

/* ---------- inviting someone ---------- */

/* The tab in force. "On this computer" and "On their own device" both add the person with the engine's POST /api/profiles
   (the engine asks for a PIN either way); their own device then gets the engine's one-time code (POST
   /api/people/<id>/reset-code: once, for fifteen minutes) and the address of this Branch's sign-in page. keepoak.com teams
   stay greyed with their reason: the engine reaches no keepoak.com. */
const INV = { tab: "this", busy: false };
const HOW = [["this", "On this computer"], ["device", "On their own device"], ["keepoak", "From your keepoak.com team"]];
const tabs = () => HOW.map(([v, l]) => (v === "keepoak"
  ? `<button class="tab" type="button" aria-selected="false" data-why="p-inv-keepoak" data-act="p-inv-ko" data-v="${v}">${l}</button>`
  : `<button class="tab" type="button" aria-selected="${INV.tab === v}" data-act="p-inv-tab" data-v="${v}">${l}</button>`)).join("");

/* While the owner has no PIN, adding somebody asks for one right there; left empty, the line under it says what that means. */
const ownPinField = () => (E.profiles?.ownerPin ? "" : `<label class="fld"><span>Your PIN, for switching back to you</span><input class="inp" id="inv-own" type="password" inputmode="numeric" maxlength="8" autocomplete="off" aria-describedby="inv-own-note"></label><p class="hint" id="inv-own-note" data-css="margin:0">Anyone at this computer can switch back to you while this is empty.</p>`);

/* The sign-in page's address for another device: the phone door's own address while it is open (GET /api/deployment
   remote.url), else this window's own. Only an http(s) address is ever shown; anything else is no address. */
export function signInPage(remote, here) {
  const base = remote?.enabled === true && remote.url ? remote.url : here;
  try {
    const u = new URL("/people", base);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch { return null; }
}
const onlyHere = (address) => /^(localhost|127\.|\[::1\])/.test(new URL(address).hostname);

/* What the device tab needs from the engine: whether people may sign in from their own device (the owner's sign-in card,
   GET /api/people/settings) and the phone door (GET /api/deployment). A read that fails says why and leaves its line out. */
async function deviceView() {
  const [card, deployment] = await Promise.all([api("people/settings").catch((error) => { toast(error.message); return null; }),
    api("deployment").catch((error) => { toast(error.message); return null; })]);
  return { off: card?.settings?.mode === "off", address: signInPage(deployment?.remote, location.origin) };
}
const offLine = (view) => (view?.off ? '<p class="hint" data-css="margin:0">“Let people sign in from their own device” must be on.</p>' : "");

async function inviteDlg(keepName = "") {
  closePop();
  const roles = [["adult", "Adult"], ["child", "Child"]].map(([v, l], i) => `<button type="button" data-act="p-inv-role" data-v="${v}" aria-pressed="${i === 0}">${esc(roleLabel(v) || l)}</button>`).join("");
  const device = INV.tab === "device" ? await deviceView() : null;
  const body = `<div class="tabs" data-css="margin:0">${tabs()}</div><label class="fld"><span>Name</span><input class="inp" id="inv-n" placeholder="Their name" maxlength="40" autocomplete="off" value="${esc(keepName)}"></label><div class="fld"><span>Role</span><span class="seg">${roles}</span></div><label class="fld"><span>Their PIN, four to eight digits</span><input class="inp" id="inv-pin" type="password" inputmode="numeric" maxlength="8" autocomplete="off"></label>${ownPinField()}${offLine(device)}`;
  openDlg({ title: "Invite someone", body, foot: `<button class="btn ghost" type="button" data-act="dlg-close">Cancel</button><button class="btn pri" type="button" data-act="p-inv-go">${INV.tab === "this" ? "Add them" : "Invite"}</button>` });
}

/* Another tab keeps the name typed so far; the PINs are asked again. */
function inviteTab(el) {
  const v = el.dataset.v;
  if (v !== "this" && v !== "device") return;
  INV.tab = v;
  return inviteDlg(($("#inv-n")?.value ?? "").trim());
}

/* The role is a choice in the form, sent with the name and PIN by "Add them". */
function inviteRole(el) {
  for (const b of el.parentElement.querySelectorAll('[data-act="p-inv-role"]')) b.setAttribute("aria-pressed", String(b === el));
}

/* The form's answers, the PIN boxes emptied as they are read; null, with the box marked, when one is not right. */
function inviteForm() {
  const nameBox = $("#inv-n"), pinBox = $("#inv-pin"), ownBox = $("#inv-own");
  const name = (nameBox?.value ?? "").trim(), pin = pinBox?.value ?? "", own = ownBox?.value ?? "";
  if (pinBox) pinBox.value = "";
  if (ownBox) ownBox.value = "";
  const role = [...document.querySelectorAll('[data-act="p-inv-role"]')].find((b) => b.getAttribute("aria-pressed") === "true")?.dataset.v ?? "adult";
  if (!name) { nameBox?.setAttribute("aria-invalid", "true"); return null; }
  if (!PIN.test(pin)) { pinBox?.setAttribute("aria-invalid", "true"); return null; }
  // The owner's PIN is theirs alone: never the one the person being added will know.
  if (own && (!PIN.test(own) || own === pin)) {
    ownBox?.setAttribute("aria-invalid", "true");
    const note = $("#inv-own-note");
    if (own === pin && note) note.textContent = t("household.ownPinNotTheirs");
    return null;
  }
  return { name, pin, role, own };
}

/* One invite at a time: a second press while the first is being answered does nothing. */
async function inviteGo() {
  if (INV.busy) return;
  const form = inviteForm();
  if (!form) return;
  INV.busy = true;
  try { await addPerson(form); } finally { INV.busy = false; }
}

async function addPerson({ name, pin, role, own }) {
  const device = INV.tab === "device";
  let made;
  try { made = await api("profiles", { name, pin, role }); } catch (error) { toast(error.message); return; }
  const pinRefused = await ownPinAfterAdd(own);
  pickPerson(made.id);
  if (device) await showDeviceCode(made);
  else closeDlg();
  // In setup the person stays in setup; everywhere else the new person's card opens in Team › People.
  if (!S.ob) { S.view = "team"; S.tabs.team = "people"; }
  await reread();
  renderNow();
  if (!pinRefused) toast(`${made.name} is added.`);
}

/* Their own device: the engine's one-time code for the person just added and where they use it, drawn once into this
   dialog and kept nowhere else, so another tab, another dialog or closing this one takes it away. A code the engine
   refuses says why; the person is added either way, and their card makes a new code. */
async function showDeviceCode(person) {
  let made, view;
  try {
    [made, view] = await Promise.all([api(`people/${encodeURIComponent(person.id)}/reset-code`, {}), deviceView()]);
  } catch (error) { toast(error.message); closeDlg(); return; }
  const minutes = Math.max(1, Math.round((Date.parse(made.expiresAt) - Date.now()) / 60000));
  const where = view.address ? `<p data-css="margin:0">They open <code>${esc(view.address)}</code> on their phone or computer and pick “I have a code from the owner”.</p>` : "";
  const here = view.address && onlyHere(view.address) ? `<p class="hint" data-css="margin:0">${esc(t("pair.onlyHere"))}</p>` : "";
  const body = `<div class="tabs" data-css="margin:0">${tabs()}</div><p data-css="margin:0"><b>${esc(person.name)}</b></p>${where}<code class="ko-code" id="inv-code">${esc(made.code)}</code><p class="hint" data-css="margin:0">Works once, for ${minutes} minutes.</p>${offLine(view)}${here}`;
  openDlg({ title: "Invite someone", body, foot: '<button class="btn ghost" type="button" data-act="dlg-close">Cancel</button>' });
}

/* The owner's PIN typed with the invite, saved once the person is added. True when the engine refused it (said in a toast). */
async function ownPinAfterAdd(own) {
  if (!own) return false;
  try { await api("profiles/owner-pin", { pin: own }); return false; } catch (error) { toast(error.message); return true; }
}

/* ---------- the person's card ---------- */

async function setRole(el) {
  try { await api(`profiles/${encodeURIComponent(el.dataset.id)}/role`, { role: el.dataset.v }); } catch (error) { toast(error.message); }
  await reread();
}

/* The engine's one-time code and how long it lasts, as the prototype says it. */
async function makeCode(el) {
  try {
    const made = await api(`people/${encodeURIComponent(el.dataset.id)}/reset-code`, {});
    const minutes = Math.max(1, Math.round((Date.parse(made.expiresAt) - Date.now()) / 60000));
    toast(`One-time code: ${made.code}. It works once, for ${minutes} minutes.`);
  } catch (error) { toast(error.message); }
}

async function signOutAll(el) {
  const name = personOf(el.dataset.id)?.name;
  try { await api(`people/${encodeURIComponent(el.dataset.id)}/sign-out`, {}); toast(`${first(name)} is signed out on every device.`); }
  catch (error) { toast(error.message); }
  await reread();
}

async function remove(el) {
  try {
    const done = await api(`profiles/${encodeURIComponent(el.dataset.id)}/remove`, {});
    if (done.removed) toast("Removed.");
  } catch (error) { toast(error.message); }
  await reread();
}

export function init() {
  markLive(["switchto", "p-switch", "pin-ok", "sw:pin-try", "invite", "p-invite", "p-inv-tab", "p-inv-role", "p-inv-go", "sw:inv-n", "sw:inv-pin",
    "p-role", "p-code", "p-signout", "p-remove", "sw:si-owner", "owner-pin-set", "sw:owner-pin-new",
    "sw:inv-own", "owner-pin-ask", "owner-pin-later"]);
  document.addEventListener("change", ownerPinSwitch);
  on("owner-pin-set", () => ownerPinSet());
  on("switchto", (el) => startSwitch(el, "menu"));
  on("p-switch", (el) => startSwitch(el, "card"));
  on("pin-ok", (el) => pinOk(el));
  on("invite", () => { INV.tab = "this"; inviteDlg(); });
  on("p-invite", () => { INV.tab = "this"; inviteDlg(); });
  on("owner-pin-ask", () => ownerPinDlg());
  on("owner-pin-later", () => noticeLater());
  on("p-inv-tab", (el) => inviteTab(el));
  on("p-inv-role", (el) => inviteRole(el));
  on("p-inv-go", () => inviteGo());
  on("p-role", (el) => setRole(el));
  on("p-code", (el) => makeCode(el));
  on("p-signout", (el) => signOutAll(el));
  on("p-remove", (el) => remove(el));
}
