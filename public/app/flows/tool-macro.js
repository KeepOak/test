/* Check/import are separate from Run. Existing graph policy, approvals and source limits remain authoritative. */
import { $, esc } from "../core/dom.js";
import { api, token } from "../core/api.js";
import { activeId } from "../core/state.js";
import { on } from "../core/actions.js";
import { openDlg, dialog, toast } from "../core/ui.js";
import { markLive } from "../core/features.js";

let generation = 0;
const actor = () => JSON.stringify([activeId(), token.get()]);
const example = JSON.stringify({ format: "branch-tool-macro/1", name: "List matching workspace files", input: { patterns: "list of text" },
  steps: [{ name: "List files", tool: "files.glob", args: { patterns: { $value: "patterns" } }, output: {} }] }, null, 2);

function editor() {
  ++generation;
  openDlg({ title: "Typed tool macro", wide: true, body: `<p>A package is a sequence of registered tools with typed inputs. Check first, then import. Import does not run it. Each call still follows your approval rules.</p>
    <label for="macro-json">Macro JSON (up to 64 KB)</label><textarea id="macro-json" rows="14" maxlength="64000">${esc(example)}</textarea>
    <p id="macro-check" role="status"></p>`, foot: '<button class="btn ghost" type="button" data-act="macro-check">Check</button><button class="btn" type="button" data-act="macro-save">Import as flow</button>' });
}

async function library() {
  const who = actor(), ticket = ++generation;
  const waiting = openDlg({ title: "Typed tool macros", body: '<p role="status">Reading saved macros…</p>' });
  try {
    const result = await api("flows/macros");
    if (waiting !== dialog() || who !== actor() || ticket !== generation) return;
    openDlg({ title: "Typed tool macros", body: result.macros.length ? `<ul>${result.macros.map((flow) => `<li><button class="btn ghost" type="button" data-act="macro-open" data-id="${esc(flow.id)}">${esc(flow.name)}</button></li>`).join("")}</ul>` : "<p>No imported macros.</p>",
      foot: '<button class="btn" type="button" data-act="macro-new">Import new macro</button>' });
  } catch (error) { if (waiting === dialog() && who === actor() && ticket === generation) toast(error.message); }
}

async function openSaved(el) {
  const who = actor(), waiting = dialog(), ticket = ++generation;
  try { const flow = await api(`flows/${encodeURIComponent(el.dataset.id)}`); if (waiting === dialog() && who === actor() && ticket === generation) details(flow); }
  catch (error) { if (waiting === dialog() && who === actor() && ticket === generation) toast(error.message); }
}

async function submit(save) {
  const box = $("#macro-json"), waiting = dialog(), who = actor(), ticket = ++generation;
  if (!box) return;
  try {
    const value = JSON.parse(box.value);
    const result = await api(save ? "flows/macros" : "flows/macros/check", value);
    if (waiting !== dialog() || who !== actor() || ticket !== generation) return;
    if (save) details(result);
    else $("#macro-check").textContent = `Checked ${result.tools.length} steps: ${result.tools.join(", ")}. Check runs no tools.`;
  } catch (error) { if (waiting === dialog() && who === actor() && ticket === generation) $("#macro-check").textContent = error.message; }
}

function details(flow) {
  ++generation;
  const shape = flow.definition.input;
  openDlg({ title: flow.name, wide: true, body: `<p>Imported flow <code>${esc(flow.id)}</code>. ${esc(flow.description)}</p>
    <p>Inputs: ${esc(Object.entries(shape).map(([name, type]) => `${name}: ${type}`).join(", ") || "none")}.</p>
    <ol>${flow.definition.nodes.map((node) => `<li>${esc(node.name)} — <code>${esc(node.tool)}</code></li>`).join("")}</ol>
    <label for="macro-input">Input values (JSON object; replace null with each required typed value)</label><textarea id="macro-input" rows="5" maxlength="64000">${esc(JSON.stringify(Object.fromEntries(Object.keys(shape).map((name) => [name, null])), null, 2))}</textarea>
    <p id="macro-run-status" role="status">Not started. Tool effects cannot be undone by cancelling.</p>`,
    foot: `<button class="btn" type="button" data-act="macro-run" data-id="${esc(flow.id)}">Run once</button><button class="btn ghost" type="button" data-act="macro-remove-ask" data-id="${esc(flow.id)}">Remove saved macro</button><button class="btn ghost" type="button" data-act="macro-import">All macros</button>` });
}

async function start(el) {
  const waiting = dialog(), who = actor(), ticket = ++generation;
  const values = $("#macro-input")?.value;
  if (values == null) return;
  el.disabled = true;
  try {
    const result = await api(`flows/${encodeURIComponent(el.dataset.id)}/run`, JSON.parse(values));
    if (waiting !== dialog() || who !== actor() || ticket !== generation) return;
    openRun(result.runId, result.flowId);
  } catch (error) { if (waiting === dialog() && who === actor() && ticket === generation) { $("#macro-run-status").textContent = error.message; el.disabled = false; } }
}

async function openRun(id, flowId) {
  const who = actor(), ticket = ++generation;
  const waiting = openDlg({ title: "Macro run", body: '<p role="status">Reading checkpoint…</p>' });
  try {
    const result = await api(`flows/runs/${encodeURIComponent(id)}`);
    if (waiting !== dialog() || who !== actor() || ticket !== generation) return;
    const interrupted = result.status === "interrupted" || result.status === "waiting_approval" && result.nodes.some((node) => node.nodeId === result.nextNode && node.status === "running");
    const expected = `data-node="${esc(result.nextNode ?? "")}" data-question="${esc(result.question ?? "")}" data-seq="${result.nodes.at(-1)?.seq ?? 0}"`;
    openDlg({ title: "Macro run", body: `<p role="status">${esc(result.status)}</p>${result.question ? `<p>${esc(result.question)}</p>` : ""}${result.error ? `<p>${esc(result.error)}</p>` : ""}
      <ol>${result.nodes.map((node) => `<li>${esc(node.name)}: ${esc(node.status)}</li>`).join("")}</ol><p>Effects already performed cannot be undone.</p>`,
      foot: `<button class="btn ghost" type="button" data-act="macro-refresh" data-id="${esc(id)}" data-flow="${esc(flowId)}">Refresh</button>
      ${result.status === "waiting_approval" && !interrupted ? `<button class="btn" type="button" data-act="macro-resume" data-flow="${esc(flowId)}" data-id="${esc(id)}" ${expected}>Approve waiting step and continue</button>` : ""}
      ${interrupted ? `<button class="btn" type="button" data-act="macro-resume" data-flow="${esc(flowId)}" data-id="${esc(id)}" data-v="again" ${expected}>Retry interrupted step</button><button class="btn ghost" type="button" data-act="macro-resume" data-flow="${esc(flowId)}" data-id="${esc(id)}" data-v="past" ${expected}>Skip interrupted step</button>` : ""}
      ${["running", "waiting_approval", "interrupted", "failed"].includes(result.status) ? `<button class="btn ghost" type="button" data-act="macro-cancel" data-id="${esc(id)}" data-flow="${esc(flowId)}">Cancel run</button>` : ""}` });
  } catch (error) { if (waiting === dialog() && who === actor() && ticket === generation) toast(error.message); }
}

export function initToolMacro() {
  markLive(["macro-import", "macro-new", "macro-open", "macro-check", "macro-save", "macro-run", "macro-refresh", "macro-cancel", "macro-resume", "macro-remove-ask", "macro-remove"]);
  on("macro-import", library);
  on("macro-new", editor);
  on("macro-open", openSaved);
  on("macro-remove-ask", (el) => {
    ++generation;
    openDlg({ title: "Remove saved macro?", body: "<p>The saved definition and its published tool will be removed. Previously performed effects stay. Cancel unfinished runs first.</p>",
      foot: `<button class="btn" type="button" data-act="macro-remove" data-id="${esc(el.dataset.id)}">Remove</button><button class="btn ghost" type="button" data-act="dlg-close">Keep</button>` });
  });
  on("macro-remove", async (el) => {
    const who = actor(), waiting = dialog();
    try { await api(`flows/${encodeURIComponent(el.dataset.id)}`, undefined, "DELETE"); if (who === actor() && waiting === dialog()) library(); }
    catch (error) { if (who === actor() && waiting === dialog()) toast(error.message); }
  });
  on("macro-check", () => submit(false));
  on("macro-save", () => submit(true));
  on("macro-run", start);
  on("macro-refresh", (el) => openRun(el.dataset.id, el.dataset.flow));
  on("macro-resume", async (el) => {
    const who = actor(), waiting = dialog();
    el.disabled = true;
    try { const run = await api(`flows/runs/${encodeURIComponent(el.dataset.id)}/resume`, { expectedNode: el.dataset.node || null, expectedQuestion: el.dataset.question || null, expectedSeq: Number(el.dataset.seq), ...(el.dataset.v ? { interrupted: el.dataset.v } : {}) }); if (who === actor() && waiting === dialog()) openRun(run.runId, run.flowId); }
    catch (error) { if (who === actor() && waiting === dialog()) { toast(error.message); el.disabled = false; } }
  });
  on("macro-cancel", async (el) => {
    const who = actor(), waiting = dialog();
    try { await api(`flows/runs/${encodeURIComponent(el.dataset.id)}/cancel`, {}); if (who === actor() && waiting === dialog()) openRun(el.dataset.id, el.dataset.flow); }
    catch (error) { if (who === actor() && waiting === dialog()) toast(error.message); }
  });
}
