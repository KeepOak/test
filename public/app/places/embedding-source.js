/* One independent embedding choice for documents, memory and knowledge bases. Opening the
   settings reads configuration only; local availability is checked when an index/search runs. */
import { esc } from "../core/dom.js";
import { E } from "../core/state.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { openDlg, closeDlg, dialog, toast, ic } from "../core/ui.js";
import { gsel } from "../core/gsel.js";
import { t } from "../../i18n.js";

export function embeddingSourceRow() {
  if (E.profiles?.isOwner === false) return "";
  return `<div class="prow"><span class="ico-tile">${ic("folder", "s")}</span><span class="grow"><b>${t("embeddings.source.title")}</b><small>${t("embeddings.source.summary")}</small></span><button type="button" class="btn sm" data-act="embedding-source-open">${t("embeddings.source.choose")}</button></div>`;
}

async function openSource() {
  try {
    const { settings, providers } = await api("knowledge/embeddings");
    const options = [["ollama", t("embeddings.source.local")], ...providers.map((p) => [`provider:${p.id}`, p.name]), ["off", t("embeddings.source.off")]];
    const value = settings.source === "provider" ? `provider:${settings.preset}` : settings.source;
    openDlg({ title: t("embeddings.source.title"), body: `<p class="hint">${t("embeddings.source.explanation")}</p>
      <label>${t("embeddings.source.from")}${gsel({ id: "embedding-source", sw: "embedding-source", label: t("embeddings.source.from"), options, value })}</label>
      <label for="embedding-model">${t("embeddings.source.model")}</label><input class="inp" id="embedding-model" data-sw="embedding-model" maxlength="120" value="${esc(settings.model)}">
      <label for="embedding-version">${t("embeddings.source.version")}</label><input class="inp" id="embedding-version" data-sw="embedding-version" maxlength="120" value="${esc(settings.version)}">
      <p class="hint">${t("embeddings.source.rebuild")}</p>`, foot: `<button class="btn pri" type="button" data-act="embedding-source-save">${t("embeddings.source.save")}</button>` });
  } catch (error) { toast(error.message); }
}

async function saveSource(el) {
  const form = dialog(), selected = form?.querySelector("#embedding-source")?.value;
  if (!selected || el.disabled) return;
  const source = selected.startsWith("provider:") ? "provider" : selected;
  const input = { source, preset: source === "provider" ? selected.slice(9) : null,
    model: form.querySelector("#embedding-model").value.trim(), version: form.querySelector("#embedding-version").value.trim() };
  el.disabled = true;
  try { await api("knowledge/embeddings", input); if (dialog() === form) closeDlg(); toast(t("embeddings.source.saved")); }
  catch (error) { toast(error.message); if (el.isConnected) el.disabled = false; }
}

markLive(["embedding-source-open", "embedding-source-save", "sw:embedding-source", "sw:embedding-model", "sw:embedding-version"]);
on("embedding-source-open", openSource);
on("embedding-source-save", saveSource);
