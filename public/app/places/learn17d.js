/* Pass 17 part D §3: "Learn this app or workflow", the behaviour-workbook skill, in Customize › Tools › Skills, 1:1 with
   the prototype's patch17d.js. Everything is the engine's (src/workbooks.ts): the switch (GET /api/workbooks,
   POST /api/workbooks/settings), Start learning (POST /api/workbooks/learn: a real task, sealed: its own browser tools only,
   every browser step asked about each time, nothing of the owner's in its conversation; it saves the workbook), each
   workbook (GET /api/workbooks/<id>), Run the checks again (POST .../rerun), Make it a skill (POST .../skill: installed switched off, for the owner to review), and Save the workbook (GET .../markdown,
   saved as a Markdown file). While a workbook is learning the window asks again every two seconds; no stage or count is
   drawn that the engine did not say. Every word a workbook holds came from the pages it read, so all of it is escaped.
   Where the checks run is only Branch's own browser: a private computer is not in this build, so that choice is greyed.
   Every word goes through t() (public/locales); "learn-this" is the skill's name, and a date follows the chosen language. */

import { esc, render } from "../core/dom.js";
import { E } from "../core/state.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { ic, toast, openDlg, dialog } from "../core/ui.js";
import { t, formatDate } from "../../i18n.js";
import { art17Slot } from "../core/art17.js"; // the prototype's SPOTS17: the learn and workbook pictures

export const LEARN_ID = "learn17d";
const W = { mode: null, list: [], open: null, tab: "must", what: "", timer: null, waiting: new Map() };
const k = (name, values) => t(`window.p17d.${name}`, values);
const STAGES = () => [[t("window.chat.ask.read-it"), k("stage-read-hint")], [k("stage-must"), k("stage-must-hint")], [k("stage-checks"), k("stage-checks-hint")], [k("stage-run"), k("stage-run-hint")]];

const pill = (cls, text) => `<span class="pill ${cls}"><i></i>${esc(text)}</span>`;
const when = (iso) => formatDate(iso, { month: "short", day: "numeric" });
const tally = (w) => { const n = (s) => w.must.filter((m) => m.status === s).length; return { pass: n("pass"), fail: n("fail"), unclear: n("unclear"), all: w.must.length }; };

/** The built-in skill, first in the skills list. */
export const learnItem = () => ({ id: LEARN_ID, name: "learn-this", sub: k("learn-desc"), icon: "book17d" });

/** The card at the top of the list whenever another skill is selected. */
export const learnTile = () => `<div class="tile wb-tile17d has-art17e"><div class="th"><span class="ico-tile ico17e">${ic("book17d", "s")}</span>${art17Slot("art17-learn", false, "spot17e tile17e")}<b>${esc(k("learn-tile"))}</b></div><p>${esc(k("learn-tile-hint"))}</p><div class="acts"><button class="btn sm" type="button" data-act="t9-sel" data-v="${LEARN_ID}">${esc(t("prompts.action.try"))}</button></div></div>`;

async function loadBooks() {
  if (E.profiles?.isOwner === false) return; // the owner's alone: the engine refuses anyone else
  const got = await api("workbooks").catch((error) => { toast(error.message); return null; });
  if (!got) return;
  const before = new Map(W.list.map((w) => [w.id, w.status]));
  W.mode = got.mode;
  W.list = got.workbooks;
  settled(before);
  render();
  follow();
}
/* A workbook that was learning and now is not: say how it went, in the engine's words, and open a new one. */
function settled(before) {
  for (const w of W.list) {
    // one this window started (it may have finished before the first look), or one seen learning before
    if (w.status === "learning" || (!W.waiting.has(w.id) && before.get(w.id) !== "learning")) continue;
    const why = W.waiting.get(w.id);
    W.waiting.delete(w.id);
    if (w.status === "failed") { toast(w.error); continue; }
    const n = tally(w);
    if (why === "rerun" && w.changed === false) toast(k("same-result"));
    else toast(k("workbook-ready", { pass: n.pass, count: n.all }));
    if (why === "new" && !dialog()) { W.open = w.id; W.tab = "must"; wbDlg(); }
    else if (W.open === w.id && dialog()?.querySelector(".wbv17d")) wbDlg();
  }
}
function follow() {
  clearTimeout(W.timer);
  if (W.list.some((w) => w.status === "learning")) W.timer = setTimeout(loadBooks, 2000);
}

export function learnDetail() {
  if (W.mode === null) { if (!W.asked) { W.asked = true; loadBooks(); } return '<div class="t9-detail wb17d"></div>'; }
  const running = W.list.some((w) => w.status === "learning");
  const browser = true; // the only place checks run in this build
  const rows = W.list.map((w) => {
    const n = tally(w), state = w.status === "learning" ? pill("work", k("learning")) : w.status === "ready" ? pill(n.fail ? "warn" : "ok", k("n-pass", { pass: n.pass, count: n.all })) : "";
    const sub = w.status === "failed" ? w.error : `${w.source || w.name} · ${when(w.updatedAt)}`;
    return `<div class="prow wb-row17d"><span class="grow"><b>${esc(w.name)}</b><small>${esc(sub)}</small></span>${state}${w.status === "ready" ? `<button class="btn sm" type="button" data-act="wbopen17d" data-id="${esc(w.id)}">${esc(t("ov.open"))}</button>` : ""}</div>`;
  }).join("");
  return `<div class="t9-detail wb17d"><div class="t9-dh has-art17e"><span class="ico-tile t9i ico17e" data-css="width:40px;height:40px">${ic("book17d", "s")}</span>${art17Slot("art17-learn", false, "spot17e tile17e")}<span class="grow"><b>learn-this</b><small>${esc(k("learn-built-in"))}</small></span><input type="checkbox" class="sw" id="wb-on17d" ${W.mode === "on" ? "checked" : ""} aria-label="${esc(k("learn-on-off"))}"></div>
    <div class="sec"><h2>${esc(k("how-it-works"))}</h2><ol class="wb-how17d">${STAGES().map(([title, sub], i) => `<li><em>${i + 1}</em><span><b>${esc(title)}</b><small>${esc(sub)}</small></span></li>`).join("")}</ol><p class="hint">${esc(k("how-it-works-hint"))}</p></div>
    <div class="sec"><h2>${esc(k("learn-new"))}</h2><label class="fld"><span>${esc(k("learn-what"))}</span><input class="inp" id="wb-what17d" value="${esc(W.what)}" autocomplete="off"></label>
      <div class="fld"><span>${esc(k("learn-where"))}</span><span class="seg"><button type="button" data-act="wbwhere17d" data-v="private" aria-pressed="false">${esc(k("private-computer"))}</button><button type="button" aria-pressed="${browser}" disabled>${esc(k("sealed-browser"))}</button></span><small class="hint">${esc(k("never-run"))}</small></div>
      <div class="acts"><button class="btn pri sm" type="button" data-act="wbstart17d" ${running || W.mode !== "on" ? "disabled" : ""}>${esc(running ? k("learning") : k("start-learning"))}</button></div></div>
    <div class="sec"><h2>${esc(k("workbooks"))}</h2><div class="rows">${rows}</div></div></div>`;
}

function wbList(w) {
  const mark = (s) => (s === "pass" ? pill("ok", k("mark-pass")) : s === "fail" ? pill("no", k("mark-fails")) : pill("idle", k("mark-unclear")));
  if (W.tab === "must") return `<ol class="wb-must17d">${w.must.map((m, i) => `<li class="${m.status}"><span class="wb-n17d">${esc(k("must-n", { n: i + 1 }))}</span><span class="grow"><b>${esc(m.text)}</b><small>${esc(m.checks.length === 1 ? k("one-check") : k("n-checks", { count: m.checks.length }))}</small></span>${mark(m.status)}</li>`).join("")}</ol>`;
  if (W.tab === "checks") return `<ol class="wb-checks17d">${w.must.map((m, i) => `<li><b>${esc(k("must-n", { n: i + 1 }))} · ${esc(m.text)}</b><ul>${m.checks.map((c) => `<li class="${m.status}">${ic(m.status === "pass" ? "check" : m.status === "fail" ? "x" : "info", "s")}${esc(c)}</li>`).join("")}</ul></li>`).join("")}</ol>`;
  const rows = w.must.map((m, i) => (m.status === "pass" ? "" : `<div class="status"><span class="sdot ${m.status === "fail" ? "bad" : ""}"></span><div><b>${esc(k("must-n", { n: i + 1 }))}: ${esc(m.text)}</b><p>${m.found ? `${esc(m.found)}. ` : ""}${esc(m.status === "fail" ? k("fail-note") : k("unclear-note"))}</p></div></div>`)).join("");
  return `<div class="wb-fail17d">${rows || `<p class="empty">${esc(k("all-passed"))}</p>`}</div>`;
}
function wbDlg() {
  const w = W.list.find((x) => x.id === W.open);
  if (!w) return;
  const n = tally(w), share = n.all ? Math.round((n.pass / n.all) * 100) : 0;
  const ring = `<span class="wb-ring17d" role="img" aria-label="${esc(k("n-pass", { pass: n.pass, count: n.all }))}"><svg viewBox="0 0 36 36"><circle cx="18" cy="18" r="15" pathLength="100"/><circle class="wb-arc17d" cx="18" cy="18" r="15" pathLength="100" data-css="stroke-dasharray:${share} 100"/></svg><b>${n.pass}/${n.all}</b></span>`;
  const head = `<div class="wbv-h17d">${ring}<span class="grow"><b>${esc(k("proved-real", { pass: n.pass, count: n.all }))}</b><small>${esc(w.source || w.name)} · ${esc(k("read-pages", { pages: w.pages }))} · ${esc(k("ran-sealed"))} · ${esc(when(w.updatedAt))}</small><span class="wbv-k17d">${pill("ok", k("count-pass", { count: n.pass }))}${n.fail ? pill("no", k("count-fail", { count: n.fail })) : ""}${n.unclear ? pill("idle", k("count-unclear", { count: n.unclear })) : ""}</span></span></div>`;
  const tabs = [["must", k("tab-must")], ["checks", k("tab-checks")], ["fail", k("tab-fail")]].map(([v, l]) => `<button class="tab" role="tab" type="button" aria-selected="${W.tab === v}" data-act="wbtab17d" data-v="${v}">${esc(l)}</button>`).join("");
  const learning = w.status === "learning";
  openDlg({ title: w.name, wide: true, body: `<div class="wbv17d">${head}<div class="tabs" role="tablist" data-css="margin:12px 0 8px">${tabs}</div>${wbList(w)}</div>`,
    foot: `<button class="btn ghost" type="button" data-act="wbexport17d">${esc(k("save-workbook"))}</button><button class="btn" type="button" data-act="wbrerun17d" ${learning ? "disabled" : ""}>${esc(k("rerun"))}</button><button class="btn pri" type="button" data-act="wbskill17d" ${w.skillId || learning ? "disabled" : ""}>${esc(w.skillId ? k("skill-made") : k("make-skill"))}</button>` });
}

async function start() {
  const what = (document.getElementById("wb-what17d")?.value ?? W.what).trim();
  W.what = what;
  try {
    const { workbook } = await api("workbooks/learn", { what, where: "browser" });
    W.waiting.set(workbook.id, "new");
    W.what = "";
    await loadBooks();
  } catch (error) { toast(error.message); }
}
async function rerun() {
  try {
    await api(`workbooks/${encodeURIComponent(W.open)}/rerun`, {});
    W.waiting.set(W.open, "rerun");
    await loadBooks();
    wbDlg();
  } catch (error) { toast(error.message); }
}
async function makeSkill() {
  try {
    const made = await api(`workbooks/${encodeURIComponent(W.open)}/skill`, {});
    await loadBooks();
    wbDlg();
    toast(k("skill-made-toast", { name: made.name }));
  } catch (error) { toast(error.message); }
}
async function saveMarkdown() {
  try {
    const { name, markdown } = await api(`workbooks/${encodeURIComponent(W.open)}/markdown`);
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([markdown], { type: "text/markdown" })), download: name });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } catch (error) { toast(error.message); }
}
async function setMode(on) {
  try { await api("workbooks/settings", { mode: on ? "on" : "off" }); } catch (error) { toast(error.message); }
  await loadBooks();
}

export function initLearn17d() {
  markLive(["wbstart17d", "wbopen17d", "wbtab17d", "wbrerun17d", "wbskill17d", "wbexport17d", "sw:wb-what17d", "sw:wb-on17d"]);
  on("wbstart17d", () => start());
  on("wbopen17d", (el) => { W.open = el.dataset.id; W.tab = "must"; wbDlg(); });
  on("wbtab17d", (el) => { W.tab = el.dataset.v; wbDlg(); });
  on("wbrerun17d", () => rerun());
  on("wbskill17d", () => makeSkill());
  on("wbexport17d", () => saveMarkdown());
  document.addEventListener("input", (e) => { if (e.target.id === "wb-what17d") W.what = e.target.value; });
  document.addEventListener("change", (e) => { if (e.target.id === "wb-on17d") setMode(e.target.checked); });
}
