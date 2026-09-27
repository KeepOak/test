/* Reading one Library document (dogfood D6): Library › Documents › Open, and a document found by search (the sidebar's
   Files and memory, Ctrl K), open the engine's words for it (GET /api/documents/<id>: the workspace file it was made
   from while that is still there, else its kept text) in a dialog titled with its name. Markdown is drawn as the
   conversation draws an answer (chat/markdown.js text(), from escaped text); any other kind of file is shown as it
   reads. A file with no readable words shows the engine's own note saying why. Documents are the owner's: the engine
   refuses anybody else, and that refusal is what is shown.
   dogfood-ux-2: Library › Made for you › Open reads a file a task kept the same way (GET /api/artifacts/read?path=): a
   picture or a sound is shown from its bytes (GET /api/artifacts/file, as the conversation shows a made picture), and
   anything else as its words. Nothing is run or handed to another program. */

import { esc } from "../core/dom.js";
import { openDlg, toast } from "../core/ui.js";
import { api, token } from "../core/api.js";
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

/* The words of a document, drawn as Markdown where it is one, else as they read; the engine's note when there are none. */
function wordsBody(name, words, note) {
  if (!words) return `<p class="hint">${esc(note ?? "")}</p>`;
  return markdownKinds.test(name ?? "") || !/\.[a-z0-9]{1,6}$/i.test(name ?? "") ? `<div class="txt docread18">${text(words)}</div>` : `<pre class="made-b2">${esc(words)}</pre>`;
}
let shownUrl = null;
/* A kept picture or sound, read with the window's own sign-in and shown from memory (the page's rules allow blob:). */
async function mediaBody(path, mediaType) {
  const auth = token.get();
  const response = await fetch(`/api/artifacts/file?path=${encodeURIComponent(path)}`, { cache: "no-store", headers: auth ? { authorization: "Bearer " + auth } : {} });
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || String(response.status));
  if (shownUrl) URL.revokeObjectURL(shownUrl);
  shownUrl = URL.createObjectURL(await response.blob());
  return mediaType.startsWith("audio/") ? `<audio class="docread18m" controls src="${shownUrl}"></audio>` : `<img class="docread18m" alt="" src="${shownUrl}">`;
}
export async function openMade(path) {
  if (!path) return;
  let got, body;
  try {
    got = await api(`artifacts/read?path=${encodeURIComponent(path)}`);
    body = got.shown ? await mediaBody(path, got.mediaType) : wordsBody(got.name, got.text, got.note);
  } catch (error) { toast(error.message); return; }
  openDlg({ title: got.name ?? "", wide: true, body, foot: `<button class="btn pri" type="button" data-act="dlg-close">${t("delight.ach.close")}</button>` });
}

/* dogfood-ux-3: Show in folder, in the desktop app only (a browser cannot show a file in Explorer or Finder): the app
   reveals the file selected in its folder, and only a file the engine lists as one the assistant kept
   (src/desktop/show-in-folder-ipc.ts). Nothing is opened or run. */
export const revealable = () => typeof window.branchDesktop?.showInFolder === "function";
async function reveal(path) {
  try { await window.branchDesktop.showInFolder(path); } catch (error) { toast(error.message); }
}

export function initDocRead() {
  markLive(["doc-open", "made-open", "made-reveal"]);
  on("doc-open", (el) => openDocument(el.dataset.id));
  on("made-open", (el) => openMade(el.dataset.v));
  on("made-reveal", (el) => { if (revealable()) reveal(el.dataset.v); });
}
