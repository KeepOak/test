/* Explicit owner choice; opening/saving settings does not contact or install a vector service. */
import { esc } from "../core/dom.js";
import { E } from "../core/state.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { openDlg, closeDlg, dialog, toast, ic } from "../core/ui.js";
import { gsel } from "../core/gsel.js";
import { t } from "../../i18n.js";

export function vectorSourceRow() {
  if (E.profiles?.isOwner === false) return "";
  return `<div class="prow"><span class="ico-tile">${ic("folder", "s")}</span><span class="grow"><b>${t("vectors.source.title")}</b><small>${t("vectors.source.summary")}</small></span><button type="button" class="btn sm" data-act="vector-source-open">${t("embeddings.source.choose")}</button></div>`;
}
const field = (id, label, value, limit) => `<label for="${id}">${t(label)}</label><input class="inp" id="${id}" data-sw="${id}" maxlength="${limit}" value="${esc(value)}">`;

async function openSource() {
  try {
    const { vectorStore: settings, backend, backendNote } = await api("knowledge");
    openDlg({ title: t("vectors.source.title"), body: `<p class="hint">${t("vectors.source.explanation")}</p>
      <label>${t("vectors.source.where")}${gsel({ id: "vector-source", sw: "vector-source", label: t("vectors.source.where"), options: [["database", t("vectors.source.database")], ["file", t("vectors.source.file")], ["qdrant", "Qdrant"], ["chroma", "Chroma"], ["pinecone", "Pinecone"], ["milvus", "Milvus"], ["elasticsearch", "Elasticsearch"]], value: settings.vectorsIn })}</label>
      ${field("vector-file", "vectors.source.path", settings.vectorsFile, 400)}
      ${field("vector-url", "vectors.source.url", settings.vectorsUrl, 500)}
      ${field("vector-secret", "vectors.source.secret", settings.vectorsSecret, 200)}
      <label>${t("nativeMemory.locality")}${gsel({ id: "vector-locality", sw: "vector-locality", label: t("nativeMemory.locality"), options: [["direct", t("nativeMemory.direct")], ["forwarded", t("nativeMemory.forwarded")]], value: settings.vectorsRemoteBehindLoopback ? "forwarded" : "direct" })}</label>
      ${field("vector-tenant", "vectors.source.tenant", settings.chromaTenant, 120)}
      ${field("vector-database", "vectors.source.chromaDatabase", settings.chromaDatabase, 120)}
      ${field("vector-milvus-database", "vectors.source.milvusDatabase", settings.milvusDatabase, 120)}
      <p class="hint">${t("vectors.source.retained")}</p><p class="hint">${esc(backend)}${backendNote ? `: ${esc(backendNote)}` : ""}</p>`, foot: `<button class="btn pri" type="button" data-act="vector-source-save">${t("embeddings.source.save")}</button>` });
  } catch (error) { toast(error.message); }
}

async function saveSource(el) {
  const form = dialog(), vectorsIn = form?.querySelector("#vector-source")?.value;
  if (!vectorsIn || el.disabled) return;
  const value = (id) => form.querySelector(`#${id}`).value.trim();
  el.disabled = true;
  try {
    const result = await api("knowledge/vectors", { vectorsIn, vectorsFile: value("vector-file"), vectorsUrl: value("vector-url"), vectorsSecret: value("vector-secret"), vectorsRemoteBehindLoopback: value("vector-locality") === "forwarded", chromaTenant: value("vector-tenant"), chromaDatabase: value("vector-database"), milvusDatabase: value("vector-milvus-database") });
    if (dialog() === form) closeDlg();
    toast(result.note || t("embeddings.source.saved"));
  } catch (error) { toast(error.message); if (el.isConnected) el.disabled = false; }
}
markLive(["vector-source-open", "vector-source-save", "sw:vector-source", "sw:vector-file", "sw:vector-url", "sw:vector-secret", "sw:vector-locality", "sw:vector-tenant", "sw:vector-database", "sw:vector-milvus-database"]);
on("vector-source-open", openSource);
on("vector-source-save", saveSource);
