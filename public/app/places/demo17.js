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
/* A greyed button carries its own reason key, so each says why it is greyed (window.why.d17-<key>, and
   window.why.d17-<key>-go for a dialog's primary), not one shared line for every row. */
const whyFor = (key, go = "") => (HANDLERS.has(key) && !go ? "" : ` data-why="d17-${esc(key)}${go}"`);

/* A row in a settings-style list: [title, what it does, button words]. A row whose readout the engine has no route for
   (settings/demos-b5.js lists them and why) states what Branch does and draws no button: an example-only button has
   nothing real behind it (QA Q002). */
/* The security-sensitive rows (a sign-in's tokens, the locker, lending a phone, the webhook address, easing voice
   approvals) keep their button drawn and greyed with their reason (window.why.d17-<key>), listed for a separate review. */
const SECURITY17 = new Set(["tokens", "locker", "devpick", "hookaddr", "voiceapprove"]);
const rowBtn17 = (key, label) => HANDLERS.has(key) ? `<span class="right"><button class="btn sm" type="button" data-act="demob17" data-k="${esc(key)}">${esc(say(label))}</button></span>`
  : SECURITY17.has(key) ? `<span class="right"><button class="btn sm" type="button" data-act="demob17-soon" data-k="${esc(key)}" data-why="d17-${esc(key)}">${esc(say(label))}</button></span>` : "";
export const demoRow17 = (key, [title, sub, label]) =>
  `<div class="ctl"><b>${esc(say(title))}</b>${rowBtn17(key, label)}<small>${esc(say(sub))}</small></div>`;

/* A row in a place, with its icon tile. */
export const demoPlace17 = (key, icon, [title, sub, label]) =>
  `<div class="prow"><span class="ico-tile">${ic(icon, "s")}</span><span class="grow"><b>${esc(say(title))}</b><small>${esc(say(sub))}</small></span><button class="btn sm" type="button" data-act="${actFor(key)}" data-k="${esc(key)}"${whyFor(key)}>${esc(say(label))}</button></div>`;

/* The dialog: a lead line, rows of [title, line, [pill kind, pill words] | null], and the primary when a handler goes.
   `field` is the markup of the one thing the primary needs (a date, which address), drawn under the rows; the handler's
   go(el) reads it, and the area marks its id live ("sw:<id>"). */
export function demoDlg17(key, { title, lead, rows, go, empty = "", field = "" }) {
  const list = rows.map(([a, b, p]) => `<div class="prow"><span class="grow"><b>${esc(a)}</b><small>${esc(b)}</small></span>${p ? pill17(p[0], p[1]) : ""}</div>`).join("");
  const goAct = HANDLERS.get(key)?.go ? "demodob17" : "demodob17-soon";
  openDlg({
    title,
    body: `${lead ? `<p class="lead-b17">${esc(lead)}</p>` : ""}<div class="rows demo-b17">${list || (empty ? `<p class="empty">${esc(empty)}</p>` : "")}</div>${field}`,
    foot: `<button class="btn ${go ? "ghost" : ""}" type="button" data-act="dlg-close">${go ? t("updates.busy.cancel") : t("delight.ach.close")}</button>${go ? `<button class="btn pri" type="button" data-act="${goAct}" data-k="${esc(key)}"${goAct === "demodob17-soon" ? whyFor(key, "-go") : ""}>${esc(go)}</button>` : ""}`,
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
