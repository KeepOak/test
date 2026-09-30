import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { esc } from "../core/dom.js";
import { E, refresh, ownerHere } from "../core/state.js";
import { sessionPrincipal } from "../core/session-pages.js";
import { openDlg, closeDlg, dialog, toast } from "../core/ui.js";
import { markLive } from "../core/features.js";

/* The dialog shows the owner's typed request, so an answer is used only while the same owner, in the same profile, with
   the window unlocked, is still waiting for it: a profile switch or App lock during the wait drops it. */
let preview = null, busy = false, generation = 0, shown = null;
const unlocked = () => !document.getElementById("app")?.classList.contains("locked-b17");
const ticket = () => ({ generation: ++generation, principal: sessionPrincipal(E.profiles) });
const current = (mine) => mine.generation === generation && ownerHere() && unlocked() && sessionPrincipal(E.profiles) === mine.principal;
export function taskSettingsButton() {
  return E.profiles?.isOwner === false ? "" : `<button class="c-btn" type="button" data-act="task-settings-open" aria-label="Suggest settings for this task" title="Suggest settings for this task">⚙</button>`;
}

function showPreview() {
  const rows = preview.changes.map((change) => `<label class="ctl"><b>${esc(change.name)} — ${esc(change.label)}</b>
    <input type="checkbox" data-sw="task-setting" data-task-setting="${esc(change.id)}" ${change.pinned ? "disabled" : ""}>
    <small>${esc(change.from)} → ${esc(change.to)}${change.pinned ? " · Pinned; preserved" : ""}. ${esc(change.why)}</small></label>`).join("");
  shown = openDlg({ title: `${preview.changes.length} settings relevant to your task`,
    body: `<p>${esc(preview.scope)}</p><blockquote>${esc(preview.request)}</blockquote>${rows || "<p>No additional settings from the supported task patterns would help.</p>"}${preview.refused.map((why) => `<p>${esc(why)}</p>`).join("")}<p>Select only the changes you want. You can undo applied changes in Settings history.</p>`,
    foot: `<button class="btn ghost" type="button" data-act="dlg-close">Not now</button><button class="btn pri" type="button" data-act="task-settings-apply">Apply selected settings</button>`, wide: true });
}

export function initTaskSettings() {
  /* The proposal checkboxes are read by task-settings-apply; a pinned one stays disabled from showPreview. */
  markLive(["task-settings-open", "task-settings-apply", "sw:task-setting"]);
  on("task-settings-open", async () => {
    if (busy || !ownerHere() || !unlocked()) return;
    const request = document.getElementById("prompt")?.value.trim();
    if (!request) { toast("Type your task first to see relevant settings."); return; }
    const mine = ticket();
    busy = true; preview = null; shown = null;
    try {
      const answer = await api("settings-kit/task-preview", { request });
      if (!current(mine)) return;
      preview = { ...answer, mine };
      showPreview();
    } catch (error) { if (current(mine)) toast(error.message); }
    finally { busy = false; }
  });
  on("task-settings-apply", async () => {
    if (busy || !preview || !current(preview.mine) || dialog() !== shown) return;
    const accept = [...shown.querySelectorAll("[data-task-setting]:checked")].map((el) => el.dataset.taskSetting);
    if (!accept.length) { toast("Select the settings you want to change."); return; }
    const mine = preview.mine, box = shown;
    busy = true;
    try {
      const result = await api("settings-kit/task-apply", { request: preview.request, fingerprint: preview.fingerprint, accept });
      preview = null;
      if (!current(mine)) return;
      if (dialog() === box) closeDlg();
      await refresh();
      if (current(mine)) toast(`${result.applied.length} settings applied; ${result.skipped.length} preserved.`);
    } catch (error) { if (current(mine)) toast(error.message); }
    finally { busy = false; }
  });
}
