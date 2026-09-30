import { esc } from "../core/dom.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { toast } from "../core/ui.js";
import { E } from "../core/state.js";

/** Paths refer to the computer running Branch, including when the window is remote. */
export function piperCard(settings) {
  if (E.profiles?.isOwner === false || !settings) return "";
  const field = (id, label, value, attrs = "") => `<label class="ctl"><b>${esc(label)}</b><span class="right"><input class="inp" id="${id}" aria-label="${esc(label)}" value="${esc(value)}" ${attrs}></span></label>`;
  return `<div class="sec"><h2>Installed Piper voice</h2>
    <p>Choose files already on the computer running Branch. Piper stays a separate installed program. Branch does not install it or download voices. Check the voice model's license before using it.</p>
    ${field("piper-executable", "Piper executable path", settings.localVoiceExecutable, 'maxlength="400" placeholder="Absolute path; empty finds Piper on PATH"')}
    <button class="btn sm" type="button" data-act="piper-browse" data-kind="executable">Browse executable</button>
    ${field("piper-model", "Voice model path", settings.localVoiceModel, 'maxlength="400" placeholder="Absolute path to voice.onnx"')}
    <button class="btn sm" type="button" data-act="piper-browse" data-kind="model">Browse voice model</button>
    <div id="piper-browser" hidden><label>Directory on Branch's computer <input class="inp" id="piper-directory" maxlength="400"></label>
      <button class="btn sm" type="button" data-act="piper-list">List files</button>
      <button class="btn sm" type="button" data-act="piper-close">Close file list</button><div id="piper-files" role="status" aria-live="polite"></div></div>
    <p>The model needs its matching .onnx.json file beside it. An empty model path uses PIPER_VOICE on the host. Requires Piper's timestamp WAV output-directory CLI.</p>
    ${field("piper-rate", "Speech speed", settings.speechRate, 'type="number" min="0.5" max="2" step="0.1"')}
    <label class="ctl"><b>Read aloud with Piper</b><span class="right"><input id="piper-enabled" type="checkbox" ${settings.ttsRoute === "piper" && settings.systemVoice !== "off" ? "checked" : ""}></span><small>Uses this installed voice for spoken replies. Answer aloud above controls when replies are read.</small></label>
    <button class="btn" type="button" data-act="piper-save">Save installed voice</button>
    <p id="piper-status" role="status" aria-live="polite"></p></div>`;
}

let browseKind = "model", browseEpoch = 0;
async function listFiles() {
  if (E.profiles?.isOwner === false) return;
  const host = document.getElementById("piper-files"), epoch = ++browseEpoch;
  const person = E.profiles?.active?.id;
  try {
    const directory = document.getElementById("piper-directory")?.value.trim() ?? "";
    const result = await api("voice/piper/files", { directory, kind: browseKind });
    if (!host?.isConnected || epoch !== browseEpoch || E.profiles?.isOwner === false || person !== E.profiles?.active?.id) return;
    const button = (name, path, folder) => `<button class="btn sm" type="button" data-act="piper-file" data-path="${esc(path)}" data-folder="${folder}">${esc(name)}</button>`;
    host.innerHTML = button("Parent directory", result.parent, true) + result.entries.map(entry => button(`${entry.directory ? "Folder: " : ""}${entry.name}`, entry.path, entry.directory)).join("")
      + (result.truncated ? "<p>File listing limited to 200 results or 2,000 inspected entries. Enter a narrower directory.</p>" : "");
  } catch (error) { if (host?.isConnected && epoch === browseEpoch) host.textContent = error.message; }
}

function initBrowser() {
  on("piper-browse", (el) => {
    browseKind = el.dataset.kind;
    ++browseEpoch;
    document.getElementById("piper-browser").hidden = false;
    const path = document.getElementById(`piper-${browseKind}`).value;
    document.getElementById("piper-directory").value = path.replace(/[\\/][^\\/]*$/, "") || "";
    document.getElementById("piper-files").textContent = "Enter a directory on the computer running Branch, then list files.";
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
  if (!rate.trim() || !Number.isFinite(Number(rate))) throw new Error("Enter a speech speed from 0.5 to 2.");
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
    if (E.profiles?.isOwner === false || el.disabled) return;
    const person = E.profiles?.active?.id;
    el.disabled = true;
    const status = document.getElementById("piper-status");
    try {
      const result = await api("voice/settings", choiceFromCard(getSettings()));
      if (E.profiles?.isOwner === false || person !== E.profiles?.active?.id) return;
      saved(result);
      if (status?.isConnected) status.textContent = "Installed voice settings saved. Playback and CLI compatibility have not been tested.";
    } catch (error) {
      if (status?.isConnected) status.textContent = error.message;
      toast(error.message);
    } finally { if (el.isConnected) el.disabled = false; }
  });
  markLive(["piper-save"]);
}
