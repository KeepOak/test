/* A file a task changed, made or only read, opened from the side panel's Files list (chat/pane.js), 1:1 with the
   prototype's fileOpen dialog: its path as the title, who touched it and when, and what it holds.
   - Changed: "Changed by <who> today at <time>. A checkpoint was kept first." and the engine's own line diff, kept with the
     task (GET /api/state runs[].changes, from each "file.changed" event). The time is when the engine kept the version
     from before the change (GET /api/history/files?path=, that version's createdAt); "today at" only when it is today.
     "Put back the earlier version" writes that kept version back (POST /api/history/restore {versionId}), the owner's
     alone in the engine, which says so to anyone else.
   - Made: "Made by <who> today." and the file as the task wrote it: the added lines of its diff (a file that did not
     exist before is all added lines).
   - Read: "Read only. <who> read this file and didn't change it." (GET /api/panels/work files.read).
   Edit and Open (in the file's own app) are drawn and stay greyed: the engine has no route for either. */

import { esc } from "../core/dom.js";
import { S, E, refresh, ownName } from "../core/state.js";
import { openDlg, closeDlg, toast } from "../core/ui.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { t, language } from "../../i18n.js";

/* The change the Files list shows for that path: this conversation's tasks first, as the list reads them. */
function changeOf(path) {
  const runs = E.state?.runs ?? [];
  const mine = runs.filter((r) => r.sessionId === S.chat).flatMap((r) => r.changes ?? []);
  return mine.find((f) => f.path === path) ?? runs.flatMap((r) => r.changes ?? []).find((f) => f.path === path);
}
const who = () => ownName(S.chat) || E.state?.identity?.name || "";
const clock = (d) => d.toLocaleTimeString(language(), { hour: "numeric", minute: "2-digit" });
const today = (d) => d.toDateString() === new Date().toDateString();

/* When the engine kept the version from before the change; null when it kept none or does not say. */
async function keptAt(change) {
  if (!change?.versionId) return null;
  try {
    const { versions } = await api(`history/files?path=${encodeURIComponent(change.path)}`);
    const at = new Date(versions.find((v) => v.id === change.versionId)?.createdAt ?? "");
    return Number.isNaN(at.getTime()) ? null : at;
  } catch (error) { toast(error.message); return null; }
}

function whoLine(kind, at, kept) {
  const name = who();
  const line = kind === "changed" ? (at && today(at) ? t("window.shell.fileview.changed-today", { name, time: clock(at) }) : t("window.shell.fileview.changed-by", { name }))
    : at && today(at) ? t("window.shell.fileview.made-today", { name }) : t("window.shell.fileview.made-by", { name });
  return `<p data-css="margin:0">${esc(line)}${kept ? ` ${esc(t("window.shell.fileview.checkpoint-kept"))}` : ""}</p>`;
}
const diffLines = (change) => String(change.diff ?? "").split("\n").map((l) => `<div class="${l[0] === "+" ? "add" : l[0] === "-" ? "del" : ""}">${esc(l)}</div>`).join("");
const madeText = (change) => String(change.diff ?? "").split("\n").filter((l) => l[0] === "+").map((l) => l.slice(1)).join("\n");

async function openFile(path, st) {
  const open = (body, foot, wide = true) => openDlg({ title: path, wide, body, foot: `${foot}<button class="btn pri" type="button" data-act="file-app">${t("ov.open")}</button>` });
  if (st === "read") return open(`<p data-css="margin:0">${esc(t("window.shell.fileview.read-only", { name: who() }))}</p>`, "", false);
  const change = changeOf(path);
  if (!change) return;
  const at = await keptAt(change);
  if (change.existed) {
    const back = change.versionId ? `<button class="btn" type="button" data-act="file-putback" data-v="${esc(change.versionId)}" data-t="${at ? esc(clock(at)) : ""}">${t("window.shell.fileview.put-back-the-earlier-version")}</button>` : "";
    return open(`${whoLine("changed", at, !!change.versionId)}<div class="diff">${diffLines(change)}</div>`, back);
  }
  open(`${whoLine("made", at, false)}<pre class="made-b2">${esc(madeText(change))}</pre>`, `<button class="btn" type="button" data-act="file-edit">${t("prompts.action.edit")}</button>`);
}

/* Writes the kept version back; the engine's answer says whether it did. */
async function putBack(el) {
  let done;
  try { done = await api("history/restore", { versionId: el.dataset.v }); } catch (error) { toast(error.message); return; }
  closeDlg();
  if (done?.restored) toast(el.dataset.t ? t("window.shell.fileview.put-back-as", { time: el.dataset.t }) : t("window.shell.fileview.put-back"));
  await refresh().catch((error) => toast(error.message));
}

export function initFileView() {
  markLive(["fileopen", "file-putback"]);
  on("fileopen", (el) => openFile(el.dataset.n, el.dataset.st));
  on("file-putback", (el) => putBack(el));
}
