import { token } from "../core/api.js";

const V = { on: false, sid: "", epoch: 0, open: null, selecting: null, frame: "", frameId: "", painted: "", viewId: "", label: "",
  refusal: "", notice: "", targets: [], loading: false, onChange: null, watching: false, driving: false };
export const screenFrame = () => V.frame;
export const screenRefusal = () => V.refusal;
export const screenCursor = () => null;
export const screenDriving = () => V.driving;
export const setDriving = (value) => { V.driving = value === true; };
export const nativeScreenState = () => ({ targets: V.targets, loading: V.loading, notice: V.notice, label: V.label, selected: !!V.viewId });
const locked = () => document.getElementById("app")?.classList.contains("locked-b17") === true;
const showing = () => V.on && !!V.sid && !document.hidden && !locked();
const changed = () => V.onChange?.(true);
const headers = () => ({ "content-type": "application/json", ...(token.get() ? { authorization: `Bearer ${token.get()}` } : {}) });
async function request(path, body, signal) {
  const response = await fetch(`/api/panels/screen${path}`, { method: body ? "POST" : "GET", headers: headers(),
    ...(body ? { body: JSON.stringify(body) } : {}), cache: "no-store", signal });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || "This screen is unavailable.");
  return value;
}
function end() {
  const sid = V.sid, viewId = V.viewId;
  V.epoch++; V.open?.abort(); V.selecting?.abort(); V.selecting = null;
  Object.assign(V, { open: null, frame: "", frameId: "", painted: "", viewId: "", label: "", driving: false, loading: false });
  if (viewId) request("/stop", { sessionId: sid, viewId }).catch(() => {});
}
export function stopNativeScreen() { end(); V.refusal = "Choose an application window to start a new view."; changed(); }
export async function refreshNativeTargets() {
  if (!showing() || V.loading) return;
  const epoch = V.epoch, sid = V.sid;
  V.loading = true; V.targets = []; changed();
  try {
    const result = await request(`/targets?session=${encodeURIComponent(sid)}`);
    if (epoch !== V.epoch || !showing()) return;
    V.targets = result.targets; V.notice = result.notice; V.refusal = "";
  } catch (error) { if (epoch === V.epoch) V.refusal = error.message; }
  finally { if (epoch === V.epoch) { V.loading = false; changed(); } }
}
export async function chooseNativeTarget(targetId) {
  if (!showing() || !targetId) return;
  end(); const epoch = V.epoch, sid = V.sid;
  const controller = new AbortController(); V.selecting = controller;
  V.loading = true; changed();
  try {
    const result = await request("/target", { sessionId: sid, targetId }, controller.signal);
    if (epoch !== V.epoch || !showing()) { request("/stop", { sessionId: sid, viewId: result.viewId }).catch(() => {}); return; }
    Object.assign(V, { viewId: result.viewId, label: result.label, refusal: "", loading: false });
    changed(); void read(epoch);
  } catch (error) { if (epoch === V.epoch) { V.loading = false; V.refusal = error.message; changed(); } }
  finally { if (V.selecting === controller) V.selecting = null; }
}
function shown(got, epoch) {
  if (epoch !== V.epoch || !showing() || got.viewId !== V.viewId) return;
  if (got.frame) {
    const first = !V.frame, flipped = V.driving !== (got.control === true);
    Object.assign(V, { frame: got.frame, frameId: got.frameId, painted: "", refusal: "", driving: got.control === true });
    V.onChange?.(first || flipped);
  }
}
async function read(epoch) {
  const controller = new AbortController(); V.open = controller;
  try {
    const query = new URLSearchParams({ session: V.sid, view: V.viewId, width: "1280" });
    const response = await fetch(`/api/panels/screen?${query}`, { headers: headers(), cache: "no-store", signal: controller.signal });
    if (!response.ok || !response.body) throw new Error((await response.json()).error || "This view stopped.");
    const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = "";
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > 16000000) throw new Error("The screen frame was too large.");
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        const got = JSON.parse(line); if (got.refusal) throw new Error(got.refusal);
        shown(got, epoch);
      }
    }
    if (epoch === V.epoch) throw new Error("This view ended. Choose the application again.");
  } catch (error) {
    if (epoch === V.epoch) { end(); V.refusal = error.message; changed(); }
  }
}
/** An image's load + paint, with exact current identity, permits control for that frame only. */
export function nativeFramePainted(image) {
  const frameId = V.frameId, viewId = V.viewId, epoch = V.epoch;
  if (!showing() || !frameId || !image.isConnected || image.getAttribute("src") !== V.frame || !image.complete || !image.naturalWidth) return;
  requestAnimationFrame(() => {
    if (epoch !== V.epoch || frameId !== V.frameId || !showing() || !image.isConnected || image.getAttribute("src") !== V.frame) return;
    request("/painted", { sessionId: V.sid, viewId, frameId }).then(() => {
      if (epoch === V.epoch && frameId === V.frameId) V.painted = frameId;
    }).catch(() => {});
  });
}
function frameRequest(extra) {
  if (!showing() || !V.viewId || V.painted !== V.frameId || !V.frameId) throw new Error("Wait for a fresh visible frame.");
  return { sessionId: V.sid, viewId: V.viewId, frameId: V.frameId, ...extra };
}
export async function controlNativeScreen(held) {
  const epoch = V.epoch, body = frameRequest({ held }); V.painted = "";
  const result = await request("/control", body);
  if (epoch === V.epoch) { V.driving = result.control === true; changed(); }
}
export async function inputNativeScreen(input) {
  if (!V.driving) throw new Error("Take control before using this application.");
  const body = frameRequest({ input: { ...input, window: V.label } });
  V.painted = "";
  await request("/input", body);
}
export function watchScreen(on, sid, onChange) {
  V.onChange = onChange;
  if (!V.watching && document.getElementById("app")) {
    V.watching = true;
    new MutationObserver(() => { if (locked()) { end(); changed(); } }).observe(document.getElementById("app"), { attributes: true, attributeFilter: ["class"] });
  }
  if (V.on === !!on && V.sid === (sid || "")) return;
  end(); Object.assign(V, { on: !!on, sid: sid || "", targets: [], refusal: "", notice: "" });
  if (showing()) void refreshNativeTargets();
}
document.addEventListener("visibilitychange", () => { if (document.hidden) { end(); changed(); } else if (showing()) void refreshNativeTargets(); });
window.addEventListener("pagehide", end);
document.addEventListener("load", (event) => { if (event.target.matches?.(".livescr-img")) nativeFramePainted(event.target); }, true);
