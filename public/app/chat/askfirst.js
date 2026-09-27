/* "Ask me questions first" (the + menu's switch, 1:1 with the prototype's), through the engine's own ask-first:
   the switch is the owner's saved setting (GET/POST /api/ask-first/settings askFirst), shown in the box as "Asks first".
   While it is on, a message is first shown to the engine (POST /api/ask-first), which says whether it is worth asking
   about and, if so, comes back with up to five short questions, each with the answer it would assume. They open in a
   dialog with those answers filled in; Send puts the answers under the request (POST /api/ask-first/answers) and sends
   that. A request the engine judged short and clear goes straight out, as the engine said. */

import { esc, render } from "../core/dom.js";
import { E } from "../core/state.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { openDlg, closeDlg, closePop, toast } from "../core/ui.js";
import { markLive } from "../core/features.js";
import { t } from "../../i18n.js";

const A = { on: false, read: false, pending: null, send: async () => {} };

export const asksFirst = () => A.on;
export function loadAskFirst() {
  if (A.read || !E.loaded) return;
  A.read = true;
  api("ask-first/settings").then((s) => { if (A.on !== !!s.askFirst) { A.on = !!s.askFirst; render(); } }, (error) => toast(error.message));
}

async function setAskFirst(box) {
  try { A.on = !!(await api("ask-first/settings", { askFirst: box.checked })).askFirst; } catch (error) { toast(error.message); box.checked = A.on; return; }
  toast(t(A.on ? "window.chat.askfirst.on" : "window.chat.askfirst.off"));
  render();
}

/** True when the words were held for the questions (the dialog sends them); false when they should go out now. */
export async function holdForQuestions(prompt) {
  if (!A.on) return false;
  let got;
  try { got = await api("ask-first", { prompt, askFirst: true }); } catch (error) { toast(error.message); return false; }
  if (got.skipped || !got.questions?.length) return false;
  A.pending = { prompt, questions: got.questions };
  const rows = got.questions.map((q, i) => `<label class="fld"><span>${esc(q.question)}</span><input class="inp" data-sw="af" data-i="${i}" value="${esc(q.suggested ?? "")}"></label>`).join("");
  openDlg({ title: t("more.askFirst"), body: rows,
    foot: `<button class="btn ghost" type="button" data-act="dlg-close">${t("first-run-steps.restore-no")}</button><button class="btn pri" type="button" data-act="af-go">${t("composer.send")}</button>` });
  return true;
}

async function sendWithAnswers() {
  const p = A.pending;
  if (!p) return;
  const answers = p.questions.map((q, i) => ({ question: q.question, answer: (document.querySelector(`.dlg input[data-sw="af"][data-i="${i}"]`)?.value ?? "").trim() }));
  let joined;
  try { joined = await api("ask-first/answers", { prompt: p.prompt, answers }); } catch (error) { toast(error.message); return; }
  A.pending = null;
  closeDlg();
  await A.send(joined.prompt);
}

export function initAskFirst({ send }) {
  A.send = send;
  markLive(["sw:pm-ask", "af-go", "sw:af"]);
  on("af-go", () => sendWithAnswers());
  document.addEventListener("change", (e) => { if (e.target.id === "pm-ask") { closePop(); setAskFirst(e.target); } });
}
