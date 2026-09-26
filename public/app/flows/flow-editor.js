/* A procedure as a picture (the prototype's flow editor), opened from Automations › Procedures. Two kinds of record open
   here, and only one can change:
   - A procedure that starts itself (GET /api/autonomy/procedures): its start and its steps, each a request to a Trunk
     ("Ask a Trunk") or one that asks the owner first ("Ask me"). Adding, moving and taking out steps is a draft in the
     window; Save opens the prototype's "Change …?" with the difference, and "Approve version N" is the same owner's yes a
     new procedure gets: the change is asked (POST /api/autonomy/procedures/<id>/propose) and answered
     (POST /api/autonomy/decide). It stays the same procedure; the version before is kept in its history, and "Go back to
     this" is itself such a change. "If it says", "When" and "Wait" steps have no engine form, so they stay greyed.
     Run starts the version in use (POST /api/autonomy/procedures/<id>/run).
   - A saved recipe (GET /api/state `procedures`: tool calls with exact expected results): its steps can be moved or
     taken out, and saved as a new version to verify (POST /api/recipes/<id>/steps), as the section below says. */

import { esc, paint } from "../core/dom.js";
import { openDlg, closeDlg, dialog, ic, toast } from "../core/ui.js";
import { E, refresh } from "../core/state.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { api } from "../core/api.js";
import { t, language } from "../../i18n.js";

const KINDS = [["when", "window.flows.flow.when"], ["do", "window.flows.flow.ask-trunk"], ["if", "window.flows.flow.if"], ["ask", "window.flows.flow.ask-me"], ["wait", "window.flows.flow.wait"]];
const EDITABLE = new Set(["do", "ask"]);
let F = null; // the open procedure: { record, steps: [{ kind, text, orig }] }

/* The prototype's picture: one box per step, joined top to bottom; a start is the accented "When" box. */
function flowSVG(boxes) {
  const W = 560, cx = W / 2, bh = 38, gap = 24, parts = [];
  let y = 10;
  const cut = (s, w) => { const n = Math.floor(w / 7.2); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
  boxes.forEach((b, i) => {
    const text = b.text || "…";
    const label = b.kind === "when" ? t("window.flows.flow.when-text", { text }) : b.kind === "ask" ? t("window.flows.flow.ask-text", { text }) : text;
    parts.push(`<rect x="${cx - 160}" y="${y}" width="320" height="${bh}" rx="10" fill="${b.kind === "ask" ? "var(--accent-tint)" : "var(--raise)"}" stroke="${b.kind === "when" ? "var(--accent)" : "var(--line-2)"}" stroke-width="1.5"/><text x="${cx}" y="${y + bh / 2 + 4}" text-anchor="middle">${esc(cut(label, 304))}</text>`);
    y += bh;
    if (i < boxes.length - 1) { parts.push(`<path d="M${cx} ${y} C ${cx} ${y + gap / 2}, ${cx} ${y + gap / 2}, ${cx} ${y + gap}" stroke="var(--ink-3)" stroke-width="1.5" fill="none" marker-end="url(#fa)"/>`); y += gap; }
  });
  return `<svg class="flow-svg" viewBox="0 0 ${W} ${y + 10}" role="img" aria-label="${t("window.flows.flow.picture")}"><defs><marker id="fa" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="var(--ink-3)"/></marker></defs>${parts.join("")}</svg>`;
}

/* ---------- a saved recipe: its steps moved or taken out ---------- */

/* A recipe's steps are exact tool calls with the results they must give, so the window only rearranges them: Move up,
   Move down and Remove are a draft, and Save shows the same "Change …?" difference; the yes is POST
   /api/recipes/<id>/steps {order}, which keeps only steps the recipe already has (by their place in the version in use)
   and saves a new version the engine marks proposed, to be verified again before it replays. A step cannot be written
   here (it needs a real call and its expected result) and a recipe is not run from here (a replay calls its tools
   directly, outside the approval path), so the recipe dialog draws neither. */
const argsText = (args) => { const text = JSON.stringify(args ?? {}); return text === "{}" ? "" : text.length > 160 ? text.slice(0, 159) + "…" : text; };
const recipeDraft = (record) => (Array.isArray(record.data?.definition?.steps) ? record.data.definition.steps : [])
  .map((s, place) => ({ kind: "do", text: [s.tool, argsText(s.args)].filter(Boolean).join(" "), place }));
function openRecipe(id) {
  const record = (E.state?.procedures ?? []).find((p) => p.id === id);
  if (!record) return;
  F = { kind: "recipe", record, steps: recipeDraft(record) };
  drawFlow();
}
function drawRecipe() {
  const n = F.steps.length;
  const rows = F.steps.map((s, j) => `<div class="flow-row"><input class="inp" id="ft-${j}" value="${esc(s.text)}" readonly aria-label="${t("window.flows.flow.step-n", { n: j + 1 })}">
    <span class="acts" data-css="gap:0"><button class="btn ghost sm" type="button" data-act="flow-mv" data-j="${j}" data-d="-1" ${j === 0 ? "disabled" : ""}>${t("accounts.action.up")}</button><button class="btn ghost sm" type="button" data-act="flow-mv" data-j="${j}" data-d="1" ${j === n - 1 ? "disabled" : ""}>${t("accounts.action.down")}</button><button class="btn ghost sm" type="button" data-act="flow-rm" data-j="${j}" ${n === 1 ? "disabled" : ""}>${t("editor.remove")}</button></span></div>`).join("");
  openDlg({ title: nameOf(), wide: true,
    body: `<div id="flow-pic">${flowSVG(F.steps.map((s) => ({ kind: "do", text: s.text.split(" ")[0] })))}</div><div>${rows}</div><div class="acts"><span class="tb-grow"></span><button class="btn pri" type="button" data-act="flow-save">${t("action.save")}</button></div>` });
}
const nameOf = () => (F.kind === "recipe" ? String(F.record.data?.definition?.name ?? "") : F.record.procedure.name);
const versionOf = () => (F.kind === "recipe" ? F.record.data?.version : F.record.version) ?? 1;
const baseDraft = () => (F.kind === "recipe" ? recipeDraft(F.record) : draftOf(F.record.procedure.steps));

/* ---------- a procedure that starts itself: a draft, then a proposal ---------- */

const draftOf = (steps) => steps.map((s) => ({ kind: s.confirm ? "ask" : "do", text: s.prompt, orig: s }));
const stepText = (s) => (s.kind === "ask" ? t("window.flows.flow.ask-text", { text: s.text || "" }) : s.text || "");
const titleOf = (text) => { const line = text.trim().split("\n")[0]; return line.length > 60 ? line.slice(0, 59) + "…" : line; };
/* Unchanged steps keep their own title; a new or edited one is named by its first line. */
const engineSteps = (draft) => draft.map((s) => ({ title: s.orig && s.orig.prompt === s.text.trim() ? s.orig.title : titleOf(s.text), prompt: s.text.trim(), confirm: s.kind === "ask" }));

function flowRow(s, j, n) {
  const field = s.kind === "ask" ? t("window.flows.flow.question") : t("window.flows.flow.what-ask");
  const kinds = KINDS.map(([k, l]) => `<option value="${k}" ${s.kind === k ? "selected" : ""} ${EDITABLE.has(k) ? "" : "disabled"}>${t(l)}</option>`).join("");
  return `<div class="flow-row"><select class="inp" id="fk-${j}" data-flow="kind" data-j="${j}" aria-label="${t("window.flows.flow.kind-n", { n: j + 1 })}">${kinds}</select><input class="inp" id="ft-${j}" data-flow="text" data-j="${j}" value="${esc(s.text)}" placeholder="${field}" aria-label="${t("window.flows.flow.field-n", { field, n: j + 1 })}">
    <span class="acts" data-css="gap:0"><button class="btn ghost sm" type="button" data-act="flow-mv" data-j="${j}" data-d="-1" ${j === 0 ? "disabled" : ""}>${t("accounts.action.up")}</button><button class="btn ghost sm" type="button" data-act="flow-mv" data-j="${j}" data-d="1" ${j === n - 1 ? "disabled" : ""}>${t("accounts.action.down")}</button><button class="btn ghost sm" type="button" data-act="flow-rm" data-j="${j}">${t("editor.remove")}</button></span></div>`;
}
const pictureOf = () => flowSVG([{ kind: "when", text: F.record.starts }, ...F.steps]);

function historyList(r) {
  const versions = [{ version: r.version ?? 1, from: r.changedAt ?? r.createdAt, now: true }, ...(r.history ?? []).slice().reverse()];
  const when = (iso) => new Date(iso).toLocaleDateString(language(), { month: "short", day: "numeric" });
  return `<div class="fh17d"><b>${t("place.inbox.history")}</b><ol>${versions.map((x) => `<li><span class="grow"><b>${t("window.flows.flow.version-n", { n: x.version })}</b><small>${esc(when(x.from))}</small></span>${x.now ? `<span class="pill ok"><i></i>${t("window.flows.flow.in-use")}</span>` : `<button class="btn ghost sm" type="button" data-act="ppold17d" data-v="${x.version}">${t("window.flows.flow.go-back")}</button>`}</li>`).join("")}</ol></div>`;
}

function drawFlow() {
  if (F.kind === "recipe") return drawRecipe();
  const r = F.record;
  markLive(F.steps.flatMap((_, j) => [`sw:ft-${j}`, `sw:fk-${j}`]));
  openDlg({ title: r.procedure.name, wide: true,
    body: `<p class="hint" data-css="margin:0">${t("window.flows.flow.redraws", { starts: esc(r.starts) })}</p><div id="flow-pic">${pictureOf()}</div><div>${F.steps.map((s, j) => flowRow(s, j, F.steps.length)).join("")}</div><div class="acts"><button class="btn" type="button" data-act="flow-add">${ic("plus", "s")}${t("action.add-a-step")}</button><span class="tb-grow"></span><button class="btn" type="button" data-act="flow-run">${ic("play", "s")}${t("commands.dashboard.run")}</button><button class="btn pri" type="button" data-act="flow-save">${t("action.save")}</button></div>${historyList(r)}` });
}

async function openAuto(id) {
  let list;
  try { list = (await api("autonomy/procedures")).procedures ?? []; } catch (error) { toast(error.message); return; }
  const record = list.find((p) => p.id === id);
  if (!record) return;
  F = { kind: "auto", record, steps: draftOf(record.procedure.steps) };
  drawFlow();
}

/* The prototype's line difference: the longest run kept, the rest added or taken out. */
function diffSteps(a, b) {
  const A = a.map(stepText), B = b.map(stepText), L = Array.from({ length: A.length + 1 }, () => Array(B.length + 1).fill(0));
  for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < A.length || j < B.length) {
    if (i < A.length && j < B.length && A[i] === B[j]) { out.push(["same", A[i]]); i++; j++; }
    else if (j < B.length && (i >= A.length || L[i][j + 1] >= L[i + 1][j])) { out.push(["add", B[j]]); j++; }
    else { out.push(["rm", A[i]]); i++; }
  }
  return out;
}

let PP = null; // the change on show: { steps (engine form), start, v }
function propDlg(draft, why, start) {
  const cur = versionOf(), v = cur + 1, d = diffSteps(baseDraft(), draft);
  const add = d.filter((x) => x[0] === "add").length, rm = d.filter((x) => x[0] === "rm").length;
  PP = F.kind === "recipe" ? { order: draft.map((s) => s.place), v } : { steps: engineSteps(draft), start, v };
  openDlg({ title: t("window.flows.flow.change", { name: nameOf() }), wide: true,
    body: `<p data-css="margin:0 0 4px">${t("window.flows.flow.your-edit", { v, cur })}</p>${why ? `<p class="hint" data-css="margin:0 0 8px">${t("window.flows.flow.why", { why: esc(why) })}</p>` : ""}
    <div class="df-k17d">${add ? `<span class="add">${t("window.flows.flow.added", { n: add })}</span>` : ""}${rm ? `<span class="rm">${t("window.flows.flow.taken-out", { n: rm })}</span>` : ""}<span>${t("window.flows.flow.versions", { cur, v })}</span></div>
    <ol class="df17d">${d.map(([k, line]) => `<li class="${k}"><em>${k === "add" ? "+" : k === "rm" ? "−" : ""}</em><span>${esc(line)}</span></li>`).join("")}</ol>`,
    foot: `<button class="btn ghost" type="button" data-act="ppback17d">${t("window.flows.flow.back-editing")}</button><button class="btn pri" type="button" data-act="ppapprove17d" ${add + rm || start ? "" : "disabled"}>${t("window.flows.flow.approve-v", { v })}</button>` });
}

function save() {
  const bad = F.steps.findIndex((s) => !s.text.trim());
  if (bad >= 0) { const box = document.getElementById(`ft-${bad}`); box?.focus(); box?.setAttribute("aria-invalid", "true"); return; }
  if (JSON.stringify(F.steps.map(stepText)) === JSON.stringify(baseDraft().map(stepText))) { closeDlg(); return; }
  propDlg(F.steps);
}

/* The owner's yes: the change is asked the way any procedure change is, and answered at once. */
async function approve() {
  const { steps, start, v } = PP;
  try {
    if (F.kind === "recipe") await api(`recipes/${encodeURIComponent(F.record.id)}/steps`, { order: PP.order });
    else {
      const asked = await api(`autonomy/procedures/${encodeURIComponent(F.record.id)}/propose`, { steps, ...(start ? { start } : {}) });
      if (!asked.id) { toast(asked.said); return; }
      await api("autonomy/decide", { id: asked.id, yes: true });
    }
  } catch (error) { toast(error.message); return; }
  closeDlg();
  F = null;
  await refresh().catch((error) => toast(error.message));
  toast(t("window.flows.flow.approved", { v }));
}

/* Run starts the version in use (not the draft): POST /api/autonomy/procedures/<id>/run. A procedure that asks before it
   starts asks in the Inbox, and the engine says so in its own words. */
async function runNow() {
  const { id } = F.record, name = nameOf();
  let said;
  try { said = await api(`autonomy/procedures/${encodeURIComponent(id)}/run`, {}); } catch (error) { toast(error.message); return; }
  toast(said.started ? t("window.flows.flow.running", { name }) : said.reason);
}

function goBack(version) {
  const old = (F.record.history ?? []).find((x) => x.version === version);
  if (!old) return;
  const start = JSON.stringify(old.start) === JSON.stringify(F.record.procedure.start) ? undefined : old.start;
  propDlg(draftOf(old.steps), t("window.flows.flow.going-back", { v: version }), start);
}

/* Typing redraws the picture; a new kind redraws the row. */
function listenDraft() {
  document.addEventListener("input", (e) => {
    const el = e.target;
    if (!F || el.dataset?.flow !== "text") return;
    F.steps[+el.dataset.j].text = el.value;
    const pic = dialog()?.querySelector("#flow-pic");
    if (pic) paint(pic, pictureOf());
  });
  document.addEventListener("change", (e) => {
    const el = e.target;
    if (!F || el.dataset?.flow !== "kind" || !EDITABLE.has(el.value)) return;
    F.steps[+el.dataset.j].kind = el.value;
    drawFlow();
  });
}

export function init() {
  markLive(["flow", "flow-add", "flow-mv", "flow-rm", "flow-save", "flow-run", "ppback17d", "ppapprove17d", "ppold17d"]);
  on("flow", (el) => (el.dataset.v === "auto" ? openAuto(el.dataset.id) : openRecipe(el.dataset.id)));
  on("flow-add", () => { F.steps.push({ kind: "do", text: "" }); drawFlow(); setTimeout(() => document.getElementById(`ft-${F.steps.length - 1}`)?.focus(), 0); });
  on("flow-mv", (el) => { const j = +el.dataset.j, d = +el.dataset.d, s = F.steps; [s[j], s[j + d]] = [s[j + d], s[j]]; drawFlow(); });
  on("flow-rm", (el) => { F.steps.splice(+el.dataset.j, 1); drawFlow(); });
  on("flow-save", () => save());
  on("flow-run", () => runNow());
  on("ppback17d", () => drawFlow());
  on("ppapprove17d", () => approve());
  on("ppold17d", (el) => goBack(+el.dataset.v));
  listenDraft();
}
