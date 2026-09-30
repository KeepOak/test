import { $, esc } from "../core/dom.js";
import { api, token } from "../core/api.js";
import { activeId, E, S } from "../core/state.js";
import { on } from "../core/actions.js";
import { openDlg, dialog, toast } from "../core/ui.js";

let generation = 0;
const profiles = new WeakMap(); let profileSerial = 0;
const actor = () => {
  const profile = E.profiles;
  if (profile && !profiles.has(profile)) profiles.set(profile, ++profileSerial);
  return JSON.stringify([profiles.get(profile), activeId(), token.get(), S.signedIn, E.profiles?.isOwner,
    document.getElementById("app")?.classList.contains("locked-b17"), document.getElementById("app")?.classList.contains("locked")]);
};
const example = { name: "Daily file review", macroId: "REPLACE_WITH_IMPORTED_MACRO_ID",
  event: { kind: "cron", cron: "0 9 * * *", timezone: "America/New_York" }, input: { patterns: ["*.md"] } };

async function library() {
  const who = actor(), ticket = ++generation;
  const waiting = openDlg({ title: "Event procedures", wide: true, body: '<p role="status">Reading procedures…</p>' });
  try {
    const result = await api("flows/sops");
    if (who !== actor() || waiting !== dialog() || ticket !== generation) return;
    openDlg({ title: "Event procedures", wide: true, body: `<p>Each event proposes one run. Approve here within ten minutes; individual tool approvals still apply. Switching off discards proposals, while existing runs stay cancellable.</p>
      ${result.procedures.map((row) => `<section><h3>${esc(row.name)}</h3><p>${row.enabled ? "Enabled" : "Disabled"} · ${esc(row.event.kind)} · macro ${esc(row.macroId)}</p>
      <details><summary>Exact event and input mapping</summary><pre>${esc(JSON.stringify({ event: row.event, input: row.input }, null, 2))}</pre></details>
      ${row.hold ? `<p role="status">Held: ${esc(row.hold)}</p>` : ""}
      ${row.due ? `<p>Next scheduled event: ${esc(row.due)}</p>` : ""}
      <button class="btn ghost" type="button" data-act="sop-enable" data-id="${esc(row.id)}" data-v="${row.enabled ? "off" : "on"}">${row.enabled ? "Switch off" : "Enable event proposals"}</button>
      <button class="btn ghost" type="button" data-act="sop-remove" data-id="${esc(row.id)}">Remove procedure${row.event.kind === "webhook" ? " and restore original trigger prompt" : ""}</button>
      ${row.pending.map((proposal) => `<article><p>Event ${esc(proposal.at)} · source ${esc(proposal.source)} · expires ${esc(proposal.expires)}</p><pre>${esc(JSON.stringify(proposal.input, null, 2))}</pre>
        <button class="btn" type="button" data-act="sop-approve" data-id="${esc(row.id)}" data-proposal="${esc(proposal.id)}">Approve this event and run macro</button>
        <button class="btn ghost" type="button" data-act="sop-reject" data-id="${esc(row.id)}" data-proposal="${esc(proposal.id)}">Discard event</button></article>`).join("")}
      ${row.runs.map((id) => `<button class="btn ghost" type="button" data-act="macro-refresh" data-id="${esc(id)}" data-flow="${esc(row.macroId)}">Open run ${esc(id)}</button>`).join("")}</section>`).join("") || "<p>No procedures saved.</p>"}`,
      foot: '<button class="btn ghost" type="button" data-act="sop-library">Refresh</button><button class="btn" type="button" data-act="sop-new">Add event procedure</button>' });
  } catch (error) { if (who === actor() && waiting === dialog() && ticket === generation) toast(error.message); }
}

function editor() {
  ++generation;
  openDlg({ title: "Add event procedure", wide: true, body: `<p>Import a typed macro first. Save creates a disabled procedure. Supported events: cron (five fields and timezone), webhook (existing triggerId with replay protection), mqtt (exact authorized channel/chatId/senderId/topic), device (four hexadecimal vendorId/productId and exact serial). Input values are literals or {"$event":"text"}; no scripts or expressions.</p>
    <p>Saving a webhook procedure takes over its existing signed trigger endpoint even while disabled. Removing it restores the original trigger prompt. MQTT enablement consumes matching authorized messages instead of opening chat turns. Trunk-bound sources are held. USB uses the existing opt-in scanner; Windows has no supported scanner.</p>
    <label for="sop-json">Procedure JSON (up to 32 KB)</label><textarea id="sop-json" rows="14" maxlength="32000">${esc(JSON.stringify(example, null, 2))}</textarea><p id="sop-error" role="status"></p>`,
    foot: '<button class="btn" type="button" data-act="sop-save">Save disabled procedure</button><button class="btn ghost" type="button" data-act="macro-import">Open macro library</button>' });
}

async function change(el, action, value) {
  const who = actor(), waiting = dialog(), ticket = ++generation;
  el.disabled = true;
  try {
    const result = await api(`flows/sops/${encodeURIComponent(el.dataset.id)}/${action}`, value);
    if (who !== actor() || waiting !== dialog() || ticket !== generation) return;
    if (result.runId) toast(`Started run ${result.runId}; open it for checkpoint approvals or cancellation.`);
    await library();
  } catch (error) { if (who === actor() && waiting === dialog() && ticket === generation) { toast(error.message); el.disabled = false; } }
}

export function initSopEvents() {
  const app = document.getElementById("app");
  if (app) new MutationObserver(() => { if (app.classList.contains("locked-b17") || app.classList.contains("locked")) generation++; })
    .observe(app, { attributes: true, attributeFilter: ["class"] });
  on("sop-library", library); on("sop-new", editor);
  on("sop-enable", (el) => change(el, "enable", { enabled: el.dataset.v === "on" }));
  on("sop-approve", (el) => change(el, "approve", { proposalId: el.dataset.proposal }));
  on("sop-reject", (el) => change(el, "reject", { proposalId: el.dataset.proposal }));
  on("sop-remove", (el) => change(el, "remove", {}));
  on("sop-save", async (el) => {
    const who = actor(), waiting = dialog(), ticket = ++generation;
    try {
      const value = JSON.parse($("#sop-json").value); el.disabled = true;
      await api("flows/sops", value);
      if (who === actor() && waiting === dialog() && ticket === generation) await library();
    } catch (error) { if (who === actor() && waiting === dialog() && ticket === generation) { $("#sop-error").textContent = error.message; el.disabled = false; } }
  });
}
