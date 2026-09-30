import { esc } from "../core/dom.js";
import { S, ownerHere, save } from "../core/state.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { openDlg, closeDlg, toast } from "../core/ui.js";
import { startConversation, openConversation } from "../chat/chat.js";

let feed = [];
function card(idea) {
  return `<article><h3>${esc(idea.title)}</h3><p>${esc(idea.reason)}</p>
    <ul data-home-list aria-label="Source conversations for ${esc(idea.title)}">${idea.sources.map((s) => `<li><button type="button" class="btn ghost" data-act="history-idea-source" data-v="${esc(s.sessionId)}" aria-label="Open source conversation: ${esc(s.title)}, ${esc(s.createdAt)}, recorded ${esc(s.status)}">${esc(s.title)}</button>
      <small>${esc(s.createdAt)} · Recorded: ${esc(s.status)} · ${esc(s.id)}</small></li>`).join("")}</ul>
    <details><summary>Preview composer draft</summary><pre>${esc(idea.draft)}</pre></details>
    <button type="button" class="btn" data-act="history-idea-draft" data-v="${esc(idea.id)}" aria-label="Put idea in composer: ${esc(idea.title)}">Put in composer</button></article>`;
}
async function show() {
  if (!ownerHere()) return;
  try {
    const answer = await api("/api/history-ideas");
    feed = answer.ideas;
    openDlg({ title: "Ideas from your history", wide: true,
      body: `<p>${esc(answer.window)}</p><p>These are optional review ideas. Recorded status does not verify an outcome. Nothing is sent or started here.</p>
        ${feed.length ? feed.map(card).join("") : "<p>No eligible explicitly titled history yet. Name a chat to make it available for future ideas.</p>"}` });
  } catch (error) { feed = []; toast(error.message); }
}
export function initHistoryIdeas() {
  markLive(["history-ideas", "history-idea-source", "history-idea-draft"]);
  on("history-ideas", show);
  on("history-idea-source", async (el) => {
    try {
      if (!ownerHere()) return;
      const fresh = await api("/api/history-ideas");
      if (!fresh.ideas.some((i) => i.sources.some((s) => s.sessionId === el.dataset.v))) return show();
      closeDlg(); openConversation(el.dataset.v);
    } catch (error) { toast(error.message); }
  });
  on("history-idea-draft", async (el) => {
    try {
      if (!ownerHere()) return;
      const fresh = await api("/api/history-ideas");
      const idea = fresh.ideas.find((i) => i.id === el.dataset.v);
      if (!idea) { toast("This history changed. Review the refreshed ideas."); return show(); }
      S.drafts.new = [S.drafts.new, idea.draft].filter(Boolean).join("\n\n");
      save(); closeDlg(); startConversation();
    } catch (error) { toast(error.message); }
  });
}
