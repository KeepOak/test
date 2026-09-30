/* SELF-309: the pages the assistant publishes for the owner (a report, a tracker like the master plan), from
   GET /api/asks/pages and GET /api/asks/pages/<id>. Library's "Kept pages" lists them; each opens here, and so does
   the stable address /#page=<id>. A live page is shown from its workspace file as it is now, with when the file last
   changed; while it is open it is read again every few seconds and drawn again only when it changed. The words are
   drawn with the conversation's own Markdown renderer (chat/markdown.js), which runs no script and loads nothing. */

import { esc } from "../core/dom.js";
import { openDlg, closeDlg, dialog, toast } from "../core/ui.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { text } from "../chat/markdown.js";
import { when17 } from "./parts17.js";
import { t } from "../../i18n.js";

const P = { id: null, seen: "", timer: null };
const everyMs = 5000;

function stop() { clearInterval(P.timer); P.timer = null; P.id = null; P.seen = ""; }

function words(page) {
  if (page.missing) return `<p class="empty">${esc(page.missing)}</p>`;
  return page.format === "markdown" ? `<div class="txt page19">${text(page.body)}</div>` : `<pre class="page19">${esc(page.body)}</pre>`;
}
function meta(page) {
  const updated = t("window.places.pages19.updated", { when: when17(page.updatedAt) });
  return page.sourcePath ? t("window.places.pages19.live-from", { path: page.sourcePath, updated }) : updated;
}
function draw(page) {
  openDlg({ title: page.title, wide: true,
    body: `<p class="lead-b17" data-page19="${esc(page.id)}">${esc(meta(page))}</p>${words(page)}`,
    foot: `<button class="btn" type="button" data-act="dlg-close">${t("delight.ach.close")}</button>` });
}

/** Opens one page, and keeps a live one current while it stays open. */
export async function openPage(id) {
  stop();
  let body;
  try { body = await api(`asks/pages/${encodeURIComponent(id)}`); } catch (error) { toast(error.message); return; }
  P.id = id;
  P.seen = JSON.stringify(body.page);
  draw(body.page);
  if (!body.page.sourcePath) return;
  P.timer = setInterval(async () => {
    const shown = dialog()?.querySelector(`[data-page19="${CSS.escape(id)}"]`);
    if (!shown || document.hidden) { if (!shown) stop(); return; }
    const again = await api(`asks/pages/${encodeURIComponent(id)}`).catch(() => null);
    if (!again || P.id !== id) return;
    // Closed or replaced while the page was being read: never open it again.
    if (!dialog()?.querySelector(`[data-page19="${CSS.escape(id)}"]`)) { stop(); return; }
    const seen = JSON.stringify(again.page);
    if (seen !== P.seen) { P.seen = seen; draw(again.page); }
  }, everyMs);
}

/** Library's "Kept pages": every page, newest first, each one opening here. */
export async function openPagesList() {
  const { pages } = await api("asks/pages");
  const rows = pages.map((p) => `<button class="prow" type="button" data-act="page19" data-id="${esc(p.id)}"><span class="grow"><b>${esc(p.title)}</b><small>${esc(meta(p))}</small></span></button>`).join("");
  openDlg({ title: t("window.places.library17.kept-answers-and-long-articles"),
    body: `<p class="lead-b17">${esc(t("window.places.pages19.lead"))}</p><div class="rows demo-b17">${rows || `<p class="empty">${esc(t("window.places.pages19.none"))}</p>`}</div>`,
    foot: `<button class="btn" type="button" data-act="dlg-close">${t("delight.ach.close")}</button>` });
}

export function initPages19() {
  markLive(["page19"]);
  on("page19", (el) => { closeDlg(); return openPage(el.dataset.id); });
}
