/* Which computer you are talking to, 1:1 with the prototype's switcher: this computer, the other computers running
   Branch the owner added (GET /api/asks/nodes) and the paired phones and computers (GET /api/devices). Each can be
   renamed, and the name is kept by the engine: this computer's own name (GET /api/reach machineName, POST
   /api/reach/machine-name), another Branch computer's (POST /api/asks/nodes replaces the whole list, so it is read
   first and only the name changes) and a paired device's (POST /api/devices/<id>/rename).
   Talking to the assistant on another computer stays greyed: the engine starts and reads single tasks there
   (/api/reach/machines/start, look), not a conversation this window can hold. */

import { $, esc, renderNow } from "../core/dom.js";
import { openPop, closePop, openDlg, closeDlg, toast, ic, mi } from "../core/ui.js";
import { E } from "../core/state.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { t } from "../../i18n.js";

export const M = { name: "", asked: false, nodes: [], devices: [] };
/* This computer's name as the engine keeps it; "" until one is given. */
export const machineName = () => M.name;

export async function loadMachineName() {
  if (M.asked || !E.loaded) return;
  M.asked = true;
  /* Q261: the computer's name is kept in the owner's reach settings, which a household person may not read. */
  if (E.profiles?.isOwner === false) return;
  M.name = (await api("reach")).machineName ?? "";
}

async function listed(path, key) {
  try { return (await api(path))[key] ?? []; } catch (error) { toast(error.message); return []; }
}

function row(act, kind, id, name, status, checked, dot) {
  const line = status ? `<span class="mi-s"><span class="dot ${dot}"></span> ${esc(status)}</span>` : "";
  return `<div data-css="display:flex;align-items:center;gap:2px"><button class="mi" type="button" role="menuitemradio" aria-checked="${checked}" data-act="${act}" data-v="${esc(id)}"><span class="tick">${ic("check", "s")}</span><span><span class="mi-t">${esc(name)}</span>${line}</span></button><button class="icon-btn" type="button" aria-label="${t("studio.rename.title", { name: esc(name) })}" data-act="renamecomp" data-k="${kind}" data-id="${esc(id)}" data-css="width:28px;height:28px">${ic("edit", "s")}</button></div>`;
}

async function openMachines(el) {
  [M.nodes, M.devices] = await Promise.all([listed("asks/nodes", "nodes"), listed("devices", "devices")]);
  const here = row("machine-here", "here", "here", M.name || t("dashboard.computer.title"), t("layout.connected"), true, "");
  const nodes = M.nodes.map((n) => row("machine", "node", n.id, n.name, "", false, "")).join("");
  const devices = M.devices.map((d) => row("machine", "device", d.id, d.name ?? d.id, d.connected ? t("layout.connected") : t("window.shell.machines.offline"), false, d.connected ? "" : "off")).join("");
  openPop(el, `<div class="ph">${t("window.shell.machines.talk-to-the-assistant-on")}</div>${here}${nodes}${devices}<hr>${mi("addcomp", "plus", t("window.shell.machines.add-a-computer-or-phone"))}`);
}

function nameOf(kind, id) {
  if (kind === "here") return M.name || t("dashboard.computer.title");
  if (kind === "node") return M.nodes.find((n) => n.id === id)?.name ?? "";
  return M.devices.find((d) => d.id === id)?.name ?? "";
}

function renameDialog(el) {
  const { k, id } = el.dataset;
  openDlg({ title: t("window.shell.machines.rename-this-computer"), body: `<div class="field"><label for="rc-name">${t("accounts.field.name")}</label><input class="inp" id="rc-name" value="${esc(k === "here" ? M.name ?? "" : nameOf(k, id))}"></div><p class="hint" data-css="margin:0">${t("window.shell.machines.the-name-shows-in-the-switcher")}</p>`,
    foot: `<button class="btn ghost" type="button" data-act="dlg-close">${t("first-run-steps.restore-no")}</button><button class="btn pri" type="button" data-act="rc-save" data-k="${esc(k)}" data-id="${esc(id)}">${t("action.save")}</button>` });
  setTimeout(() => $("#rc-name")?.select(), 0);
}

/* Another Branch computer: the whole list goes back with only this one's name changed. */
async function renameNode(id, name) {
  const { nodes } = await api("asks/nodes");
  await api("asks/nodes", { nodes: nodes.map((n) => (n.id === id ? { ...n, name } : n)) });
}

async function saveName(el) {
  const { k, id } = el.dataset, name = ($("#rc-name")?.value ?? "").trim();
  if (!name) { closeDlg(); return; }
  try {
    if (k === "here") M.name = (await api("reach/machine-name", { name })).name ?? M.name;
    else if (k === "node") await renameNode(id, name);
    else if (k === "device") await api(`devices/${encodeURIComponent(id)}/rename`, { name });
    closeDlg();
    renderNow();
    toast(t("window.shell.machines.renamed"));
  } catch (error) { toast(error.message); }
}

export function initMachines() {
  markLive(["sw:rc-name", "machines", "machine-here", "renamecomp", "rc-save"]);
  on("machines", (el) => openMachines(el));
  on("machine-here", () => closePop());
  on("renamecomp", (el) => renameDialog(el));
  on("rc-save", (el) => saveName(el));
}
