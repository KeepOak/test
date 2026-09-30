import { esc } from "../core/dom.js";
import { selectField } from "../core/gsel.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { dialog, openDlg, closeDlg, toast } from "../core/ui.js";
import { t } from "../../i18n.js";

let changes = [], review = null;
export async function readSourceMerges() {
  const fresh = (await api("self-development/merge").catch(() => ({ changes: [] }))).changes ?? [];
  const changed = JSON.stringify(changes) !== JSON.stringify(fresh);
  changes = fresh;
  return changed;
}
export function sourceMergeCards() {
  return changes.map((change) => `<section class="card"><b>${t("selfMerge.title")}</b><p>${esc(change.worktree)}</p><p class="hint">${change.evidence ? t("selfMerge.tested", { count: change.evidence.passed }) : t("selfMerge.testFirst")}</p><button class="btn" type="button" data-act="self-merge-open" data-worktree="${esc(change.worktree)}">${t("selfMerge.open")}</button></section>`).join("");
}
function choose(el) {
  const change = changes.find((row) => row.worktree === el.dataset.worktree);
  if (!change) return;
  review = null;
  openDlg({ title: t("selfMerge.title"), body: `<p>${t("selfMerge.explain")}</p><p><code>${esc(change.worktree)}</code></p><label>${t("selfMerge.repository")}${selectField({ id: "self-merge-repo", label: t("selfMerge.repository"), options: change.repositories.map((repo) => [repo, repo]) })}</label><label>${t("selfMerge.number")}<input id="self-merge-number" type="number" min="1" step="1"></label>`,
    foot: `<button class="btn" type="button" data-act="self-merge-runner">${t("selfMerge.runner")}</button><button class="btn pri" type="button" data-act="self-merge-read" data-worktree="${esc(change.worktree)}">${t("selfMerge.read")}</button>` });
}
function diffHtml(diff) {
  return diff.files.map((file) => `<div class="diff15"><b>${esc(file.path)}</b><pre>${file.lines.map((line) => esc(`${line.m} ${line.t}`)).join("\n")}</pre></div>`).join("");
}
function showReview(approved = false) {
  if (!review) return;
  const gh = review.github;
  const scope = review.scope ? `<p><b>${t("selfMerge.scope")}</b></p><pre>${esc(review.scope.allowedPaths.join("\n"))}</pre><p>${esc(review.scope.sideEffects.join("; "))}</p>` : "";
  openDlg({ title: t("selfMerge.title"), wide: true,
    body: `<p>${esc(review.definition)}</p><p><b>${esc(gh.repo)} #${gh.number}</b></p><p>${t("selfMerge.head")} <code>${esc(gh.headSha)}</code></p><p>${t("selfMerge.base")} <code>${esc(gh.base)} ${esc(gh.baseSha)}</code></p>${scope}<p>${t("selfMerge.tested", { count: review.tests.passed })}</p><pre>${esc(review.tests.command.join(" "))}</pre><p>${t("selfMerge.required")}</p><ul>${gh.required.map((check) => `<li>${esc(check.context)}${check.appId === null ? "" : ` (GitHub App ${check.appId})`}</li>`).join("")}</ul>${diffHtml(review.diff)}<p><b>${t("selfMerge.rollback")}</b> ${esc(review.rollback)}</p><p class="hint">${t(approved ? "selfMerge.approved" : "selfMerge.confirm")}</p>`,
    foot: `<button class="btn pri" type="button" data-act="${approved ? "self-merge-finish" : "self-merge-approve"}">${t(approved ? "selfMerge.merge" : "selfMerge.approve")}</button>` });
}
async function read(el) {
  const number = Number(dialog()?.querySelector("#self-merge-number")?.value);
  const repo = dialog()?.querySelector("#self-merge-repo")?.value;
  if (!Number.isSafeInteger(number) || number < 1 || !repo) { toast(t("selfMerge.needNumber")); return; }
  el.disabled = true;
  try { review = await api("self-development/merge/review", { worktree: el.dataset.worktree, repo, number }); showReview(); }
  catch (error) { el.disabled = false; toast(error.message); }
}
async function approve(el) {
  if (!review) return;
  el.disabled = true;
  try { await api("self-development/merge/approve", { id: review.id }); showReview(true); }
  catch (error) { review = null; closeDlg(); toast(error.message); }
}
async function finish(el) {
  if (!review) return;
  el.disabled = true;
  try { const merged = await api("self-development/merge/finish", { id: review.id }); review = null; closeDlg(); toast(t("selfMerge.done", { sha: merged.sha })); }
  catch (error) { review = null; closeDlg(); toast(error.message); }
}
async function runner(el) {
  el.disabled = true;
  try { const result = await api("self-development/merge/runner"); toast([result.problem || t("selfMerge.runnerReady"), result.note || ""].filter(Boolean).join(" ")); }
  catch (error) { toast(error.message); }
  finally { el.disabled = false; }
}
on("self-merge-open", choose); on("self-merge-read", read); on("self-merge-approve", approve); on("self-merge-finish", finish);
on("self-merge-runner", runner);
markLive(["self-merge-open", "self-merge-read", "self-merge-approve", "self-merge-finish", "self-merge-runner", "sw:self-merge-repo", "sw:self-merge-number"]);
