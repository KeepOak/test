/**
 * The phone's own switches (the prototype's PH_SW, in Settings › On this phone): each row cycles Off, When needed,
 * On, as the prototype's ph-sw does, and is kept by the native side (Keychain group defaults, Android preferences),
 * never by the engine. Lockdown sits with them: it is the engine's (GET/POST /api/lockdown). Switching it on is
 * one tap from the phone; switching it off is offered only when the engine says the one here is the owner
 * (GET /api/profiles isOwner), and the engine's own rule still decides: its refusal is shown in its words.
 */
import { E, attempt, draw, esc, ios, on, post, soon, w } from "/ph-core.js";
import { loadLockdown, loadProfiles } from "/ph-data.js";
import { phone, plugin } from "/phone-common.js";
import { DEFAULT_KINDS, DEFAULT_SWITCHES, SWITCH_POSITIONS, readSwitches } from "/rules.js";
import { restartChecks } from "/notify.js";

let current = readSwitches({});
export const switchesNow = () => current;
export async function loadSwitches() {
  current = await phone.vault.switches();
  return current;
}

export const PH_SW = [
  ["lock", "phone8.sw.lock", "Lock with {bio}", "phone.switch.lock.note", "Ask before showing Branch. When needed: only after five minutes away."],
  ["notifications", "phone.switch.notifications.title", "Tell me when a task needs me", "phone8.sw.notifyNote", "Checks your Branch for questions."],
  ["share", "phone.switch.share.title", "Send to Branch from other apps", "phone8.sw.shareNote", "Puts Branch in the share sheet."],
  ["voice", "phone.switch.voice.title", "Talk button", "phone.switch.voice.note", "Shows the button that turns what you say into a message."],
  ["push", "phone.switch.push.title", "Alerts while the app is closed", "phone8.sw.pushNote", "Needs a store account first."],
];
export const POS = { off: ["settings.chat-live.off", "Off"], "when-needed": ["settings.chat-live.when-needed", "When needed"], on: ["settings.chat-live.on", "On"] };
const bio = () => (ios() ? "Face ID" : w("phone8.sw.fingerprint", "fingerprint"));

export function switchRows() {
  return PH_SW.map(([k, lk, l, sk, s]) => `<button type="button" class="p-li" data-act="ph-sw" data-v="${k}"><span class="grow"><b>${w(lk, l, { bio: bio() })}</b><small>${w(sk, s)}</small></span><span class="p-val">${w(...POS[current[k]])}</span></button>`).join("");
}
/** Lockdown: On or Off, from the engine. */
export function lockdownRow() {
  const on = E.lockdown?.on === true;
  const may = on ? E.profiles?.isOwner === true : E.lockdown !== undefined;
  return `<button type="button" class="p-li" data-act="ph-lockdown" ${may ? "" : soon}><span class="grow"><b>${w("lockdown.label", "Lockdown")}</b></span><span class="p-val">${w(...POS[on ? "on" : "off"])}</span></button>`;
}
/** Settings › Notifications: the kinds this phone can tell, each a switch; the rest are drawn and not live. */
export const KINDS = [["notifyNeeds", "phone8.notif.needs", "A Trunk needs your yes"], ["notifyDone", "phone8.notif.done", "A task finished"],
  [null, "phone8.notif.team", "Someone on your team needs you"], [null, "phone8.notif.usage", "Usage is nearly out"], [null, "phone8.notif.daily", "Daily summary at 6 pm"]];
export function kindRows() {
  return KINDS.map(([k, key, e]) => `<div class="p-li"><span class="grow"><b>${w(key, e)}</b></span><input type="checkbox" class="p-sw8" ${k ? `data-kind="${k}" ${current[k] === "on" ? "checked" : ""}` : soon} aria-label="${w(key, e)}"></div>`).join("");
}

/* Changes are saved one after another: two quick taps must not each read the old set and undo the other. */
let changes = Promise.resolve();
export function setSwitch(name, position) {
  changes = changes.then(async () => {
    current = await phone.vault.setSwitch(name, position);
    await plugin.switchesChanged?.();
    restartChecks(current);
  }).catch(async () => { current = await phone.vault.switches(); }).finally(draw);
  return changes;
}
function cycle(name) {
  const next = SWITCH_POSITIONS[(SWITCH_POSITIONS.indexOf(current[name]) + 1) % SWITCH_POSITIONS.length];
  return setSwitch(name, next);
}
async function flipLockdown() {
  const on = E.lockdown?.on === true;
  await attempt(async () => {
    E.lockdown = await post("/api/lockdown", { on: !on });
    await Promise.all([loadLockdown(), loadProfiles()]);
  });
}
export function initSwitches() {
  on("ph-sw", (el) => { if (el.dataset.v in DEFAULT_SWITCHES) void cycle(el.dataset.v); });
  on("ph-lockdown", () => flipLockdown());
  document.addEventListener("change", (event) => {
    const kind = event.target?.dataset?.kind;
    if (kind && kind in DEFAULT_KINDS) void setSwitch(kind, event.target.checked ? "on" : "off");
  });
}
export const count = (list) => esc(String(list.length));
