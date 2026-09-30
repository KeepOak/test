import { api } from "../core/api.js";
import { esc } from "../core/dom.js";
import { ownerHere } from "../core/state.js";
import { on, has } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { toast, openDlg, closeDlg } from "../core/ui.js";
export const groupResponseCard = () => ownerHere() ? `<div class="sec"><h2>Group responses</h2><p>Choose mention-only or free responses for exact groups. Discord can create a separate thread for each admitted source message. Sender and tool permissions stay in force.</p><button class="btn" data-act="group-response-review">Review group settings</button></div>` : "";
export function initGroupResponses() {
  if (has("group-response-review")) return;
  on("group-response-review", async () => {
    if (!ownerHere()) return;
    try {
      const settings = await api("channels/group-responses");
      if (!ownerHere()) return;
      openDlg({ title: "Group response settings", body: `<p>Each row binds an exact connection ID and chat/channel ID. activation is mention or always; autoThread is for Discord only. Existing conversations and credentials are unchanged.</p><label>Groups JSON<textarea id="group-response-json">${esc(JSON.stringify(settings, null, 2))}</textarea></label><p>Example: {"groups":[{"connection":"discord","chatId":"123456789012345678","activation":"always","autoThread":true}]}</p>`,
        foot: `<button class="btn" data-act="group-response-cancel">Cancel</button><button class="btn pri" data-act="group-response-save">Save explicit group settings</button>` });
    } catch (error) { toast(error.message); }
  });
  on("group-response-save", async () => {
    if (!ownerHere()) return;
    try { await api("channels/group-responses", JSON.parse(document.getElementById("group-response-json").value)); closeDlg(); toast("Group response settings saved."); }
    catch (error) { toast(error.message); }
  });
  on("group-response-cancel", closeDlg);
  markLive(["group-response-review", "group-response-save", "group-response-cancel"]);
}
