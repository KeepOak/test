/* A procedure as a picture (the prototype's flow editor), opened from Automations › Procedures. Two kinds of record open
   here, and only one can change:
   - A procedure that starts itself (GET /api/autonomy/procedures): its start and its steps, each a request to a Trunk
     ("Ask a Trunk") or one that asks the owner first ("Ask me"). Adding, moving and taking out steps is a draft in the
     window; Save opens the prototype's "Change …?" with the difference, and "Approve version N" is the same owner's yes a
     new procedure gets: the change is asked (POST /api/autonomy/procedures/<id>/propose) and answered
     (POST /api/autonomy/decide). It stays the same procedure; the version before is kept in its history, and "Go back to
     this" is itself such a change. Every kind of step is the engine's own (src/autonomy/step-kinds.ts): "Ask a Trunk",
     "Ask me", "When" (a time of day, every so often, or after a task, in the owner's words), "If it says" (the words, and
     what to ask when it does and when it doesn't), "Wait" (how long), "Repeat" (up to 5 times), "Split and gather" (once
     for each line the step before gave) and "Run a flow" (another procedure, by its name).
     A procedure that repeats or runs another flow waits for the owner's own yes to exactly that (the engine's question,
     GET /api/autonomy/ledger kind "unattended", in its own words): it is shown at the top of the procedure with Yes and
     No, answered through POST /api/autonomy/decide, and shown at once after a change that asks it.
     A Trunk's suggested change (the procedures.auto.suggest_change tool: a question in GET /api/autonomy/ledger, kind
     "procedure", from "assistant", naming the procedure) shows at the top as "<Trunk> suggests a change", with that
     Trunk's face (none for Branch's own assistant: the mascot is only the logo). "See the change" opens the same
     difference; "Approve version N" answers that very question yes and "Keep it as it is" answers it no
     (POST /api/autonomy/decide), after which the engine never asks it again.
     Run starts the version in use (POST /api/autonomy/procedures/<id>/run).
   - A saved recipe (GET /api/state `procedures`: tool calls with exact expected results): its steps can be moved or
     taken out, and saved as a new version to verify (POST /api/recipes/<id>/steps), as the section below says. */

import { esc, paint, renderNow } from "../core/dom.js";
import { openDlg, closeDlg, dialog, ic, toast, av } from "../core/ui.js";
import { S, E, refresh, level } from "../core/state.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { api } from "../core/api.js";
import { t, language } from "../../i18n.js";
import { gsel } from "../core/gsel.js";

const KINDS = [["when", "window.flows.flow.when"], ["do", "window.flows.flow.ask-trunk"], ["if", "window.flows.flow.if"], ["ask", "window.flows.flow.ask-me"], ["wait", "window.flows.flow.wait"],
  ["loop", "window.flows.flow.repeat"], ["fan", "window.flows.flow.fan"], ["sub", "window.flows.flow.sub"]];
const EDITABLE = new Set(KINDS.map(([k]) => k));
const REPEAT = 5; // the prototype's "Repeat (up to 5)"
let F = null; // the open procedure: { record, steps: [{ kind, text, orig }], suggestion }

/* The prototype's picture: one box per step, joined top to bottom; a start is the accented "When" box. */
function flowSVG(boxes) {
  const W = 560, cx = W / 2, bh = 38, gap = 24, parts = [];
  let y = 10;
  const cut = (s, w) => { const n = Math.floor(w / 7.2); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
  boxes.forEach((b, i) => {
    const text = b.text || "…";
    const label = boxLabel(b.kind, text);
    parts.push(`<rect x="${cx - 160}" y="${y}" width="320" height="${bh}" rx="${b.kind === "if" ? 19 : 10}" fill="${b.kind === "ask" ? "var(--accent-tint)" : "var(--raise)"}" stroke="${b.kind === "when" ? "var(--accent)" : "var(--line-2)"}" stroke-width="1.5"/><text x="${cx}" y="${y + bh / 2 + 4}" text-anchor="middle">${esc(cut(label, 304))}</text>`);
    y += bh;
    if (b.kind === "if") {
      const y2 = y + gap, way = (x, words) => `<rect x="${x}" y="${y2}" width="240" height="${bh}" rx="10" fill="var(--raise)" stroke="var(--line-2)" stroke-width="1.5"/><text x="${x + 120}" y="${y2 + bh / 2 + 4}" text-anchor="middle">${esc(cut(words, 224))}</text>`;
      const line = (x1, y1, x2, yy) => `<path d="M${x1} ${y1} C ${x1} ${(y1 + yy) / 2}, ${x2} ${(y1 + yy) / 2}, ${x2} ${yy}" stroke="var(--ink-3)" stroke-width="1.5" fill="none" marker-end="url(#fa)"/>`;
      parts.push(line(cx - 70, y, cx - 140, y2), line(cx + 70, y, cx + 140, y2), way(cx - 260, t("window.flows.flow.yes-way", { text: b.yes || "…" })), way(cx + 20, t("window.flows.flow.no-way", { text: b.no || "…" })));
      y = y2 + bh;
    }
    if (i < boxes.length - 1) { parts.push(`<path d="M${cx} ${y} C ${cx} ${y + gap / 2}, ${cx} ${y + gap / 2}, ${cx} ${y + gap}" stroke="var(--ink-3)" stroke-width="1.5" fill="none" marker-end="url(#fa)"/>`); y += gap; }
  });
  return `<svg class="flow-svg" viewBox="0 0 ${W} ${y + 10}" role="img" aria-label="${t("window.flows.flow.picture")}"><defs><marker id="fa" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="var(--ink-3)"/></marker></defs>${parts.join("")}</svg>`;
}

/* A step as the picture and the difference say it, in the prototype's words. */
function boxLabel(kind, text) {
  const words = { when: "window.flows.flow.when-text", ask: "window.flows.flow.ask-text", if: "window.flows.flow.if-text", wait: "window.flows.flow.wait-text",
    loop: "window.flows.flow.repeat-text", fan: "window.flows.flow.fan-text", sub: "window.flows.flow.sub-text" }[kind];
  return words ? t(words, { text, n: REPEAT }) : text;
}

/* ---------- a saved recipe: its steps moved or taken out ---------- */

/* A recipe's steps are exact tool calls with the results they must give, so the window only rearranges them: Move up,
   Move down and Remove are a draft, and Save shows the same "Change …?" difference; the yes is POST
   /api/recipes/<id>/steps {order}, which keeps only steps the recipe already has (by their place in the version in use)
   and saves a new version the engine marks proposed, to be verified again before it replays. The yes also sends the
   version the owner rearranged, and the engine refuses it when the recipe changed since. A step cannot be written here
   (it needs a real call and its expected result) and the engine has no route that runs a recipe (a replay is only the
   replay_procedure tool, inside a task), so Add a step and Run are drawn greyed. */
/* stress test B004: each step reads as the engine's own description of its tool (GET /api/tools), not as the raw call;
   the call itself is shown underneath only at the detailed levels. Every greyed control says why, and a proposed recipe
   says what that means. The shipped "Tidy my memory" (its one step is memory.tidy) runs from Library › Memory. */
let toolWords = new Map();
async function readToolWords() {
  const { tools } = await api("tools");
  toolWords = new Map((tools ?? []).map((x) => [x.name, x.description]));
}
const WHY = (words) => ` disabled aria-disabled="true" data-tip="${esc(words)}"`;
const argsText = (args) => { const text = JSON.stringify(args ?? {}); return text === "{}" ? "" : text.length > 160 ? text.slice(0, 159) + "…" : text; };
const recipeDraft = (record) => (Array.isArray(record.data?.definition?.steps) ? record.data.definition.steps : [])
  .map((s, place) => ({ kind: "do", text: toolWords.get(s.tool) || s.tool, call: [s.tool, argsText(s.args)].filter(Boolean).join(" "), tool: s.tool, place }));
async function openRecipe(id) {
  const record = (E.state?.procedures ?? []).find((p) => p.id === id);
  if (!record) return;
  try { await readToolWords(); } catch (error) { toast(error.message); }
  F = { kind: "recipe", record, steps: recipeDraft(record) };
  drawFlow();
}
function drawRecipe() {
  const n = F.steps.length;
  const one = n === 1 ? WHY(t("window.switch-on.one-step")) : "";
  const rows = F.steps.map((s, j) => `<div class="flow-row rcp18"><input class="inp" id="ft-${j}" value="${esc(s.text)}" readonly aria-label="${t("window.flows.flow.step-n", { n: j + 1 })}">
    <span class="acts" data-css="gap:0"><button class="btn ghost sm" type="button" data-act="flow-mv" data-j="${j}" data-d="-1"${j === 0 ? one || " disabled" : ""}>${t("accounts.action.up")}</button><button class="btn ghost sm" type="button" data-act="flow-mv" data-j="${j}" data-d="1"${j === n - 1 ? one || " disabled" : ""}>${t("accounts.action.down")}</button><button class="btn ghost sm" type="button" data-act="flow-rm" data-j="${j}"${one}>${t("editor.remove")}</button></span></div>${level() >= 2 && s.call ? `<code class="code15">${esc(s.call)}</code>` : ""}`).join("");
  const tidy = F.steps.some((s) => s.tool === "memory.tidy");
  const about = [F.record.data?.status === "proposed" ? `<p class="hint">${t("window.switch-on.recipe-proposed")}</p>` : "",
    tidy ? `<p class="hint">${t("window.switch-on.tidy-where")} <button class="btn ghost sm" type="button" data-act="flow-memory">${t("window.switch-on.open-memory")}</button></p>` : ""].join("");
  openDlg({ title: nameOf(), wide: true,
    body: `${about}<div id="flow-pic">${flowSVG(F.steps.map((s) => ({ kind: "do", text: s.text })))}</div><div>${rows}</div><div class="acts"><button class="btn soon" type="button"${WHY(t("window.switch-on.recipe-add-why"))}>${ic("plus", "s")}${t("action.add-a-step")}</button><span class="tb-grow"></span><button class="btn soon" type="button"${WHY(t("window.switch-on.recipe-run-why"))}>${ic("play", "s")}${t("commands.dashboard.run")}</button><button class="btn pri" type="button" data-act="flow-save">${t("action.save")}</button></div>` });
}
const nameOf = () => (F.kind === "recipe" ? String(F.record.data?.definition?.name ?? "") : F.record.procedure.name);
const versionOf = () => (F.kind === "recipe" ? F.record.data?.version : F.record.version) ?? 1;
const baseDraft = () => (F.kind === "recipe" ? recipeDraft(F.record) : draftOf(F.record.procedure.steps));

/* ---------- a procedure that starts itself: a draft, then a proposal ---------- */

/* The procedures this window knows, by id, for "Run a flow" (read with the procedure opened). */
let known = [];
const nameOfFlow = (id) => known.find((p) => p.id === id)?.procedure.name ?? "";
/* A "When" step's moment in words the engine reads back the same way (src/autonomy/step-kinds.ts parseWhen). */
function whenWords(at) {
  if (!at) return "";
  if (at.kind === "daily") return at.time;
  if (at.kind === "every") return at.minutes % 60 ? `every ${at.minutes} minutes` : `every ${at.minutes / 60} hours`;
  return at.kind === "after-task" ? `after ${at.words}`.trim() : "";
}
/* An engine step as the editor holds it: its kind, the one text box, and If's two ways. */
function draftStep(s) {
  const kind = s.kind ?? (s.confirm ? "ask" : "do");
  const text = kind === "when" ? whenWords(s.at) : kind === "wait" ? `${s.minutes} minutes` : kind === "if" ? s.contains : kind === "sub" ? nameOfFlow(s.flowId) : s.prompt;
  return { kind, text: text ?? "", yes: s.yes ?? "", no: s.no ?? "", orig: s };
}
const draftOf = (steps) => steps.map(draftStep);
const stepText = (s) => {
  const line = boxLabel(s.kind, s.text || "");
  return s.kind === "if" ? `${line} ${t("window.flows.flow.yes-no", { yes: s.yes || "…", no: s.no || "…" })}` : line;
};
const titleOf = (text) => { const line = text.trim().split("\n")[0]; return line.length > 60 ? line.slice(0, 59) + "…" : line; };
/* What the engine is sent for one step. The words of a When or Wait go as written; the engine reads them. */
function engineStep(s) {
  const text = s.text.trim(), same = s.orig && draftStep(s.orig).text === text && (s.orig.kind ?? (s.orig.confirm ? "ask" : "do")) === s.kind;
  const title = same ? s.orig.title : titleOf(text);
  if (s.kind === "do" || s.kind === "ask") return { title, prompt: text, confirm: s.kind === "ask" };
  if (s.kind === "when") return same ? { kind: "when", title, at: s.orig.at } : { kind: "when", title, at: text };
  if (s.kind === "wait") return same ? { kind: "wait", title, minutes: s.orig.minutes } : { kind: "wait", title, minutes: text };
  if (s.kind === "if") return { kind: "if", title, contains: text, ...(s.yes.trim() ? { yes: s.yes.trim() } : {}), ...(s.no.trim() ? { no: s.no.trim() } : {}) };
  if (s.kind === "loop") return { kind: "loop", title, prompt: text, times: s.orig?.kind === "loop" ? s.orig.times : REPEAT, ...(s.orig?.kind === "loop" && s.orig.until ? { until: s.orig.until } : {}) };
  if (s.kind === "fan") return { kind: "fan", title, prompt: text };
  if (s.kind === "sub" && same) return { kind: "sub", title, flowId: s.orig.flowId };
  const flow = known.find((p) => p.procedure.name.trim().toLowerCase() === text.toLowerCase() && p.id !== F?.record?.id);
  return { kind: "sub", title, ...(flow ? { flowId: flow.id } : {}) };
}
const engineSteps = (draft) => draft.map(engineStep);

const FIELD = { if: "personal.mail.words", when: "autonomy.start.when", wait: "window.flows.flow.how-long", ask: "window.flows.flow.question" };
function flowRow(s, j, n) {
  const field = t(FIELD[s.kind] ?? "window.flows.flow.what-ask");
  const kinds = KINDS.map(([k, l]) => [k, t(l), !EDITABLE.has(k)]);
  return `<div class="flow-row">${gsel({ id: `fk-${j}`, label: t("window.flows.flow.kind-n", { n: j + 1 }), options: kinds, value: s.kind, attrs: `data-flow="kind" data-j="${j}"` })}<input class="inp" id="ft-${j}" data-flow="text" data-j="${j}" value="${esc(s.text)}" placeholder="${field}" aria-label="${t("window.flows.flow.field-n", { field, n: j + 1 })}">
    <span class="acts" data-css="gap:0"><button class="btn ghost sm" type="button" data-act="flow-mv" data-j="${j}" data-d="-1" ${j === 0 ? "disabled" : ""}>${t("accounts.action.up")}</button><button class="btn ghost sm" type="button" data-act="flow-mv" data-j="${j}" data-d="1" ${j === n - 1 ? "disabled" : ""}>${t("accounts.action.down")}</button><button class="btn ghost sm" type="button" data-act="flow-rm" data-j="${j}">${t("editor.remove")}</button></span>${s.kind === "if" ? ifWays(s, j) : ""}</div>`;
}
/* "If it says": what to ask when it does, and when it doesn't. */
const ifWays = (s, j) => `<span class="more"><input class="inp" id="fy-${j}" data-flow="yes" data-j="${j}" value="${esc(s.yes)}" placeholder="${t("window.flows.flow.if-does")}" aria-label="${t("window.flows.flow.if-does")}"><input class="inp" id="fn-${j}" data-flow="no" data-j="${j}" value="${esc(s.no)}" placeholder="${t("window.flows.flow.if-doesnt")}" aria-label="${t("window.flows.flow.if-doesnt")}"></span>`;
const pictureOf = () => flowSVG([{ kind: "when", text: F.record.starts }, ...F.steps]);

function historyList(r) {
  const versions = [{ version: r.version ?? 1, from: r.changedAt ?? r.createdAt, now: true }, ...(r.history ?? []).slice().reverse()];
  const when = (iso) => new Date(iso).toLocaleDateString(language(), { month: "short", day: "numeric" });
  return `<div class="fh17d"><b>${t("place.inbox.history")}</b><ol>${versions.map((x) => `<li><span class="grow"><b>${t("window.flows.flow.version-n", { n: x.version })}</b><small>${esc(when(x.from))}</small></span>${x.now ? `<span class="pill ok"><i></i>${t("window.flows.flow.in-use")}</span>` : `<button class="btn ghost sm" type="button" data-act="ppold17d" data-v="${x.version}">${t("window.flows.flow.go-back")}</button>`}</li>`).join("")}</ol></div>`;
}

/* Who suggested a change: the Trunk it names, else Branch's own assistant (named, never drawn). */
function suggester(entry) {
  const trunk = E.trunks.find((x) => x.id === entry.payload?.trunk);
  return { face: trunk ? av(trunk, 26) : "", name: trunk?.name ?? E.state?.identity?.name ?? "" };
}
function suggestionNote() {
  const entry = F.suggestion;
  if (!entry) return "";
  const { face, name } = suggester(entry);
  return `<div class="fp17d" role="note">${face}<span class="grow"><b>${t("window.flows.flow.suggests-change", { name: esc(name) })}</b><small>${esc(entry.payload?.why ?? "")}</small></span><button class="btn sm" type="button" data-act="ppsee17d">${t("window.flows.flow.see-change")}</button></div>`;
}

function drawFlow() {
  if (F.kind === "recipe") return drawRecipe();
  const r = F.record;
  markLive(F.steps.flatMap((s, j) => [`sw:ft-${j}`, `sw:fk-${j}`, ...(s.kind === "if" ? [`sw:fy-${j}`, `sw:fn-${j}`] : [])]));
  openDlg({ title: r.procedure.name, wide: true,
    body: `${unattendedNote()}${suggestionNote()}<p class="hint" data-css="margin:0">${t("window.flows.flow.redraws", { starts: esc(r.starts) })}</p><div id="flow-pic">${pictureOf()}</div><div>${F.steps.map((s, j) => flowRow(s, j, F.steps.length)).join("")}</div><div class="acts"><button class="btn" type="button" data-act="flow-add">${ic("plus", "s")}${t("action.add-a-step")}</button><span class="tb-grow"></span><button class="btn" type="button" data-act="flow-run">${ic("play", "s")}${t("commands.dashboard.run")}</button><button class="btn pri" type="button" data-act="flow-save">${t("action.save")}</button></div>${historyList(r)}` });
}

/* The engine's own question about what this procedure would repeat or run by itself, still waiting: its words, Yes and No. */
function unattendedNote() {
  const q = F.unattended;
  if (!q) return "";
  return `<div class="fp17d un-flow" role="note"><span class="grow"><b>${esc(q.title)}</b>${q.detail.split("\n").map((line) => `<small>${esc(line)}</small>`).join("")}</span><button class="btn ghost sm" type="button" data-act="flow-unatt" data-v="no" data-id="${esc(q.id)}">${t("autonomy.needs.no")}</button><button class="btn pri sm" type="button" data-act="flow-unatt" data-v="yes" data-id="${esc(q.id)}">${t("autonomy.needs.yes")}</button></div>`;
}
async function readUnattended(id) {
  const { entries } = await api("autonomy/ledger");
  return (entries ?? []).find((e) => e.kind === "unattended" && e.payload?.procedureId === id) ?? null;
}
async function answerUnattended(el) {
  if (sending) return;
  sending = true;
  try { await api("autonomy/decide", { id: el.dataset.id, yes: el.dataset.v === "yes" }); } catch (error) { toast(error.message); return; } finally { sending = false; }
  F.unattended = null;
  drawFlow();
}

/* A change a Trunk suggested for this procedure that still waits for the owner (the newest one). */
async function readSuggestion(id) {
  const { entries } = await api("autonomy/ledger");
  return (entries ?? []).find((e) => e.kind === "procedure" && e.from === "assistant" && e.payload?.procedureId === id) ?? null;
}
async function openAuto(id) {
  let list;
  try { list = (await api("autonomy/procedures")).procedures ?? []; } catch (error) { toast(error.message); return; }
  const record = list.find((p) => p.id === id);
  if (!record) return;
  known = list;
  let suggestion = null, unattended = null;
  try { [suggestion, unattended] = await Promise.all([readSuggestion(id), readUnattended(id)]); } catch (error) { toast(error.message); }
  F = { kind: "auto", record, steps: draftOf(record.procedure.steps), suggestion, unattended };
  drawFlow();
}

/* A step's identity for the difference: a recipe's step is its place in the version in use (two steps can read the same,
   and a long one is cut), a procedure's step is everything the engine would be sent for it. */
const keyOf = (s) => (F.kind === "recipe" ? `#${s.place}` : JSON.stringify(engineSteps([s])[0]));

/* The prototype's line difference: the longest run kept, the rest added or taken out. Steps are matched by keyOf and
   shown by their words. */
function diffSteps(a, b) {
  const A = a.map(keyOf), B = b.map(keyOf), L = Array.from({ length: A.length + 1 }, () => Array(B.length + 1).fill(0));
  for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < A.length || j < B.length) {
    if (i < A.length && j < B.length && A[i] === B[j]) { out.push(["same", stepText(a[i])]); i++; j++; }
    else if (j < B.length && (i >= A.length || L[i][j + 1] >= L[i + 1][j])) { out.push(["add", stepText(b[j])]); j++; }
    else { out.push(["rm", stepText(a[i])]); i++; }
  }
  return out;
}

let PP = null; // the change on show: { steps (engine form), start, v, entry (a Trunk's suggestion it answers) }
function propDlg(draft, why, start, entry) {
  const cur = versionOf(), v = cur + 1, d = diffSteps(baseDraft(), draft);
  const add = d.filter((x) => x[0] === "add").length, rm = d.filter((x) => x[0] === "rm").length;
  PP = F.kind === "recipe" ? { order: draft.map((s) => s.place), version: cur, v } : { steps: engineSteps(draft), start, v, entry };
  const lead = entry ? t("window.flows.flow.suggests-this", { name: esc(suggester(entry).name), v, cur }) : t("window.flows.flow.your-edit", { v, cur });
  openDlg({ title: t("window.flows.flow.change", { name: nameOf() }), wide: true,
    body: `<p data-css="margin:0 0 4px">${lead}</p>${why ? `<p class="hint" data-css="margin:0 0 8px">${t("window.flows.flow.why", { why: esc(why) })}</p>` : ""}
    <div class="df-k17d">${add ? `<span class="add">${t("window.flows.flow.added", { n: add })}</span>` : ""}${rm ? `<span class="rm">${t("window.flows.flow.taken-out", { n: rm })}</span>` : ""}<span>${t("window.flows.flow.versions", { cur, v })}</span></div>
    <ol class="df17d">${d.map(([k, line]) => `<li class="${k}"><em>${k === "add" ? "+" : k === "rm" ? "−" : ""}</em><span>${esc(line)}</span></li>`).join("")}</ol>`,
    foot: `<button class="btn ghost" type="button" data-act="ppback17d">${t("window.flows.flow.back-editing")}</button>${entry ? `<button class="btn" type="button" data-act="ppdeny17d">${t("window.flows.flow.keep-as-is")}</button>` : ""}<button class="btn pri" type="button" data-act="ppapprove17d" ${add + rm || start ? "" : "disabled"}>${t("window.flows.flow.approve-v", { v })}</button>` });
}

function save() {
  const bad = F.steps.findIndex((s) => !s.text.trim());
  if (bad >= 0) { const box = document.getElementById(`ft-${bad}`); box?.focus(); box?.setAttribute("aria-invalid", "true"); return; }
  if (JSON.stringify(F.steps.map(keyOf)) === JSON.stringify(baseDraft().map(keyOf))) { closeDlg(); return; }
  propDlg(F.steps);
}

/* The owner's yes: the change is asked the way any procedure change is, and answered at once. A second press while the
   first is on its way sends nothing. */
let sending = false;
async function approve() {
  if (sending || !PP) return;
  const { steps, start, v, entry } = PP;
  let said = t("window.flows.flow.approved", { v });
  sending = true;
  try {
    // A Trunk's suggestion is already a waiting question: the yes answers that one, it is not asked again.
    if (entry) await api("autonomy/decide", { id: entry.id, yes: true });
    // A recipe's new version waits to be verified again before anything replays it; the engine says so.
    else if (F.kind === "recipe") said = (await api(`recipes/${encodeURIComponent(F.record.id)}/steps`, { order: PP.order, version: PP.version })).said;
    else {
      const asked = await api(`autonomy/procedures/${encodeURIComponent(F.record.id)}/propose`, { steps, ...(start ? { start } : {}) });
      if (!asked.id) { toast(asked.said); return; }
      await api("autonomy/decide", { id: asked.id, yes: true });
    }
  } catch (error) { toast(error.message); return; } finally { sending = false; }
  PP = null;
  const id = F.kind === "auto" ? F.record.id : null;
  closeDlg();
  F = null;
  await refresh().catch((error) => toast(error.message));
  toast(said);
  // A change with Repeat, Split and gather or Run a flow asks its own question at once: the procedure opens on it.
  if (id) { const asked = await readUnattended(id).catch((error) => { toast(error.message); return null; }); if (asked) await openAuto(id); }
}

/* Run starts the version in use (not the draft): POST /api/autonomy/procedures/<id>/run. A procedure that asks before it
   starts asks in the Inbox, and the engine says so in its own words. */
async function runNow() {
  const { id } = F.record, name = nameOf();
  let said;
  try { said = await api(`autonomy/procedures/${encodeURIComponent(id)}/run`, {}); } catch (error) { toast(error.message); return; }
  toast(said.started ? t("window.flows.flow.running", { name }) : said.reason);
}

/* A Trunk's suggestion, shown as the difference it would make. */
function seeSuggestion() {
  const entry = F?.suggestion, change = entry?.payload?.change;
  if (!change) return;
  const start = JSON.stringify(change.start) === JSON.stringify(F.record.procedure.start) ? undefined : change.start;
  propDlg(draftOf(change.steps), entry.payload.why, start, entry);
}
/* "Keep it as it is": the owner's no to that suggestion, which the engine keeps so it is never asked again. */
async function keepAsIs() {
  const entry = PP?.entry;
  if (sending || !entry) return;
  sending = true;
  try { await api("autonomy/decide", { id: entry.id, yes: false }); } catch (error) { toast(error.message); return; } finally { sending = false; }
  PP = null;
  F.suggestion = null;
  drawFlow();
  toast(t("window.flows.flow.kept", { name: suggester(entry).name }));
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
    if (!F || !["text", "yes", "no"].includes(el.dataset?.flow)) return;
    F.steps[+el.dataset.j][el.dataset.flow] = el.value;
    const pic = dialog()?.querySelector("#flow-pic");
    if (pic) paint(pic, pictureOf());
  });
  document.addEventListener("change", (e) => {
    const el = e.target;
    if (!F || el.dataset?.flow !== "kind" || !EDITABLE.has(el.value)) return;
    Object.assign(F.steps[+el.dataset.j], { kind: el.value, yes: F.steps[+el.dataset.j].yes ?? "", no: F.steps[+el.dataset.j].no ?? "" });
    drawFlow();
  });
}

export function init() {
  on("flow-memory", () => { closeDlg(); S.view = "library"; S.tabs.library = "memory"; renderNow(); });
  markLive(["flow-memory", "flow", "flow-add", "flow-mv", "flow-rm", "flow-save", "flow-run", "ppback17d", "ppapprove17d", "ppold17d", "ppsee17d", "ppdeny17d", "flow-unatt"]);
  on("flow", (el) => (el.dataset.v === "auto" ? openAuto(el.dataset.id) : openRecipe(el.dataset.id)));
  on("flow-add", () => { F.steps.push({ kind: "do", text: "", yes: "", no: "" }); drawFlow(); document.getElementById(`ft-${F.steps.length - 1}`)?.focus(); });
  on("flow-mv", (el) => { const j = +el.dataset.j, d = +el.dataset.d, s = F.steps; [s[j], s[j + d]] = [s[j + d], s[j]]; drawFlow(); });
  on("flow-rm", (el) => { F.steps.splice(+el.dataset.j, 1); drawFlow(); });
  on("flow-save", () => save());
  on("flow-run", () => runNow());
  on("ppback17d", () => drawFlow());
  on("ppapprove17d", () => approve());
  on("ppold17d", (el) => goBack(+el.dataset.v));
  on("ppsee17d", () => seeSuggestion());
  on("ppdeny17d", () => keepAsIs());
  on("flow-unatt", (el) => answerUnattended(el));
  listenDraft();
}
