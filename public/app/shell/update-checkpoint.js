import { S, ownerHere } from "../core/state.js";
import { $, renderNow } from "../core/dom.js";
import { goingAway } from "../core/api.js";
import { startConversation } from "../chat/chat.js";
import { toast } from "../core/ui.js";

/** Prepare words only. The owner presses Send and reviews existing Git permissions before any upload. */
export function initUpdateCheckpoint() {
  window.branchDesktop?.onUpdateCheckpoint?.((request) => {
    if (!ownerHere() || typeof request?.version !== "string" || request.version.length > 100) return false;
    const box = $("#prompt");
    if (box) S.drafts[S.chat ?? "new"] = box.value;
    const words = `Before updating Branch to ${request.version}, help me prepare a GitHub checkpoint. First ask which project folder, GitHub remote and branch I want. Inspect the files and exclude secrets and personal data. Show exactly what would be saved and sent and ask for my approval before any commit or upload. Do not install the update or send anything yet.`;
    const kept = S.drafts.new ?? "";
    S.drafts.new = kept ? `${kept}\n\n${words}` : words;
    goingAway(false);
    startConversation();
    renderNow();
    $("#prompt")?.focus();
    toast("The checkpoint request is ready to review. Press Send when ready; nothing has been saved or uploaded.");
    return $("#prompt")?.value === S.drafts.new;
  });
}
