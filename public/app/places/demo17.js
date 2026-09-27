/* Pass 17's shared row-and-dialog pattern (patch17b.js DEMOB17): a row with a button opens a small dialog of rows, and the
   dialog may carry one primary action. The two action names, demob17 (open) and demodob17 (the primary), are registered
   here once and routed by the row's data-k to the handlers each area registers with onDemo17(key, {open, go}). A key with
   no handler is drawn under an action nobody registers, so it greys itself; the words are always the caller's. */

import { esc } from "../core/dom.js";
import { ic, openDlg, toast } from "../core/ui.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { pill17 } from "./parts17.js";
import { say } from "../core/words.js";
import { t } from "../../i18n.js";

const HANDLERS = new Map();

/* open(el) draws the dialog (demoDlg17 below does the usual one); go(el) does the primary action for real. */
export function onDemo17(key, handler) {
  if (HANDLERS.has(key)) throw new Error(`Demo "${key}" is registered twice`);
  HANDLERS.set(key, handler);
}

const actFor = (key) => (HANDLERS.has(key) ? "demob17" : "demob17-soon");

/* A row in a settings-style list: [title, what it does, button words]. */
export const demoRow17 = (key, [title, sub, label]) =>
  `<div class="ctl"><b>${esc(say(title))}</b><span class="right"><button class="btn sm" type="button" data-act="${actFor(key)}" data-k="${esc(key)}">${esc(say(label))}</button></span><small>${esc(say(sub))}</small></div>`;

/* A row in a place, with its icon tile. */
export const demoPlace17 = (key, icon, [title, sub, label]) =>
  `<div class="prow"><span class="ico-tile">${ic(icon, "s")}</span><span class="grow"><b>${esc(say(title))}</b><small>${esc(say(sub))}</small></span><button class="btn sm" type="button" data-act="${actFor(key)}" data-k="${esc(key)}">${esc(say(label))}</button></div>`;

/* The dialog: a lead line, rows of [title, line, [pill kind, pill words] | null], and the primary when a handler goes. */
export function demoDlg17(key, { title, lead, rows, go, empty = "" }) {
  const list = rows.map(([a, b, p]) => `<div class="prow"><span class="grow"><b>${esc(a)}</b><small>${esc(b)}</small></span>${p ? pill17(p[0], p[1]) : ""}</div>`).join("");
  const goAct = HANDLERS.get(key)?.go ? "demodob17" : "demodob17-soon";
  openDlg({
    title,
    body: `${lead ? `<p class="lead-b17">${esc(lead)}</p>` : ""}<div class="rows demo-b17">${list || (empty ? `<p class="empty">${esc(empty)}</p>` : "")}</div>`,
    foot: `<button class="btn ${go ? "ghost" : ""}" type="button" data-act="dlg-close">${go ? t("updates.busy.cancel") : t("delight.ach.close")}</button>${go ? `<button class="btn pri" type="button" data-act="${goAct}" data-k="${esc(key)}">${esc(go)}</button>` : ""}`,
  });
}

export function initDemo17() {
  markLive(["demob17", "demodob17"]);
  on("demob17", (el) => {
    const handler = HANDLERS.get(el.dataset.k);
    if (handler) Promise.resolve(handler.open(el)).catch((error) => toast(error.message));
  });
  on("demodob17", (el) => {
    const handler = HANDLERS.get(el.dataset.k);
    if (handler?.go) Promise.resolve(handler.go(el)).catch((error) => toast(error.message));
  });
}
