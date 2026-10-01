/* A file becomes a new Trunk only after its name is reviewed. The preview/apply split follows
   Hermes profile_distribution.py plan_install/install_distribution (Nous Research, MIT);
   Branch's existing import route validates its JSON and resets keys, reach and tool servers. */
import { esc } from "../core/dom.js";
import { openDlg, closeDlg, dialog, toast } from "../core/ui.js";
import { activeId, ownerHere, refresh } from "../core/state.js";
import { api } from "../core/api.js";
import { on, run } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { t } from "../../i18n.js";
import { say } from "../core/words.js";

const fileBytes = 2 * 1024 * 1024;
let pending = null;
const here = (pick) => pending === pick && ownerHere() && activeId() === pick.owner && dialog() === pick.dialog;

function draw(pick) {
  const name = pick.file?.trunk?.name;
  const preview = name ? `<p><b>${esc(name)}</b></p><p>${esc(say("This makes a new Trunk. Its chats, memory and keys are not imported. It starts with no connected tool servers or chat apps and can only look until you change its permissions."))}</p>` : "";
  openDlg({ title: say("Import a Trunk"), body: `<label class="fld">${esc(say("Choose a .branch-trunk file"))}<input type="file" id="trunk-import-file" data-sw="trunk-import-file" accept=".branch-trunk,.json,application/json"></label>${preview}`,
    foot: `<button class="btn ghost" type="button" data-act="dlg-close">${t("updates.busy.cancel")}</button><button class="btn pri" type="button" data-act="trunk-import-save" ${name ? "" : "disabled"}>${esc(say("Import Trunk"))}</button>` });
  pick.dialog = dialog();
}

function openImport() {
  if (!ownerHere()) return;
  pending = { owner: activeId(), dialog: null, file: null, busy: false };
  draw(pending);
}

async function readFile(input) {
  const pick = pending, file = input.files?.[0];
  if (!pick || !here(pick) || pick.busy || !file) return;
  const read = pick.read = (pick.read ?? 0) + 1;
  const current = () => here(pick) && pick.read === read;
  pick.file = null;
  const submit = pick.dialog?.querySelector('[data-act="trunk-import-save"]');
  if (submit) submit.disabled = true;
  try {
    if (file.size > fileBytes) throw new Error(say("Choose a Trunk file up to 2 MB."));
    const value = JSON.parse(await file.text());
    if (!current()) return;
    if (value?.format !== "branch-trunk/1" || typeof value.trunk?.name !== "string" || !value.trunk.name.trim())
      throw new Error(say("That is not a Branch Trunk file."));
    pick.file = value;
    draw(pick);
  } catch (error) { if (current()) { draw(pick); toast(error.message); } }
}

async function saveImport(button) {
  const pick = pending;
  if (!pick?.file || pick.busy || !here(pick)) return;
  pick.busy = true;
  button.disabled = true;
  let trunk;
  try { ({ trunk } = await api("trunks/import", pick.file)); }
  catch (error) {
    if (here(pick)) { toast(error.message); button.disabled = false; }
    pick.busy = false;
    return;
  }
  if (!here(pick)) return;
  closeDlg();
  pending = null;
  await refresh().catch((error) => toast(error.message));
  if (!ownerHere() || activeId() !== pick.owner) return;
  toast(say("Trunk imported."));
  const open = document.createElement("button");
  open.dataset.id = trunk.chatSessionId;
  run("chat", open);
}

export function initTrunkImport() {
  markLive(["trunk-import", "trunk-import-save", "sw:trunk-import-file"]);
  on("trunk-import", () => openImport());
  on("trunk-import-save", (button) => saveImport(button));
  document.addEventListener("change", (event) => { if (event.target.id === "trunk-import-file") readFile(event.target); });
}
