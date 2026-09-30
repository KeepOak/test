import { sessionPages, clearSessionPages } from "../core/session-pages.js";
import { refresh, S, E } from "../core/state.js";
import { on } from "../core/actions.js";
import { renderNow, esc } from "../core/dom.js";
import { toast } from "../core/ui.js";
import { markLive } from "../core/features.js";
import { t } from "../../i18n.js";

export function olderConversationsHTML() {
  if (!sessionPages.more) return "";
  return `<button class="lh lh-btn" type="button" data-act="sessions-older"${sessionPages.busy ? ' disabled aria-busy="true"' : ""}>${esc(t("window.sessions.showOlder"))}</button>`;
}

export function initSessionPages() {
  const app = document.getElementById("app");
  if (app) new MutationObserver(() => {
    if (!app.classList.contains("locked-b17")) return;
    clearSessionPages();
    E.sessions = [];
  }).observe(app, { attributes: true, attributeFilter: ["class"] });
  markLive(["sessions-older"]);
  on("sessions-older", async () => {
    if (sessionPages.busy || !sessionPages.more || !S.signedIn) return;
    sessionPages.pages += 1;
    sessionPages.busy = true;
    renderNow();
    try {
      await refresh();
      if (sessionPages.error) toast(sessionPages.error.message);
    } catch (error) { sessionPages.busy = false; toast(error.message); }
    renderNow();
  });
}
