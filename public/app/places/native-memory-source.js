/* Owner opt-in to an existing native service; opening/saving this panel makes no service request. */
import { esc } from "../core/dom.js";
import { E } from "../core/state.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { openDlg, closeDlg, dialog, toast, ic } from "../core/ui.js";
import { gsel } from "../core/gsel.js";
import { t } from "../../i18n.js";

const forms = new WeakMap();
export function nativeMemorySourceRow() {
  if (E.profiles?.isOwner === false) return "";
  return `<div class="prow"><span class="ico-tile">${ic("folder", "s")}</span><span class="grow"><b>${t("nativeMemory.title")}</b><small>${t("nativeMemory.summary")}</small></span><button type="button" class="btn sm" data-act="native-memory-open">${t("embeddings.source.choose")}</button></div>`;
}
const field = (id, label, value, limit) => `<label for="${id}">${t(label)}</label><input class="inp" id="${id}" data-sw="${id}" maxlength="${limit}" value="${esc(value)}">`;

function showSource(view, settings) {
  openDlg({ title: t("nativeMemory.title"), body: `<p class="hint">${t("nativeMemory.explanation")}</p>
    <label>${t("nativeMemory.provider")}${gsel({ id: "native-provider", sw: "native-provider", label: t("nativeMemory.provider"), options: [["off", t("nativeMemory.off")], ["mem0", "Mem0 (self-hosted)"], ["honcho", "Honcho (v2)"]], value: settings.provider })}</label>
    ${field("native-url", "nativeMemory.url", settings.url, 500)}
    ${field("native-secret", "nativeMemory.secret", settings.secret, 200)}
    ${field("native-project", "nativeMemory.project", settings.secretProject || view.lockerProject, 100)}
    <label>${t("nativeMemory.locality")}${gsel({ id: "native-locality", sw: "native-locality", label: t("nativeMemory.locality"), options: [["direct", t("nativeMemory.direct")], ["forwarded", t("nativeMemory.forwarded")]], value: settings.remoteBehindLoopback ? "forwarded" : "direct" })}</label>
    <p class="hint">${t("nativeMemory.retained")}</p>${view.destinations.length ? `<label>${t("nativeMemory.restore")}${gsel({ id: "native-restore", sw: "native-restore", label: t("nativeMemory.restore"), options: [["", t("nativeMemory.choosePrior")], ...view.destinations.map((entry, index) => [String(index), `${entry.provider}: ${entry.host}${entry.pending ? " • " + t("nativeMemory.pending") : ""}`])], value: "" })}</label><button type="button" class="btn sm" data-act="native-memory-restore">${t("nativeMemory.usePrior")}</button>` : ""}`,
    foot: `<button class="btn pri" type="button" data-act="native-memory-save">${t("embeddings.source.save")}</button>` });
  forms.set(dialog(), { view, settings });
}
async function openSource() {
  try { const view = await api("memory/native"); showSource(view, view.settings); }
  catch (error) { toast(error.message); }
}
function restoreSource() {
  const form = dialog(), state = forms.get(form), index = form?.querySelector("#native-restore")?.value;
  if (!state || index === "" || index === undefined) return;
  const entry = state.view.destinations[Number(index)];
  if (entry) showSource(state.view, entry.settings);
}
async function saveSource(el) {
  const form = dialog(), state = forms.get(form);
  if (!state || el.disabled) return;
  const value = (id) => form.querySelector(`#${id}`).value.trim();
  el.disabled = true;
  try {
    await api("memory/native", { ...state.settings, provider: value("native-provider"), url: value("native-url"), secret: value("native-secret"), secretProject: value("native-project"), remoteBehindLoopback: value("native-locality") === "forwarded" });
    if (dialog() === form) closeDlg();
    toast(t("embeddings.source.saved"));
  } catch (error) { toast(error.message); if (el.isConnected) el.disabled = false; }
}
markLive(["native-memory-open", "native-memory-save", "native-memory-restore", "sw:native-provider", "sw:native-url", "sw:native-secret", "sw:native-project", "sw:native-locality", "sw:native-restore"]);
on("native-memory-open", openSource);
on("native-memory-save", saveSource);
on("native-memory-restore", restoreSource);
