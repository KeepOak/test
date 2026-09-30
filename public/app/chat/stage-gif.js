import { S, ownerHere } from "../core/state.js";
import { token } from "../core/api.js";
import { esc, render, onRender } from "../core/dom.js";
import { on } from "../core/actions.js";
import { toast } from "../core/ui.js";
import { markLive } from "../core/features.js";
import { t } from "../../i18n.js";
import { gifBytes, gifPalette } from "./gif-encode.js";

const G = { scope: "", run: "", generation: 0, recording: false, frames: [], busy: false, at: 0, started: 0,
  timer: 0, expires: 0, decoding: null };
const currentScope = () => ownerHere() && S.signedIn && S.chat && !document.hidden
  && !document.getElementById("app")?.classList.contains("locked-b17") ? `${S.chat}/${token.get()}` : "";
function reset() {
  clearTimeout(G.timer); clearTimeout(G.expires); G.decoding?.cancel();
  Object.assign(G, { scope: "", run: "", generation: G.generation + 1, recording: false, frames: [], busy: false, decoding: null });
}
function sync() { if (G.scope && currentScope() !== G.scope) reset(); return !!currentScope(); }
function finish() {
  if (!sync() || !G.scope) return;
  G.recording = false; clearTimeout(G.timer);
  G.expires = setTimeout(() => { reset(); render(); }, 60_000); render();
}
function boundedJPEG(bytes) {
  if (bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); let at = 2;
  while (at + 2 < Math.min(bytes.length, 65536)) {
    if (bytes[at++] !== 255) return false;
    while (bytes[at] === 255) at++;
    const marker = bytes[at++];
    if (marker === 217 || marker === 218) return false;
    if (marker === 1 || marker >= 208 && marker <= 216) continue;
    if (at + 2 > bytes.length) return false;
    const length = view.getUint16(at);
    if (length < 2 || at + length > bytes.length) return false;
    if (marker === 192 || marker === 194) {
      if (length < 8) return false;
      const height = view.getUint16(at + 3), width = view.getUint16(at + 5);
      return width > 0 && height > 0 && width <= 4096 && height <= 8192 && width * height <= 4 * 1024 * 1024;
    }
    at += length;
  }
  return false;
}
function imageOf(bytes) {
  return new Promise((resolve, reject) => {
    const image = new Image(), url = URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
    const clean = () => { clearTimeout(timer); image.onload = image.onerror = null; URL.revokeObjectURL(url); G.decoding = null; };
    const failed = () => { clean(); image.src = ""; reject(new Error("Image unavailable")); };
    const timer = setTimeout(failed, 3000);
    G.decoding = { cancel: failed }; image.onerror = failed;
    image.onload = () => { clean(); resolve(image); }; image.src = url;
  });
}
/** Only freshly observed, ready, masked task frames; no saved fallback, borrowed frame or unseen step is recorded. */
export async function observeGif(view) {
  if (!sync() || !G.recording || G.busy) return;
  const browser = view?.browser;
  if (browser?.runId && browser.runId !== G.run) { reset(); render(); return; }
  if (!browser?.live) { finish(); return; }
  if (browser.preview !== "ready" || typeof browser.frame !== "string" || !browser.frame.startsWith("data:image/jpeg;base64,")) return;
  const at = Date.parse(browser.at);
  if (!Number.isFinite(at) || at < G.started || at - G.at < 500 || browser.frame.length > 2_800_000) return;
  const generation = G.generation; G.busy = true; G.at = at;
  try {
    const encoded = browser.frame.slice("data:image/jpeg;base64,".length);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error("Image unavailable");
    const binary = atob(encoded), bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    if (bytes.length > 2 * 1024 * 1024 || !boundedJPEG(bytes)) throw new Error("Image limit");
    const image = await imageOf(bytes);
    if (!sync() || generation !== G.generation || !G.recording) return;
    const canvas = document.createElement("canvas"); canvas.width = 320; canvas.height = 240;
    const ctx = canvas.getContext("2d", { willReadFrequently: true }); if (!ctx) throw new Error("Canvas unavailable");
    ctx.fillStyle = "#000"; ctx.fillRect(0, 0, 320, 240);
    const scale = Math.min(320 / image.naturalWidth, 240 / image.naturalHeight), width = image.naturalWidth * scale, height = image.naturalHeight * scale;
    ctx.drawImage(image, (320 - width) / 2, (240 - height) / 2, width, height);
    G.frames.push(gifPalette(ctx.getImageData(0, 0, 320, 240).data));
    canvas.width = canvas.height = 0;
    if (G.frames.length >= 20) finish();
  } catch { /* Bad or oversized frames are omitted; never invent a replacement. */ }
  finally { if (generation === G.generation) G.busy = false; }
}
export function gifButtons(view) {
  if (!sync()) return "";
  if (G.run && view?.runId && view.runId !== G.run) reset();
  const button = (action, key) => `<button type="button" class="btn sm" data-act="${action}" title="${esc(t("window.stage.gif.limits"))}">${esc(t(key))}</button>`;
  if (G.recording) return button("stage-gif-finish", "window.stage.gif.finish");
  if (G.frames.length >= 2) return button("stage-gif-save", "window.stage.gif.save") + button("stage-gif-discard", "window.stage.gif.discard");
  return view?.live && view.preview === "ready" && view.frame ? button("stage-gif-start", "window.stage.gif.start") : "";
}
export function startGif(view) {
  reset(); if (!sync() || !view?.live || view.preview !== "ready" || !view.frame || !view.runId) return;
  G.scope = currentScope(); G.run = view.runId; G.recording = true; G.started = Date.now(); G.at = 0;
  G.timer = setTimeout(finish, 10_000); render();
}
on("stage-gif-finish", finish);
markLive(["stage-gif-start", "stage-gif-finish", "stage-gif-save", "stage-gif-discard"]);
on("stage-gif-discard", () => { reset(); render(); });
on("stage-gif-save", () => {
  if (!sync() || G.frames.length < 2 || G.recording) return;
  try {
    const url = URL.createObjectURL(new Blob([gifBytes(G.frames)], { type: "image/gif" }));
    const link = document.createElement("a"); link.href = url; link.download = "branch-task-snapshots.gif";
    link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); reset(); render();
  } catch { toast(t("window.stage.gif.unavailable")); }
});
onRender(sync);
document.addEventListener("visibilitychange", () => { if (document.hidden) reset(); });
addEventListener("pagehide", reset);
const root = document.getElementById("app");
if (root) new MutationObserver(sync).observe(root, { attributes: true, attributeFilter: ["class"] });
