/* "Write one with Branch" in Add a skill (the prototype's 'Write a skill with Branch' dialog: sk-write, sk-draft, sk-save).
   The owner says what the skill should know how to do; "Draft it" asks the engine to write the SKILL.md with the model
   (POST /api/skills/write {what}), which installs nothing and refuses in its own words (no model, a name already taken,
   or a line that reads like an order slipped in). The draft is shown exactly as it would be installed. "Add skill" stays
   disabled until there is a draft, and then installs exactly that text (POST /api/skills/install {document}), which the
   engine checks and scans again, and opens it in Customize › Tools. */

import { $, esc, renderNow } from "../core/dom.js";
import { openDlg, closeDlg, closePop, dialog, toast } from "../core/ui.js";
import { refresh } from "../core/state.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { showTool, reloadTools } from "../places/customize.js";
import { t } from "../../i18n.js";

let draft = null; // { name, description, document } from the engine, or null

function openWrite() {
  closePop();
  draft = null;
  openDlg({ title: t("window.flows.skill-write.title"),
    body: `<label class="fld"><span>${t("window.flows.skill-write.what")}</span><textarea class="inp" id="sk-what" rows="3"></textarea></label><div id="sk-draft"></div>`,
    foot: `<button class="btn" type="button" data-act="sk-draft">${t("window.flows.skill-write.draft-it")}</button><button class="btn pri" type="button" data-act="sk-save" disabled>${t("window.flows.skill-write.add-skill")}</button>` });
}

async function draftIt(el) {
  const box = $("#sk-what"), what = box?.value.trim();
  if (!what) { box?.setAttribute("aria-invalid", "true"); box?.focus(); return; }
  el.disabled = true;
  try { draft = await api("skills/write", { what }); } catch (error) { draft = null; toast(error.message); }
  el.disabled = false;
  const dlg = dialog(), shown = dlg?.querySelector("#sk-draft"), save = dlg?.querySelector('[data-act="sk-save"]');
  if (shown) shown.innerHTML = draft ? `<pre class="diff6">${esc(draft.document)}</pre>` : "";
  if (save) save.disabled = !draft;
}

async function save() {
  if (!draft) return;
  const kept = draft; // taken at once, so a second press while this one is on its way installs nothing more
  draft = null;
  let skill;
  try { skill = await api("skills/install", { document: kept.document }); } catch (error) { draft = kept; toast(error.message); return; }
  const name = kept.name;
  closeDlg();
  await refresh().catch((error) => toast(error.message));
  await reloadTools().catch((error) => toast(error.message));
  showTool("skills", skill.id);
  renderNow();
  toast(t("window.flows.skill-write.added", { name }));
}

export function init() {
  markLive(["sk-write", "sk-draft", "sk-save", "sw:sk-what"]);
  on("sk-write", () => openWrite());
  on("sk-draft", (el) => draftIt(el));
  on("sk-save", () => save());
}
