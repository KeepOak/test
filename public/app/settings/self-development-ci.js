import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { esc, render } from "../core/dom.js";
import { E } from "../core/state.js";
import { markLive } from "../core/features.js";

let snapshot = null, problem = "", busy = false, repository = "";
const states = { unknown: "Unknown", pending: "Queued or running", "observed-passed": "Observed checks passed", "not-passed": "Checks did not pass" };

export function ciQueueSection() {
  if (E.profiles?.isOwner === false) return "";
  const rows = (snapshot?.rows ?? []).map((row) => {
    const runs = [...row.checks, ...row.workflows].map((run) => `<li>${esc(run.name)}: ${esc(run.status)} · ${esc(run.result ?? run.conclusion)}${run.attempt ? ` · attempt ${esc(run.attempt)} · ${esc(run.event)}` : ""}</li>`).join("");
    const label = row.labels.includes("ci-waiting") ? " · Waiting for a CI slot" : "";
    return `<li><b>#${row.number} ${esc(row.title)}</b><p>${esc(states[row.state] ?? "Unknown")}${esc(label)}${row.draft ? " · Draft" : ""}</p><code>${esc(row.headSha)}</code><p>${row.exactHead ? "Matched the PR head when read" : "Head changed; refresh needed"}</p><ul>${runs}</ul></li>`;
  }).join("");
  return `<div class="sec"><h2>CI queue</h2><p>Read current pull-request heads, check runs and workflow attempts from your connected GitHub account.</p>
    <label for="self-ci-repo">Repository (owner/name)</label><input class="inp" id="self-ci-repo" value="${esc(repository)}" spellcheck="false">
    <button class="btn" type="button" data-act="self-ci-refresh" ${busy ? "disabled" : ""}>${busy ? "Reading CI…" : "Refresh CI"}</button>
    <p role="status">${esc(problem)}</p>${snapshot ? `<p>Snapshot: ${esc(snapshot.observedAt)}. Heads may have moved since this read. Required branch rules are unverified.</p><ol>${rows || "<li>No open pull requests.</li>"}</ol>` : ""}</div>`;
}

export function initCiQueue() {
  markLive(["self-ci-refresh"]);
  on("self-ci-refresh", async () => {
    if (busy) return;
    repository = document.getElementById("self-ci-repo")?.value.trim() ?? "";
    snapshot = null; problem = ""; busy = true; render();
    try { snapshot = await api("self-development/ci", { repo: repository }); }
    catch (error) { problem = error.message; }
    finally { busy = false; render(); }
  });
}
