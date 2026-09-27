/* Shared pieces for places: tab bars, rows, common controls. */

import { esc, $ } from "../core/dom.js";
import { ic } from "../core/ui.js";

/* A tab's count, when it has one, is the engine's number; none is drawn at zero. */
export const tabBar = (tabs, place, current) =>
  `<div class="tabs" role="tablist">${tabs.map(([id, label, count]) =>
    `<button class="tab" role="tab" type="button" aria-selected="${id === current}" data-act="ptab" data-place="${place}" data-v="${id}">${esc(label)}${count > 0 ? `<span class="n">${count}</span>` : ''}</button>`
  ).join('')}</div>`;

export const row = (icon, name, sub, action, actionText, extra = "") =>
  `<div class="row"><span class="ico">${ic(icon, "s")}</span><div class="inf"><b>${esc(name)}</b><p>${esc(sub)}</p></div>${extra}${action ? `<button class="btn-sm" data-act="${action}">${esc(actionText)}</button>` : ''}</div>`;

export const cnt = (n) => n > 0 ? `<span class="cnt" aria-label="count">${n}</span>` : '';
