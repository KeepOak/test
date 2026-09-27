/* Settings › Your data (privacy). Everything drawn here is read from GET /api/your-data (src/your-data.ts), which answers
   for whoever is at the window: a household person gets only their own counts and the model services their words go to;
   the owner also gets keys and connections (counted and named, never a value), logs, the folder, and every door out.
   What's kept: one row per kind with the engine's count and size, and for the owner where it lives on disk.
   What leaves this computer: one row per thing switched on now, the engine's sentence of what it sends, and Open,
   which goes to the page that switches it (setpage, the owner only).
   Export everything: POST /api/your-data/export starts one .zip; GET /api/your-data/export/<id> says how many of its
   parts are written (the bar is that count, nothing else); GET /api/your-data/export/<id>/file is the download.
   Keys, passwords and sign-ins never go in it, so there is no passphrase to choose.
   Delete everything: never automatic. The dialog offers the export first, the person types the engine's phrase, and
   POST /api/your-data/delete { confirm } does it; the engine refuses it under Lockdown, through a door, to a
   short-lived key and while a task works, and writes every delete to the owner's record. */
import { on } from "../../core/actions.js";
import { markLive } from "../../core/features.js";
import { api, token } from "../../core/api.js";
import { toast, openDlg, closeDlg, dialog, ic } from "../../core/ui.js";
import { esc, render, $ } from "../../core/dom.js";
import { statusBox } from "../parts.js";
import { t, language } from "../../../i18n.js";

let data = null;
let job = null; // the export in progress or ready: { id, done, total, ready, bytes, error }
let polling = false;

async function loadData() {
  try { data = await api("your-data"); } catch (error) { data = null; toast(error.message); }
  render();
}

const KIND_ICON = { conversations: "chat", memory: "bulb", files: "clip", recordings: "play", receipts: "check", keys: "key", logs: "list15" };
const LEAVE_ICON = { model: "cloud17d", chat: "chat", door: "globe", phone: "phone", webhook: "plug", updates: "retry" };
const size = (bytes) => {
  const units = [["gigabyte", 1e9], ["megabyte", 1e6], ["kilobyte", 1e3]];
  const [unit, div] = units.find(([, d]) => bytes >= d) ?? ["byte", 1];
  return new Intl.NumberFormat(language(), { style: "unit", unit, unitDisplay: "short", maximumFractionDigits: 1 }).format(bytes / div);
};

function keptRows() {
  return (data?.kinds ?? []).map((k) => {
    const line = [String(k.count), k.bytes === null ? "" : size(k.bytes)].filter(Boolean).join(" · ");
    return `<div class="prow"><span class="ico-tile">${ic(KIND_ICON[k.kind] ?? "doc", "s")}</span><span class="grow"><b>${t(`window.settings.data.kind.${esc(k.kind)}`)}</b><small>${esc(line)}</small>${k.where ? `<small class="where-p18">${esc(k.where)}</small>` : ""}</span></div>`;
  }).join("");
}

function leaveRows() {
  const rows = data?.leaves ?? [];
  if (!rows.length) return `<p class="hint">${t("window.settings.data.nothing-leaves")}</p>`;
  return rows.map((l) => `<div class="prow"><span class="ico-tile">${ic(LEAVE_ICON[l.kind] ?? "globe", "s")}</span><span class="grow"><b>${t(`window.settings.data.leave.${esc(l.kind)}`)}${l.name ? ` · ${esc(l.name)}` : ""}</b><small>${esc(l.sends)}</small></span>${l.page ? `<button class="btn ghost sm" type="button" data-act="setpage" data-v="${esc(l.page)}">${t("window.settings.data.open")}</button>` : ""}</div>`).join("");
}

function exportRow() {
  const bar = job && !job.ready && !job.error ? `<progress class="prog-p18" max="${job.total}" value="${job.done}" aria-label="${t("window.settings.data.export")}"></progress>` : "";
  const ready = job?.ready ? `<button class="btn pri sm" type="button" data-act="data-dl">${t("window.settings.data.download", { size: size(job.bytes ?? 0) })}</button>` : "";
  const busy = job && !job.ready && !job.error;
  return `<div class="ctl"><b>${t("window.settings.data.export")}</b><span class="right">${ready || `<button class="btn sm" type="button" data-act="data-export" ${busy ? "disabled" : ""}>${t("window.settings.data.export-go")}</button>`}</span><small>${t("window.settings.data.export-sub")}</small>${bar}${job?.error ? `<small class="bad-p18">${esc(job.error)}</small>` : ""}</div>`;
}

function deleteRow() {
  return `<div class="ctl"><b>${t("window.settings.data.delete")}</b><span class="right"><button class="btn bad sm" type="button" data-act="data-del">${t("window.settings.data.delete-go")}</button></span><small>${t(data?.owner ? "window.settings.data.delete-sub-owner" : "window.settings.data.delete-sub-person")}</small></div>`;
}

export function draw() {
  const head = `<h1>${t("window.settings.data.title")}</h1><p class="lede">${t("window.settings.data.lede")}</p>`;
  if (!data) return head;
  const lock = data.lockdown ? statusBox(t("window.settings.data.lockdown"), t("window.settings.data.lockdown-sub"), true) : "";
  const folder = data.folder ? `<p class="hint">${t("window.settings.data.folder")} <code class="where-p18">${esc(data.folder)}</code></p>` : "";
  return `${head}${lock}
    <div class="sec"><h2>${t("window.settings.data.kept")}</h2><div class="rows">${keptRows()}</div>${folder}</div>
    <div class="sec"><h2>${t("window.settings.data.leaves")}</h2><div class="rows">${leaveRows()}</div></div>
    <div class="sec"><h2>${t("window.settings.data.take")}</h2>${exportRow()}${deleteRow()}</div>`;
}

/* ---------- Export: the bar moves only as the engine writes each part ---------- */
async function poll() {
  if (polling) return;
  polling = true;
  try {
    while (job && !job.ready && !job.error) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      job = await api(`your-data/export/${encodeURIComponent(job.id)}`);
      render();
    }
  } catch (error) { toast(error.message); job = null; render(); } finally { polling = false; }
}
async function startExport() {
  if (dialog()) closeDlg(); // from the delete dialog: the bar is on the page
  try { job = await api("your-data/export", {}); } catch (error) { toast(error.message); return; }
  render();
  poll();
}
async function download() {
  if (!job?.ready) return;
  try {
    const auth = token.get();
    const response = await fetch(`/api/your-data/export/${encodeURIComponent(job.id)}/file`, { cache: "no-store", headers: auth ? { authorization: "Bearer " + auth } : {} });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || String(response.status));
    const name = /filename="([^"]+)"/.exec(response.headers.get("content-disposition") ?? "")?.[1] ?? "branch-your-data.zip";
    const url = URL.createObjectURL(await response.blob());
    Object.assign(document.createElement("a"), { href: url, download: name }).click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (error) { toast(error.message); }
}

/* ---------- Delete everything: export first, then type the engine's phrase ---------- */
function deleteDialog() {
  const phrase = data?.deletePhrase ?? "";
  return openDlg({ title: t("window.settings.data.delete-title"),
    body: `<p class="lead-b17">${t(data?.owner ? "window.settings.data.delete-warn-owner" : "window.settings.data.delete-warn-person")}</p>
      <div class="ctl"><b>${t("window.settings.data.export-first")}</b><span class="right"><button class="btn sm" type="button" data-act="data-export">${t("window.settings.data.export-go")}</button></span><small>${t("window.settings.data.export-sub")}</small></div>
      <label class="fld"><span>${t("window.settings.data.type", { phrase: esc(phrase) })}</span><input class="inp" id="data-del-in" autocomplete="off" spellcheck="false"></label>`,
    foot: `<button class="btn ghost" type="button" data-act="dlg-close">${t("window.settings.data.cancel")}</button><button class="btn bad" type="button" data-act="data-del-go">${t("window.settings.data.delete-go")}</button>` });
}
async function deleteGo() {
  const box = dialog();
  const confirm = $("#data-del-in")?.value ?? "";
  try {
    const done = await api("your-data/delete", { confirm });
    if (dialog() === box) closeDlg();
    toast(t("window.settings.data.deleted", { conversations: done.deleted.conversations, memory: done.deleted.memory }));
  } catch (error) { toast(error.message); return; }
  job = null;
  await loadData();
}

export function init() {
  on("data-export", () => startExport());
  on("data-dl", () => download());
  on("data-del", () => deleteDialog());
  on("data-del-go", () => deleteGo());
  markLive(["data-export", "data-dl", "data-del", "data-del-go", "sw:data-del-in"]);
  loadData();
}

export async function load() { await loadData(); }

export const live = { "data-export": true, "data-dl": true, "data-del": true, "data-del-go": true, "sw:data-del-in": true };
