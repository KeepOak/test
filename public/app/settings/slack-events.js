import { api } from "../core/api.js";
import { esc, render } from "../core/dom.js";
import { ownerHere } from "../core/state.js";
import { on, has } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { toast, openDlg, closeDlg } from "../core/ui.js";

let settings = null, pending = null;
export async function loadSlackEvents() {
  if (!ownerHere()) { settings = null; return; }
  try { settings = await api("channels/slack-automations"); } catch (error) { toast(error.message); }
  render();
}
export function slackEventsCard() {
  if (!ownerHere()) return "";
  const queued = (settings?.waiting ?? []).map((event) => `<button class="btn sm" data-act="sl-event-run" data-id="${esc(event.id)}">Run waiting ${esc(event.event.type)} · ${esc(event.event.channel)}</button>`).join("");
  return `<div class="sec"><h2>Slack event automations</h2><p>Mode: ${esc(settings?.mode ?? "not loaded")}. Only events from explicitly selected Slack connections and approved senders can match. Events remain untrusted data; existing automation policy still applies.</p>
    <button class="btn" data-act="sl-event-edit" ${settings ? "" : "disabled"}>Review subscriptions</button><button class="btn" data-act="sl-event-refresh">Refresh waiting events</button>${queued}</div>`;
}
function edit() {
  if (!ownerHere() || !settings) return;
  openDlg({ title: "Slack subscriptions", body: `<p>Choose off, when-needed (owner starts each match), or on. Each rule must name a configured Slack connection ID, event type and existing trigger UUID. Optional channel, users, reaction and contains restrict matches. Unbound legacy rules do not run.</p>
    <label>Mode<select id="sl-event-mode">${["off", "when-needed", "on"].map((mode) => `<option ${settings.mode === mode ? "selected" : ""}>${mode}</option>`).join("")}</select></label>
    <label>Rules JSON<textarea id="sl-event-rules">${esc(JSON.stringify(settings.rules, null, 2))}</textarea></label><p>Example: {"connection":"your-slack-id","event":"reaction_added","channel":"C123","users":["U123"],"reaction":"white_check_mark","trigger":"existing-trigger-uuid"}</p>`,
    foot: `<button class="btn" data-act="sl-event-cancel">Cancel</button><button class="btn pri" data-act="sl-event-save">Save reviewed subscriptions</button>` });
}
export function initSlackEvents() {
  if (has("sl-event-edit")) return;
  on("sl-event-edit", edit); on("sl-event-refresh", loadSlackEvents);
  on("sl-event-cancel", () => { pending = null; closeDlg(); });
  on("sl-event-save", async () => {
    if (!ownerHere()) return;
    try {
      const input = { mode: document.getElementById("sl-event-mode").value, rules: JSON.parse(document.getElementById("sl-event-rules").value) };
      if (input.rules.some((rule) => !rule.connection)) throw new Error("Every subscription needs an explicit Slack connection ID.");
      await api("channels/slack-automations", input); closeDlg(); await loadSlackEvents();
    } catch (error) { toast(error.message); }
  });
  on("sl-event-run", (el) => {
    if (!ownerHere()) return;
    pending = el.dataset.id;
    openDlg({ title: "Run Slack automation?", body: "<p>Run the owner-selected trigger for this waiting event under its existing policy? Event text grants no permissions.</p>",
      foot: `<button class="btn" data-act="sl-event-cancel">Cancel</button><button class="btn pri" data-act="sl-event-confirm">Run this event</button>` });
  });
  on("sl-event-confirm", async () => {
    const event = pending; pending = null; closeDlg();
    if (!event || !ownerHere()) return;
    try { await api("channels/slack-automations/run", { event }); await loadSlackEvents(); } catch (error) { toast(error.message); }
  });
  markLive(["sl-event-edit", "sl-event-refresh", "sl-event-cancel", "sl-event-save", "sl-event-run", "sl-event-confirm"]);
}
