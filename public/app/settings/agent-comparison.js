import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { esc } from "../core/dom.js";
import { E } from "../core/state.js";
import { markLive } from "../core/features.js";
import { openDlg, toast } from "../core/ui.js";

let overview = null, busy = false;
export function agentComparisonSection() {
  return E.profiles?.isOwner === false ? "" : `<div class="sec"><h2>Compare agent implementations</h2><p>Ask Branch to compare chosen steps against pinned Branch, Hermes and OpenClaw source files. Source interpretations require evidence; this does not run competitor agents or establish benchmark results.</p><button class="btn" type="button" data-act="agent-comparison-open">Set up comparison</button></div>`;
}

function draw() {
  const choices = overview.presets.map((preset) => `<option value="${esc(preset.id)}">${esc(preset.name)} · ${esc(preset.model)}</option>`).join("");
  const jobs = overview.jobs.map((job, index) => `<li>${esc(job.startedAt)} · ${esc(job.status)} · ${esc(job.artifact?.status ?? "No verified artifact")} ${job.runId ? `<code>${esc(job.runId)}</code>` : ""}<button class="btn ghost" data-act="agent-comparison-artifact" data-index="${index}">Read artifact and manifest</button></li>`).join("");
  openDlg({ title: "Compare pinned implementations", wide: true, body: `<p>Comparisons are ${overview.enabled ? "enabled" : "off"}. Starting a job uses your chosen model and bounded token allowance. No agent tools are granted.</p>
    <button class="btn" data-act="agent-comparison-enable" data-value="${overview.enabled ? "false" : "true"}">${overview.enabled ? "Turn off comparisons" : "Enable comparisons"}</button>
    <label for="comparison-preset">Model preset</label><select id="comparison-preset"><option value="">Choose a model explicitly</option>${choices}</select>
    <label for="comparison-tokens">Maximum tokens (input and output)</label><input class="inp" id="comparison-tokens" type="number" value="12000">
    <label for="comparison-steps-budget">Maximum model steps</label><input class="inp" id="comparison-steps-budget" type="number" value="3">
    <label for="comparison-timeout">Timeout in milliseconds</label><input class="inp" id="comparison-timeout" type="number" value="120000">
    <label for="comparison-sources">Primary sources: JSON array of {agent,commit,path,fromLine,toLine}. Pin a full 40-character commit for each of Branch, Hermes and OpenClaw; up to 6 files (1 MiB each), at most 100 selected lines per file. Total prompt must fit 16,000 characters and the chosen model's context.</label><textarea class="inp" id="comparison-sources" rows="5">[]</textarea>
    <label for="comparison-steps">Implementation steps to compare, one per line (up to 12)</label><textarea class="inp" id="comparison-steps" rows="4"></textarea>
    <label><input type="checkbox" id="comparison-network">Allow fetching only the selected pinned primary files from raw.githubusercontent.com, subject to existing network policy</label>
    <p>Fetched text is untrusted information. Artifacts preserve its hashes, commits, model-run identity and quoted evidence. Evidence anchors do not verify the model's interpretation or runtime behavior.</p><ol>${jobs || "<li>No comparison jobs.</li>"}</ol>`,
    foot: `<button class="btn ghost" data-act="dlg-close">Close</button><button class="btn" data-act="agent-comparison-refresh">Refresh history</button><button class="btn pri" data-act="agent-comparison-start" ${overview.enabled && !busy ? "" : "disabled"}>Start bounded comparison</button>` });
}

export function initAgentComparison() {
  markLive(["agent-comparison-open", "agent-comparison-enable", "agent-comparison-start", "agent-comparison-refresh", "agent-comparison-artifact"]);
  const reload = async () => { overview = await api("agent-comparison"); draw(); };
  on("agent-comparison-open", () => reload().catch((error) => toast(error.message)));
  on("agent-comparison-refresh", () => reload().catch((error) => toast(error.message)));
  on("agent-comparison-enable", async (el) => { try { overview = await api("agent-comparison/settings", { enabled: el.dataset.value === "true" }); draw(); } catch (error) { toast(error.message); } });
  on("agent-comparison-artifact", (el) => openDlg({ title: "Source comparison artifact", wide: true,
    body: `<pre class="code6">${esc(JSON.stringify(overview.jobs[Number(el.dataset.index)], null, 2))}</pre>`, foot: `<button class="btn" data-act="dlg-close">Close</button>` }));
  on("agent-comparison-start", async (el) => {
    if (busy) return;
    try {
      if (!document.getElementById("comparison-network")?.checked) throw new Error("Choose the source network scope explicitly before starting.");
      const number = (id) => Number(document.getElementById(id)?.value);
      const input = { preset: document.getElementById("comparison-preset")?.value, maxTokens: number("comparison-tokens"),
        maxSteps: number("comparison-steps-budget"), timeoutMs: number("comparison-timeout"), network: "pinned-primary-sources",
        sources: JSON.parse(document.getElementById("comparison-sources")?.value ?? "[]"),
        steps: document.getElementById("comparison-steps")?.value.split("\n").map((step) => step.trim()).filter(Boolean) ?? [] };
      busy = true; el.disabled = true; toast("Requesting comparison with the selected model and budget.");
      const result = await api("agent-comparison/start", input); toast(`Comparison artifact: ${result.artifact.status}`); await reload();
    } catch (error) { toast(error.message); }
    finally { busy = false; const button = document.querySelector('[data-act="agent-comparison-start"]'); if (button) button.disabled = !overview?.enabled; }
  });
}
