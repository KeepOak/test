/* Each item opens its existing review conversation; this view gives no standing or bulk yes. */
import { esc } from "../core/dom.js";
import { openDlg, closeDlg, dialog } from "../core/ui.js";
import { E, activeId, ownerHere } from "../core/state.js";
import { api } from "../core/api.js";
import { on, run } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { t } from "../../i18n.js";
import { say } from "../core/words.js";

let opened = null;
const current = (view) => opened === view && ownerHere() && activeId() === view.owner && dialog() === view.dialog
  && E.trunks.some((trunk) => trunk.id === view.id);
const line = (text) => String(text ?? "").split("\n")[0].slice(0, 200);
const row = (text, note, sessionId) => `<div class="prow"><span class="grow"><b>${esc(line(text))}</b><small>${esc(line(note))}</small></span>${sessionId ? `<button class="btn sm" type="button" data-act="trunk-inbox-open" data-id="${esc(sessionId)}">${t("ov.open")}</button>` : ""}</div>`;
const section = (title, rows) => rows.length ? `<h2>${esc(say(title))} (${rows.length})</h2><div class="rows">${rows.join("")}</div>` : "";
const trunkName = (id) => E.trunks.find((trunk) => trunk.id === id)?.name ?? say("A Trunk");

function draw(view, data = null, error = "") {
  let body = error ? `<p role="alert">${esc(error)}</p>` : `<p>${esc(say("Reading this Trunk's Inbox…"))}</p>`;
  if (data) {
    body = section("Needs your review", data.asks.map((q) => row(q.question || q.label, q.label, q.sessionId)))
      + section("Trunk messages waiting", data.messages.map((m) => row(m.message, `${trunkName(m.from)} → ${trunkName(m.to)}`, m.sessionId)))
      + section("Handed over", data.deferred.map((job) => row(job.description, say("Waiting for a result or a step by hand"), job.sessionId)))
      + section("Recent task history", data.runs.map((task) => row(task.title || task.prompt, task.status.replaceAll("_", " "), task.sessionId)));
    body = (body || `<p>${esc(say("Nothing is listed for this Trunk in the recent Inbox records."))}</p>`)
      + `<p class="hint">${esc(say("This view reads the owner's 100 newest tasks and up to 100 waiting questions, handed-over jobs and Trunk messages. Older work, tasks with no recorded Trunk and system requests remain in the full Inbox. Items open their usual review conversation."))}</p>`;
    if (data.limits.historyCapped || data.limits.queuesCapped) body += `<p class="hint">${esc(say("More records may be outside this view's limits."))}</p>`;
  }
  openDlg({ title: `${view.name} · ${t("place.inbox")}`, wide: true, body,
    foot: `<button class="btn ghost" type="button" data-act="trunk-inbox-reload">${esc(say("Refresh"))}</button><button class="btn" type="button" data-act="trunk-inbox-full" data-v="inbox">${esc(say("Full Inbox"))}</button><button class="btn pri" type="button" data-act="dlg-close">${t("first-run-steps.done")}</button>` });
  view.dialog = dialog();
}

async function read(view) {
  const generation = view.generation = (view.generation ?? 0) + 1;
  try {
    const data = await api(`trunks/${encodeURIComponent(view.id)}/inbox`);
    if (!current(view) || view.generation !== generation) return;
    view.name = data.trunk.name;
    draw(view, data);
  } catch (error) { if (current(view) && view.generation === generation) draw(view, null, error.message); }
}

function open(id) {
  const trunk = ownerHere() && E.trunks.find((item) => item.id === id);
  if (!trunk) return;
  opened = { id, name: trunk.name, owner: activeId(), dialog: null };
  draw(opened);
  read(opened);
}

export function initTrunkInbox() {
  markLive(["trunk-inbox", "trunk-inbox-open", "trunk-inbox-reload", "trunk-inbox-full"]);
  on("trunk-inbox", (button) => open(button.dataset.id));
  on("trunk-inbox-reload", () => { if (opened && current(opened)) read(opened); });
  on("trunk-inbox-open", (button) => {
    if (!opened || !current(opened)) return;
    closeDlg();
    opened = null;
    run("chat", button);
  });
  on("trunk-inbox-full", (button) => {
    if (!opened || !current(opened)) return;
    closeDlg();
    opened = null;
    run("view", button);
  });
}
