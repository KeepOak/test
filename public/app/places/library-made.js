/* RES-159: browse existing kept files by their reported type. No files are read or changed here. */
import { esc, renderNow } from "../core/dom.js";
import { activeId } from "../core/state.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { t } from "../../i18n.js";

const kinds = ["all", "pictures", "audio", "video", "documents", "data", "other"];
let selected = "all", profile;
const extensions = {
  pictures: ["png", "jpg", "jpeg", "webp", "gif", "svg", "bmp", "avif"],
  audio: ["wav", "mp3", "ogg", "flac", "m4a", "aac"],
  video: ["mp4", "webm", "mov", "mkv"],
  documents: ["pdf", "txt", "md", "doc", "docx", "odt", "rtf", "html"],
  data: ["csv", "tsv", "json", "jsonl", "xml", "yaml", "yml", "xlsx", "xls", "ods"],
};
function category(file) {
  const type = String(file.mediaType ?? "").slice(0, 200).split(";")[0].trim().toLowerCase();
  if (type.startsWith("image/")) return "pictures";
  if (type.startsWith("audio/")) return "audio";
  if (type.startsWith("video/")) return "video";
  if (["application/json", "application/xml", "text/csv", "text/tab-separated-values"].includes(type)) return "data";
  if (["application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.oasis.opendocument.spreadsheet"].includes(type)) return "data";
  if (["application/pdf", "application/msword", "application/rtf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.oasis.opendocument.text"].includes(type) || type.startsWith("text/")) return "documents";
  if (type && type !== "application/octet-stream") return "other";
  // The engine lists unrecognised extensions as octet-stream. Names are only a browsing hint,
  // never a claim that the contents were inspected or are safe to open.
  const extension = String(file.name ?? "").slice(0, 512).split(".").pop().toLowerCase();
  for (const [kind, names] of Object.entries(extensions)) if (names.includes(extension)) return kind;
  return "other";
}
export function madeFiles(files, row) {
  const now = activeId();
  if (profile !== now) { selected = "all"; profile = now; }
  if (!files.length) return "";
  const entries = files.map((file) => ({ file, kind: category(file) }));
  const counts = Object.fromEntries(kinds.map((kind) => [kind,
    kind === "all" ? files.length : entries.filter((one) => one.kind === kind).length]));
  const controls = `<div class="acts" data-css="flex-wrap:wrap" role="group" aria-label="${esc(t("libraryMadeTypes.label"))}">${kinds.map((kind) =>
    `<button class="btn ghost sm" type="button" data-act="library-made-type" data-kind="${kind}" aria-pressed="${kind === selected}">${esc(t(`libraryMadeTypes.${kind}`))} (${counts[kind]})</button>`).join("")}</div>`;
  const visible = entries.filter((one) => selected === "all" || one.kind === selected);
  return controls + `<p class="hint" role="status">${esc(t("libraryMadeTypes.count", { shown: visible.length, total: files.length }))}</p>`
    + (visible.length ? visible.map(({ file }) => row(file)).join("") : `<p class="hint">${esc(t("libraryMadeTypes.empty"))}</p>`);
}
markLive(["library-made-type"]);
on("library-made-type", (el) => {
  if (!kinds.includes(el.dataset.kind)) return;
  selected = el.dataset.kind;
  renderNow();
});
