import { esc, render } from "../core/dom.js";
import { api } from "../core/api.js";
import { ownerHere } from "../core/state.js";
import { on, has } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { toast, openDlg, closeDlg } from "../core/ui.js";
import { settingsRow } from "./row-kit.js";
import { enterIsolatedChat } from "../chat/isolated.js";

let selected = null, status = null, problem = "", pending = null, busy = false, revision = 0;
const choices = { credentials: "fresh", history: "keep-in-original", sharing: "none" };
const button = (action, label, disabled = false) => `<button class="btn sm" type="button" data-act="${action}" ${disabled ? "disabled" : ""}>${esc(label)}</button>`;

export async function selectGateway(id) {
  selected = id === "owner" ? null : id;
  status = null; problem = ""; pending = null;
  const version = ++revision, profile = selected;
  if (!profile || !ownerHere()) return;
  try {
    const value = await api(`profile-gateways/${profile}`);
    if (version === revision && ownerHere()) status = value;
  } catch (error) { if (version === revision) problem = error.message; }
  if (version === revision) render();
}

export function gatewayRows(id) {
  if (id === "owner" || !ownerHere()) return "";
  const current = id === selected ? status : null;
  const state = current?.running?.worker?.state ?? (current?.choices ? "stopped" : "not created");
  const disabled = busy || !current;
  const controls = button("pg-refresh", "Refresh status", busy)
    + (current?.choices ? button(state === "stopped" ? "pg-start" : "pg-stop", state === "stopped" ? "Start isolated gateway" : "Stop isolated gateway", disabled)
      : button("pg-create", "Create independent home", disabled));
  return `<div class="sec"><h2>Profile gateway</h2>${settingsRow({ title: current?.choices ? "Independent home" : "Existing logical profile",
    description: "Keep using the existing profile, or create a fresh independent process, data home, memory and keys. Original conversations stay here; credentials and data are not copied.", control: controls })}
    <p role="status">${esc(problem || `Gateway: ${state}${busy ? " · action in progress" : ""}`)}</p>
    ${current?.running?.ok ? settingsRow({ title: "Set up this gateway's model", description: "Enter a new service key explicitly. Connect checks that service and saves the key only in this profile's isolated locker.", control: button("pg-model", "Add separate model connection", busy) }) : ""}
    ${current?.running?.ok ? button("pg-chat", "Open independent profile chat", busy) : ""}
    <p class="hint">Opening independent chat explicitly changes this window's conversation context. Original history remains in the logical profile.</p></div>`;
}

function confirm(action) {
  if (!ownerHere() || !selected || busy) return;
  pending = { id: selected, revision, action };
  const descriptions = { create: "Create a fresh independent home with separate memory and keys? Existing history stays in the original profile. Nothing is migrated or shared.",
    start: "Start this profile's separate worker? It uses only its own saved settings and credentials.", stop: "Stop this profile's separate worker? Its current work will be closed; its saved home remains." };
  openDlg({ title: "Profile gateway", body: `<p>${esc(descriptions[action])}</p>`,
    foot: button("pg-cancel", "Cancel") + button("pg-confirm", action === "create" ? "Create fresh home" : action === "start" ? "Start gateway" : "Stop gateway") });
}

async function apply() {
  const choice = pending;
  pending = null; closeDlg();
  if (!choice || busy || !ownerHere() || choice.id !== selected || choice.revision !== revision) return toast("Profile changed; review the action again.");
  busy = true; render();
  try { await api(`profile-gateways/${choice.id}${choice.action === "create" ? "" : `/${choice.action}`}`, choice.action === "create" ? choices : {}); }
  catch (error) { toast(error.message); }
  finally { busy = false; if (choice.id === selected && ownerHere()) await selectGateway(selected); }
}

function modelDialog() {
  if (!ownerHere() || !selected || busy) return;
  pending = { id: selected, revision, action: "model" };
  openDlg({ title: "Separate model connection", body: `<p>This key belongs only to this gateway. Connect checks the provider; the owner's saved keys are not used.</p>
    <label>Service ID<input id="pg-provider" placeholder="openai" autocomplete="off"></label>
    <label>Model (optional)<input id="pg-model-name" autocomplete="off"></label>
    <label>New API key<input id="pg-key" type="password" autocomplete="new-password"></label>`,
    foot: button("pg-cancel", "Cancel") + button("pg-connect", "Connect separate key") });
}

async function connect() {
  const choice = pending;
  if (!choice || choice.action !== "model" || busy || !ownerHere() || choice.id !== selected || choice.revision !== revision) return toast("Profile changed; reopen setup.");
  const provider = document.getElementById("pg-provider")?.value.trim();
  const model = document.getElementById("pg-model-name")?.value.trim();
  const keyBox = document.getElementById("pg-key");
  const key = keyBox?.value ?? "";
  if (!provider || !key) return toast("Enter a service ID and a new key.");
  keyBox.value = ""; pending = null; closeDlg(); busy = true; render();
  try { await api(`profile-gateways/${choice.id}/route`, { operation: "connect-model", settings: { provider, key, ...(model ? { model } : {}) } }); toast("Separate model connection saved."); }
  catch (error) { toast(error.message); }
  finally { busy = false; if (choice.id === selected && ownerHere()) await selectGateway(selected); }
}

export function initGatewayRows() {
  if (has("pg-refresh")) return;
  on("pg-refresh", () => selectGateway(selected));
  for (const action of ["create", "start", "stop"]) on(`pg-${action}`, () => confirm(action));
  on("pg-confirm", apply); on("pg-model", modelDialog); on("pg-connect", connect);
  on("pg-chat", async () => {
    const id = selected;
    if (!ownerHere() || !id || busy) return;
    try { await enterIsolatedChat(id, "Selected household profile"); } catch (error) { toast(error.message); }
  });
  on("pg-cancel", () => { pending = null; closeDlg(); });
  markLive(["pg-refresh", "pg-create", "pg-start", "pg-stop", "pg-confirm", "pg-model", "pg-connect", "pg-cancel", "pg-chat"]);
}
