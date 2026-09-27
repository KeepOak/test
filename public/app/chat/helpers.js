/* Helpers (pass 17, part C §4; the prototype's helpersHTML17c and its thread chip): the tasks a conversation's newest task
   started, from GET /api/runs/<id>/steps (`helpers`). Each shows its name, the model and provider it runs on, where it
   stands, the job it was given, "What it's thinking" (the engine's live line, or its last recorded one) and the question
   it waits on, naming the exact request: No and Allow once answer that request by conversation and fingerprint through
   POST /api/policy/approve, the same body the main card sends; the engine settles a helper rather than carrying it on as
   the owner's own task. The thread's chip reads "N helpers · N needs you" and opens Activity at the section. */

import { $, esc } from "../core/dom.js";
import { ic, toast, closePop, closeDlg } from "../core/ui.js";
import { S, E } from "../core/state.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { timelineRun, stepsOf, loadSteps, forgetSteps } from "./timeline.js";
import { t } from "../../i18n.js";

/* Q257: a question the engine bound to the exact request shown (its fingerprint); only such a question is answered here. */
const exactAsk = (q) => /^[a-f0-9]{32}$/.test(String(q.fingerprint ?? ""));

const H = { redraw: () => {}, busy: new Set() };
const calm = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const key = (q) => `${q.sessionId}\n${q.fingerprint}`;

/* The newest task's helpers, as last read (the read itself is shared with the Timeline, at most every two seconds). */
function helpersNow() {
  const runId = timelineRun();
  loadSteps(runId);
  return { runId, list: stepsOf(runId)?.helpers ?? [] };
}
const needing = (list) => list.filter((h) => h.waiting?.length).length;
const needsWords = (n) => (n > 1 ? t("window.chat.helpers.need-you", { count: n }) : t("window.chat.helpers.needs-you", { count: n }));
function parentName() {
  const s = E.sessions.find((x) => (x.sessionId ?? x.id) === S.chat);
  return E.trunks.find((tr) => tr.id === s?.trunkId || tr.id === s?.trunk?.id)?.name || E.state?.identity?.name || "";
}

function pill(h) {
  if (h.waiting?.length) return `<span class="pill work"><i></i>${t("dashboard.needs.title")}</span>`;
  if (h.status === "running" || h.status === "queued") return `<span class="pill work"><i></i>${t("strip.status.working")}</span>`;
  if (h.status === "completed") return `<span class="pill done"><i></i>${t("first-run-steps.done")}</span>`;
  if (h.status === "cancelled" || h.status === "failed") return `<span class="pill no"><i></i>${t("panels.state.stopped")}</span>`;
  return "";
}
/* The helper's question: the exact request, where it applies and who asked for whom, with No and Allow once. */
function ask(h, q) {
  const off = H.busy.has(key(q)) ? " disabled" : "";
  const id = `data-sid="${esc(q.sessionId)}" data-fp="${esc(q.fingerprint)}"${off}`;
  const where = [q.bytes || q.target, t("window.chat.helpers.asked-by", { name: h.name || "", parent: parentName() })].filter(Boolean).join(" · ");
  return `<div class="hpask17c"><span class="pill idle">${esc(q.tool)}</span><span class="grow"><b>${esc(q.question || q.label)}</b><small>${esc(where)}</small></span><span class="hpbtn17c"><button class="btn ghost sm" type="button" data-act="hpdo17c" data-v="deny" ${id}>${t("autonomy.needs.no")}</button><button class="btn pri sm" type="button" data-act="hpdo17c" data-v="allow" ${id}>${t("window.chat.helpers.allow-once")}</button></span></div>`;
}
function card(h) {
  const via = [h.model, h.provider].filter(Boolean).join(" · ");
  const thought = h.thinking ? `<details class="hpth17c"><summary>${ic("chev", "s chev")}${t("window.chat.helpers.thinking")}</summary><p>${esc(h.thinking)}</p></details>` : "";
  const meta = [t("window.chat.helpers.steps", { count: Number(h.steps) || 0 }), h.cost?.amount != null ? h.cost.display : ""].filter(Boolean).join(" · ");
  return `<div class="hpc17c"><div class="hpt17c"><span class="hpav17c">${esc((h.name || "").slice(0, 1))}</span><span class="grow"><b>${esc(h.name || "")}</b><small>${esc(via)}</small></span>${pill(h)}</div><p class="hpjob17c">${esc(h.job)}</p>${thought}${(h.waiting ?? []).map((q) => ask(h, q)).join("")}<small class="hpm17c">${esc(meta)}</small></div>`;
}

/* The section at the end of Activity; nothing when the task started no helpers. */
export function helpersSection() {
  const { list } = helpersNow();
  if (!list.length) return "";
  const wait = needing(list);
  return `<section class="hp17c" id="helpers17c" aria-label="${t("window.chat.helpers.title")}"><div class="hph17c"><b>${t("window.chat.helpers.title")}</b><small>${t("window.chat.helpers.started-by", { count: list.length, name: esc(parentName()) })}${wait ? ` · ${needsWords(wait)}` : ""}</small></div>${list.map(card).join("")}<p class="hint">${t("window.chat.helpers.hint")}</p></section>`;
}

/* The one-line chip in the thread: "N helpers · N needs you", or "· done". */
export function helpersChip() {
  if (S.view !== "chat") return "";
  const { list } = helpersNow();
  if (!list.length) return "";
  const wait = needing(list);
  const faces = list.map((h) => `<span class="hpav17c">${esc((h.name || "").slice(0, 1))}</span>`).join("");
  return `<button type="button" class="hl17c" data-act="hpopen17c">${faces}<span>${t("window.chat.helpers.count", { count: list.length })}${wait ? ` · <b>${needsWords(wait)}</b>` : ` · ${t("window.chat.helpers.done")}`}</span>${ic("chev", "s")}</button>`;
}

/* Allow once or No: the question is read again, and only that exact request is answered, once. */
async function answer(el) {
  const q = { sessionId: el.dataset.sid, fingerprint: el.dataset.fp };
  if (!q.sessionId || H.busy.has(key(q))) return;
  H.busy.add(key(q));
  for (const b of el.closest(".hpask17c")?.querySelectorAll("button") ?? []) b.disabled = true;
  try {
    const waiting = (await api("policy")).waiting ?? [];
    const asked = waiting.find((w) => w.sessionId === q.sessionId && (w.fingerprint || "") === q.fingerprint);
    // Q257: only a question that carries a fingerprint is answered, and always with it, so a yes lands on what was shown.
    if (asked && exactAsk(asked)) await api("policy/approve", { sessionId: asked.sessionId, decision: el.dataset.v === "deny" ? "deny" : "allow", remember: "never", fingerprint: asked.fingerprint, carryOn: true });
  } catch (error) { toast(error.message); }
  H.busy.delete(key(q));
  const runId = timelineRun();
  forgetSteps(runId);
  await loadSteps(runId);
  H.redraw();
}

function openSection() {
  closeDlg();
  closePop();
  S.pane = "activity";
  H.redraw();
  setTimeout(() => $("#helpers17c")?.scrollIntoView({ block: "start", behavior: calm() ? "auto" : "smooth" }), 30);
}

export function initHelpers({ redraw }) {
  H.redraw = redraw;
  markLive(["hpdo17c", "hpopen17c"]);
  on("hpdo17c", (el) => answer(el));
  on("hpopen17c", () => openSection());
}
