/* QA Q002: a control that stays greyed says why, in plain words, in its own row, never only a "Coming soon" hover.
   A reason is keyed by the control's own data-why, id (a switch, a field) or action name, or by its row's data-why (a row of
   choices or a button that shares an action name), and its words live in the locale files as "window.why.<key>".
   features.js greyOut() looks the reason up for every control it greys: the words become the control's tip and the row's
   data-why-text, which app.css shows under the row (an attribute on markup already drawn, so a redraw never adds more). */
import { t } from "../../i18n.js";

export function reason(key) {
  if (!key) return "";
  const name = `window.why.${key}`, words = t(name);
  return words === name ? "" : words;
}

/** The reason for one greyed control, from the nearest key that has one. */
export function reasonFor(el, row) {
  return reason(el.dataset.why) || reason(el.id) || reason(el.dataset.act) || reason(el.dataset.sw && el.dataset.sw !== "set" ? el.dataset.sw : "") || reason(row?.dataset.why);
}
