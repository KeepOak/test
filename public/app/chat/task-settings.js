import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { esc } from "../core/dom.js";
import { E, refresh } from "../core/state.js";
import { openDlg, closeDlg, toast } from "../core/ui.js";
import { markLive } from "../core/features.js";

let preview = null, busy = false;
export function taskSettingsButton() {
  return E.profiles?.isOwner === false ? "" : `<button class="c-btn" type="button" data-act="task-settings-open" aria-label="Suggest settings for this task" title="Suggest settings for this task">⚙</button>`;
}

function showPreview() {
  const rows = preview.changes.map((change) => `<label class="ctl"><b>${esc(change.name)} — ${esc(change.label)}</b>
    <input type="checkbox" data-task-setting="${esc(change.id)}" ${change.pinned ? "disabled" : ""}>
    <small>${esc(change.from)} → ${esc(change.to)}${change.pinned ? " · Pinned; preserved" : ""}. ${esc(change.why)}</small></label>`).join("");
  openDlg({ title: `${preview.changes.length} settings relevant to your task`,
    body: `<p>${esc(preview.scope)}</p><blockquote>${esc(preview.request)}</blockquote>${rows || "<p>No additional settings from the supported task patterns would help.</p>"}${preview.refused.map((why) => `<p>${esc(why)}</p>`).join("")}<p>Select only the changes you want. You can undo applied changes in Settings history.</p>`,
    foot: `<button class="btn ghost" type="button" data-act="dlg-close">Not now</button><button class="btn pri" type="button" data-act="task-settings-apply">Apply selected settings</button>`, wide: true });
}

export function initTaskSettings() {
  markLive(["task-settings-open", "task-settings-apply"]);
  on("task-settings-open", async () => {
    if (busy) return;
    const request = document.getElementById("prompt")?.value.trim();
    if (!request) { toast("Type your task first to see relevant settings."); return; }
    busy = true; preview = null;
    try { preview = await api("settings-kit/task-preview", { request }); showPreview(); }
    catch (error) { toast(error.message); }
    finally { busy = false; }
  });
  on("task-settings-apply", async () => {
    if (busy || !preview) return;
    const accept = [...document.querySelectorAll("[data-task-setting]:checked")].map((el) => el.dataset.taskSetting);
    if (!accept.length) { toast("Select the settings you want to change."); return; }
    busy = true;
    try {
      const result = await api("settings-kit/task-apply", { request: preview.request, fingerprint: preview.fingerprint, accept });
      closeDlg(); preview = null; await refresh();
      toast(`${result.applied.length} settings applied; ${result.skipped.length} preserved.`);
    } catch (error) { toast(error.message); }
    finally { busy = false; }
  });
}
