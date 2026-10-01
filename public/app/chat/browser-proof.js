/* One recorded browser frame under a finished reply. Receipts and the scoped artifact route decide what exists. */
import { esc, render, onRender } from "../core/dom.js";
import { S, E, ownerHere } from "../core/state.js";
import { token } from "../core/api.js";
import { t } from "../../i18n.js";

const MAX_BYTES = 2 * 1024 * 1024, MAX_PICTURES = 12;
const P = { scope: "", auth: "", generation: 0, pictures: new Map() };
const scope = () => ownerHere() && S.signedIn && S.chat && !document.hidden
  && !document.getElementById("app")?.classList.contains("locked-b17") ? S.chat : "";
function forget() {
  for (const picture of P.pictures.values()) {
    picture.controller?.abort();
    if (picture.url) URL.revokeObjectURL(picture.url);
  }
  P.pictures.clear(); P.generation++;
}
function sync() {
  const now = scope(), auth = token.get();
  if (now !== P.scope || auth !== P.auth) { forget(); P.scope = now; P.auth = auth; }
  return !!now;
}
function artifact(value, kept, runId) {
  if (!value || typeof value.path !== "string" || typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256)) return null;
  const entry = kept.find(one => one.runId === runId && one.path === value.path);
  if (!entry || entry.mediaType !== "image/png"
    || !Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > MAX_BYTES || entry.bytes !== value.bytes) return null;
  return { path: value.path, bytes: value.bytes, sha256: value.sha256, mediaType: entry.mediaType };
}
/** Only successful screenshot/flow receipts in this conversation, matching the exact task's stored image, count. */
export function browserProofReceipt(run, messages, kept) {
  const names = new Map(messages.flatMap(message => message.toolCalls ?? []).map(call => [call.id, call.name]));
  for (const message of [...messages].reverse()) {
    if (message.role !== "tool" || !["browser.screenshot", "browser.flow"].includes(names.get(message.toolCallId))) continue;
    let answer;
    try { answer = JSON.parse(message.content ?? "null"); } catch { continue; }
    if (answer?.ok !== true || !answer.result) continue;
    const result = names.get(message.toolCallId) === "browser.flow"
      ? Array.isArray(answer.result.steps) ? answer.result.steps.at(-1)?.screenshot : null : answer.result;
    const found = artifact(result, kept, run.id);
    if (found) return found;
  }
  return null;
}
async function readBounded(response, expected, signal) {
  if (!response.body) throw new Error("No image body");
  const reader = response.body.getReader(), chunks = [];
  let length = 0;
  try {
    for (;;) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > expected || length > MAX_BYTES) throw new Error("Image exceeds receipt");
      chunks.push(value);
    }
    if (length !== expected) throw new Error("Image differs from receipt");
    const bytes = new Uint8Array(length); let at = 0;
    for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
    return bytes;
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
async function load(proof, picture) {
  const generation = P.generation, controller = new AbortController(); picture.controller = controller;
  try {
    const response = await fetch(`/api/artifacts/file?path=${encodeURIComponent(proof.path)}`, {
      cache: "no-store", signal: controller.signal, headers: P.auth ? { authorization: `Bearer ${P.auth}` } : {},
    });
    if (!response.ok || response.headers.get("content-type")?.split(";")[0] !== proof.mediaType) throw new Error("Image refused");
    const bytes = await readBounded(response, proof.bytes, controller.signal);
    if (!boundedPNG(bytes)) throw new Error("Image dimensions exceed preview limits");
    const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(byte => byte.toString(16).padStart(2, "0")).join("");
    if (digest !== proof.sha256) throw new Error("Image differs from receipt");
    if (!sync() || generation !== P.generation || controller.signal.aborted) return;
    picture.url = URL.createObjectURL(new Blob([bytes], { type: proof.mediaType }));
  } catch {
    if (generation === P.generation && !controller.signal.aborted) picture.failed = true;
  } finally { picture.controller = null; if (generation === P.generation) render(); }
}
function boundedPNG(bytes) {
  if (bytes.length < 33 || ![137, 80, 78, 71, 13, 10, 26, 10].every((byte, at) => bytes[at] === byte)) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452) return false;
  const width = view.getUint32(16), height = view.getUint32(20);
  return width > 0 && height > 0 && width <= 4096 && height <= 8192 && width * height <= 4 * 1024 * 1024;
}
/** At most twelve completed replies in the open owner conversation can load two-megabyte verified images. */
export function browserProofHTML(run, messages, kept) {
  if (!sync() || run.status !== "completed" || run.sessionId !== S.chat) return "";
  const recent = (E.state?.runs ?? []).filter(one => one.sessionId === S.chat && one.status === "completed")
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, MAX_PICTURES);
  const allowed = new Set(recent.map(one => one.id));
  for (const [key, picture] of P.pictures) if (!allowed.has(key.split("/")[0])) {
    picture.controller?.abort(); if (picture.url) URL.revokeObjectURL(picture.url); P.pictures.delete(key);
  }
  if (!recent.some(one => one.id === run.id)) return "";
  const proof = browserProofReceipt(run, messages, kept); if (!proof) return "";
  const key = `${run.id}/${proof.sha256}`;
  for (const [old, picture] of P.pictures) if (old.startsWith(`${run.id}/`) && old !== key) {
    picture.controller?.abort(); if (picture.url) URL.revokeObjectURL(picture.url); P.pictures.delete(old);
  }
  if (!P.pictures.has(key)) {
    if (P.pictures.size >= MAX_PICTURES) return "";
    const picture = { url: "", failed: false, controller: null }; P.pictures.set(key, picture); void load(proof, picture);
  }
  const picture = P.pictures.get(key), label = t("window.chat.browser-proof.snapshot");
  const content = picture.url ? `<img src="${esc(picture.url)}" alt="${esc(label)}" loading="lazy">`
    : `<small role="status">${esc(t(picture.failed ? "window.chat.browser-proof.unavailable" : "window.chat.browser-proof.loading"))}</small>`;
  return `<div class="b"><div class="gut"></div><div><figure class="browser-proof7"><figcaption>${esc(label)}</figcaption>${content}<small>${esc(t("window.chat.browser-proof.recorded"))}</small></figure></div></div>`;
}
onRender(sync);
addEventListener("pagehide", () => { forget(); P.scope = ""; });
document.addEventListener("visibilitychange", () => { if (document.hidden) { forget(); P.scope = ""; } });
const root = document.getElementById("app");
if (root) new MutationObserver(() => {
  if (scope()) return;
  forget(); P.scope = "";
  for (const image of root.querySelectorAll(".browser-proof7 img")) image.removeAttribute("src");
}).observe(root, { attributes: true, attributeFilter: ["class"] });
