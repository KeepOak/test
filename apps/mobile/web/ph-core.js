/**
 * The phone app's screen machinery, 1:1 with the prototype's pass 8 (design/redesign/prototype.html, "pass 8: the
 * phone apps, with the whole of Branch in them"): which screen shows (P), what the engine said (E, loaded and never
 * invented), the actions a tap runs (on / data-act), and the pieces every screen draws with (a nav bar, a large
 * title, an avatar, a row). A screen is a function that returns markup; every engine string goes through esc().
 */
import { esc, phone, platform, say, w } from "/phone-common.js";
import { ic } from "/icons.js";
import { formatDate, language } from "/i18n.js";

/** The window state of the phone: which screen, which tab of it, which sheet. Nothing here is the engine's. */
export const P = { scr: "home", prev: "home", chat: null, inTab: "needs", libTab: "memory", chatF: "all", q: "", sheet: null, chF: "on", chApp: null, busy: false };
/** What the engine answered, by route. A missing value is drawn as nothing. */
export const E = {};
/** Where Back goes from each screen (the prototype's PH_BACK). */
export const BACK = { chat: "chats", profile: "chat", automations: "more", library: "more", trunks: "more", usage: "more", settings: "more",
  themes: "settings", accounts: "settings", notif: "settings", pair: "settings", chatapps: "settings", chatapp: "chatapps", localm: "settings", lend: "settings" };
export const TABS = [["home", "home", "phone8.tab.home", "Home"], ["chats", "chat", "phone8.tab.chats", "Chats"], ["inbox", "inbox", "place.inbox", "Inbox"], ["more", "more", "more.label", "More"]];

const acts = new Map();
/** Registers THE handler for a data-act name; a second registration is a mistake. */
export function on(name, fn) {
  if (acts.has(name)) throw new Error(`Two handlers for ${name}`);
  acts.set(name, fn);
}
export const act = (name) => acts.get(name);

let redraw = () => undefined;
export const setRedraw = (fn) => { redraw = fn; };
export const draw = () => redraw();

/** Goes to a screen (the prototype's phGo): the one before is remembered for the full-screen views. */
export function go(scr) {
  if (!["voice"].includes(scr)) P.prev = P.scr;
  P.scr = scr;
  P.sheet = null;
  draw();
}

/** One request to the paired Branch; a refusal reaches the owner in the engine's own words. */
export const api = (method, path, body, extra) => phone.vault.request(method, path, body, extra);
export const get = (path, query) => api("GET", path, undefined, query ? { query } : undefined);
export const post = (path, body = {}) => api("POST", path, body);

let toastTimer = 0;
/** A short line at the bottom: an engine message, shown verbatim. */
export function toast(text) {
  const node = document.getElementById("toast");
  if (!node || !text) return;
  node.textContent = text;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 4000);
}
/** Runs an engine call; its refusal is shown and the screen drawn again either way. */
export async function attempt(work) {
  try { return await work(); } catch (error) { toast(String(error?.message ?? error)); return null; } finally { draw(); }
}

/* ---------- pieces every screen draws with ---------- */
export const ios = () => platform() === "ios";
export { ic, esc, w, say };
/** The first letter of a name in a round tile: the engine's avatars are pictures the page may not load. */
export function av(name, size = 34, cls = "") {
  const letter = String(name ?? "").trim().charAt(0).toUpperCase() || "B";
  return `<span class="p-av ${cls}" data-size="${size}" aria-hidden="true">${esc(letter)}</span>`;
}
/** A pushed screen's bar: Back, the title, and whatever sits on the right (the prototype's phNav). */
export function nav(title, back, right = "") {
  const label = back ? w("pair.back", "Back") : "";
  const button = back ? `<button type="button" data-act="back" aria-label="${label}">${ios() ? `‹ ${esc(back)}` : "←"}</button>` : "<span></span>";
  return `<div class="p-nav">${button}<span class="p-who"><b>${esc(title)}</b></span>${right || "<span></span>"}</div>`;
}
/** A tab's large title on iOS, an app bar on Android (the prototype's phBig). */
export function big(title, right = "") {
  return ios() ? `<div class="p-large8"><span>${esc(title)}</span>${right}</div>` : `<div class="p-appbar"><span>${esc(title)}</span>${right}</div>`;
}
/** A disabled control: drawn as the prototype draws it, and not pretending to work. */
export const soon = 'disabled aria-disabled="true" data-soon="1"';
export const time = (iso) => (iso ? formatDate(iso, sameDay(iso) ? { hour: "numeric", minute: "2-digit" } : { month: "short", day: "numeric" }) : "");
const sameDay = (iso) => new Date(iso).toDateString() === new Date().toDateString();
export const firstLine = (text, n = 90) => String(text ?? "").split("\n")[0].slice(0, n);
export const lang = () => language();
