/* A new saved prompt (Automations › Procedures, "New prompt"), saved in the engine's prompt library with POST /api/prompts
   {title, command, body}. Blanks are the engine's {{name}}; the line under the text says which ones it will ask for.
   The library is off until the owner switches it on, and the engine's refusal is shown in its own words.
   There is no "Try on two models" here: asking two models at once is the Model arena's, which the dialog says in words. Save waits until the name and what to ask are filled in (stress test B005), and says so;
   while the library is switched off, the dialog opens with its switch (places/switch-on.js) above the fields. */

import { $ } from "../core/dom.js";
import { offTile, modeOf } from "../places/switch-on.js";
import { openDlg, closeDlg, toast } from "../core/ui.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { reason } from "../core/why.js";
import { t } from "../../i18n.js";

async function newPrompt() {
  let mode = null;
  try { mode = await modeOf("prompts"); } catch (error) { toast(error.message); }
  const off = mode === "off" ? offTile("prompts", t("window.switch-on.off", { label: t("prompts.card.title") })) : "";
  openDlg({ title: t("window.flows.prompt.title"),
    body: `${off}<label class="fld"><span>${t("accounts.field.name")}</span><input class="inp" id="pr-name"></label><label class="fld"><span>${t("commands.dashboard.label")}</span><input class="inp" id="pr-cmd" maxlength="32"></label><label class="fld"><span>${t("window.flows.flow.what-ask")}</span><textarea class="inp" id="pr-text" rows="3"></textarea></label><p class="hint" id="pr-blanks"></p><p class="hint" id="pr-need">${t("window.switch-on.prompt-need")}</p><p class="hint">${reason("prompt-try")}</p>`,
    foot: `<button class="btn pri" type="button" data-act="prompt-save" disabled>${t("action.save")}</button>` });
}

/* Save is pressable once both the name and what to ask have words; the line under the fields says what is missing. */
const filled = () => Boolean(($("#pr-name")?.value ?? "").trim() && ($("#pr-text")?.value ?? "").trim());
function checkFilled() {
  const save = document.querySelector('[data-act="prompt-save"]'), need = $("#pr-need");
  if (save) save.disabled = !filled();
  if (need) need.hidden = filled();
}

async function savePrompt() {
  if (!filled()) { ($("#pr-name")?.value.trim() ? $("#pr-text") : $("#pr-name"))?.focus(); return; }
  const title = ($("#pr-name")?.value ?? "").trim(), command = ($("#pr-cmd")?.value ?? "").trim().replace(/^\//, "").toLowerCase(), body = ($("#pr-text")?.value ?? "").trim();
  try {
    const saved = await api("prompts", { title, command, body });
    closeDlg();
    document.dispatchEvent(new Event("branch-prompts")); // the "/" menu reads its list again (chat/messages.js)
    toast(t("window.flows.prompt.saved", { command: saved.command || command }));
  } catch (error) { toast(error.message); }
}

function showBlanks(text) {
  const names = [...new Set([...text.matchAll(/\{\{\s*([a-z][a-z0-9_]{0,39})\s*\}\}/g)].map((m) => `{{${m[1]}}}`))];
  const line = $("#pr-blanks");
  if (line) line.textContent = names.length ? t("window.prompts.blanks", { names: names.join(", ") }) : "";
}

export function init() {
  markLive(["prompt-new", "prompt-save", "sw:pr-name", "sw:pr-cmd", "sw:pr-text"]);
  on("prompt-new", () => newPrompt());
  on("prompt-save", () => savePrompt());
  document.addEventListener("input", (e) => {
    if (e.target.id === "pr-text") showBlanks(e.target.value);
    if (e.target.id === "pr-name" || e.target.id === "pr-text") checkFilled();
  });
  /* Switched on from inside the dialog: its switch line goes, the fields stay as typed. */
  document.addEventListener("branch-switched", (e) => { if (e.detail?.key === "prompts") document.querySelector('.dlg [data-off="prompts"]')?.remove(); });
}
