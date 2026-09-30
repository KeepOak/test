import { $, esc, render } from "../core/dom.js";
import { S, E } from "../core/state.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { openDlg, closeDlg, toast } from "../core/ui.js";

let held = { key: "", entries: [], at: 0 }, pending = null, reading = false;
const scope = () => JSON.stringify([S.chat, E.profiles]);
const entries = () => held.key === scope() && E.profiles?.isOwner !== false ? held.entries : [];
const badge = entry => `<span class="tag6" title="${esc(`Plugin: ${entry.pluginName}`)}">${esc(entry.pluginName)}: ${esc(entry.text)}</span>`;
export const pluginRowBadges = message => entries().filter(e => e.slot === "row-badge" && e.messageId === message.messageId).map(badge).join("");
export const pluginModelLabels = () => entries().filter(e => e.slot === "model-pill").map(badge).join("");
export const pluginDraftButtons = () => entries().filter(e => e.slot === "composer-draft").map(e => `<button class="btn" type="button" data-act="plugin-draft-preview" data-v="${esc(e.id)}">${esc(e.pluginName)}: ${esc(e.label)}</button>`).join("");
export async function loadPluginWindow() {
  const key = scope(), session = S.chat;
  if (!session || E.profiles?.isOwner === false) { held = { key, entries: [], at: 0 }; pending = null; return; }
  if (reading || held.key === key && Date.now() - held.at < 5000) return;
  reading = true;
  try {
    const got = await api(`plugins/window/${encodeURIComponent(session)}`);
    if (key !== scope()) return;
    const changed = held.key !== key || JSON.stringify(held.entries) !== JSON.stringify(got.contributions);
    held = { key, entries: got.contributions, at: Date.now() };
    if (changed) render();
  } catch { if (key === scope()) { const changed = held.entries.length > 0; held = { key, entries: [], at: Date.now() }; if (changed) render(); } }
  finally { reading = false; }
}
export function initPluginWindow() {
  markLive(["plugin-draft-preview", "plugin-draft-append"]);
  on("plugin-draft-preview", el => {
    const draft = entries().find(e => e.id === el.dataset.v && e.slot === "composer-draft");
    if (!draft || !$("#prompt")) return;
    pending = { key: scope(), session: S.chat, draft, previous: $("#prompt").value };
    openDlg({ title: `Draft from ${draft.pluginName}`, body: `<p>Plugin-provided text. Review before adding it to your composer. Your existing text will be kept. Sending remains a separate action.</p><pre>${esc(draft.text)}</pre>`,
      foot: `<button class="btn" type="button" data-act="dlg-close">Cancel</button><button class="btn pri" type="button" data-act="plugin-draft-append">Append to draft</button>` });
  });
  on("plugin-draft-append", async () => {
    const preview = pending; pending = null;
    if (!preview || preview.key !== scope() || $("#prompt")?.value !== preview.previous) return toast("Conversation or draft changed. Preview again.");
    try {
      const got = await api(`plugins/window/${encodeURIComponent(preview.session)}/draft`, { id: preview.draft.id, approve: true });
      const box = $("#prompt");
      if (preview.key !== scope() || !box || box.value !== preview.previous || JSON.stringify(got.draft) !== JSON.stringify(preview.draft))
        return toast("The plugin, conversation or draft changed. Preview again.");
      box.value = [preview.previous, got.draft.text].filter(Boolean).join("\n\n");
      box.dispatchEvent(new Event("input", { bubbles: true })); closeDlg(); box.focus();
    } catch (error) { toast(error.message); }
  });
}
