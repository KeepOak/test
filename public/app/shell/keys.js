/* The window's changeable shortcuts, one shared place (prototype #179). The engine keeps them in its "keys" card
   (GET /api/comfort values.keys; POST /api/comfort {card:"keys", values} lays the change over what is kept) and names
   its defaults (shortcutDefaults). Every listener asks pressed(event, action), so a changed key changes what fires.
   Until the engine has answered, the keys the window always had are used. */

import { api } from "../core/api.js";
import { E } from "../core/state.js";

const MAC = /Mac/.test(navigator.platform);
const FIRST = { palette: "Ctrl+K", newConversation: "Ctrl+N", appearance: "Ctrl+,", sidePane: "Ctrl+Shift+K", sideList: "Ctrl+B" };
export const K = { keys: null, defaults: null, asked: false };
const MODS = ["Ctrl", "Control", "Alt", "Shift"];
const CODES = { Comma: ",", Period: ".", Slash: "/", Semicolon: ";", Space: "Space", Enter: "Enter" };

/* The pressed key the way the engine writes it: letters and digits by their place on the keyboard, so Shift never turns
   "," into "<". "Ctrl" is the computer's main key (Command on a Mac); a Mac's own Control key is "Control". */
function keyName(e) {
  if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3);
  if (/^Digit[0-9]$/.test(e.code)) return e.code.slice(5);
  if (/^F([1-9]|1[0-2])$/.test(e.code)) return e.code;
  return CODES[e.code] ?? (e.key.length === 1 ? e.key.toUpperCase() : e.key);
}
export function comboOf(e) {
  const main = MAC ? e.metaKey : e.ctrlKey;
  return [main && "Ctrl", MAC && e.ctrlKey && "Control", e.altKey && "Alt", e.shiftKey && "Shift", keyName(e)].filter(Boolean).join("+");
}
/* Modifiers in one order and any case, so "shift+ctrl+k" and "Ctrl+Shift+K" are the same keys. */
function same(combo) {
  const parts = String(combo ?? "").split("+").filter(Boolean);
  const key = parts.pop() ?? "";
  const mods = MODS.filter((m) => parts.some((p) => p.toLowerCase() === m.toLowerCase()));
  return [...mods, key].join("+").toLowerCase();
}

export const binding = (action) => (K.keys ? K.keys[action] ?? "" : FIRST[action] ?? "");
export const defaultOf = (action) => (K.defaults ? K.defaults[action] ?? "" : FIRST[action] ?? "");
export const pressed = (e, action) => { const b = binding(action); return !!b && same(comboOf(e)) === same(b); };
/* How a key is shown: the engine's "Ctrl" is the computer's main key, Command on a Mac, so a Mac shows it as Cmd.
   Only the display changes; what is kept and compared stays the engine's own writing. */
const shown = (part) => (MAC && part === "Ctrl" ? "Cmd" : part);
/* "Ctrl+Shift+K" as the prototype shows keys: one <kbd> each. */
export const kbd = (combo, esc) => String(combo).split("+").filter(Boolean).map((x) => `<kbd>${esc(shown(x))}</kbd>`).join(" ");
export const spoken = (combo) => String(combo).split("+").map(shown).join(" ");
/* The same keys for aria-keyshortcuts: the main key is Meta on a Mac and Control elsewhere; a Mac's own Control stays. */
const ARIA = { Ctrl: MAC ? "Meta" : "Control", Control: "Control", Alt: "Alt", Shift: "Shift" };
export const ariaKeys = (combo) => String(combo).split("+").filter(Boolean).map((x) => ARIA[x] ?? x).join("+");
export const usedBy = (combo, except) => Object.keys(K.keys ?? FIRST).find((a) => a !== except && binding(a) && same(binding(a)) === same(combo));

export async function loadKeys() {
  if (K.asked || !E.loaded) return;
  K.asked = true;
  /* Q261: the shortcuts are kept in the owner's comfort card, which a household person may not read; they keep the
     keys the window always had. E.profiles is read with E.state, so it is known once E.loaded is. */
  if (E.profiles?.isOwner === false) return;
  const c = await api("comfort");
  K.keys = c.values?.keys ?? null;
  K.defaults = c.shortcutDefaults ?? null;
}
/* Saves one action's keys ("" for none) and keeps what the engine says is now in force. */
export async function saveKey(action, combo) {
  const c = await api("comfort", { card: "keys", values: { [action]: combo } });
  K.keys = c.values?.keys ?? K.keys;
  K.defaults = c.shortcutDefaults ?? K.defaults;
  // Pass 17: the desktop app reads the quick-ask keys again itself (src/desktop/quick-ask.ts); nothing is handed over.
  if (action === "quickAsk") await window.branchDesktop?.quickAskKeysChanged?.();
}
