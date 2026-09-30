import { api } from "../core/api.js";
import { esc } from "../core/dom.js";
import { ownerHere } from "../core/state.js";
import { on, has } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { openDlg, closeDlg, toast } from "../core/ui.js";

export const chatPolicyCard = () => ownerHere() ? `<div class="sec"><h2>Chat policy requests</h2><p>Your named owner direct chat can request an exact sender rule with /allowlist allow, block or remove. Confirm it here within two minutes. Changes do not grant tool permissions or identify a sender as the owner.</p><button class="btn" data-act="chat-policy-review">Review admission requests</button></div>` : "";
export function initChatPolicyRequests() {
  if (has("chat-policy-review")) return;
  const pending = new Map();
  on("chat-policy-review", async () => {
    if (!ownerHere()) return;
    try {
      const answer = await api("channels/owner-policy-proposals");
      if (!ownerHere()) return;
      pending.clear();
      for (const p of answer.proposals) pending.set(p.id, p);
      openDlg({ title: "Admission requests from your chat", body: answer.proposals.map((p) => `<div class="prow"><span class="grow"><b>${esc(p.action)} sender ${esc(p.target)}</b><small>Exact connection ${esc(p.channel)} · requested by ${esc(p.senderId)} in direct chat ${esc(p.chatId)} · expires ${esc(p.expiresAt)}</small></span><button class="btn" data-act="chat-policy-confirm" data-id="${esc(p.id)}">Review change</button></div>`).join("") || "<p>No current requests. They expire if source authorization or policy changes.</p>", foot: '<button class="btn" data-act="chat-policy-close">Close</button>' });
    } catch (error) { toast(error.message); }
  });
  on("chat-policy-confirm", (el) => {
    const p = pending.get(el.dataset.id);
    if (!ownerHere() || !p || Date.parse(p.expiresAt) <= Date.now()) return toast("This request expired. Request it again from your chat.");
    openDlg({ title: "Confirm exact sender rule?", body: `<p>${esc(p.action)} sender ${esc(p.target)} on connection ${esc(p.channel)}, requested by ${esc(p.senderId)}.</p><p>This replaces only rules for that exact sender and connection. Broader block rules still win. Removing a rule does not revoke existing pairing or other admission rules. Tool permissions and owner-account identity stay separate.</p>`, foot: `<button class="btn" data-act="chat-policy-close">Cancel</button><button class="btn pri" data-act="chat-policy-apply" data-id="${esc(p.id)}">Apply this admission change</button>` });
  });
  on("chat-policy-apply", async (el) => {
    if (!ownerHere()) return;
    try { await api("channels/owner-policy-proposals/confirm", { id: el.dataset.id }); closeDlg(); toast("Sender rule saved."); }
    catch (error) { toast(error.message); }
  });
  on("chat-policy-close", closeDlg);
  markLive(["chat-policy-review", "chat-policy-confirm", "chat-policy-apply", "chat-policy-close"]);
}
