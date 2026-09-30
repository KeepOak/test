import { api } from "../core/api.js";
import { esc, afterDraw } from "../core/dom.js";
import { E, S, ownerHere, activeId } from "../core/state.js";
import { openDlg, closeDlg, closePop, toast } from "../core/ui.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { hasFiles } from "../chat/attach.js";

let confirmation = null, preparation = 0;
const context = () => JSON.stringify([activeId(), S.signedIn, S.view, S.chat, S.setPage]);
const ownerNow = person => S.signedIn && ownerHere() && activeId() === person && !E.state?.lock?.locked
  && !document.getElementById("app")?.classList.contains("locked-b17");
const attachments = () => hasFiles() || hasFiles("home19");

export async function prepareGatewayRestart() {
  const person = activeId(), started = context(), epoch = ++preparation;
  if (!ownerNow(person)) return;
  closePop(); confirmation = null;
  try {
    const readiness = await api("comfort/update-readiness");
    if (!ownerNow(person) || started !== context() || epoch !== preparation) return;
    const working = readiness.workingTasks ?? readiness.busyTasks;
    const waiting = Math.max(0, readiness.busyTasks - working);
    const drafts = Object.values(S.drafts).filter(value => typeof value === "string" && value.trim()).length;
    const blocked = attachments();
    const body = `<p>Restart the engine that runs Branch. The window stays open. Restart is available only where Branch can start the engine again.</p>
      <p>${esc(working)} tasks working; ${esc(waiting)} waiting for an answer. Restart waits until no task is working and cancels if the app locks or the person changes.</p>
      <p>${esc(drafts)} stored unsent drafts stay in this window.</p>${blocked ? "<p>Send or remove unsent file attachments before restarting; staged uploads do not survive an engine restart.</p>" : ""}`;
    const dialog = openDlg({ title: "Restart engine?", body, foot: `<button class="btn ghost" type="button" data-act="dlg-close">Cancel</button><button class="btn pri" type="button" data-act="gwpop-restart-confirm" ${blocked ? "disabled" : ""}>${working ? "Restart when idle" : "Restart engine"}</button>` });
    confirmation = { person, dialog, context: started };
  } catch (error) { if (ownerNow(person) && epoch === preparation) toast(error.message); }
}

async function confirmRestart(el) {
  const pending = confirmation;
  if (!pending || pending.context !== context() || !pending.dialog.isConnected || !pending.dialog.contains(el) || !ownerNow(pending.person) || el.disabled) return;
  if (attachments()) { toast("Send or remove unsent file attachments before restarting."); return; }
  el.disabled = true;
  try {
    await api("comfort/update-readiness");
    if (!ownerNow(pending.person) || pending.context !== context() || !pending.dialog.isConnected || attachments()) return;
    const result = await api("dashboard/restart", { whenIdle: true });
    if (!ownerNow(pending.person) || pending.context !== context() || !pending.dialog.isConnected) return;
    confirmation = null; closeDlg();
    toast(result.waiting ? "Restart requested for when work is idle. Locking or switching person cancels it." : "Engine restart requested.");
  } catch (error) { toast(error.message); }
  finally { if (el.isConnected) el.disabled = false; }
}

export function initGatewayRestart() {
  const clearStale = () => {
    if (confirmation && (!ownerNow(confirmation.person) || confirmation.context !== context())) {
      const shown = confirmation.dialog.isConnected; confirmation = null; ++preparation;
      if (shown) closeDlg();
    }
  };
  on("gwpop-restart-confirm", confirmRestart);
  afterDraw(clearStale);
  const app = document.getElementById("app");
  if (app) new MutationObserver(clearStale).observe(app, { attributes: true, attributeFilter: ["class"] });
  markLive(["gwpop-restart-confirm"]);
}
