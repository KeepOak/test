/* Who is using Branch, 1:1 with the prototype, against the engine's household routes (src/collab-server.ts,
   src/profiles.ts, src/people/api.ts). The engine keeps every guard: switching to a person needs that person's PIN,
   switching back to the owner needs the owner's PIN once it is set, and only the owner adds people, sets roles, makes
   one-time codes, signs people out or removes them (requireOwner, the household route table, the short-lived-key table).
   The window only asks for what the engine asks for and shows the engine's refusal as it is.
   A PIN is read from its field once, the field is emptied, and it goes straight to the engine: it is never kept in a
   variable beyond that call, saved, drawn back or written to the console.
     switchto (the person menu), p-switch (the person's card) and pin-ok: POST /api/profiles/switch {profileId, pin}.
     invite, p-invite, p-inv-tab, p-inv-role, p-inv-go: the invite dialog; "On this computer" is POST /api/profiles
       {name, pin, role}. The other two tabs have no engine route and stay greyed.
     si-owner (Team › Signing in, "Ask for my PIN when switching back to me") and owner-pin-set: POST
       /api/profiles/owner-pin {pin} to set it, {pin: null} to switch it off.
     p-role: POST /api/profiles/<id>/role {role}. p-code: POST /api/people/<id>/reset-code. p-signout: POST
       /api/people/<id>/sign-out. p-remove: POST /api/profiles/<id>/remove. */
import { $, esc, render, renderNow } from "../core/dom.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { openDlg, closeDlg, closePop, toast } from "../core/ui.js";
import { S, E, activeId, roleLabel } from "../core/state.js";
import { pickPerson } from "../settings/pages/people.js";
import { nameOf } from "../core/faces.js";

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

function startSwitch(el, from) {
  closePop();
  const id = el.dataset.v || null;
  if (id === activeId()) return;
  if (id === null && !E.profiles?.ownerPin) return switchTo(null, undefined, from);
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
  const owner = ownerName();
  openDlg({ title: "The owner’s PIN", body: `<p data-css="margin:0;color:var(--ink-2)">Switching back to ${esc(owner)} asks for this PIN. Five wrong tries wait five minutes.</p><div class="field"><label for="owner-pin-new">PIN</label><input class="inp" id="owner-pin-new" type="password" inputmode="numeric" maxlength="8" autocomplete="off"></div>`,
    foot: '<button class="btn ghost" type="button" data-act="dlg-close">Cancel</button><button class="btn pri" type="button" data-act="owner-pin-set">Save</button>' });
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

const HOW = [["this", "On this computer"], ["device", "On their own device"], ["keepoak", "From your keepoak.com team"]];
/* Only "On this computer" has an engine route; the other two tabs are drawn greyed. */
const tabs = () => HOW.map(([v, l]) => (v === "this"
  ? `<button class="tab" type="button" aria-selected="true" data-act="p-inv-tab" data-v="${v}">${l}</button>`
  : `<button class="tab soon" type="button" aria-selected="false" aria-disabled="true" tabindex="-1" data-tip="Coming soon" data-act="p-inv-tab" data-v="${v}">${l}</button>`)).join("");

function inviteDlg() {
  closePop();
  const roles = [["adult", "Adult"], ["child", "Child"]].map(([v, l], i) => `<button type="button" data-act="p-inv-role" data-v="${v}" aria-pressed="${i === 0}">${esc(roleLabel(v) || l)}</button>`).join("");
  const body = `<div class="tabs" data-css="margin:0">${tabs()}</div><label class="fld"><span>Name</span><input class="inp" id="inv-n" placeholder="Their name" maxlength="40" autocomplete="off"></label><div class="fld"><span>Role</span><span class="seg">${roles}</span></div><label class="fld"><span>Their PIN, four to eight digits</span><input class="inp" id="inv-pin" type="password" inputmode="numeric" maxlength="8" autocomplete="off"></label>`;
  openDlg({ title: "Invite someone", body, foot: '<button class="btn ghost" type="button" data-act="dlg-close">Cancel</button><button class="btn pri" type="button" data-act="p-inv-go">Add them</button>' });
}

/* The role is a choice in the form, sent with the name and PIN by "Add them". */
function inviteRole(el) {
  for (const b of el.parentElement.querySelectorAll('[data-act="p-inv-role"]')) b.setAttribute("aria-pressed", String(b === el));
}

async function inviteGo() {
  const nameBox = $("#inv-n"), pinBox = $("#inv-pin");
  const name = (nameBox?.value ?? "").trim(), pin = pinBox?.value ?? "";
  if (pinBox) pinBox.value = "";
  const role = [...document.querySelectorAll('[data-act="p-inv-role"]')].find((b) => b.getAttribute("aria-pressed") === "true")?.dataset.v ?? "adult";
  if (!name) { nameBox?.setAttribute("aria-invalid", "true"); return; }
  if (!PIN.test(pin)) { pinBox?.setAttribute("aria-invalid", "true"); return; }
  let made;
  try { made = await api("profiles", { name, pin, role }); } catch (error) { toast(error.message); return; }
  closeDlg();
  pickPerson(made.id);
  S.view = "team";
  S.tabs.team = "people";
  await reread();
  renderNow();
  toast(`${made.name} is added.`);
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
    "p-role", "p-code", "p-signout", "p-remove", "sw:si-owner", "owner-pin-set", "sw:owner-pin-new"]);
  document.addEventListener("change", ownerPinSwitch);
  on("owner-pin-set", () => ownerPinSet());
  on("switchto", (el) => startSwitch(el, "menu"));
  on("p-switch", (el) => startSwitch(el, "card"));
  on("pin-ok", (el) => pinOk(el));
  on("invite", () => inviteDlg());
  on("p-invite", () => inviteDlg());
  on("p-inv-tab", () => inviteDlg());
  on("p-inv-role", (el) => inviteRole(el));
  on("p-inv-go", () => inviteGo());
  on("p-role", (el) => setRole(el));
  on("p-code", (el) => makeCode(el));
  on("p-signout", (el) => signOutAll(el));
  on("p-remove", (el) => remove(el));
}
