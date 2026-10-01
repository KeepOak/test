/* One Settings row anatomy. Trusted control slots preserve page-specific actions, pins and search text.
   Design reference: OpenClaw settings-design/settings-ui at 1794d8b (MIT); original Branch implementation. */
import { esc } from "../core/dom.js";
import { gsel } from "../core/gsel.js";

/** Custom editors and legacy label rows use this same container, without rebuilding or escaping their slots. */
export function controlRow(body, { tag = "div", className = "ctl", attributes = "", help = "", configPath = "", helpTitle = "" } = {}) {
  if (tag !== "div" && tag !== "label") throw new Error("Unsupported Settings row container");
  const explanation = rowHelp(body, help, configPath, helpTitle);
  return `<${tag} class="${esc(className)}"${attributes ? ` ${attributes}` : ""}>${body}${tag === "label" ? "" : explanation}</${tag}>${tag === "label" && help ? explanation : ""}`;
}

/* Already-escaped trusted slots become text only: never duplicate an action from a description.
   Native details supplies tap, Enter/Space and collapsed state; data-tip reuses Branch's hover help.
   Short/status-only notes have no inferred explanation. Callers can supply accurate field copy instead. */
function rowHelp(body, explicit, configPath, helpTitle) {
  if (!/<(?:input|button|select)\b/.test(body)) return "";
  const plain = html => html.replace(/<[^>]*>/g, " ").replace(/&(?:amp|quot|apos|lt|gt|nbsp);/g, entity => ({"&amp;": "&", "&quot;": '"', "&apos;": "'", "&lt;": "<", "&gt;": ">", "&nbsp;": " "})[entity]).replace(/\s+/g, " ").trim();
  const title = helpTitle || plain(body.match(/<b>([\s\S]*?)<\/b>/)?.[1] ?? "");
  const notes = [...body.matchAll(/<small>([\s\S]*?)<\/small>/g)];
  const description = notes.at(-1)?.[1] ?? "";
  // A description with an action needs explicit text; do not guess what its live markup means.
  const note = /<[^>]+>/.test(description) ? "" : plain(description);
  const words = explicit ? esc(explicit) : note.length >= 24 ? esc(note) : "";
  if (!title || !words) return "";
  return `<details class="setting-help"><summary aria-label="${esc(title)}: ${words}" data-tip="${words}">?</summary><div>${words}${configPath ? `<code>${esc(configPath)}</code>` : ""}</div></details>`;
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
export function segmentedRow({ title, description = "", help, configPath, ...options }) {
  return settingsRow({ title, description, help, configPath, control: segmentedControl({ title, ...options }) });
}

export function dropdownRow({ title, description = "", dropdown, ...container }) {
  return settingsRow({ title, description, control: gsel({ ...dropdown, label: dropdown.label ?? title }), ...container });
}

/** A navigation/action link uses the page's existing handler; no default action or authority is invented. */
export function linkRow({ title, description = "", label, action, attributes = "", ...container }) {
  return settingsRow({ title, description,
    control: `<button class="btn sm" type="button" data-act="${esc(action)}" ${attributes}>${esc(label)}</button>`, ...container });
}
