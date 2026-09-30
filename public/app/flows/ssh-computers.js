/* Owner-selected SSH workspaces use the existing /api/remotes checks; this flow never connects or handles keys. */
import { esc } from "../core/dom.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { dialog, openDlg, toast } from "../core/ui.js";
import { say } from "../core/words.js";
import { t } from "../../i18n.js";

let busy = false, generation = 0;
const words = (text) => esc(say(text));
const cancel = () => `<button class="btn ghost" type="button" data-act="dlg-close">${t("mode.cancel")}</button>`;

export async function openSshComputers() {
  const request = ++generation;
  const dlg = openDlg({ title: say("Computers over SSH"), body: `<p role="status">${words("Reading saved computers…")}</p>` });
  try {
    const { computers = [] } = await api("remotes");
    if (request !== generation || dialog() !== dlg) return;
    openDlg({ title: say("Computers over SSH"), body: `<p>${words("These are file workspaces on another computer. Adding one checks your SSH config and previously trusted host key; it does not connect or enable remote commands.")}</p>
      <div class="rows">${computers.map(computerRow).join("") || `<p>${words("No SSH computers added yet.")}</p>`}</div>`,
      foot: `${cancel()}<button class="btn pri" type="button" data-act="ssh-comp-new">${words("Add SSH computer")}</button>` });
  } catch (error) { if (request === generation && dialog() === dlg) toast(error.message); }
}

function computerRow(computer) {
  return `<div class="prow"><span class="grow"><b>${esc(computer.label || computer.alias)}</b><small>${esc(computer.alias)} · ${esc(computer.root)}</small>
    <small>${words("Allowed programs:")} ${esc((computer.executables ?? []).join(", ") || say("none"))}</small></span>
    <button class="btn ghost sm" type="button" data-act="ssh-comp-remove" data-v="${esc(computer.alias)}">${words("Remove")}</button></div>`;
}

function addSshComputer() {
  if (busy) return;
  ++generation;
  openDlg({ title: say("Add a computer over SSH"), body: `<p>${words("First add a short Host alias to your own SSH config and connect once yourself to check its host key. Branch uses your existing key and never asks for a password.")}</p>
    <form id="ssh-comp-form">
      <label>${words("SSH config alias")}<input name="alias" required maxlength="64" pattern="[A-Za-z0-9][A-Za-z0-9._-]{0,63}" placeholder="tower" autocomplete="off"></label>
      <label>${words("Folder on that computer")}<input name="root" required maxlength="300" placeholder="/home/me/work" autocomplete="off"></label>
      <label>${words("Name in Branch")}<input name="label" maxlength="80" autocomplete="off"></label>
    </form><p>${words("The folder must start with / or ~/. New computers allow files only; no remote programs are enabled.")}</p><p id="ssh-comp-error" role="alert"></p>`,
    foot: `${cancel()}<button class="btn pri" type="button" data-act="ssh-comp-save">${words("Check and add")}</button>` });
  const form = dialog()?.querySelector("#ssh-comp-form");
  form?.addEventListener("submit", (event) => { event.preventDefault(); saveSshComputer(); });
}

async function saveSshComputer() {
  const dlg = dialog(), form = dlg?.querySelector("#ssh-comp-form");
  if (busy || !form || !form.reportValidity()) return;
  const input = Object.fromEntries(new FormData(form));
  input.executables = [];
  busy = true;
  form.querySelectorAll("input").forEach((field) => { field.disabled = true; });
  try {
    const current = await api("remotes");
    if ((current.computers ?? []).some((computer) => computer.alias === input.alias.trim()))
      throw new Error(say("That SSH alias is already saved. Remove it first if you want to replace its workspace."));
    if (dialog() !== dlg) return;
    const saved = await api("remotes", input);
    if (!saved.computer) throw new Error(say("The computer was not saved."));
    // Read back through the real list; a closed/replaced dialog is never reopened by an old response.
    if (dialog() === dlg) await openSshComputers();
  } catch (error) { if (dialog() === dlg) dlg.querySelector("#ssh-comp-error").textContent = error.message; }
  finally { busy = false; form.querySelectorAll("input").forEach((field) => { field.disabled = false; }); }
}

function confirmRemove(alias) {
  if (busy) return;
  ++generation;
  openDlg({ title: say("Remove SSH computer"), body: `<p>${words("Remove this saved workspace from Branch?")} <b>${esc(alias)}</b></p><p>${words("Files and SSH settings on both computers stay where they are.")}</p>`,
    foot: `${cancel()}<button class="btn pri" type="button" data-act="ssh-comp-remove-yes" data-v="${esc(alias)}">${words("Remove")}</button>` });
}

async function removeSshComputer(alias) {
  if (busy) return;
  busy = true;
  const dlg = dialog();
  try { await api("remotes/remove", { computer: alias }); if (dialog() === dlg) await openSshComputers(); }
  catch (error) { if (dialog() === dlg) toast(error.message); }
  finally { busy = false; }
}

export function initSshComputers() {
  markLive(["ssh-comp-open", "ssh-comp-new", "ssh-comp-save", "ssh-comp-remove", "ssh-comp-remove-yes"]);
  on("ssh-comp-open", openSshComputers); on("ssh-comp-new", addSshComputer); on("ssh-comp-save", saveSshComputer);
  on("ssh-comp-remove", (el) => confirmRemove(el.dataset.v));
  on("ssh-comp-remove-yes", (el) => removeSshComputer(el.dataset.v));
}
