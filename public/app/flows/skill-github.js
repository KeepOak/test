import { $, esc, renderNow } from "../core/dom.js";
import { openDlg, closeDlg, toast } from "../core/ui.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { ownerHere, refresh } from "../core/state.js";
import { showTool } from "../places/customize.js";
import { t } from "../../i18n.js";

let preview = null, ticket = 0;
export function openGitHubSkill() {
  if (!ownerHere()) { toast(t("github-skill.owner")); return; }
  preview = null; ticket++;
  const field = (id, key) => `<label class="fld"><span>${t(key)}</span><input class="inp" id="${id}" autocomplete="off" spellcheck="false"></label>`;
  openDlg({ title: t("github-skill.title"), body: `<div id="github-skill-form">${field("github-skill-owner", "github-skill.owner-field")}${field("github-skill-repo", "github-skill.repo")}${field("github-skill-path", "github-skill.path")}${field("github-skill-sha", "github-skill.sha")}<p class="hint">${t("github-skill.public-only")}</p></div>`,
    foot: `<button class="btn pri" type="button" data-act="github-skill-inspect">${t("github-skill.inspect")}</button>` });
}
function showPreview() {
  const result = preview;
  const findings = (result.findings ?? []).map((finding) => `<li>${esc(finding.path)}:${finding.line} — ${esc(finding.reason)}</li>`).join("");
  const permissions = (result.permissions ?? []).map((permission) => `<li>${esc(permission.why)}</li>`).join("");
  const leftOut = (result.leftOut ?? []).map((path) => `<li>${esc(path)}</li>`).join("");
  openDlg({ title: t("github-skill.title"), wide: true,
    body: `<div id="github-skill-preview"><b>${esc(result.manifest.name)}</b><p><a href="${esc(result.origin.url)}" target="_blank" rel="noopener noreferrer">${esc(result.origin.owner)}/${esc(result.origin.repo)}</a></p><code>${esc(result.origin.treeSha)}</code><p class="hint">${t("github-skill.off")}</p>${findings ? `<ul class="hint" role="alert">${findings}</ul>` : ""}${permissions ? `<ul>${permissions}</ul>` : ""}<details><summary>${t("github-skill.instructions")}</summary><pre>${esc(result.document)}</pre></details>${leftOut ? `<details><summary>${t("github-skill.left-out")}</summary><ul>${leftOut}</ul></details>` : ""}</div>`,
    foot: `<button class="btn ghost" type="button" data-act="sk-git">${t("action.back")}</button><button class="btn pri" type="button" data-act="github-skill-install" ${result.blocked ? "disabled" : ""}>${t("github-skill.approve")}</button>` });
}
async function inspect(button) {
  if (!ownerHere()) return;
  const mine = ++ticket, form = $("#github-skill-form");
  if (!form) return;
  button.disabled = true;
  try {
    const treeSha = $("#github-skill-sha").value.trim();
    const result = await api("skill-installs/github", { owner: $("#github-skill-owner").value.trim(),
      repo: $("#github-skill-repo").value.trim(), path: $("#github-skill-path").value.trim(), ...(treeSha ? { treeSha } : {}) });
    if (mine !== ticket || form !== $("#github-skill-form") || !ownerHere()) return;
    preview = result; showPreview();
  } catch (error) { if (mine === ticket && form === $("#github-skill-form")) toast(error.message); }
  finally { if (button.isConnected) button.disabled = false; }
}
async function install(button) {
  if (!ownerHere() || !preview || preview.blocked) return;
  const mine = ticket, shown = $("#github-skill-preview"), chosen = preview.ticket;
  button.disabled = true;
  try {
    const result = await api("skill-installs/github/install", { ticket: chosen, approve: true });
    if (result.record?.ok === false) throw new Error(result.record.error);
    if (mine !== ticket || shown !== $("#github-skill-preview") || !ownerHere()) return;
    preview = null; ticket++; closeDlg();
    await refresh();
    if (!ownerHere()) return;
    showTool("skills", result.result.skill.id); renderNow(); toast(t("window.flows.conn.skill-added"));
  } catch (error) { if (mine === ticket && shown === $("#github-skill-preview")) { preview = null; toast(error.message); } }
  finally { if (button.isConnected) button.disabled = !preview; }
}
export function initGitHubSkills() {
  markLive(["sk-git", "github-skill-inspect", "github-skill-install", "sw:github-skill-owner", "sw:github-skill-repo", "sw:github-skill-path", "sw:github-skill-sha"]);
  on("sk-git", () => openGitHubSkill());
  on("github-skill-inspect", (button) => inspect(button));
  on("github-skill-install", (button) => install(button));
}
