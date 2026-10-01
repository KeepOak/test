import { esc } from "../core/dom.js";
import { ownerHere, E } from "../core/state.js";
import { sessionAuthority } from "../core/session-pages.js";
import { api } from "../core/api.js";
import { openDlg, closeDlg, dialog, toast } from "../core/ui.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";

const locked = () => document.getElementById("app")?.classList.contains("locked-b17") === true;
/** A request from chat cannot open a pairing door. Consent and codes remain local. */
export function initChatPairing(start) {
  let current = null, frame = null, busy = false, stopped = false, held = null;
  /* The owner authority captured when the list was asked for: a lock or profile change since, even one undone, revokes it. */
  const authorized = (authority) => !!authority?.current(E.profiles) && ownerHere() && !locked();
  const forget = () => { held?.close(); held = null; current = null; frame = null; };
  const seen = new Set();
  markLive(["chat-pair-start", "chat-pair-dismiss"]);
  on("chat-pair-dismiss", () => { forget(); closeDlg(); });
  on("chat-pair-start", () => {
    if (!current || dialog() !== frame || !authorized(held) || Date.parse(current.expiresAt) <= Date.now()) {
      forget(); closeDlg(); toast("This pairing request expired. Send /pair again."); return;
    }
    const proposal = current;
    forget(); closeDlg();
    start(proposal.kind, proposal.id);
  });
  async function poll() {
    if (busy || stopped || !E.loaded || !ownerHere() || locked() || document.hidden || dialog()) return;
    busy = true;
    const authority = sessionAuthority(E.profiles, document.getElementById("app"));
    let kept = false;
    try {
      const answer = await api("devices/chat-pairing");
      // App lock or another profile while the list was read, even one undone since: no consent is shown.
      if (!authorized(authority) || dialog()) return;
      const pending = answer.proposals ?? [];
      for (const id of seen) if (!pending.some((p) => p.id === id)) seen.delete(id);
      current = pending.find((p) => !seen.has(p.id));
      if (!current) return;
      seen.add(current.id);
      frame = openDlg({ title: "Pairing request from your chat",
        body: `<p>${esc(current.senderName)} (${esc(current.senderId)}) requested a ${esc(current.kind)}${current.label ? ` named ${esc(current.label)}` : ""} from ${esc(current.channel)}, direct chat ${esc(current.chatId)}.</p><p>This creates an invitation in this window. It does not approve a device. Compare the check code on the intended device before letting it in. The invitation replaces any earlier invitation.</p>`,
        foot: '<button class="btn ghost" type="button" data-act="chat-pair-dismiss">Dismiss</button><button class="btn pri" type="button" data-act="chat-pair-start">Create invitation here</button>' });
      held?.close(); held = authority; kept = true;
    } catch (error) {
      // A phone/household window cannot read these proposals; stop polling that surface.
      if (error.status === 403) stopped = true;
    } finally { busy = false; if (!kept) authority.close(); }
  }
  setInterval(poll, 15_000);
  document.addEventListener("visibilitychange", poll);
}
