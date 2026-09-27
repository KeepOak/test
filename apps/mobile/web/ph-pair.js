/**
 * Connecting to a Branch (the prototype's "Connect to your Branch"). The window's "Pair a phone" says: open the
 * app, tap Pair with a computer, point the camera at the code. The square carries the computer's address and the
 * invitation (/devices/pair?offer=…); the six numbers are typed. The native side then asks to be let in with this
 * phone's own key, and the page shows the check code the computer shows beside the request, so the owner can
 * compare them before pressing Let it in. Once let in, the native side asks for the phone's key once (POST
 * /api/devices/pair/session) and keeps it. The older invitation (/pair?id=…) still pairs through POST /api/pair.
 */
import { P, esc, ios, nav, on, say, w } from "/ph-core.js";
import { describe, phone, plugin } from "/phone-common.js";
import { keyCheck, readInvitation } from "/rules.js";
import { startScan } from "/scan.js";

const X = { said: "", bad: false, busy: false, stop: null, scanning: false };
const setSaid = (text, bad = false) => { Object.assign(X, { said: text, bad }); const node = document.getElementById("pair-status"); if (node) { node.textContent = text; node.classList.toggle("bad", bad); } };

export function drawPair(paired) {
  const back = paired ? say("nav.settings", "Settings") : "";
  const scanner = `<button type="button" class="p-big" data-act="pair-scan">${w("window.flows.pair.with-computer", "Pair with a computer")}</button><video id="scan-view" playsinline muted ${X.scanning ? "" : "hidden"}></video>`;
  return nav(say("phone.pair.title", "Connect to your Branch"), back) + `<div class="p-scroll">${scanner}
    <p class="p-empty">${w("phone8.pair.or", "Scan the square code on the computer, or:")}</p>
    <label class="p-fld"><span>${w("phone.pair.address", "Address from the computer")}</span><input id="address" type="url" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
    <label class="p-fld"><span>${w("phone.pair.code", "Six numbers from the computer")}</span><input id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="7"></label>
    <label class="p-fld"><span>${w("phone8.pair.name", "This phone’s name")}</span><input id="device-name" maxlength="80" autocomplete="off"></label>
    <button type="button" class="p-big" id="pair" data-act="pair" ${X.busy ? "disabled" : ""}>${w("phone.pair.connect", "Connect")}</button>
    <p class="p-empty">${w("phone.pair.addressNote", "Plain http only works on your own network or Tailscale.")}</p>
    <p class="subtle ${X.bad ? "bad" : ""}" id="pair-status" role="status">${esc(X.said)}</p></div>`;
}

async function scan() {
  const video = document.getElementById("scan-view");
  if (!video) return;
  X.scanning = true;
  video.hidden = false;
  setSaid(say("phone.pair.scanning", "Point the camera at the square code on your computer."));
  try {
    await import("/vendor/jsqr.js");
    const run = startScan(video, globalThis.jsQR?.default ?? globalThis.jsQR);
    X.stop = run.stop;
    const text = await run.found;
    if (text) { document.getElementById("address").value = text; setSaid(""); document.getElementById("code")?.focus(); }
  } catch {
    setSaid(say("phone.pair.noCamera", "The camera could not be opened. Paste the address instead."), true);
  } finally {
    X.scanning = false;
    X.stop = null;
    video.hidden = true;
  }
}
export const stopScan = () => { X.stop?.(); X.stop = null; X.scanning = false; };

/** The line shown while the computer decides, with the check code made from this phone's own key. */
async function waitingWords() {
  const key = await plugin.deviceKey?.().catch(() => null);
  const check = key?.publicKey ? await keyCheck(globalThis.crypto, key.publicKey).catch(() => null) : null;
  return check
    ? say("phone.device.waitingCheck", "Waiting for you to press Let it in on your computer. Check code {check}: your computer shows the same code beside this phone's request.", { check })
    : say("phone.device.waiting", "Waiting for you to press Let it in on your computer.");
}
async function pair(onPaired) {
  let invitation;
  try { invitation = readInvitation(document.getElementById("address").value); } catch (error) { setSaid(describe(error), true); return; }
  if (!invitation.offer && !invitation.offerId) { setSaid(say("phone.pair.needCode", "That is the address. Scan the square code too, so this phone can be let in."), true); return; }
  const code = document.getElementById("code").value, name = document.getElementById("device-name").value;
  X.busy = true;
  document.getElementById("pair").disabled = true;
  setSaid(invitation.offer ? await waitingWords() : say("phone.pair.connecting", "Connecting…"));
  try {
    await phone.vault.pair(invitation, code, name);
    document.getElementById("code").value = "";
    setSaid("");
    await onPaired();
  } catch (error) {
    setSaid(describe(error), true);
  } finally {
    X.busy = false;
    const button = document.getElementById("pair");
    if (button) button.disabled = false;
  }
}
export function initPair(onPaired) {
  on("pair-scan", () => scan());
  on("pair", () => pair(onPaired));
  void P; void ios;
}
