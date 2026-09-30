import { esc } from "../core/dom.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { openDlg, toast } from "../core/ui.js";
import { markLive } from "../core/features.js";

export const pluginLifecycleButton = id => `<button type="button" class="btn" data-act="plugin-lifecycle" data-id="${esc(id)}">Compare and restore versions</button>`;
async function show(id) {
  const status = await api("plugin-catalog/status", { id });
  const reports = status.evaluations.map(report => `<div class="sec"><b>${esc(report.suite.id)}</b>
    <p>${report.baselineUnavailable ? "No approved baseline is installed." : `Installed: ${report.baseline.passed}/${report.baseline.total}.`} Candidate: ${report.candidate.passed}/${report.candidate.total}.
    ${report.passed ? (report.baselineUnavailable ? "Passed initial fixtures" : report.candidate.passed > report.baseline.passed ? "Improved" : "Passed with unchanged score") : "Failed or incomplete"}</p>
    <code>${esc(report.candidateHash)}</code>
    <p>Candidate permissions: ${esc((report.candidatePermissions ?? []).join(", ") || "none")}. Requested network hosts when enabled: ${esc((report.candidateHosts ?? []).join(", ") || "none")}.</p>
    ${report.passed ? `<button type="button" class="btn" data-act="plugin-promote" data-id="${esc(id)}" data-evaluation="${esc(report.id)}">Promote this candidate</button>` : ""}</div>`).join("");
  const versions = status.versions.map(version => `<p><code>${esc(version.versionSha256 ?? version.sha256)}</code>
    ${(version.versionSha256 ?? version.sha256) !== status.currentSha256 ? `<button type="button" class="btn" data-act="plugin-restore" data-id="${esc(id)}" data-sha="${esc(version.versionSha256 ?? version.sha256)}" data-current="${esc(status.currentSha256)}">Restore this version</button>` : "Current"}</p>`).join("");
  openDlg({ title: `Plugin versions: ${id}`, wide: true, body: `<p>Compare executable tasks with the installed version. Evaluations have no network access and cannot write your files. Promotion and restore switch the plugin off until you enable it.</p>
    <label for="plugin-candidate">Candidate folder or ZIP</label><input id="plugin-candidate" type="text">
    ${status.kind === "add-on" ? `<button type="button" class="btn" data-act="plugin-stage-update" data-id="${esc(id)}">Prepare update from its list</button>` : ""}
    <label for="plugin-suite">Task fixtures (JSON)</label><textarea id="plugin-suite" rows="8" placeholder='{"id":"my-tasks","cases":[{"id":"one","tool":"plugin.${esc(id)}.example","args":{},"expected":"result"}]}'></textarea>
    <button type="button" class="btn" data-act="plugin-evaluate" data-id="${esc(id)}">Run comparison</button>
    <h3>Comparison results</h3>${reports || "No comparisons yet."}<h3>Retained versions</h3>${versions || "The installed version will be retained before promotion."}` });
}
const guarded = handler => async element => {
  element.disabled = true;
  try { await handler(element); } catch (error) { toast(error.message); }
  finally { element.disabled = false; }
};
export function initPluginLifecycle() {
  markLive(["plugin-lifecycle", "plugin-evaluate", "plugin-promote", "plugin-restore", "plugin-stage-update"]);
  on("plugin-stage-update", guarded(async el => {
    const candidate = await api("plugin-catalog/add-ons/lists/stage-update", { id: el.dataset.id });
    document.getElementById("plugin-candidate").value = candidate.source;
  }));
  on("plugin-lifecycle", guarded(el => show(el.dataset.id)));
  on("plugin-evaluate", guarded(async el => {
    const source = document.getElementById("plugin-candidate").value;
    const suite = JSON.parse(document.getElementById("plugin-suite").value);
    await api("plugin-catalog/evaluate", { id: el.dataset.id, source, suite });
    await show(el.dataset.id);
  }));
  on("plugin-promote", guarded(async el => {
    await api("plugin-catalog/promote", { id: el.dataset.id, evaluationId: el.dataset.evaluation });
    await show(el.dataset.id);
  }));
  on("plugin-restore", guarded(async el => {
    await api("plugin-catalog/restore", { id: el.dataset.id, sha256: el.dataset.sha, expectedCurrent: el.dataset.current });
    await show(el.dataset.id);
  }));
}
