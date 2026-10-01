import { esc } from "../core/dom.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { toast } from "../core/ui.js";
import { viewFence } from "../core/view-fence.js";
import { t } from "../../i18n.js";
import { S, E } from "../core/state.js";

let cardGeneration = 0;
function cardFence(name) {
  const generation = cardGeneration, card = document.getElementById("piper-card"), viewer = viewFence(name), page = S.setPage;
  return () => viewer() && S.setPage === page && E.profiles?.isOwner === true && generation === cardGeneration
    && card?.isConnected && document.getElementById("piper-card") === card;
}

/** Paths refer to the computer running Branch, including when the window is remote. */
export function piperCard(settings) {
  ++cardGeneration;
  if (E.profiles?.isOwner !== true || !settings) return "";
  const field = (id, label, value, attrs = "") => `<label class="ctl"><b>${esc(label)}</b><span class="right"><input class="inp" id="${id}" aria-label="${esc(label)}" value="${esc(value)}" ${attrs}></span></label>`;
  return `<div id="piper-card" role="group" aria-labelledby="piper-title"><p id="piper-title"><b>${t("window.settings.piper.title")}</b></p>
    <p>${t("window.settings.piper.intro")}</p>
    ${field("piper-executable", t("window.settings.piper.executable"), settings.localVoiceExecutable, `maxlength="400" placeholder="${esc(t("window.settings.piper.executable-placeholder"))}"`)}
    <button class="btn sm" type="button" data-act="piper-browse" data-kind="executable">${t("window.settings.piper.browse-executable")}</button>
    ${field("piper-model", t("window.settings.piper.model"), settings.localVoiceModel, `maxlength="400" placeholder="${esc(t("window.settings.piper.model-placeholder"))}"`)}
    <button class="btn sm" type="button" data-act="piper-browse" data-kind="model">${t("window.settings.piper.browse-model")}</button>
    <div id="piper-browser" hidden><label>${t("window.settings.piper.directory")} <input class="inp" id="piper-directory" maxlength="400"></label>
      <button class="btn sm" type="button" data-act="piper-list">${t("window.settings.piper.list")}</button>
      <button class="btn sm" type="button" data-act="piper-close">${t("window.settings.piper.close")}</button><div id="piper-files" role="status" aria-live="polite"></div></div>
    <p>${t("window.settings.piper.model-hint")}</p>
    ${field("piper-rate", t("window.settings.piper.rate"), settings.speechRate, 'type="number" min="0.5" max="2" step="0.1"')}
    <label class="ctl"><b>${t("window.settings.piper.enabled")}</b><span class="right"><input id="piper-enabled" type="checkbox" ${settings.ttsRoute === "piper" && settings.systemVoice !== "off" ? "checked" : ""}></span><small>${t("window.settings.piper.enabled-hint")}</small></label>
    <button class="btn" type="button" data-act="piper-save">${t("window.settings.piper.apply")}</button>
    <p id="piper-status" role="status" aria-live="polite"></p></div>`;
}

let browseKind = "model", browseEpoch = 0;
async function listFiles() {
  if (E.profiles?.isOwner !== true) return;
  const host = document.getElementById("piper-files"), epoch = ++browseEpoch;
  const current = cardFence("piper-list"), kind = browseKind;
  const stillHere = () => current() && host?.isConnected && epoch === browseEpoch && kind === browseKind;
  if (!stillHere()) return;
  try {
    const directory = document.getElementById("piper-directory")?.value.trim() ?? "";
    const result = await api("voice/piper/files", { directory, kind });
    if (!stillHere()) return;
    const button = (name, path, folder) => `<button class="btn sm" type="button" data-act="piper-file" data-path="${esc(path)}" data-folder="${folder}">${esc(name)}</button>`;
    host.innerHTML = button(t("window.settings.piper.parent"), result.parent, true) + result.entries.map(entry => button(entry.directory ? t("window.settings.piper.folder", { name: entry.name }) : entry.name, entry.path, entry.directory)).join("")
      + (result.truncated ? `<p>${t("window.settings.piper.limited")}</p>` : "");
  } catch (error) { if (stillHere()) host.textContent = error.message; }
}

function initBrowser() {
  on("piper-browse", (el) => {
    browseKind = el.dataset.kind;
    ++browseEpoch;
    document.getElementById("piper-browser").hidden = false;
    const path = document.getElementById(`piper-${browseKind}`).value;
    document.getElementById("piper-directory").value = path.replace(/[\\/][^\\/]*$/, "") || "";
    document.getElementById("piper-files").textContent = t("window.settings.piper.browse-hint");
    document.getElementById("piper-directory").focus();
  });
  on("piper-list", () => listFiles());
  on("piper-close", () => { ++browseEpoch; document.getElementById("piper-browser").hidden = true; });
  on("piper-file", (el) => {
    if (el.dataset.folder === "true") { document.getElementById("piper-directory").value = el.dataset.path; listFiles(); }
    else { document.getElementById(`piper-${browseKind}`).value = el.dataset.path; ++browseEpoch; document.getElementById("piper-browser").hidden = true; }
  });
  markLive(["piper-browse", "piper-list", "piper-close", "piper-file"]);
}

function choiceFromCard(settings) {
  const enabled = document.getElementById("piper-enabled")?.checked;
  const rate = document.getElementById("piper-rate")?.value ?? "";
  if (!rate.trim() || !Number.isFinite(Number(rate))) throw new Error(t("window.settings.piper.rate-error"));
  return {
    localVoiceExecutable: document.getElementById("piper-executable")?.value.trim() ?? "",
    localVoiceModel: document.getElementById("piper-model")?.value.trim() ?? "",
    speechRate: Number(rate),
    ...(enabled ? { ttsRoute: "piper", systemVoice: "on" }
      : settings.ttsRoute === "piper" ? { systemVoice: "off" } : {}),
  };
}

export function initPiper(getSettings, saved) {
  initBrowser();
  on("piper-save", async (el) => {
    if (E.profiles?.isOwner !== true || el.disabled) return;
    const current = cardFence("piper-save");
    const stillHere = () => current() && el.isConnected && document.getElementById("piper-status") === status;
    el.disabled = true;
    const status = document.getElementById("piper-status");
    try {
      if (!stillHere()) return;
      const result = await api("voice/settings", choiceFromCard(getSettings()));
      if (!stillHere()) return;
      saved(result);
      if (status?.isConnected) status.textContent = t("window.settings.piper.applied");
    } catch (error) {
      if (!stillHere()) return;
      if (status?.isConnected) status.textContent = error.message;
      toast(error.message);
    } finally { if (stillHere()) el.disabled = false; }
  });
  markLive(["piper-save"]);
}
