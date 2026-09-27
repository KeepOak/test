/* Shared pieces for settings pages: control builders. Match the prototype exactly (design doc 2 and 5). */

import { esc } from "../core/dom.js";
import { ic } from "../core/ui.js";
import { id15 } from "./rows15.js";

export const ctl = (id, title, sub, on) =>
  `<div class="ctl"><b>${esc(title)}</b><input class="sw" type="checkbox" id="${id}" ${on ? 'checked' : ''} aria-label="${esc(title)}" data-sw="set"><small>${esc(sub)}</small></div>`;

/* why: the key of the reason a row with no engine setting stays greyed (core/why.js). */
export const ctlSeg = (title, sub, opts, cur, why = "") =>
  `<div class="ctl"><b>${esc(title)}</b><span class="right"><span class="seg" role="group" aria-label="${esc(title)}">${opts.map(o => `<button type="button" aria-pressed="${o === cur}" data-act="seg" data-why="${esc(why || id15(title))}">${esc(o)}</button>`).join('')}</span></span><small>${esc(sub)}</small></div>`;

export const statusBox = (title, text, bad) =>
  `<div class="status"><span class="sdot ${bad ? 'bad' : ''}"></span><div><b>${esc(title)}</b><p>${esc(text)}</p></div></div>`;
