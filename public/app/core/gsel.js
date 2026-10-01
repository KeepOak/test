/* The window's own dropdown (UI-100): a button that opens the glass list (core/ui.js openPop, the same popover every menu
   uses) instead of the system's select with its blue highlight. It keeps a select's contract for the code around it:
   it carries an id or data-sw, its `.value` is the choice, and choosing dispatches "change" on it, so a page's change
   listener reads it exactly as it read the select. A long list gets a box that narrows it as you type; the arrows,
   Home, End and Enter move through it; Escape closes it and gives the keyboard back to the button.
   Live like a select: greyed unless its "sw:<id>" (or "sw:<data-sw>") is marked live (core/features.js greyOut). */
import { esc } from "./dom.js";
import { on } from "./actions.js";
import { markLive } from "./features.js";
import { ic, openPop, closePop } from "./ui.js";
import { t } from "../../i18n.js";

const LONG = 10; // more choices than this get the narrowing box
const LIST_ID = "gsel-options"; // the window has one popover at a time

/**
 * A dropdown. `options` is [[value, words, cannotTake?], ...]; `attrs` is any other attribute text (data-k, data-j, data-flow...).
 * `label` names it for a screen reader when no visible label does.
 */
export function gsel({ id = "", sw = "", label = "", options, value = "", attrs = "", cls = "" }) {
  const list = options.map(([v, words, off]) => (off ? [String(v ?? ""), String(words ?? ""), 1] : [String(v ?? ""), String(words ?? "")]));
  const now = list.find(([v]) => v === String(value ?? "")) ?? list[0] ?? ["", ""];
  return `<button type="button" class="inp gsel ${esc(cls)}" role="combobox" data-act="gsel"${id ? ` id="${esc(id)}"` : ""}${sw ? ` data-sw="${esc(sw)}"` : ""} value="${esc(now[0])}" data-opts="${esc(JSON.stringify(list))}" aria-haspopup="listbox" aria-controls="${LIST_ID}" aria-expanded="false"${label ? ` aria-label="${esc(label)}"` : ""} ${attrs}><span class="gsel-t">${esc(now[1])}</span>${ic("down", "s")}</button>`;
}

/** Sets a dropdown's choice from code, as `select.value = v` did (no "change" is sent). */
export function setGsel(el, value) {
  const found = choices(el).find(([v]) => v === String(value ?? ""));
  if (!el || !found) return;
  el.value = found[0];
  const words = el.querySelector(".gsel-t");
  if (words) words.textContent = found[1];
}

const choices = (el) => { try { return JSON.parse(el?.dataset.opts ?? "[]"); } catch { return []; } };
let open = null; // the dropdown whose list is showing

function show(el) {
  const list = choices(el), current = el.value;
  /* Select semantics follow Hermes Desktop's searchable-select (Nous Research, MIT), adapted to our popover. */
  const items = list.map(([v, words, off], i) => `<button class="mi" type="button" role="option" aria-selected="${v === current}" tabindex="-1" data-act="gsel-pick" data-i="${i}" data-v="${esc(v)}"${off ? ' aria-disabled="true"' : ""}><span class="tick">${ic("check", "s")}</span><span class="mi-t">${esc(words)}</span></button>`).join("");
  const filter = list.length > LONG ? `<div class="gsel-q"><input class="inp" type="search" role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls="${LIST_ID}" data-sw="gsel-q" aria-label="${esc(t("window.core.gsel.narrow"))}" placeholder="${esc(t("window.core.gsel.narrow"))}" autocomplete="off" spellcheck="false"></div>` : "";
  const name = el.getAttribute("aria-label") || el.textContent.trim();
  openPop(el, `${filter}<div id="${LIST_ID}" role="listbox" aria-label="${esc(name)}">${items}</div>`, { role: "presentation" });
  const pop = document.querySelector("#app > .pop");
  if (!pop || el.getAttribute("aria-expanded") !== "true") { open = null; return; } // pressed again: it closed
  open = el;
  pop.classList.add("gsel-pop");
  pop.style.minWidth = `${Math.max(el.offsetWidth, 180)}px`;
  const chosen = pop.querySelector(`[data-act="gsel-pick"][data-i="${list.findIndex(([v]) => v === current)}"]`);
  if (!filter && chosen?.getAttribute("aria-disabled") !== "true") chosen?.focus({ preventScroll: true });
  chosen?.scrollIntoView({ block: "nearest" });
}

/* A redraw while the list is open may have replaced the button: the one drawn in its place takes the choice. */
const inPlace = (el) => (!el || el.isConnected ? el : el.id ? document.getElementById(el.id)
  : [...document.querySelectorAll(".gsel")].find((x) => ["sw", "k", "j", "id"].every((k) => x.dataset[k] === el.dataset[k])) ?? null);

/* The choice is found by its value, so a list drawn again while it was open (new choices in front) still takes the
   one that was pressed; a list item with no value falls back to its place. */
function pick(i, value) {
  const el = inPlace(open), list = choices(el), found = value === undefined ? list[i] : list.find(([v]) => v === value);
  if (!el || !found || found[2]) return; // a choice that cannot be taken stays where it is
  closePop({ refocus: true });
  open = null;
  if (el.value === found[0]) return;
  setGsel(el, found[0]);
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

on("gsel", (el) => show(el));
on("gsel-pick", (el) => pick(Number(el.dataset.i), el.dataset.v));
markLive(["gsel", "gsel-pick", "sw:gsel-q"]);

/* The narrowing box keeps only the choices holding what was typed; Enter picks the first one left. */
document.addEventListener("input", (e) => {
  if (e.target?.dataset?.sw !== "gsel-q") return;
  const q = e.target.value.trim().toLowerCase();
  for (const item of e.target.closest(".pop").querySelectorAll('[data-act="gsel-pick"]')) item.hidden = !!q && !item.textContent.toLowerCase().includes(q);
});
document.addEventListener("keydown", (e) => {
  if (e.isComposing || e.keyCode === 229) return;
  if (e.target?.matches?.(".gsel") && ["ArrowDown", "ArrowUp"].includes(e.key)) {
    e.preventDefault();
    show(e.target);
    return;
  }
  const pop = e.target?.closest?.(".gsel-pop");
  if (!pop) return;
  const items = [...pop.querySelectorAll('[data-act="gsel-pick"]')].filter((item) => !item.hidden && item.getAttribute("aria-disabled") !== "true");
  const at = items.indexOf(e.target);
  const to = { ArrowDown: at + 1, ArrowUp: at < 0 ? items.length - 1 : at - 1, Home: 0, End: items.length - 1 }[e.key];
  if (to !== undefined && !(e.target.tagName === "INPUT" && (e.key === "Home" || e.key === "End"))) {
    e.preventDefault();
    items[Math.max(0, Math.min(items.length - 1, to))]?.focus();
  } else if (e.key === "Enter" && e.target.tagName === "INPUT" && items[0]) {
    e.preventDefault();
    pick(Number(items[0].dataset.i), items[0].dataset.v);
  }
});
