/* A file a task changed or made, opened from the side panel's Files list (chat/pane.js), 1:1 with the prototype's
   dialog: its path as the title and the change itself. The change is the engine's own line diff, kept with the task
   (GET /api/state runs[].changes, from each "file.changed" event). Putting the earlier version back, editing and
   opening it in its own app are drawn and stay greyed. */

import { esc } from "../core/dom.js";
import { S, E } from "../core/state.js";
import { openDlg } from "../core/ui.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { t } from "../../i18n.js";

/* The change the Files list shows for that path: this conversation's tasks first, as the list reads them. */
function changeOf(path) {
  const runs = E.state?.runs ?? [];
  const mine = runs.filter((r) => r.sessionId === S.chat).flatMap((r) => r.changes ?? []);
  return mine.find((f) => f.path === path) ?? runs.flatMap((r) => r.changes ?? []).find((f) => f.path === path);
}

function openFile(path) {
  const change = changeOf(path);
  if (!change) return;
  const lines = String(change.diff ?? "").split("\n").map((l) => `<div class="${l[0] === "+" ? "add" : l[0] === "-" ? "del" : ""}">${esc(l)}</div>`).join("");
  const foot = `${change.existed ? `<button class="btn" type="button" data-act="file-putback">${t("window.shell.fileview.put-back-the-earlier-version")}</button>` : `<button class="btn" type="button" data-act="file-edit">${t("prompts.action.edit")}</button>`}<button class="btn pri" type="button" data-act="file-app">${t("ov.open")}</button>`;
  openDlg({ title: path, wide: true, body: `<div class="diff">${lines}</div>`, foot });
}

export function initFileView() {
  markLive(["fileopen"]);
  on("fileopen", (el) => openFile(el.dataset.n));
}
