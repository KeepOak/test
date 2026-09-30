import { segmentedRow, switchRow } from "./row-kit.js";
/* Shared pieces for settings pages: control builders. Match the prototype exactly (design doc 2 and 5). */

import { esc } from "../core/dom.js";
import { ic } from "../core/ui.js";
import { id15 } from "./rows15.js";

export const ctl = (id, title, sub, on) => switchRow({id, title, description: sub, checked: on});

/* why: the key of the reason a row with no engine setting stays greyed (core/why.js). */
export const ctlSeg = (title, sub, opts, cur, why = "") => segmentedRow({title, description: sub, options: opts.map(o => [o, o]), current: cur, valueAttribute: false, attributes: () => `data-why="${esc(why || id15(title))}"`});

export const statusBox = (title, text, bad) =>
  `<div class="status"><span class="sdot ${bad ? 'bad' : ''}"></span><div><b>${esc(title)}</b><p>${esc(text)}</p></div></div>`;
