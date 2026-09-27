/* attach-anything: any file goes with a message, the way it does in Claude. A file is added by the + menu (Attach files,
   Add a folder), by pasting (a copied picture or screenshot, files copied in Explorer or Finder, or long text, which
   becomes a text file over PASTE_CHARS), or by dropping files and folders onto the conversation. Each one is sent ahead
   at once (POST /api/attachments/upload, streamed by the browser and written to disk by the engine as it arrives) and
   shown as a chip with its own preview, made here from the file itself: a picture's thumbnail, a video's first frame and
   length, a sound's length, a PDF's page count, the first words of text, or the kind and size. The progress is the
   browser's own count of bytes sent. A chip can be taken off before sending (DELETE /api/attachments/upload). The
   message carries only the upload ids; the engine refuses one that is too big in its own words, shown on the chip.
   A folder comes as its files, each named "folder/inside/file", rather than as a zip: every file stays readable by the
   model and previewable here, and nothing has to be packed on this computer first. */

import { $, esc, applyCss } from "../core/dom.js";
import { ic, toast } from "../core/ui.js";
import { api, uploadFile } from "../core/api.js";
import { t } from "../../i18n.js";

/** The engine's own limits (src/contracts.ts maximumUploadsPerTurn, maximumUploadBytes); it decides, this only says early. */
export const MAX_FILES = 20;
export const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;
/** Pasted text longer than this becomes a text file, as in Claude, instead of flooding the box. */
export const PASTE_CHARS = 4000;

const A = { files: [], next: 1 };
const sizeOf = (n) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const ending = (name) => (/\.([a-z0-9]{1,6})$/i.exec(name)?.[1] ?? "").toLowerCase();
const WORDS = new Set(["txt", "md", "csv", "json", "log", "xml", "yaml", "yml", "toml", "ini", "sql", "sh", "ps1", "js", "mjs", "ts", "tsx", "jsx", "py", "rb", "go", "rs", "java", "kt", "c", "h", "cpp", "cs", "swift", "php", "css", "html", "htm"]);
function kindOf(file) {
  const type = file.type || "";
  if (WORDS.has(ending(file.name)) && !type.startsWith("image/")) return "text";
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/")) return "audio";
  if (type === "application/pdf" || ending(file.name) === "pdf") return "pdf";
  if (type.startsWith("text/")) return "text";
  return "file";
}

/** Whatever is waiting to go with the next message, as chips; drawn in #attached above the box. */
export function attachedChips() {
  if (!A.files.length) return "";
  return `<div class="att-row">${A.files.map(chip).join("")}</div>`;
}
function look(f) {
  const p = f.preview;
  if (p.thumb) return `<img class="att-img" src="${esc(p.thumb)}" alt="">`;
  if (p.poster) return `<span class="att-img att-vid"><img src="${esc(p.poster)}" alt="">${ic("play15", "s")}</span>`;
  return `<span class="fi">${esc(ending(f.name) || f.kind)}</span>`;
}
function detail(f) {
  if (f.state === "failed") return `<small class="att-err">${esc(f.error)}</small>`;
  const p = f.preview;
  const bits = [sizeOf(f.size)];
  if (p.dur) bits.push(mmss(p.dur));
  if (p.pages) bits.push(t("window.chat.plus.pages", { n: p.pages }));
  if (f.state === "sending") bits.push(t("window.chat.plus.sending", { pct: f.pct }));
  const snippet = p.snippet ? `<small class="att-snip">${esc(p.snippet)}</small>` : "";
  return `<small>${esc(bits.join(" · "))}</small>${snippet}`;
}
function chip(f) {
  const bar = f.state === "sending" ? `<i class="att-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${f.pct}"><u data-css="width:${f.pct}%"></u></i>` : "";
  return `<div class="att ${f.state}" data-k="${f.key}" data-kind="${f.kind}">${look(f)}<span class="att-t"><b>${esc(f.name)}</b>${detail(f)}</span>`
    + `<button class="att-x" type="button" data-act="unattach" data-k="${f.key}" aria-label="${t("window.chat.media.remove", { name: esc(f.name) })}">${ic("x", "s")}</button>${bar}</div>`;
}
function redraw() {
  const box = $("#attached");
  if (!box) return;
  box.innerHTML = attachedChips();
  applyCss(box);
}

/** Adds files (a FileList or an array of { file, name }) and starts sending each one at once. */
export function addFiles(list) {
  const incoming = [...list].map((one) => (one instanceof File ? { file: one, name: one.name } : one));
  const room = MAX_FILES - A.files.length;
  if (incoming.length > room) toast(t("window.chat.plus.left-out", { files: MAX_FILES, n: incoming.length - Math.max(0, room) }));
  for (const { file, name } of incoming.slice(0, Math.max(0, room))) start(file, name);
  redraw();
}
function start(file, name) {
  const f = { key: String(A.next++), name: name || file.name || "file", size: file.size, kind: kindOf(file), state: "sending", pct: 0, preview: {}, upload: null, error: "" };
  A.files.push(f);
  describe(f, file).then(redraw, () => {});
  if (file.size > MAX_FILE_BYTES) return fail(f, t("window.chat.plus.too-big", { name: f.name, size: sizeOf(MAX_FILE_BYTES) }));
  const sending = uploadFile(file, f.name, (sent, total) => { const pct = Math.floor((sent / total) * 100); if (pct !== f.pct) { f.pct = pct; paintProgress(f); } });
  f.abort = sending.abort;
  f.done = sending.promise.then((view) => { f.upload = view.upload; f.state = "ready"; redraw(); }, (error) => { if (!error.aborted) fail(f, error.message); });
}
function fail(f, why) { f.state = "failed"; f.error = why; redraw(); }
/* Only the one chip's bar and words move while a file is sent; the rest of the row is left alone. */
function paintProgress(f) {
  const node = $(`#attached [data-k="${f.key}"]`);
  if (!node) return;
  const holder = document.createElement("div");
  holder.innerHTML = chip(f);
  applyCss(holder);
  node.replaceWith(holder.firstElementChild);
}

/* The preview, made from the file in this window: nothing is fetched back from the engine to draw it. */
async function describe(f, file) {
  if (f.kind === "image") { f.preview.thumb = URL.createObjectURL(file); return; }
  if (f.kind === "video" || f.kind === "audio") return mediaLook(f, file);
  if (f.kind === "pdf") { f.preview.pages = await pdfPages(file); return; }
  if (f.kind === "text") f.preview.snippet = (await file.slice(0, 2048).text()).replace(/\s+/g, " ").trim().slice(0, 90);
}
function mediaLook(f, file) {
  const url = URL.createObjectURL(file);
  const el = document.createElement(f.kind === "video" ? "video" : "audio");
  el.preload = "metadata";
  el.muted = true;
  el.src = url;
  return new Promise((done) => {
    const finish = () => { URL.revokeObjectURL(url); done(); };
    el.addEventListener("error", finish, { once: true });
    el.addEventListener("loadedmetadata", () => {
      f.preview.dur = Number.isFinite(el.duration) ? el.duration : 0;
      if (f.kind !== "video") return finish();
      el.addEventListener("seeked", () => {
        try {
          const canvas = Object.assign(document.createElement("canvas"), { width: 160, height: Math.max(1, Math.round((160 * el.videoHeight) / (el.videoWidth || 1))) });
          canvas.getContext("2d").drawImage(el, 0, 0, canvas.width, canvas.height);
          f.preview.poster = canvas.toDataURL("image/jpeg", 0.7);
        } catch { /* a frame that cannot be drawn leaves the file's kind as its look */ }
        finish();
      }, { once: true });
      el.currentTime = Math.min(1, (el.duration || 0) / 4);
    }, { once: true });
  });
}
/* A PDF's page count, from its page objects (the first 8 MB is plenty); drawing a page needs a PDF renderer this window
   does not ship, so the chip says how many pages there are instead. */
async function pdfPages(file) {
  const text = await file.slice(0, 8 * 1024 * 1024).text();
  return (text.match(/\/Type\s*\/Page(?!s)/g) ?? []).length || 0;
}

/** Takes a chip off: stops its sending, and has the engine drop what already arrived. */
export function removeFile(key) {
  const at = A.files.findIndex((f) => f.key === key);
  if (at < 0) return;
  const [f] = A.files.splice(at, 1);
  f.abort?.();
  if (f.preview.thumb) URL.revokeObjectURL(f.preview.thumb);
  if (f.upload) api(`attachments/upload?id=${encodeURIComponent(f.upload)}`, undefined, "DELETE").catch(() => {});
  redraw();
}

/** Whether anything is waiting to go (so a message can be only files). */
export const hasFiles = () => A.files.some((f) => f.state !== "failed");

/** The upload ids for the next message, once every file has finished sending; the chips go with it. */
export async function takeUploads() {
  const waiting = A.files.filter((f) => f.state === "sending").map((f) => f.done);
  await Promise.all(waiting);
  const ids = A.files.filter((f) => f.state === "ready" && f.upload).map((f) => f.upload);
  const failed = A.files.filter((f) => f.state === "failed");
  for (const f of A.files) if (f.preview.thumb) URL.revokeObjectURL(f.preview.thumb);
  A.files = [];
  if (failed.length) toast(failed.map((f) => f.error).join(" "));
  return ids;
}

/* ---------- paste and drop ---------- */
function onPaste(e) {
  if (e.target?.id !== "prompt") return;
  const data = e.clipboardData;
  const files = [...(data?.files ?? [])];
  if (files.length) {
    e.preventDefault();
    addFiles(files.map((file, i) => ({ file, name: file.name && file.name !== "image.png" ? file.name : pastedName(file, i) })));
    return;
  }
  const text = data?.getData("text/plain") ?? "";
  if (text.length > PASTE_CHARS) {
    e.preventDefault();
    addFiles([{ file: new File([text], "pasted.txt", { type: "text/plain" }), name: `${t("window.chat.plus.pasted")}.txt` }]);
    return;
  }
  /* Files copied in Explorer or Finder are not handed to a page; the desktop app reads the list itself and sends them. */
  if (!text && window.branchDesktop?.clipboardFiles) {
    window.branchDesktop.clipboardFiles().then((sent) => {
      for (const view of sent ?? []) {
        if (A.files.length >= MAX_FILES) break;
        A.files.push({ key: String(A.next++), name: view.name, size: view.bytes, kind: { picture: "image", sound: "audio", document: "text" }[view.kind] ?? view.kind, state: "ready", pct: 100, preview: {}, upload: view.upload, error: "" });
      }
      redraw();
    }, (error) => toast(error.message));
  }
}
const pastedName = (file, i) => `${t("window.chat.plus.pasted")}${i ? ` ${i + 1}` : ""}.${(file.type.split("/")[1] || "bin").replace("jpeg", "jpg")}`;

const carriesFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes("Files");
const dropZone = (e) => e.target?.closest?.("#conversation, .dock, .composer, .chat-empty, main");
function onDragOver(e) {
  if (!carriesFiles(e) || !dropZone(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "copy";
  $("#composer")?.classList.add("drop-on");
}
function onDragLeave(e) {
  if (!e.relatedTarget || !dropZone({ target: e.relatedTarget })) $("#composer")?.classList.remove("drop-on");
}
async function onDrop(e) {
  if (!carriesFiles(e) || !dropZone(e)) return;
  e.preventDefault();
  $("#composer")?.classList.remove("drop-on");
  const entries = [...(e.dataTransfer.items ?? [])].map((item) => item.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) { addFiles(e.dataTransfer.files); return; }
  const found = [];
  for (const entry of entries) await walk(entry, "", found);
  addFiles(found);
}
/* A dropped folder, walked for its files; each keeps the folder's layout in its name. Stops once there are enough. */
async function walk(entry, under, found) {
  if (found.length > MAX_FILES) return;
  if (entry.isFile) {
    const file = await new Promise((done, fail) => entry.file(done, fail)).catch(() => null);
    if (file) found.push({ file, name: under + file.name });
    return;
  }
  if (!entry.isDirectory) return;
  const reader = entry.createReader();
  for (;;) {
    const batch = await new Promise((done, fail) => reader.readEntries(done, fail)).catch(() => []);
    if (!batch.length) break;
    for (const inner of batch) await walk(inner, `${under}${entry.name}/`, found);
  }
}

/** Picks files, or a whole folder, with the system's own picker. */
export function pickFiles(folder = false) {
  const input = Object.assign(document.createElement("input"), { type: "file", multiple: true });
  if (folder) input.webkitdirectory = true;
  input.addEventListener("change", () => addFiles([...input.files].map((file) => ({ file, name: file.webkitRelativePath || file.name }))));
  input.click();
}

export function initAttach() {
  document.addEventListener("paste", onPaste);
  document.addEventListener("dragover", onDragOver);
  document.addEventListener("dragleave", onDragLeave);
  document.addEventListener("drop", onDrop);
}
