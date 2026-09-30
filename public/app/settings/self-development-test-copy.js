import { api } from "../core/api.js";
import { esc, render } from "../core/dom.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { openDlg, toast } from "../core/ui.js";

let changes = [], problem = null, loading = false, selectedCopy = null, currentJob = null;

export async function loadTestCopies() {
  loading = true;
  try { changes = (await api("self-development/merge")).changes ?? []; problem = null; }
  catch (error) { changes = []; problem = error.message; }
  finally { loading = false; }
}

export function testCopySection() {
  const note = problem ?? (loading ? "Reading source changes…" : "Commit a scoped source change, then prepare a separate copy to try it.");
  return `<div class="sec"><h2>Test copy</h2><p class="hint">${esc(note)}</p>${changes.map((change) =>
    `<div class="ctl"><b>${esc(change.worktree)}</b><span class="right"><button class="btn" type="button" data-act="self-test-copy" data-worktree="${esc(change.worktree)}">Test copy</button></span><small>A separate source checkout and empty data folder. Your running Branch stays open.</small></div>`).join("")}
    ${!changes.length && !loading && !problem ? "<p>No source changes have been prepared yet.</p>" : ""}
    <button class="btn ghost" type="button" data-act="self-test-copy-refresh">Refresh source changes</button>${selectedCopy ? `<button class="btn" type="button" data-act="self-test-copy-show">Open last test copy</button>` : ""}</div>`;
}

async function prepare(el) {
  el.disabled = true;
  try {
    selectedCopy = await api("self-development/merge/test-copy", { worktree: el.dataset.worktree });
    currentJob = null;
    showCopy();
  } catch (error) { toast(error.message); }
  finally { el.disabled = false; }
}

function showCopy() {
  const copy = selectedCopy;
  if (!copy) return;
  const active = currentJob?.status === "running";
  const job = currentJob ? `<p><b>${esc(currentJob.mode)}: ${esc(currentJob.status)}</b></p><p>${esc(currentJob.problem ?? "")}</p><pre>${esc([currentJob.result?.stdout, currentJob.result?.stderr].filter(Boolean).join("\n"))}</pre><p class="hint">A passed preview means this isolated engine answered health. Native desktop UI, providers and installed updates remain untested.</p>` : "";
  const preparation = `<p><b>Tests have not run. The copy has not launched.</b></p><p>A pre-existing container image with Node 24 and this copy's own dependencies is required. Nothing will be downloaded or installed.</p><ul>${copy.holds.map((hold) => `<li>${esc(hold)}</li>`).join("")}</ul>`;
  openDlg({ title: "Test copy", wide: true,
      body: `<p>The copy contains commit <code>${esc(copy.sha)}</code>.</p><dl class="kv"><dt>Source copy</dt><dd>${esc(copy.folder)}</dd><dt>Fresh data</dt><dd>${esc(copy.dataDirectory)}</dd><dt>Preview workspace</dt><dd>${esc(copy.workspace)}</dd></dl>${currentJob ? job : preparation}<p>Expected tests</p><pre>${esc(copy.expectedTests.join("\n"))}</pre>`,
      foot: `${active ? `<button class="btn" type="button" data-act="self-test-copy-status">Check job</button><button class="btn" type="button" data-act="self-test-copy-cancel">Cancel job</button>` : `<button class="btn" type="button" data-act="self-test-copy-start" data-mode="tests">Run focused tests</button><button class="btn" type="button" data-act="self-test-copy-start" data-mode="preview">Try confined engine</button>`}<button class="btn" type="button" data-act="dlg-close">Done</button>` });
}

async function jobAction(el, action) {
  if (!selectedCopy || (action !== "start" && !currentJob)) return;
  el.disabled = true;
  try {
    currentJob = await api(`self-development/merge/test-copy/${action}`, action === "start"
      ? { id: selectedCopy.id, mode: el.dataset.mode } : { id: currentJob.id });
    showCopy();
  } catch (error) { toast(error.message); }
  finally { el.disabled = false; }
}

export function initTestCopies() {
  on("self-test-copy", prepare);
  on("self-test-copy-refresh", async () => { await loadTestCopies(); render(); });
  on("self-test-copy-show", showCopy);
  on("self-test-copy-start", (el) => jobAction(el, "start"));
  on("self-test-copy-status", (el) => jobAction(el, "status"));
  on("self-test-copy-cancel", (el) => jobAction(el, "cancel"));
  markLive(["self-test-copy", "self-test-copy-refresh", "self-test-copy-show", "self-test-copy-start", "self-test-copy-status", "self-test-copy-cancel"]);
}
