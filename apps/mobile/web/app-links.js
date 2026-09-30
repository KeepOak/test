import { appLinkUrl, appLinkDetails } from "/app-link-rules.js";
import { plugin } from "/phone-common.js";
import { esc, on, toast } from "/ph-core.js";

/** Listing offers are explicit buttons; reading a reply never opens another app. */
export function listingButtons(text) {
  if (!plugin) return "";
  const urls = String(text ?? "").match(/https:\/\/[^\s<>"']+/g) ?? [];
  const links = [...new Set(urls.slice(0, 30).map((url) => appLinkUrl(url.split(/[)\]]/)[0])).filter(Boolean))].slice(0, 3);
  return links.map((url) => {
    const link = appLinkDetails(url);
    return `<button type="button" class="p-pri" data-act="phone-app-link" data-url="${esc(url)}">Open ${esc(link.name)} ${esc(link.kind)} ${esc(url.split("/").at(-1))}</button>`;
  }).join("");
}
export function initAppLinks() {
  on("phone-app-link", async (el) => {
    const url = appLinkUrl(el.dataset.url);
    if (!url || !plugin) return;
    try { const result = await plugin.openAppLink({ url }); if (result?.opened === false && result?.destination === "system") toast("No app or browser could open this link"); }
    catch (error) { toast(error.message); }
  });
}
