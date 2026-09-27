/* A new saved prompt (Automations › Procedures, "New prompt"), saved in the engine's prompt library with POST /api/prompts
   {title, command, body}. Blanks are the engine's {{name}}; the line under the text says which ones it will ask for.
   The library is off until the owner switches it on, and the engine's refusal is shown in its own words.
   "Try on two models" stays greyed. */

import { $ } from "../core/dom.js";
import { openDlg, closeDlg, toast } from "../core/ui.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { t } from "../../i18n.js";

function newPrompt() {
  openDlg({ title: t("window.flows.prompt.title"),
    body: `<label class="fld"><span>${t("accounts.field.name")}</span><input class="inp" id="pr-name"></label><label class="fld"><span>${t("commands.dashboard.label")}</span><input class="inp" id="pr-cmd" maxlength="32"></label><label class="fld"><span>${t("window.flows.flow.what-ask")}</span><textarea class="inp" id="pr-text" rows="3"></textarea></label><p class="hint" id="pr-blanks"></p>`,
    foot: `<button class="btn ghost" type="button" data-act="prompt-try">${t("window.flows.prompt.try")}</button><button class="btn pri" type="button" data-act="prompt-save">${t("action.save")}</button>` });
}

async function savePrompt() {
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
  document.addEventListener("input", (e) => { if (e.target.id === "pr-text") showBlanks(e.target.value); });
}
