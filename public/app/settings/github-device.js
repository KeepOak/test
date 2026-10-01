import { esc, render } from "../core/dom.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { toast } from "../core/ui.js";
import { markLive } from "../core/features.js";
import { ownerHere } from "../core/state.js";
import { t } from "../../i18n.js";

let view = null, timer = null, generation = 0, busy = false;
const words = (key) => t(`githubDevice.${key}`);
const present = () => ownerHere() && !!document.querySelector("#github-device-client");
const stop = () => { clearTimeout(timer); timer = null; };
const button = (act, title, disabled = false) => `<button class="btn sm" type="button" data-act="github-device-${act}" ${disabled || (busy && !["cancel", "disconnect"].includes(act)) ? "disabled" : ""}>${esc(words(title))}</button>`;

export function drawGitHubDevice() {
  if (!ownerHere()) return "";
  const flow = view?.flow;
  return `<div class="sec"><h2>${esc(words("title"))}</h2><p>${esc(words("description"))}</p>
    <label for="github-device-client">${esc(words("client"))}</label>
    <input id="github-device-client" type="text" maxlength="200" autocomplete="off" value="${esc(view?.clientId ?? "")}" ${busy ? "disabled" : ""}>
    ${button("save", "save")}
    <p>${esc(words(view?.connected ? "connected" : "disconnected"))}${view?.connected ? ` (${esc(view.who)})` : ""}</p>
    ${button("begin", "begin", !view?.clientId || !!flow)} ${button("disconnect", "disconnect", !view?.connected && !flow)}
    ${flow ? `<p>${esc(words("code"))} <strong>${esc(flow.userCode)}</strong></p>
      <p><a href="${esc(flow.verificationUri)}" target="_blank" rel="noopener noreferrer">${esc(words("consent"))}</a></p>
      <p>${esc(words("waiting"))}</p>${button("cancel", "cancel")}` : ""}
    <small>${esc(words("launch"))}</small></div>`;
}

function schedule() {
  stop();
  if (!view?.flow || !present() || document.hidden) return;
  const flowId = view.flow.flowId, ticket = generation;
  timer = setTimeout(async () => {
    if (ticket !== generation || !present() || document.hidden || busy) return;
    busy = true;
    try {
      const next = await api("github-device/poll", { flowId });
      if (ticket !== generation || !present()) return;
      view = next; render();
    } catch (error) {
      if (ticket === generation) { view = null; toast(error.message); render(); }
    } finally { if (ticket === generation) { busy = false; render(); schedule(); } }
  }, Math.max(1000, Math.min(120000, view.flow.nextAt - Date.now())));
}

export async function loadGitHubDevice() {
  const ticket = ++generation; stop(); busy = false;
  if (!ownerHere()) { view = null; return; }
  try {
    const next = await api("github-device");
    if (ticket !== generation || !ownerHere()) return;
    view = next;
  } catch { if (ticket === generation) view = null; }
  if (ticket === generation) schedule();
}

async function change(path, body) {
  if ((busy && !["github-device/cancel", "github-device/disconnect"].includes(path)) || !present()) return;
  const ticket = ++generation; stop(); busy = true; render();
  try {
    const next = await api(path, body);
    if (ticket === generation && ownerHere()) view = next;
  } catch (error) { if (ticket === generation) toast(error.message); }
  finally { if (ticket === generation) { busy = false; render(); schedule(); } }
}

export function initGitHubDevice() {
  on("github-device-save", () => change("github-device", { clientId: document.querySelector("#github-device-client")?.value ?? "" }));
  on("github-device-begin", () => change("github-device/begin", {}));
  on("github-device-disconnect", () => change("github-device/disconnect", {}));
  on("github-device-cancel", () => view?.flow && change("github-device/cancel", { flowId: view.flow.flowId }));
  markLive(["sw:github-device-client", "github-device-save", "github-device-begin", "github-device-disconnect", "github-device-cancel"]);
  document.addEventListener("visibilitychange", async () => {
    if (document.hidden) { stop(); return; }
    if (!present()) return;
    await loadGitHubDevice(); render(); schedule();
  });
  addEventListener("pagehide", () => { ++generation; stop(); view = null; });
}
