/* TRUNK-122: failed schedule turns may have no Run at all. Read the durable schedule
   history already supplied by owner /api/state, rather than guessing from recent runs.
   No scheduler action or raw engine/script error is sent through these notices. */
import { E, S, ownerHere } from "../core/state.js";
import { esc, renderNow } from "../core/dom.js";
import { av, ic } from "../core/ui.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { t, language } from "../../i18n.js";

function failures() {
  if (!ownerHere() || !S.signedIn || document.getElementById("app")?.classList.contains("locked-b17")) return [];
  return (Array.isArray(E.state?.schedules) ? E.state.schedules : []).flatMap((schedule) => {
    const history = Array.isArray(schedule.data?.history) ? schedule.data.history : [];
    const latest = history.at(-1);
    // A running, successful, quiet or waiting turn supersedes the old failure.
    if (!latest || latest.status !== "failed" || !latest.finishedAt) return [];
    return [{ schedule, latest }];
  }).sort((a, b) => String(b.latest.finishedAt).localeCompare(String(a.latest.finishedAt)));
}

function row({ schedule, latest }) {
  const trunkId = schedule.routine?.trunkId ?? schedule.data?.startedBy;
  const trunk = (Array.isArray(E.trunks) ? E.trunks : []).find((one) => one.id === trunkId || one.name === trunkId);
  const name = schedule.routine?.name ?? String(schedule.data?.prompt ?? "").split("\n")[0].slice(0, 80);
  const date = new Date(latest.finishedAt);
  const when = Number.isNaN(date.getTime()) ? "" : date.toLocaleString(language(), { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const who = trunk?.name ?? E.state?.identity?.name ?? "";
  const run = (E.state?.runs ?? []).find((one) => one.id === latest.runId);
  const open = run?.sessionId ? `<button class="btn sm ghost" type="button" data-act="chat" data-id="${esc(run.sessionId)}">${t("ov.open")}</button>` : "";
  return `<div class="prow" role="status">${trunk ? av(trunk, 34) : `<span class="ico-tile">${ic("clock", "s")}</span>`}<span class="grow"><b>${esc(name)}</b><small>${esc([t("window.chat.agent.snag"), who, when].filter(Boolean).join(" · "))}</small></span>${open}<button class="btn sm" type="button" data-act="inbox-schedules-open">${t("place.automations.scheduled")}</button></div>`;
}

export function scheduleFailureSection() {
  const rows = failures();
  if (!rows.length) return "";
  return `<div class="tile"><div class="th"><b>${t("place.automations.scheduled")} · ${t("window.chat.agent.snag")}</b></div><div class="rows">${rows.slice(0, 20).map(row).join("")}</div></div>`;
}

export function initScheduleFailures() {
  markLive(["inbox-schedules-open"]);
  on("inbox-schedules-open", () => {
    if (!ownerHere() || !S.signedIn || document.getElementById("app")?.classList.contains("locked-b17")) return;
    S.view = "automations";
    S.tabs.automations = "scheduled";
    renderNow();
  });
}
