import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { toast } from "../core/ui.js";
import { ownerHere } from "../core/state.js";

let busy = false;
export function mapsSection() {
  return `<div class="sec"><h2>Maps, places and routes</h2><p class="hint">Geoapify is off by default. Use your existing account/plan and a key saved in the locker. Provider billing/remaining quota are unknown; this creates no subscription. Every request requires the exact coordinates you enter, a preview and one-use approval. No GPS, device location or IP location is read. Requests/results may enter your ordinary owner task history.</p>
    <button class="btn" type="button" data-act="maps-settings">Enable or disable maps</button>
    <button class="btn" type="button" data-act="maps-request">Preview a map, route or places request</button>
    <button class="btn" type="button" data-act="maps-request" data-v="prepare">Prepare one request for my owner task</button>
    <button class="btn" type="button" data-act="maps-revoke">Revoke pending requests and cancel</button>
    <div id="maps-image"></div><pre id="maps-result" style="white-space:pre-wrap"></pre>
    <p>Powered by <a href="https://www.geoapify.com/" target="_blank" rel="noopener">Geoapify</a> · <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a> · <a href="https://openmaptiles.org/" target="_blank" rel="noopener">© OpenMapTiles</a> · <a href="https://www.geoapify.com/terms-and-conditions/" target="_blank" rel="noopener">Provider terms</a> · <a href="https://www.geoapify.com/privacy-policy/" target="_blank" rel="noopener">Provider privacy</a></p></div>`;
}
on("maps-settings", async () => {
  if (!ownerHere() || busy) return;
  try {
    const current = await api("maps"); if (!ownerHere()) return;
    if (current.settings.enabled) { await api("maps", { ...current.settings, enabled: false }); toast("Maps disabled; pending requests revoked"); return; }
    const keySecret = prompt("Existing Geoapify key's locker secret name, never the key value", "GEOAPIFY_KEY"); if (!keySecret) return;
    const maxCallsPerDay = Number(prompt("Local HTTP attempt cap per UTC day (1–100); this is not a money limit or provider quota", "10"));
    if (!Number.isInteger(maxCallsPerDay) || maxCallsPerDay < 1 || maxCallsPerDay > 100) return;
    if (!confirm("I have reviewed the provider terms and my existing plan's commercial-use eligibility. Billing and remaining quota are unknown. I accept sending only coordinates I explicitly enter and approve per request. This enables no subscription, GPS or automatic IP location.") || !ownerHere()) return;
    await api("maps", { enabled: true, termsAndBillingAccepted: true, keySecret, maxCallsPerDay });
    if (ownerHere()) toast("Maps enabled; each location request still needs approval");
  } catch (error) { if (ownerHere()) toast(error.message); }
});
function coordinate(label) {
  const answer = prompt(`${label}: latitude,longitude (you must provide the exact coordinate; no device location is used)`);
  if (!answer) return null;
  const parts = answer.split(","); if (parts.length !== 2 || parts.some(value => !value.trim())) return null;
  const [latitude, longitude] = parts.map(Number);
  return Number.isFinite(latitude) && Number.isFinite(longitude) && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180 ? { latitude, longitude } : null;
}
function requestInput() {
  const kind = prompt("Request type: image, route or places", "image");
  if (!["image", "route", "places"].includes(kind)) return null;
  const centre = coordinate(kind === "route" ? "Origin" : "Centre"); if (!centre) return null;
  if (kind === "image") return { kind, centre, zoom: Number(prompt("Zoom 1–18", "12")) };
  if (kind === "route") {
    const destination = coordinate("Destination"); if (!destination) return null;
    return { kind, origin: centre, destination, mode: prompt("Mode: drive, walk or bicycle", "walk") };
  }
  return { kind, centre, radiusMeters: Number(prompt("Search radius in metres (100–10000)", "1000")), limit: 5,
    category: prompt("Category: catering.restaurant, catering.cafe, commercial.supermarket, healthcare.pharmacy, accommodation.hotel or tourism.attraction", "catering.restaurant") };
}
function show(answer) {
  if (!ownerHere()) return;
  const picture = document.getElementById("maps-image"), output = document.getElementById("maps-result");
  const image = answer?.kind === "image" ? answer.result?.image : null;
  if (picture) { picture.replaceChildren(); if (typeof image === "string" && image.startsWith("data:image/png;base64,") && image.length <= 360000) {
    const img = document.createElement("img"); img.src = image; img.alt = "Provider static map of the exact approved coordinates"; img.width = 400; img.height = 300; picture.append(img);
  } }
  if (output) output.textContent = JSON.stringify(image ? { ...answer, result: { ...answer.result, image: "[map displayed above]" } } : answer, null, 2);
}
on("maps-request", async (element) => {
  if (!ownerHere() || busy) return;
  const request = requestInput(); if (!request || !ownerHere()) return;
  if (!confirm(`Send this exact request to Geoapify?\n${JSON.stringify(request, null, 2)}\nI entered these coordinates. One HTTP attempt may consume my existing provider plan; billing is unknown. Approval is single use, including failure/timeout; no retry. Data is not verified live navigation or comprehensive place coverage.`)) return;
  busy = true;
  try {
    const grant = await api("maps/authorize", { request, ownerEnteredCoordinates: true, singleCallBillingAccepted: true });
    if (!ownerHere()) return;
    if (element.dataset.v === "prepare") {
      show({ ...grant, note: "No provider call made. Give this tool and requestId to your original private owner task to execute once within three minutes. This is an authorization, not a result." }); return;
    }
    show(await api("maps/request", { tool: grant.tool, requestId: grant.requestId }));
  } catch (error) { if (ownerHere()) toast(error.message); }
  finally { busy = false; }
});
on("maps-revoke", async () => {
  if (!ownerHere()) return;
  try { await api("maps/revoke", {}); if (ownerHere()) { show({ revoked: true }); toast("Pending maps requests revoked; active request cancellation sent"); } }
  catch (error) { if (ownerHere()) toast(error.message); }
});
