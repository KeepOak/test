/* Inspect the specific visible fact, rather than a demo of whichever fact changed most recently. */
import { $, esc } from "../core/dom.js";
import { E, refresh, activeId } from "../core/state.js";
import { openDlg, closeDlg, dialog, toast } from "../core/ui.js";
import { api } from "../core/api.js";
import { on, run } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { say } from "../core/words.js";
import { t } from "../../i18n.js";

let detail = null;
const words = (text) => esc(say(text));
const here = (view) => detail === view && activeId() === view.scope && dialog()?.querySelector("#memory-detail-text");
const field = (label, value) => value ? `<dt>${words(label)}</dt><dd>${esc(value)}</dd>` : "";

function metadata(data) {
  const trunk = E.trunks.find((one) => `agent:trunk:${one.id}` === data.scope);
  const scope = trunk ? trunk.name : data.scope?.startsWith("agent:") ? say("A specialist") : data.scope === "shared" ? say("Shared with Trunks") : say("Private");
  return `<dl class="kv">${field("Source", data.source)}${field("Who remembers it", scope)}${field("About", data.entity)}${field("Detail", data.attribute)}${field("Kind", data.kind)}${field("Kept for", data.layer)}${field("Project", data.project)}${field("Valid from", data.validFrom)}${field("Valid until", data.validTo)}${field("Labels", data.tags?.join(", "))}${field("Expires", data.expiresAt)}</dl>`;
}

function versionRows(view) {
  if (view.error) return `<p class="hint">${esc(view.error)}</p>`;
  if (!view.versions.length) return `<p class="hint">${words(view.loading ? "Loading earlier versions…" : "No earlier versions are kept for this fact.")}</p>`;
  return view.versions.map((version) => `<details><summary>${words("Version")} ${esc(version.revision)} · ${esc(version.createdAt)}</summary><pre>${esc(version.data?.text ?? "")}</pre>${metadata(version.data ?? {})}${version.revision === view.fact.revision ? "" : `<button class="btn sm" type="button" data-act="memory-detail-restore" data-revision="${esc(version.revision)}" ${view.busy ? "disabled" : ""}>${words("Use these words")}</button>`}</details>`).join("");
}

function drawDetail(view) {
  if (detail !== view || activeId() !== view.scope) return;
  openDlg({ title: say("Inspect memory"), wide: true,
    body: `<label class="field" for="memory-detail-text">${words("Remembered words")}<textarea class="inp" id="memory-detail-text" rows="5" maxlength="4000">${esc(view.text)}</textarea></label>${metadata(view.fact.data ?? {})}<h3>${t("window.settings.instructions.earlier-versions")}</h3>${versionRows(view)}`,
    foot: `<button class="btn bad" type="button" data-act="memory-detail-forget" ${view.busy ? "disabled" : ""}>${t("window.places.library.forget")}</button><button class="btn ghost" type="button" data-act="dlg-close">${t("first-run-steps.done")}</button><button class="btn pri" type="button" data-act="memory-detail-save" ${view.busy ? "disabled" : ""}>${t("action.save")}</button>` });
}

async function inspect(id) {
  const fact = (E.state?.memory ?? []).find((one) => one.id === id);
  if (!fact) return;
  const view = { fact, scope: activeId(), text: String(fact.data?.text ?? ""), versions: [], loading: true, busy: false, error: "" };
  detail = view;
  drawDetail(view);
  try {
    const answer = await api(`memory/versions?id=${encodeURIComponent(id)}`);
    if (!here(view)) return;
    view.versions = answer.versions ?? [];
  } catch (error) { if (here(view)) view.error = error.message; }
  if (!here(view)) return;
  view.text = $("#memory-detail-text")?.value ?? view.text;
  view.loading = false;
  drawDetail(view);
}

async function saveWords(version = null) {
  const view = detail;
  if (!view || view.busy || !here(view)) return;
  view.text = $("#memory-detail-text")?.value ?? view.text;
  const text = version ? String(version.data?.text ?? "") : view.text.trim();
  if (!text.trim()) { $("#memory-detail-text")?.focus(); return; }
  const source = String((version?.data ?? view.fact.data)?.source || "Corrected in the Library");
  view.busy = true;
  drawDetail(view);
  try {
    const result = await api("action", { tool: "memory.update", args: { id: view.fact.id, text, source, expectedRevision: view.fact.revision } });
    if (!here(view)) return;
    closeDlg();
    detail = null;
    await refresh();
    if (result?.staged) toast(result.message || say("Saved as a suggestion. Review it in the Library."));
  } catch (error) { if (here(view)) toast(error.message); }
  finally { view.busy = false; if (here(view)) drawDetail(view); }
}

export function initMemoryDetail() {
  markLive(["memory-detail", "memory-detail-save", "memory-detail-restore", "memory-detail-forget", "sw:memory-detail-text"]);
  on("memory-detail", (el) => inspect(el.dataset.id));
  on("memory-detail-save", () => saveWords());
  on("memory-detail-restore", (el) => {
    const version = detail?.versions.find((one) => one.revision === Number(el.dataset.revision));
    if (version) saveWords(version);
  });
  on("memory-detail-forget", () => {
    if (!detail || detail.busy || !here(detail)) return;
    const button = document.createElement("button");
    button.dataset.id = detail.fact.id;
    closeDlg();
    detail = null;
    run("forget", button); // reuse the existing scoped delete and Undo flow
  });
}
