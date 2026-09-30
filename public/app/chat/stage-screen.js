import { token } from "../core/api.js";

const V = { on: false, sid: "", epoch: 0, open: null, selecting: null, frame: "", frameId: "", painted: "", viewId: "", label: "",
  refusal: "", notice: "", targets: [], loading: false, onChange: null, watching: false, driving: false, cursor: null, kind: "", chosen: false, last: null, claimed: "" };
export const screenFrame = () => V.frame;
export const screenRefusal = () => V.refusal;
/** Where the Trunk's newest click landed on the frame ({ x, y } shares, `at`, `trunk`), or null. */
export const screenCursor = () => (V.frame ? V.cursor : null);
export const screenDriving = () => V.driving;
export const setDriving = (value) => { V.driving = value === true; };
export const nativeScreenState = () => ({ targets: V.targets, loading: V.loading, notice: V.notice, label: V.label, selected: !!V.viewId, kind: V.kind });
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
  Object.assign(V, { open: null, frame: "", frameId: "", painted: "", viewId: "", label: "", kind: "", driving: false, cursor: null, loading: false });
  if (viewId) request("/stop", { sessionId: sid, viewId }).catch(() => {});
}
// computer-control: once the owner stops or picks something, the main display is no longer opened for them by itself.
export function stopNativeScreen() { end(); V.chosen = true; V.last = null; V.refusal = "Choose a display or an app window to see it again."; changed(); }
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
  // computer-control: opening the computer view shows this computer at once (its main display, with Branch's own
  // windows left out), as GrokBot's live computer does; the owner can pick another display or one app window.
  // Shown again (the view reopened, the window came back): what the owner last chose, if it is still there.
  if (epoch !== V.epoch || V.viewId) return;
  const again = V.last && V.targets.find((target) => target.kind === V.last.kind && target.label === V.last.label);
  const main = !V.chosen ? V.targets.find((target) => target.kind === "monitor" && target.primary) ?? V.targets.find((target) => target.kind === "monitor") : null;
  const pick = again || main;
  if (pick) void chooseNativeTarget(pick.id, false);
}
export async function chooseNativeTarget(targetId, byOwner = true) {
  if (!showing() || !targetId) return;
  const chosen = V.targets.find((target) => target.id === targetId), kind = chosen?.kind || "";
  if (byOwner) { V.chosen = true; V.last = chosen ? { kind: chosen.kind, label: chosen.label } : null; }
  end(); const epoch = V.epoch, sid = V.sid;
  const controller = new AbortController(); V.selecting = controller;
  V.loading = true; changed();
  try {
    const result = await request("/target", { sessionId: sid, targetId }, controller.signal);
    if (epoch !== V.epoch || !showing()) { request("/stop", { sessionId: sid, viewId: result.viewId }).catch(() => {}); return; }
    Object.assign(V, { viewId: result.viewId, label: result.label, kind, refusal: "", loading: false });
    changed(); void read(epoch);
  } catch (error) { if (epoch === V.epoch) { V.loading = false; V.refusal = error.message; changed(); } }
  finally { if (V.selecting === controller) V.selecting = null; }
}
function shown(got, epoch) {
  if (epoch !== V.epoch || !showing() || got.viewId !== V.viewId) return;
  if (got.frame) {
    const first = !V.frame, flipped = V.driving !== (got.control === true);
    // Another Trunk's click redraws its name and colour at once; the same Trunk's next click only moves the cursor.
    const changedTrunk = (got.cursor?.trunk ?? null) !== (V.cursor?.trunk ?? null) || !got.cursor !== !V.cursor;
    Object.assign(V, { frame: got.frame, frameId: got.frameId, painted: "", refusal: "", driving: got.control === true, cursor: got.cursor ?? null });
    V.onChange?.(first || flipped || changedTrunk);
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
// computer-control: a press lands between two frames as often as not; wait (up to five seconds, for a busy computer) for the next painted one instead of
// refusing the owner's click, so Take over and clicks through the view work on a busy computer too.
async function frameRequest(extra) {
  const viewId = V.viewId;
  // Each painted frame carries one press: a second press made meanwhile waits for the next frame instead of reusing it.
  const ready = () => V.frameId && V.painted === V.frameId && V.claimed !== V.frameId;
  for (let tries = 0; tries < 100 && showing() && V.viewId === viewId && !ready(); tries++)
    await new Promise((done) => setTimeout(done, 50));
  if (!showing() || !V.viewId || V.viewId !== viewId || !ready()) throw new Error("Wait for a fresh visible frame.");
  V.claimed = V.frameId;
  return { sessionId: V.sid, viewId: V.viewId, frameId: V.frameId, ...extra };
}
export async function controlNativeScreen(held) {
  const epoch = V.epoch, body = await frameRequest({ held }); V.painted = "";
  const result = await request("/control", body);
  if (epoch === V.epoch) { V.driving = result.control === true; changed(); }
}
export async function inputNativeScreen(input) {
  if (!V.driving) throw new Error("Take control before using this application.");
  if (V.kind !== "window") throw new Error("On a whole display, use your own mouse and keyboard while you have control. To click through the view, choose an app window.");
  const body = await frameRequest({ input: { ...input, window: V.label } });
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
  // Another conversation starts from its main display again; closing and reopening this one keeps the owner's choice.
  const same = V.sid === (sid || "");
  end(); Object.assign(V, { on: !!on, sid: sid || "", targets: [], refusal: "", notice: "", ...(same ? {} : { chosen: false, last: null }) });
  if (showing()) void refreshNativeTargets();
}
document.addEventListener("visibilitychange", () => { if (document.hidden) { end(); changed(); } else if (showing()) void refreshNativeTargets(); });
window.addEventListener("pagehide", end);
document.addEventListener("load", (event) => { if (event.target.matches?.(".livescr-img")) nativeFramePainted(event.target); }, true);
