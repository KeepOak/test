import { S, ownerHere, activeId } from "../core/state.js";
import { token } from "../core/api.js";
import { esc, render, onRender } from "../core/dom.js";
import { on } from "../core/actions.js";
import { toast } from "../core/ui.js";
import { markLive } from "../core/features.js";
import { t } from "../../i18n.js";

// Original Branch adapter. Upstream recording_watchdog.py uses raw CDP and a Python video writer;
// this records only the existing masked, owner-visible task preview through canvas/MediaRecorder.
const V = { scope: "", run: "", generation: 0, recording: false, finishing: false, count: 0, at: 0,
  started: 0, deadline: 0, busy: false, canvas: null, recorder: null, stream: null, chunks: [], bytes: 0,
  ready: null, timer: 0, expires: 0, decoding: null };
const MAX_BYTES = 2 * 1024 * 1024;
const currentScope = () => ownerHere() && !activeId() && S.signedIn && token.get() && S.view === "chat" && S.chat && !document.hidden
  && !document.getElementById("app")?.classList.contains("locked-b17") ? `${S.chat}/${token.get()}` : "";
function codec() {
  if (typeof MediaRecorder !== "function" || typeof MediaRecorder.isTypeSupported !== "function"
    || typeof HTMLCanvasElement !== "function" || typeof HTMLCanvasElement.prototype.captureStream !== "function") return "";
  return ["video/webm;codecs=vp8", "video/webm"].find(type => MediaRecorder.isTypeSupported(type)) ?? "";
}
function reset() {
  clearTimeout(V.timer); clearTimeout(V.expires); V.decoding?.cancel();
  const recorder = V.recorder;
  if (recorder) {
    recorder.ondataavailable = recorder.onstop = recorder.onerror = null;
    if (recorder.state !== "inactive") { try { recorder.stop(); } catch { /* Already ending. */ } }
  }
  V.stream?.getTracks().forEach(track => track.stop());
  if (V.canvas) V.canvas.width = V.canvas.height = 0;
  Object.assign(V, { scope: "", run: "", generation: V.generation + 1, recording: false, finishing: false,
    count: 0, at: 0, busy: false, canvas: null, recorder: null, stream: null, chunks: [], bytes: 0, ready: null, decoding: null });
}
function sync() { if (V.scope && currentScope() !== V.scope) reset(); return !!currentScope(); }
function unavailable() { reset(); toast(t("window.stage.video.unavailable")); render(); }
function finalized(generation) {
  if (!sync() || generation !== V.generation || !V.finishing) return;
  clearTimeout(V.timer);
  if (performance.now() > V.deadline + 1000 || V.count < 2 || !V.bytes || V.bytes > MAX_BYTES) { unavailable(); return; }
  const ready = new Blob(V.chunks, { type: "video/webm" });
  V.stream?.getTracks().forEach(track => track.stop());
  V.recorder.ondataavailable = V.recorder.onstop = V.recorder.onerror = null;
  V.canvas.width = V.canvas.height = 0;
  Object.assign(V, { ready, chunks: [], recorder: null, stream: null, canvas: null, finishing: false });
  V.expires = setTimeout(() => { reset(); render(); }, 60_000); render();
}
function finish() {
  if (!sync() || !V.recording) return;
  V.recording = false; V.finishing = true; clearTimeout(V.timer); V.decoding?.cancel();
  if (!V.recorder || V.count < 2) { unavailable(); return; }
  const generation = V.generation;
  V.timer = setTimeout(() => { if (generation === V.generation && V.finishing) unavailable(); }, 1000);
  try { V.recorder.stop(); } catch { unavailable(); return; }
  render();
}
function recorderFor(canvas) {
  const type = codec(); if (!type) throw new Error("Codec unavailable");
  V.stream = canvas.captureStream(0);
  const track = V.stream.getVideoTracks()[0];
  if (!track || typeof track.requestFrame !== "function") throw new Error("Canvas capture unavailable");
  const recorder = V.recorder = new MediaRecorder(V.stream, { mimeType: type, videoBitsPerSecond: 250_000 });
  const generation = V.generation;
  recorder.ondataavailable = event => {
    if (!sync() || generation !== V.generation || V.recorder !== recorder) return;
    if (event.data.size) {
      if (V.bytes + event.data.size > MAX_BYTES || V.chunks.length >= 64) { unavailable(); return; }
      V.chunks.push(event.data); V.bytes += event.data.size;
    }
    if (V.recording && performance.now() >= V.deadline) finish();
  };
  recorder.onerror = () => { if (generation === V.generation) unavailable(); };
  recorder.onstop = () => finalized(generation);
  recorder.start(250);
  return track;
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
    const clean = () => { clearTimeout(timer); image.onload = image.onerror = null; URL.revokeObjectURL(url); V.decoding = null; };
    const failed = () => { clean(); image.src = ""; reject(new Error("Image unavailable")); };
    const timer = setTimeout(failed, 3000);
    V.decoding = { cancel: failed }; image.onerror = failed;
    image.onload = () => { clean(); resolve(image); }; image.src = url;
  });
}
function drawImage(image) {
  const canvas = V.canvas ??= document.createElement("canvas");
  canvas.width = 320; canvas.height = 240;
  const ctx = canvas.getContext("2d"); if (!ctx) throw new Error("Canvas unavailable");
  const paint = () => {
    ctx.fillStyle = "#000"; ctx.fillRect(0, 0, 320, 240);
    const scale = Math.min(320 / image.naturalWidth, 240 / image.naturalHeight);
    const width = image.naturalWidth * scale, height = image.naturalHeight * scale;
    ctx.drawImage(image, (320 - width) / 2, (240 - height) / 2, width, height);
  };
  paint();
  const track = V.recorder ? V.stream.getVideoTracks()[0] : recorderFor(canvas);
  // Paint after a newly created track too: captureStream(0) needs new canvas content.
  paint(); track.requestFrame();
}
/** Freshly observed, secret-masked frames of this task only; missing observations are never reconstructed. */
export async function observeVideo(view) {
  if (!sync() || !V.recording || V.busy) return;
  const browser = view?.browser;
  if (browser?.runId && browser.runId !== V.run) { reset(); render(); return; }
  if (!browser?.live || performance.now() >= V.deadline) { finish(); return; }
  if (browser.preview !== "ready" || typeof browser.frame !== "string" || !browser.frame.startsWith("data:image/jpeg;base64,")) return;
  const at = Date.parse(browser.at);
  if (!Number.isFinite(at) || at < V.started || at - V.at < 500 || browser.frame.length > 2_800_000) return;
  const generation = V.generation; V.busy = true; V.at = at;
  try {
    const encoded = browser.frame.slice("data:image/jpeg;base64,".length);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error("Image unavailable");
    const binary = atob(encoded), bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    if (bytes.length > MAX_BYTES || !boundedJPEG(bytes)) throw new Error("Image limit");
    const image = await imageOf(bytes);
    if (!sync() || generation !== V.generation || !V.recording) return;
    if (performance.now() >= V.deadline) { finish(); return; }
    drawImage(image); V.count++;
    if (V.count >= 20) finish();
  } catch { if (generation === V.generation) unavailable(); }
  finally { if (generation === V.generation) V.busy = false; }
}
export function videoButtons(view) {
  if (!sync()) return "";
  if (V.run && view?.runId && view.runId !== V.run) reset();
  const button = (action, key) => `<button type="button" class="btn sm" data-act="${action}" title="${esc(t("window.stage.video.limits"))}">${esc(t(key))}</button>`;
  if (V.recording) return button("stage-video-finish", "window.stage.video.finish") + button("stage-video-discard", "window.stage.video.discard");
  if (V.finishing) return button("stage-video-discard", "window.stage.video.discard");
  if (V.ready) return button("stage-video-save", "window.stage.video.save") + button("stage-video-discard", "window.stage.video.discard");
  return view?.live && view.preview === "ready" && view.frame && codec() ? button("stage-video-start", "window.stage.video.start") : "";
}
export function startVideo(view) {
  reset(); if (!sync() || !view?.live || view.preview !== "ready" || !view.frame || !view.runId) return;
  if (!codec()) { unavailable(); return; }
  Object.assign(V, { scope: currentScope(), run: view.runId, recording: true, started: Date.now(), deadline: performance.now() + 10_000 });
  V.timer = setTimeout(finish, 10_000); render();
}
on("stage-video-finish", finish);
markLive(["stage-video-start", "stage-video-finish", "stage-video-save", "stage-video-discard"]);
on("stage-video-discard", () => { reset(); render(); });
on("stage-video-save", () => {
  if (!sync() || !V.ready || V.ready.size > MAX_BYTES || V.recording || V.finishing) return;
  const url = URL.createObjectURL(V.ready), link = document.createElement("a");
  link.href = url; link.download = "branch-task-preview.webm"; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000); reset(); render();
});
onRender(sync);
document.addEventListener("visibilitychange", () => { if (document.hidden) reset(); });
addEventListener("pagehide", reset);
const root = document.getElementById("app");
if (root) new MutationObserver(sync).observe(root, { attributes: true, attributeFilter: ["class"] });
