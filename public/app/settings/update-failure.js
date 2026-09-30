/* PLAT-040: the existing owner-only update report, downloaded locally on the owner's press.
   Report contents/redaction stay with the engine. No report is uploaded or sent by this module. */
import { S, activeId, ownerHere } from "../core/state.js";
import { api } from "../core/api.js";
import { esc, render } from "../core/dom.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { toast } from "../core/ui.js";
import { t } from "../../i18n.js";

let failure = null, owner = null, generation = 0, reads = 0, downloading = false;
const stamp = () => S.signedIn && ownerHere() && !document.getElementById("app")?.classList.contains("locked-b17")
  ? activeId() ?? "owner" : null;
function syncOwner() {
  const now = stamp();
  if (now !== owner) { owner = now; failure = null; downloading = false; generation++; }
  return now;
}
export async function loadUpdateFailure() {
  const who = syncOwner(), at = generation, request = ++reads;
  if (!who) return;
  try {
    const got = await api("updates/failure");
    if (syncOwner() === who && generation === at && reads === request) failure = got.failure ?? null;
  } catch (error) {
    if (syncOwner() === who && generation === at && reads === request) { failure = null; toast(error.message); }
  }
  render();
}
export function updateFailureSection(currentFailure = false) {
  if (!syncOwner() || (!failure && !currentFailure)) return "";
  const detail = failure ? t("updateFailureDownload.failed", { from: failure.fromVersion, to: failure.toVersion }) : "";
  return `<div class="status upd18-status"><div class="grow"><b>${esc(t("updateFailureDownload.title"))}</b>${detail ? `<p>${esc(detail)}</p>` : ""}<p>${esc(t("updateFailureDownload.why"))}</p></div><button class="btn sm" type="button" data-act="update-failure-download"${downloading ? " disabled" : ""}>${esc(t(downloading ? "updateFailureDownload.preparing" : "updateFailureDownload.download"))}</button></div>`;
}
async function download() {
  const who = syncOwner(), at = generation;
  if (!who || downloading) return;
  downloading = true;
  render();
  try {
    const report = await api("updates/failure-report", {});
    if (syncOwner() !== who || generation !== at) return;
    if (typeof report.base64 !== "string" || !report.base64 || typeof report.name !== "string")
      throw new Error(t("updateFailureDownload.unavailable"));
    const bytes = Uint8Array.from(atob(report.base64), (char) => char.charCodeAt(0));
    const name = /^branch-update-report-[A-Za-z0-9-]+\.zip$/.test(report.name) ? report.name : "branch-update-report.zip";
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
    try {
      const link = Object.assign(document.createElement("a"), { href: url, download: name });
      document.body.append(link);
      try {
        if (syncOwner() === who && generation === at) link.click();
      } finally { link.remove(); }
    } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
  } catch (error) {
    if (syncOwner() === who && generation === at) toast(error.message);
  } finally {
    if (syncOwner() === who && generation === at) downloading = false;
    render();
  }
}
export function initUpdateFailure() {
  markLive(["update-failure-download"]);
  on("update-failure-download", () => download());
}
