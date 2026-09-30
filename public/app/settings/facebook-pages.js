import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { ownerHere } from "../core/state.js";
import { toast } from "../core/ui.js";
let busy = false;
export function facebookSection() {
  return `<div class="sec"><h2>Facebook Page content</h2><p class="hint">Off by default. Read your administered Page's published posts, compose text locally, then review its exact Page ID/text before a one-use publish. This is not personal-profile, Instagram or Marketplace search. Meta app approval, current permissions, Page tasks and provider terms must be arranged by you; configuration does not verify them. No ads, payment, scraping or automatic posting.</p>
    <div class="acts"><button class="btn" data-act="fb-settings" type="button">Configure or disable</button><button class="btn" data-act="fb-posts" type="button">Read recent Page posts</button><button class="btn" data-act="fb-compose" type="button">Compose local draft</button><button class="btn" data-act="fb-review" type="button">Review exact draft</button><button class="btn" data-act="fb-overview" type="button">Drafts and last publish evidence</button><button class="btn" data-act="fb-revoke" type="button">Revoke and cancel</button></div>
    <pre id="fb-result" style="white-space:pre-wrap"></pre><a href="https://developers.facebook.com/docs/pages-api/posts/" target="_blank" rel="noopener">Meta Page API prerequisites</a> · <a href="https://developers.facebook.com/terms/" target="_blank" rel="noopener">Platform terms</a></div>`;
}
function show(result) { if (!ownerHere()) return; const box = document.getElementById("fb-result"); if (box) box.textContent = JSON.stringify(result, null, 2); }
async function action(work) {
  if (!ownerHere() || busy) return; busy = true;
  try { const result = await work(); if (result !== undefined) show(result); }
  catch (error) { if (ownerHere()) toast(error.message); }
  finally { busy = false; }
}
on("fb-settings", () => action(async () => {
  const overview = await api("personal/facebook"); if (!ownerHere()) return;
  if (overview.settings.readEnabled && confirm("Disable Facebook content and revoke all local drafts/approvals?"))
    return api("personal/facebook", { ...overview.settings, readEnabled: false, publishEnabled: false });
  const pageId = prompt("Exact administered Facebook Page ID (not a personal profile ID)"); if (!pageId) return;
  const tokenSecret = prompt("Existing Page access token's locker secret NAME, never its value", "FACEBOOK_PAGE_TOKEN"); if (!tokenSecret) return;
  const publishEnabled = confirm("Enable the future reviewed publishing path too? Every post will still require exact one-use owner review. Cancel keeps only read/local-compose enabled.");
  if (!confirm(`Configure Page ${pageId}? I have reviewed current Meta terms and obtained the required app access, Page tasks and read${publishEnabled ? "/publish" : ""} permissions. Their validity and billing are unverified here. Requests/results may enter my ordinary owner task history. Ten HTTP attempts per UTC day; up to two for a read, three for a publish with exact readback. No OAuth, token discovery or provider call occurs on configuration.`) || !ownerHere()) return;
  return api("personal/facebook", { pageId, tokenSecret, readEnabled: true, publishEnabled, termsAndRightsAcknowledged: true, maxCallsPerDay: 10 });
}));
on("fb-posts", () => action(async () => {
  if (!confirm("Read at most ten published posts from your configured Page within the last seven days? This sends up to two Meta requests, includes Page-token identity verification and does not read a personal feed.")) return;
  return api("personal/facebook/posts", { limit: 10, days: 7 });
}));
on("fb-compose", () => action(async () => {
  const message = prompt("Exact text draft (up to 4000 characters). This only composes locally and posts nothing."); if (!message || !ownerHere()) return;
  return api("personal/facebook/compose", { message });
}));
on("fb-overview", () => action(() => api("personal/facebook")));
on("fb-revoke", () => action(() => api("personal/facebook/revoke", {})));
on("fb-review", () => action(async () => {
  const overview = await api("personal/facebook"); if (!ownerHere()) return;
  show(overview);
  const draftId = prompt("Draft ID from the displayed local drafts to review"); if (!draftId) return;
  const draft = overview.drafts.find(d => d.draftId === draftId); if (!draft) throw new Error("No such current local draft");
  const mode = prompt("Type prepare to approve once for your private owner task, or publish to post now", "prepare");
  if (!["prepare", "publish"].includes(mode)) return;
  if (!confirm(`Exact Facebook Page: ${draft.pageId}\nExact text:\n${draft.message}\nSHA256: ${draft.sha256}\nI reviewed this exact Page and text for public Page publication. One-use approval expires in three minutes and is consumed on failure/timeout. Verify any prior unknown outcome in Facebook before retrying. No attachments, tags, scheduling or ads. Actual visibility/distribution and provider billing are unknown.`) || !ownerHere()) return;
  const grant = await api("personal/facebook/review", { draftId, sha256: draft.sha256, exactPageAndTextReviewed: true });
  if (!ownerHere()) return;
  if (mode === "prepare") return { ...grant, note: "No post made. Manually give the tool and reviewId to your original private owner task; never send automatically." };
  return api("personal/facebook/publish", { reviewId: grant.reviewId });
}));
