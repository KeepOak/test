import { appLinkUrl } from "../../app-link-rules.js";
import { toast } from "../core/ui.js";

export function initAppLinks() {
  document.addEventListener("click", (event) => {
    if (!event.isTrusted || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const anchor = event.target.closest?.("a[href]");
    const url = appLinkUrl(anchor?.href);
    if (!url || typeof window.branchDesktop?.openAppLink !== "function") return;
    event.preventDefault(); event.stopImmediatePropagation();
    window.branchDesktop.openAppLink(url).catch((error) => toast(error.message));
  }, true);
}
