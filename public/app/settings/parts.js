/* Shared pieces for settings pages: control builders. Match the prototype exactly (design doc 2 and 5). */

import { esc } from "../core/dom.js";
import { ic } from "../core/ui.js";

export const ctl = (id, title, sub, on) =>
  `<div class="ctl"><b>${esc(title)}</b><input class="sw" type="checkbox" id="${id}" ${on ? 'checked' : ''} aria-label="${esc(title)}" data-sw="set"><small>${esc(sub)}</small></div>`;

export const ctlSeg = (title, sub, opts, cur) =>
  `<div class="ctl"><b>${esc(title)}</b><span class="right"><span class="seg" role="group" aria-label="${esc(title)}">${opts.map(o => `<button type="button" aria-pressed="${o === cur}" data-act="seg">${esc(o)}</button>`).join('')}</span></span><small>${esc(sub)}</small></div>`;

export const statusBox = (title, text, bad) =>
  `<div class="status"><span class="sdot ${bad ? 'bad' : ''}"></span><div><b>${esc(title)}</b><p>${esc(text)}</p></div></div>`;
