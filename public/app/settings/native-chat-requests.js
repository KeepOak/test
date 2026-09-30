import { api } from "../core/api.js";
import { esc } from "../core/dom.js";
import { ownerHere } from "../core/state.js";
import { on, has } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { openDlg, closeDlg, toast } from "../core/ui.js";
import { openChatRequestedSignIn } from "../flows/account-signin.js";

export const nativeChatCard = () => ownerHere() ? `<div class="sec"><h2>Native requests</h2><p>Your named owner DM can request /reload-mcp for one enabled owner-managed server, or /login chatgpt, codex or claude-code. Confirm here within two minutes. Sign-in pages, codes and tokens stay in the local account flow.</p><button class="btn" data-act="native-chat-review">Review native requests</button></div>` : "";
export function initNativeChatRequests() {
  if (has("native-chat-review")) return;
  const pending = new Map();
  on("native-chat-review", async () => {
    if (!ownerHere()) return;
    try {
      const answer = await api("channels/native-requests");
      if (!ownerHere()) return;
      pending.clear(); for (const p of answer.proposals) pending.set(p.id, p);
      openDlg({ title: "Native requests from your owner chat", body: answer.proposals.map((p) => `<div class="prow"><span class="grow"><b>${esc(p.action)} · ${esc(p.target)}</b><small>${esc(p.channel)} / ${esc(p.chatId)} · sender ${esc(p.senderId)} · expires ${esc(p.expiresAt)}</small></span><button class="btn" data-act="native-chat-confirm" data-id="${esc(p.id)}">Review</button></div>`).join("") || "<p>No valid native requests.</p>", foot: '<button class="btn" data-act="native-chat-close">Close</button>' });
    } catch (error) { toast(error.message); }
  });
  on("native-chat-confirm", (el) => {
    const p = pending.get(el.dataset.id);
    if (!ownerHere() || !p || Date.parse(p.expiresAt) <= Date.now()) return toast("Request expired. Send it again from your owner chat.");
    const explanation = p.action === "login" ? "Open the existing native account sign-in flow for this provider. Continue or Sign in there starts its real browser/program flow. Codes, links and tokens are never sent back to chat. No existing account is silently replaced." : "Reload only this enabled owner-managed MCP server. Busy servers are refused. Its old connection closes; starting it again preserves the existing launch approval and network policy. Stdio may require another explicit local launch approval; cancelling leaves the server off.";
    openDlg({ title: "Confirm native action?", body: `<p>${esc(p.action)} for ${esc(p.target)}, requested by ${esc(p.senderId)} on ${esc(p.channel)}.</p><p>${esc(explanation)}</p>`, foot: `<button class="btn" data-act="native-chat-close">Cancel</button><button class="btn pri" data-act="native-chat-apply" data-id="${esc(p.id)}">${p.action === "login" ? "Open local sign-in flow" : "Reload this idle server"}</button>` });
  });
  on("native-chat-apply", async (el) => {
    if (!ownerHere()) return;
    try {
      const answer = await api("channels/native-requests/confirm", { id: el.dataset.id });
      if (!ownerHere()) return;
      closeDlg();
      if (answer.login) await openChatRequestedSignIn(answer.login);
      else openDlg({ title: "MCP reload result", body: `<p>${esc(answer.said ?? "Reload requested.")}</p><p>Review any waiting launch approval in Branch. No approval can be granted from chat.</p>`, foot: '<button class="btn" data-act="native-chat-close">Close</button>' });
    } catch (error) { toast(error.message); }
  });
  on("native-chat-close", closeDlg);
  markLive(["native-chat-review", "native-chat-confirm", "native-chat-apply", "native-chat-close"]);
}
