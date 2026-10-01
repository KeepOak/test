/* The owner writes preparation terms, then separately reviews the exact committed
   source before consenting to the engine's durable draft-publication request. */
import { esc } from "../core/dom.js";
import { S, ownerHere, activeId } from "../core/state.js";
import { api } from "../core/api.js";
import { openDlg, closeDlg, dialog, toast } from "../core/ui.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { t } from "../../i18n.js";

let current = null, generation = 0, reread = async () => {};
const here = () => JSON.stringify([activeId(), ownerHere(), document.getElementById("app")?.classList.contains("locked-b17")]);
const allowed = () => ownerHere() && !document.getElementById("app")?.classList.contains("locked-b17");
const words = (key) => esc(t(`window.sourceReview.${key}`));
const route = (id, action) => `self-development/requests/${encodeURIComponent(id)}/${action}`;
const button = (id, action, label) => `<button class="btn pri" type="button" data-act="selfdo15" data-v="${action}" data-id="${esc(id)}">${words(label)}</button>`;
const lines = (value) => String(value ?? "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

function field(name, label, options = {}) {
  const { multiline = false, required = true, max = 2000, pattern = "", type = "text" } = options;
  const attrs = `id="source-${name}" name="${name}" class="inp" maxlength="${max}"${required ? " required" : ""}${pattern ? ` pattern="${pattern}"` : ""}`;
  return `<label class="ctl" for="source-${name}"><b>${words(label)}</b>${multiline ? `<textarea ${attrs} rows="3"></textarea>` : `<input ${attrs} type="${type}">`}</label>`;
}

function termsForm(id) {
  return `<form id="source-prepare" data-source-review="${esc(id)}"><p class="hint">${words("preparationOnly")}</p>
    ${field("name", "name", { max: 24, pattern: "[a-z0-9][a-z0-9-]{0,23}" })}
    ${field("repository", "repositoryOptional", { required: false, type: "url", max: 2000 })}
    ${field("base", "baseOptional", { required: false, max: 200 })}
    ${field("allowedPaths", "allowedPaths", { multiline: true, max: 10000 })}
    ${field("permissions", "permissions", { multiline: true, max: 5000 })}
    ${field("expectedTests", "expectedTests", { multiline: true, max: 9000 })}
    ${field("definitionOfDone", "definitionOfDone", { multiline: true })}
    ${field("sideEffects", "sideEffects", { multiline: true, required: false, max: 9000 })}
    ${field("rollbackPlan", "rollbackPlan", { multiline: true })}</form>`;
}

function prepareInput(form) {
  const values = Object.fromEntries(new FormData(form));
  const { name, repository, base, ...terms } = values;
  return { name: String(name).trim(), ...(repository.trim() ? { repository: repository.trim() } : {}),
    ...(base.trim() ? { base: base.trim() } : {}), contract: {
      allowedPaths: lines(terms.allowedPaths), permissions: lines(terms.permissions), expectedTests: lines(terms.expectedTests),
      definitionOfDone: terms.definitionOfDone.trim(), sideEffects: lines(terms.sideEffects), rollbackPlan: terms.rollbackPlan.trim(),
    } };
}

function publicationForm(id, snapshot) {
  const { review, contract } = snapshot;
  const labels = ["revision", "sourceSha", "head", "repository", "base", "branch"];
  const metadata = labels.map((key) => `<dt>${words(key)}</dt><dd><code>${esc(String(review[key] ?? ""))}</code></dd>`).join("");
  const terms = ["allowedPaths", "permissions", "expectedTests", "definitionOfDone", "sideEffects", "rollbackPlan"]
    .map((key) => `<dt>${words(key)}</dt><dd><pre>${esc(Array.isArray(contract[key]) ? contract[key].join("\n") : String(contract[key] ?? ""))}</pre></dd>`).join("");
  return `<dl>${metadata}</dl><details><summary>${words("contract")}</summary><dl>${terms}</dl></details>
    <form id="source-publish" data-source-review="${esc(id)}">
    ${field("title", "title", { max: 200 })}${field("summary", "summary", { multiline: true, max: 8000 })}
    <label class="ctl" for="source-consent"><input type="checkbox" id="source-consent" name="consent" required> <b>${words("consent")}</b></label></form>`;
}

export async function openSourceReview(request, diffHTML, details = "") {
  if (!allowed()) return;
  /* The review opens only over what asked for it: the same person, unlocked, on the same page, with no dialog opened,
     closed or replaced while the draft and diff were read. A late answer is dropped instead of covering newer work. */
  const mine = ++generation, who = here(), view = S.view, opened = dialog();
  const still = () => mine === generation && who === here() && allowed() && S.view === view && dialog() === opened;
  current = null;
  let snapshot = null, diff = null, problem = "";
  try {
    if (request.status === "approved") {
      try { snapshot = await api(route(request.id, "draft")); diff = snapshot.diff; }
      catch (error) { problem = error.message; }
    }
    diff ??= await api(route(request.id, "diff"));
  } catch (error) { if (still()) toast(error.message); return; }
  if (!still()) return;
  const ready = request.status === "approved" && snapshot;
  current = { id: request.id, who, snapshot, mine };
  const form = ready ? publicationForm(request.id, snapshot) : request.status === "waiting" ? termsForm(request.id) : `<div data-source-review="${esc(request.id)}"><p class="hint">${words("notReady")}</p></div>`;
  const foot = ready ? button(request.id, "published", "publishDraft") : request.status === "waiting" ?
    `<button class="btn ghost" type="button" data-act="selfno15" data-id="${esc(request.id)}">${esc(t("flowsBoards.installs.decline"))}</button>${button(request.id, "editing", "prepare")}` :
    `<button class="btn" type="button" data-act="dlg-close">${esc(t("delight.ach.close"))}</button>`;
  openDlg({ title: t("window.places.inbox.a-change-to-branchs-own-code"), wide: true,
    body: `<p>${esc(request.text)}</p>${details}${problem ? `<p class="hint">${esc(problem)}</p>` : ""}${diffHTML(diff)}${form}`, foot });
  dialog()?.querySelector("form")?.addEventListener("submit", (event) => { event.preventDefault(); });
}

async function answer(el) {
  if (!["editing", "published"].includes(el.dataset.v)) return;
  const review = current, form = dialog()?.querySelector(el.dataset.v === "editing" ? "#source-prepare" : "#source-publish");
  if (!review || review.id !== el.dataset.id || review.who !== here() || !allowed() || form?.dataset.sourceReview !== review.id || !form.reportValidity()) return;
  const prepare = el.dataset.v === "editing";
  if (!prepare && (!review.snapshot || !form.elements.consent.checked)) return;
  const payload = prepare ? prepareInput(form) : { review: review.snapshot.review,
    title: form.elements.title.value.trim(), summary: form.elements.summary.value.trim(), consent: true };
  /* The engine records its answer whatever happens here. Its result or error is shown, the review closed and the Inbox
     read again only for this same review: its dialog still open with nothing closed or opened since, the same person on
     the same page, unlocked. */
  const opened = dialog(), mine = generation, view = S.view;
  const still = () => current === review && review.who === here() && allowed() && S.view === view && mine === generation
    && dialog() === opened && opened?.querySelector("[data-source-review]")?.dataset.sourceReview === review.id;
  el.disabled = true;
  let result;
  try { result = await api(route(review.id, prepare ? "approve" : "publish"), payload); }
  catch (error) { if (still()) { el.disabled = false; toast(error.message); } return; }
  if (!still()) return;
  closeDlg();
  current = null;
  toast(prepare ? t("window.sourceReview.prepared") : result.publication?.reason ?? t(`sourcePublication.${result.publication?.state ?? "checked"}`));
  await reread(!prepare);
}

/* Every field both forms draw is read by prepareInput or answer, so each is live (core/features.js greys the rest). */
const fields = ["name", "repository", "base", "allowedPaths", "permissions", "expectedTests", "definitionOfDone", "sideEffects",
  "rollbackPlan", "title", "summary", "consent"];

export function initSourceReview(afterChange) {
  reread = afterChange;
  markLive(["selfdo15", ...fields.map((name) => `sw:source-${name}`)]);
  on("selfdo15", (el) => answer(el));
  addEventListener("pagehide", () => { current = null; generation += 1; });
  /* Closing any dialog (its close button, or Escape, which main.js turns into a close) is newer owner activity: a review
     still being read must not open after it. */
  document.addEventListener("click", (e) => { if (e.target.closest?.('[data-act="dlg-close"]')) generation += 1; }, true);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && dialog()) generation += 1; }, true);
}
