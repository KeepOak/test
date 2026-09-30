/* Each autonomy question is answered by its immutable ledger id. It never participates in Allow all. */
import { esc, renderNow } from "../core/dom.js";
import { E, refresh } from "../core/state.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { openDlg, closeDlg, toast, ic } from "../core/ui.js";
import { prowOpen } from "../chat/unread.js";
import { t } from "../../i18n.js";

let entries = [];
let reviewing = null;
let sending = false;
export const autonomyCount = () => E.profiles?.active?.id ? 0 : entries.length;
export function autonomyRows() {
  if (E.profiles?.active?.id) return "";
  return entries.map((entry) => `${prowOpen(`autonomy:${entry.id}`, entry.createdAt)}<span class="ico-tile">${ic("flow", "s")}</span><span class="grow"><b>${esc(entry.title)}</b><small>${esc(entry.detail)}</small></span><button class="btn sm" type="button" data-act="autonomy-review" data-id="${esc(entry.id)}">${t("window.places.inbox.review")}</button></div>`).join("");
}
export async function readAutonomy() {
  const fresh = E.profiles?.active?.id ? [] : (await api("autonomy/ledger")).entries ?? [];
  const changed = JSON.stringify(fresh) !== JSON.stringify(entries);
  entries = fresh;
  return changed;
}

function scopeText(entry) {
  const procedure = entry.payload?.scope?.procedure;
  if (!procedure) return "";
  const step = entry.kind === "step" ? Number(entry.payload.step) : null;
  const steps = step === null ? procedure.steps : procedure.steps.slice(step, step + 1);
  const list = steps.map((item) => `<li><b>${esc(item.title)}</b><pre>${esc(stepWords(item))}</pre></li>`).join("");
  const reach = procedure.permissions?.length ? procedure.permissions.join(", ") : t("inbox.autonomy.held");
  const coverage = t(step === null && procedure.level === "ask-to-start" ? "inbox.autonomy.start-coverage" : "inbox.autonomy.step-coverage");
  return `<p>${esc(coverage)}</p><ol>${list}</ol><p>${t("inbox.autonomy.reach", { reach: esc(reach), count: esc(procedure.perDay) })}</p>`;
}

function stepWords(item) {
  const lines = [item.prompt || ""];
  for (const field of ["contains", "yes", "no", "times", "until", "minutes", "flowId", "version"])
    if (item[field] !== undefined) lines.push(`${t(`inbox.autonomy.${field}`)}: ${item[field]}`);
  if (item.at) lines.push(`${t("inbox.autonomy.when")}: ${Object.entries(item.at).map(([key, value]) => `${key}: ${value}`).join(", ")}`);
  if (item.kind === "fan") lines.push(t("inbox.autonomy.fan"));
  return lines.filter(Boolean).join("\n");
}

async function review(id) {
  try { await readAutonomy(); } catch (error) { toast(error.message); return; }
  const entry = entries.find((item) => item.id === id);
  if (!entry) { toast(t("inbox.autonomy.gone")); renderNow(); return; }
  reviewing = { id: entry.id, fingerprint: entry.fingerprint };
  openDlg({ title: entry.title, wide: true, body: `<pre>${esc(entry.detail)}</pre>${scopeText(entry)}`,
    foot: `<button class="btn ghost" type="button" data-act="autonomy-answer" data-v="no">${t("window.places.inbox.dont")}</button><button class="btn pri" type="button" data-act="autonomy-answer" data-v="yes">${t("trunks.room.allow")}</button>` });
}

async function answer(el) {
  const picked = reviewing;
  if (!picked || sending || el.disabled) return;
  sending = true;
  el.disabled = true;
  try {
    await readAutonomy();
    if (!entries.some((entry) => entry.id === picked.id && entry.fingerprint === picked.fingerprint)) throw new Error(t("inbox.autonomy.gone"));
    await api("autonomy/decide", { id: picked.id, yes: el.dataset.v === "yes" });
    reviewing = null;
    closeDlg();
  } catch (error) { toast(error.message); el.disabled = false; }
  sending = false;
  await readAutonomy().catch(() => { entries = []; });
  await refresh().catch((error) => toast(error.message));
  renderNow();
}
export function initAutonomyInbox() {
  markLive(["autonomy-review", "autonomy-answer"]);
  on("autonomy-review", (el) => review(el.dataset.id));
  on("autonomy-answer", (el) => answer(el));
}
