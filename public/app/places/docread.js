/* Reading one Library document (dogfood D6): Library › Documents › Open, and a document found by search (the sidebar's
   Files and memory, Ctrl K), open the engine's words for it (GET /api/documents/<id>: the workspace file it was made
   from while that is still there, else its kept text) in a dialog titled with its name. Markdown is drawn as the
   conversation draws an answer (chat/markdown.js text(), from escaped text); any other kind of file is shown as it
   reads. A file with no readable words shows the engine's own note saying why. Documents are the owner's: the engine
   refuses anybody else, and that refusal is what is shown. */

import { esc } from "../core/dom.js";
import { openDlg, toast } from "../core/ui.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { text } from "../chat/markdown.js";
import { t } from "../../i18n.js";

const markdownKinds = /\.(md|markdown|txt)$/i;

export async function openDocument(id) {
  if (!id) return;
  let doc;
  try { doc = await api(`documents/${encodeURIComponent(id)}`); } catch (error) { toast(error.message); return; }
  const words = typeof doc.text === "string" ? doc.text : "";
  const body = !words ? `<p class="hint">${esc(doc.note ?? "")}</p>`
    : markdownKinds.test(doc.name ?? "") || !/\.[a-z0-9]{1,6}$/i.test(doc.name ?? "") ? `<div class="txt docread18">${text(words)}</div>`
      : `<pre class="made-b2">${esc(words)}</pre>`;
  openDlg({ title: doc.name ?? "", wide: true, body, foot: `<button class="btn pri" type="button" data-act="dlg-close">${t("delight.ach.close")}</button>` });
}

export function initDocRead() {
  markLive(["doc-open"]);
  on("doc-open", (el) => openDocument(el.dataset.id));
}
