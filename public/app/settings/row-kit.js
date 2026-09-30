/* One Settings row anatomy. Trusted control slots preserve page-specific actions, pins and search text.
   Design reference: OpenClaw settings-design/settings-ui at 1794d8b (MIT); original Branch implementation. */
import { esc } from "../core/dom.js";
import { gsel } from "../core/gsel.js";

/** Custom editors and legacy label rows use this same container, without rebuilding or escaping their slots. */
export function controlRow(body, { tag = "div", className = "ctl", attributes = "" } = {}) {
  if (tag !== "div" && tag !== "label") throw new Error("Unsupported Settings row container");
  return `<${tag} class="${esc(className)}"${attributes ? ` ${attributes}` : ""}>${body}</${tag}>`;
}

export function settingsRow({ title, description = "", control = "", wrapControl = true, ...container }) {
  return controlRow(`<b>${esc(title)}</b>${wrapControl ? `<span class="right">${control}</span>` : control}<small>${esc(description)}</small>`, container);
}

export function switchControl({ title, id = "", checked = false, attributes = 'data-sw="set"' }) {
  return `<input class="sw" type="checkbox"${id ? ` id="${esc(id)}"` : ""} ${checked ? "checked" : ""} aria-label="${esc(title)}" ${attributes}>`;
}
export function switchRow({ title, description = "", id, checked, attributes, ...container }) {
  return settingsRow({ title, description, control: switchControl({ title, id, checked, attributes }), wrapControl: false, ...container });
}

export function segmentedControl({ title, options, current, action = "seg", attributes = () => "", selected, optionAction, valueAttribute = true }) {
  const buttons = options.map(([value, label]) => {
    const extra = attributes(value);
    return `<button type="button" aria-pressed="${selected ? selected(value) : current === value}" data-act="${esc(optionAction ? optionAction(value) : action)}"${valueAttribute ? ` data-v="${esc(value)}"` : ""}${extra ? ` ${extra}` : ""}>${esc(label)}</button>`;
  }).join("");
  return `<span class="seg" role="group" aria-label="${esc(title)}">${buttons}</span>`;
}
export function segmentedRow({ title, description = "", ...options }) {
  return settingsRow({ title, description, control: segmentedControl({ title, ...options }) });
}

export function dropdownRow({ title, description = "", dropdown, ...container }) {
  return settingsRow({ title, description, control: gsel({ ...dropdown, label: dropdown.label ?? title }), ...container });
}

/** A navigation/action link uses the page's existing handler; no default action or authority is invented. */
export function linkRow({ title, description = "", label, action, attributes = "", ...container }) {
  return settingsRow({ title, description,
    control: `<button class="btn sm" type="button" data-act="${esc(action)}" ${attributes}>${esc(label)}</button>`, ...container });
}
