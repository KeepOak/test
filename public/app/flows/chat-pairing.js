import { esc } from "../core/dom.js";
import { ownerHere, activeId, E } from "../core/state.js";
import { api } from "../core/api.js";
import { openDlg, closeDlg, dialog, toast } from "../core/ui.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";

const locked = () => document.getElementById("app")?.classList.contains("locked-b17") === true;
/** A request from chat cannot open a pairing door. Consent and codes remain local. */
export function initChatPairing(start) {
  let current = null, frame = null, busy = false, stopped = false;
  const seen = new Set();
  markLive(["chat-pair-start", "chat-pair-dismiss"]);
  on("chat-pair-dismiss", () => { current = null; frame = null; closeDlg(); });
  on("chat-pair-start", () => {
    if (!current || dialog() !== frame || !ownerHere() || Date.parse(current.expiresAt) <= Date.now()) {
      toast("This pairing request expired. Send /pair again."); return;
    }
    const proposal = current;
    current = null; frame = null; closeDlg();
    start(proposal.kind, proposal.id);
  });
  async function poll() {
    if (busy || stopped || !E.loaded || !ownerHere() || locked() || document.hidden || dialog()) return;
    busy = true;
    const profile = activeId();
    try {
      const answer = await api("devices/chat-pairing");
      // App lock (only a reload undoes it) or another profile while the list was read: no consent is shown.
      if (!ownerHere() || locked() || activeId() !== profile || dialog()) return;
      const pending = answer.proposals ?? [];
      for (const id of seen) if (!pending.some((p) => p.id === id)) seen.delete(id);
      current = pending.find((p) => !seen.has(p.id));
      if (!current) return;
      seen.add(current.id);
      frame = openDlg({ title: "Pairing request from your chat",
        body: `<p>${esc(current.senderName)} (${esc(current.senderId)}) requested a ${esc(current.kind)}${current.label ? ` named ${esc(current.label)}` : ""} from ${esc(current.channel)}, direct chat ${esc(current.chatId)}.</p><p>This creates an invitation in this window. It does not approve a device. Compare the check code on the intended device before letting it in. The invitation replaces any earlier invitation.</p>`,
        foot: '<button class="btn ghost" type="button" data-act="chat-pair-dismiss">Dismiss</button><button class="btn pri" type="button" data-act="chat-pair-start">Create invitation here</button>' });
    } catch (error) {
      // A phone/household window cannot read these proposals; stop polling that surface.
      if (error.status === 403) stopped = true;
    } finally { busy = false; }
  }
  setInterval(poll, 15_000);
  document.addEventListener("visibilitychange", poll);
}
