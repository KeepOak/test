/* Explicit feedback learns presentation preferences for this conversation's project and assistant.
   The engine reads the original reply; the browser sends only its lasting message identity. */
import { $, esc } from "../core/dom.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { E } from "../core/state.js";
import { openDlg, closeDlg, toast, ic } from "../core/ui.js";
import { markLive } from "../core/features.js";
import { t } from "../../i18n.js";

const T = { sessionId: null, messageId: null, preferences: [], editing: null, busy: false };
export function tasteButton(message, sessionId) {
  if (E.profiles?.isOwner === false || message.role !== "assistant" || message.toolCalls?.length || !sessionId) return "";
  return `<button type="button" data-act="taste-open" data-sid="${esc(sessionId)}" data-mid="${esc(message.messageId)}" aria-label="${esc(t("taste.title"))}">${ic("edit")}</button>`;
}
const button = (action, label, primary = false) => `<button type="button" class="btn ${primary ? "pri" : "ghost"}" data-act="${action}">${esc(t(label))}</button>`;
function openFeedback(el) {
  T.sessionId = el.dataset.sid; T.messageId = Number(el.dataset.mid);
  openDlg({ title: t("taste.title"), body: `<p class="hint">${esc(t("taste.explain"))}</p>
    <label for="taste-outcome">${esc(t("taste.outcome"))}</label><select class="inp" id="taste-outcome">${["accept", "reject", "edit"].map(value => `<option value="${value}">${esc(t(`taste.${value}`))}</option>`).join("")}</select>
    <label for="taste-explanation">${esc(t("taste.explanation"))}</label><textarea class="inp" id="taste-explanation" rows="3" maxlength="2000"></textarea>
    <label for="taste-replacement">${esc(t("taste.replacement"))}</label><textarea class="inp" id="taste-replacement" rows="3" maxlength="8000"></textarea>`,
    foot: button("taste-list", "taste.list") + button("dlg-close", "taste.cancel") + button("taste-save", "taste.save", true) });
}
async function saveFeedback(el) {
  if (T.busy) return;
  const input = { sessionId: T.sessionId, messageId: T.messageId, outcome: $("#taste-outcome").value,
    explanation: $("#taste-explanation").value, replacement: $("#taste-replacement").value, remember: true };
  T.busy = true; el.disabled = true;
  try {
    const { receipt } = await api("taste/feedback", input);
    closeDlg(); toast(t(receipt.preferenceIds.length ? "taste.saved" : "taste.not-learned"));
  } catch (error) { toast(error.message); } finally { T.busy = false; el.disabled = false; }
}
async function listPreferences() {
  try {
    const { preferences } = await api(`taste/preferences?sessionId=${encodeURIComponent(T.sessionId)}`);
    T.preferences = preferences;
    openDlg({ title: t("taste.list"), body: `<p class="hint">${esc(t("taste.scope"))}</p>` +
      (preferences.length ? preferences.map(row => `<div class="field"><b>${esc(t(`taste.domain.${row.domain}`))}</b><p>${esc(row.text)}</p>
        <p class="hint">${esc(t("taste.evidence"))}: ${esc(row.evidence)}</p><p class="hint">${esc(t("taste.revision", { revision: row.revision }))}</p>
        <button class="btn ghost" type="button" data-act="taste-correct" data-id="${esc(row.id)}">${esc(t("taste.correct"))}</button>
        <button class="btn ghost" type="button" data-act="taste-forget" data-id="${esc(row.id)}">${esc(t("taste.forget"))}</button></div>`).join("") : `<p>${esc(t("taste.empty"))}</p>`),
      foot: button("dlg-close", "taste.close") });
  } catch (error) { toast(error.message); }
}
function correctPreference(el) {
  const row = T.preferences.find(item => item.id === el.dataset.id);
  if (!row) return;
  T.editing = row;
  openDlg({ title: t("taste.correct"), body: `<label for="taste-correction">${esc(t("taste.preference"))}</label>
    <textarea class="inp" id="taste-correction" rows="4" maxlength="400">${esc(row.text)}</textarea>`,
    foot: button("taste-list", "taste.cancel") + button("taste-correction-save", "taste.keep", true) });
}
async function saveCorrection() {
  if (!T.editing || T.busy) return;
  T.busy = true;
  try {
    await api("taste/correct", { sessionId: T.sessionId, id: T.editing.id, revision: T.editing.revision, text: $("#taste-correction").value });
    await listPreferences();
  } catch (error) { toast(error.message); } finally { T.busy = false; }
}
async function forgetPreference(el) {
  const row = T.preferences.find(item => item.id === el.dataset.id);
  if (!row || T.busy) return;
  T.busy = true;
  try {
    await api("taste/forget", { sessionId: T.sessionId, id: row.id, revision: row.revision });
    await listPreferences(); toast(t("taste.forgotten"));
  } catch (error) { toast(error.message); } finally { T.busy = false; }
}
export function initTaste() {
  markLive(["taste-open", "taste-save", "taste-list", "taste-correct", "taste-correction-save", "taste-forget",
    "sw:taste-outcome", "sw:taste-explanation", "sw:taste-replacement", "sw:taste-correction"]);
  on("taste-open", openFeedback); on("taste-save", saveFeedback); on("taste-list", listPreferences);
  on("taste-correct", correctPreference); on("taste-correction-save", saveCorrection); on("taste-forget", forgetPreference);
}
