/* Owner chooses precisely what goes to an already paired engine. Nothing silently exports memory. */
import { $, esc } from "../core/dom.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { S, ownerHere } from "../core/state.js";
import { closePop, openDlg, toast } from "../core/ui.js";
import { markLive } from "../core/features.js";
import { t } from "../../i18n.js";

const button = (action, label, row) => `<button class="btn" type="button" data-act="${action}" data-id="${esc(row.id)}" data-generation="${row.generation}">${t(label)}</button>`;
function transferRow(row) {
  const controls = row.direction === "outgoing" && row.state !== "released"
    ? (row.dispatched === false ? button("continuity-preview", "continuity.preview", row)
      : button("continuity-inspect", "continuity.check", row) + button("continuity-retry", "continuity.retry", row)) + button("continuity-reclaim", "continuity.return", row) : "";
  return `<section><p><strong>${esc(row.peer)}</strong> · ${t(`continuity.state.${row.state}`)} · ${t(`continuity.direction.${row.direction}`)}</p>
    ${row.output ? `<pre>${esc(row.output)}</pre>` : ""}${row.error ? `<p role="alert">${esc(row.error)}</p>` : ""}${controls}</section>`;
}
export async function openContinuity() {
  closePop();
  if (!ownerHere()) return;
  try {
    const [{ transfers }, { machines }] = await Promise.all([api("reach/continuity"), api("reach/machines")]);
    const choices = machines.map((machine) => `<option value="${esc(machine.id)}">${esc(machine.name)}</option>`).join("");
    const form = S.chat && choices ? `<div class="field"><label for="continuity-machine">${t("continuity.destination")}</label><select class="inp" id="continuity-machine">${choices}</select></div>
      <div class="field"><label for="continuity-prompt">${t("continuity.prompt")}</label><textarea class="inp" id="continuity-prompt" maxlength="16000" rows="5"></textarea></div>
      <label><input type="checkbox" id="continuity-context"> ${t("continuity.include-context")}</label>
      <button class="btn pri" type="button" data-act="continuity-start" data-session="${esc(S.chat)}">${t("continuity.start")}</button>` : `<p>${t("continuity.choose")}</p>`;
    openDlg({ title: t("continuity.title"), body: `<p>${t("continuity.explanation")}</p>${form}<hr>${transfers.map(transferRow).join("") || `<p>${t("continuity.empty")}</p>`}`,
      foot: `<button class="btn ghost" type="button" data-act="dlg-close">${t("studio.close")}</button>` });
  } catch (error) { toast(error.message); }
}
async function start(el) {
  const machine = $("#continuity-machine")?.value, prompt = $("#continuity-prompt")?.value.trim();
  if (!machine || !prompt) { toast(t("continuity.required")); return; }
  el.disabled = true;
  try { showPreview(await api("reach/continuity/prepare", { machine, sessionId: el.dataset.session, prompt, includeContext: !!$("#continuity-context")?.checked })); }
  catch (error) { toast(error.message); await openContinuity(); }
}
function showPreview(value) {
  openDlg({ title: t("continuity.preview"), body: `<p>${t("continuity.preview-explanation")}</p><pre>${esc(value.prompt)}</pre>
    ${value.contextText ? `<pre>${esc(value.contextText)}</pre>` : `<p>${t("continuity.no-context")}</p>`}`,
    foot: `${button("continuity-reclaim", "continuity.cancel", value)}<button class="btn pri" type="button" data-act="continuity-send" data-id="${esc(value.id)}" data-generation="${value.generation}" data-fingerprint="${esc(value.contextFingerprint ?? "")}">${t("continuity.send")}</button>` });
}
async function preview(el) {
  try { showPreview(await api("reach/continuity/preview", { id: el.dataset.id, generation: Number(el.dataset.generation) })); }
  catch (error) { toast(error.message); }
}
async function change(el, action) {
  el.disabled = true;
  try {
    const result = await api(`reach/continuity/${action}`, { id: el.dataset.id, generation: Number(el.dataset.generation),
      ...(el.dataset.fingerprint ? { contextFingerprint: el.dataset.fingerprint } : {}) });
    toast(t(`continuity.state.${result.state}`));
  } catch (error) { toast(error.message); }
  finally { await openContinuity(); }
}
export function initContinuity() {
  markLive(["continuity-open", "continuity-start", "continuity-inspect", "continuity-retry", "continuity-reclaim", "continuity-preview", "continuity-send", "sw:continuity-machine", "sw:continuity-prompt", "sw:continuity-context"]);
  on("continuity-open", openContinuity);
  on("continuity-start", start);
  on("continuity-preview", preview);
  on("continuity-send", (el) => change(el, "retry"));
  on("continuity-inspect", (el) => change(el, "inspect"));
  on("continuity-retry", (el) => change(el, "retry"));
  on("continuity-reclaim", (el) => change(el, "reclaim"));
}
