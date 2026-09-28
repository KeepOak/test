/* Branch from here (pass 17, design/redesign/pass17/FEATURES17C.md §2), 1:1 with the prototype's patch17c:
   - the dialog: a name and a model for the new path (POST /api/sessions/<id>/branch; the models are the engine's presets,
     E.state.models.presets). From one of your own messages the path begins just before it and answers it again (the
     engine hands the words back and they are sent as usual); from a reply the cursor goes to the message box;
   - "N paths from here" at each split point, "On the path …" above the thread while on a branch, and the side panel's
     Branches tab (tree, Switch, Compare two answers), all from GET /api/sessions/<id>/paths;
   - switching opens that path's own conversation; every path stays exactly as it was.
   Approvals are never copied: a question a task stopped on belongs to its task, so it is answered once. */

import { $, esc, render } from "../core/dom.js";
import { S, E, refresh } from "../core/state.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { ic, mi, toast, openDlg, closeDlg, closePop } from "../core/ui.js";
import { markLive } from "../core/features.js";
import { text } from "./markdown.js";
import { extraTabs } from "./pane.js";
import { addMoreItem } from "./more.js";
import { t, language, plural } from "../../i18n.js";
import { gsel } from "../core/gsel.js";

const B = { sid: null, paths: [], at: 0, pick: null, model: null, from: null };
let X = { state: () => ({ sessionId: null, messages: [] }), sendText: async () => {}, reopen: async () => {} };

const plain = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const here = () => B.paths.find((p) => p.sessionId === B.sid);
const pathOf = (id) => B.paths.find((p) => p.sessionId === id);
const nameOf = (p) => p?.name || t("window.chat.branches.original");
const modelOf = (p) => (p?.preset ? (E.state?.models?.presets ?? []).find((x) => x.id === p.preset)?.name ?? p.preset : "");
const when = (at) => (at ? new Date(at).toLocaleString(language(), { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "");

/* The tree the open conversation belongs to, read when it opens and after each change. */
/** Hook (PARITY.md pane-stage-001, B2's side panel tab row): the Branches tab as [id, label key, draw, shown], so the
    panel can place it in the prototype's tab order; this module adds it to `extraTabs` itself. */
export const branchesTab = ["branches", "window.chat.branches.tab", () => paneBody(), () => S.view === "chat" && !!S.chat && S.chat === B.sid && B.paths.length > 1];

export async function loadPaths(sid) {
  if (!sid) { if (B.sid) Object.assign(B, { sid: null, paths: [] }); return; }
  if (sid === B.sid && Date.now() - B.at < 3000) return;
  B.at = Date.now();
  const got = await api(`sessions/${encodeURIComponent(sid)}/paths`).catch((error) => { toast(error.message); return null; });
  if (!got || S.chat !== sid) return;
  const before = JSON.stringify([B.sid, B.paths]);
  Object.assign(B, { sid, paths: got.paths ?? [] });
  if (JSON.stringify([B.sid, B.paths]) !== before) render();
}
const fresh = (sid) => { B.at = 0; return loadPaths(sid); };

/* ---------- in the thread: "N paths from here" ---------- */
const chips = (group) => `<div class="brm17c" role="group" aria-label="${t("window.chat.branches.paths-label")}">${ic("branch", "s")}<span>${t("window.chat.branches.paths-count", { count: group.length })}</span>${group.map((p) => `<button type="button" data-act="brgo17c" data-v="${esc(p.sessionId)}" aria-pressed="${p.sessionId === B.sid}">${esc(nameOf(p))}</button>`).join("")}</div>`;

/* Where each marker goes in the open conversation: by its own message ids (a split in this conversation), or by how many
   messages a branch began with (its own split from its parent). */
function points(messages) {
  const cur = here(), out = { after: new Map(), before: new Map(), start: "" };
  if (!cur || B.paths.length < 2) return out;
  const put = (map, key, group) => map.set(key, (map.get(key) ?? []).concat(group.filter((p) => !(map.get(key) ?? []).includes(p))));
  const kids = B.paths.filter((p) => p.parentSessionId === cur.sessionId);
  for (const p of kids) put(p.split === "before" ? out.before : out.after, p.branchPointMessageId, [cur, p]);
  if (cur.parentSessionId) {
    const parent = pathOf(cur.parentSessionId), siblings = B.paths.filter((p) => p.parentSessionId === cur.parentSessionId && p.branchPointMessageId === cur.branchPointMessageId && p.split === cur.split);
    const shown = messages.slice(0, cur.copied).filter((m) => m.messageId && (m.role === "user" || m.role === "assistant")).at(-1);
    const group = [parent, ...siblings].filter(Boolean);
    if (shown) put(out.after, shown.messageId, group); else out.start = chips(group);
  }
  return out;
}
/* What goes around each message of the thread: chat.js asks once per draw. */
export function pathMarks(messages) {
  const at = points(messages);
  return { start: at.start, before: (m) => (at.before.has(m.messageId) ? chips(at.before.get(m.messageId)) : ""), after: (m) => (at.after.has(m.messageId) ? chips(at.after.get(m.messageId)) : "") };
}

/* ---------- above the thread: "On the path …" ---------- */
export function pathBar(sid) {
  const cur = sid && sid === B.sid ? here() : null;
  if (!cur?.parentSessionId) return "";
  const parent = pathOf(cur.parentSessionId), model = modelOf(cur);
  return `<div class="brbar17c" role="region" aria-label="${t("window.chat.branches.which")}">${ic("branch", "s")}<span class="grow">${t("window.chat.branches.on-path", { name: `<b>${esc(nameOf(cur))}</b>` })}${model ? ` · ${esc(model)}` : ""}</span><button class="btn ghost sm" type="button" data-act="brcmp17c">${t("action.compare")}</button><button class="btn sm" type="button" data-act="brgo17c" data-v="${esc(cur.parentSessionId)}">${t("window.chat.branches.back-to", { name: esc(nameOf(parent)) })}</button></div>`;
}

/* ---------- the side panel's Branches tab ---------- */
function row(p, depth) {
  const small = [plural(p.messages, { one: "window.chat.branches.messages.one", other: "window.chat.branches.messages" }), modelOf(p) || t("window.chat.branches.same-model-lower"), when(p.createdAt)].filter(Boolean).map(esc).join(" · ");
  const end = p.sessionId === B.sid ? `<span class="pill done"><i></i>${t("window.chat.branches.here")}</span>` : `<button class="btn sm" type="button" data-act="brgo17c" data-v="${esc(p.sessionId)}">${t("household.switch")}</button>`;
  return `<div class="brr17c${depth ? " sub17c" : ""}" data-css="--d:${Math.min(depth, 6)}"><span class="brdot17c ${p.sessionId === B.sid ? "on17c" : ""}"></span><span class="grow"><b>${esc(nameOf(p))}</b><small>${small}</small><em>${esc(plain(p.lastAnswer).slice(0, 96))}</em></span>${end}</div>`;
}
function tree(parent, depth) {
  return B.paths.filter((p) => p.parentSessionId === parent).map((p) => row(p, depth) + tree(p.sessionId, depth + 1)).join("");
}
function paneBody() {
  const root = B.paths[0];
  return `<div class="brp17c"><p class="hint">${t("window.chat.branches.pane-hint")}</p><div class="brtree17c">${root ? row(root, 0) + tree(root.sessionId, 1) : ""}</div><div class="acts"><button class="btn sm" type="button" data-act="brcmp17c">${t("window.chat.branches.compare-two")}</button><button class="btn ghost sm" type="button" data-act="br17c">${t("window.chat.branches.new-latest")}</button></div></div>`;
}

/* ---------- starting a path ---------- */
/* Shortens at a word boundary and marks the cut, so a quote never ends mid-word. */
const clip = (s, n) => (s.length <= n ? s : `${s.slice(0, n).replace(/\s+\S*$/, "")}…`);
function openBranch(el) {
  closePop();
  const list = X.state().messages ?? [];
  const wanted = Number(el.dataset.mid) || [...list].reverse().find((m) => m.messageId && (m.role === "assistant" && !m.toolCalls?.length || m.role === "user"))?.messageId;
  const m = list.find((x) => x.messageId === wanted);
  if (!m || !X.state().sessionId) return;
  B.from = { sid: X.state().sessionId, mid: wanted };
  B.model = "same";
  const models = [["same", t("window.chat.branches.same-model")], ...(E.state?.models?.presets ?? []).map((x) => [x.id, x.name])];
  /* The label and its hint sit above the choices, one choice per row, so a long model list never squeezes the label. */
  const seg = `<div class="brm17d"><b>${t("window.chat.branches.model-for")}</b><small>${t("window.chat.branches.model-hint")}</small><div class="brml17d" role="group" aria-label="${t("window.chat.branches.model-for")}">${models.map(([v, l]) => `<button type="button" aria-pressed="${v === B.model}" data-act="brmodel17c" data-v="${esc(v)}">${esc(l)}</button>`).join("")}</div></div>`;
  openDlg({ title: t("window.chat.branches.from-here"),
    body: `<p class="lede" data-css="margin:0 0 10px">${t("window.chat.branches.lede", { words: esc(clip(plain(m.content), 60)) })}</p><label class="fld"><span>${t("accounts.field.name")}</span><input class="inp" id="br-name17c" value="${esc(t("window.chat.branches.try", { n: Math.max(B.paths.length, 1) + 1 }))}" autocomplete="off"></label>${seg}<p class="hint" id="br-error17c" role="alert"></p>`,
    foot: `<button class="btn ghost" type="button" data-act="dlg-close">${t("first-run-steps.restore-no")}</button><button class="btn pri" type="button" data-act="brmake17c">${t("window.chat.branches.start")}</button>` });
}

function pickModel(el) {
  B.model = el.dataset.v;
  for (const b of el.parentElement.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b === el));
}

async function makePath() {
  const from = B.from, name = ($("#br-name17c")?.value ?? "").trim();
  if (!from || !name) return;
  let made;
  try { made = await api(`sessions/${encodeURIComponent(from.sid)}/branch`, { messageId: from.mid, name, preset: B.model === "same" ? null : B.model }); }
  catch (error) {
    const notice = $("#br-error17c");
    if (notice) notice.textContent = error.message;
    else toast(error.message);
    return;
  }
  closeDlg();
  B.from = null;
  await refresh().catch((error) => toast(error.message));
  await X.reopen(made.sessionId);
  await fresh(made.sessionId);
  toast(t("window.chat.branches.started", { name: made.name }));
  if (made.again) await X.sendText(made.again);
  else $("#prompt")?.focus();
}

/* ---------- switching and comparing ---------- */
async function go(el) {
  const p = pathOf(el.dataset.v);
  closePop();
  closeDlg();
  if (!p || p.sessionId === B.sid) return;
  await X.reopen(p.sessionId);
  await fresh(p.sessionId);
  toast(t("window.chat.branches.on", { name: nameOf(p) }));
}

function column(p) {
  const answer = p.lastAnswer ? text(p.lastAnswer) : `<p>${t("window.chat.branches.no-answer")}</p>`;
  const small = [modelOf(p) || t("window.chat.branches.same-model-lower"), plural(p.messages, { one: "window.chat.branches.messages.one", other: "window.chat.branches.messages" })].map(esc).join(" · ");
  return `<section class="cmpc17c"><h3>${esc(nameOf(p))}</h3><small>${small}</small><div class="txt">${answer}</div><button class="btn sm" type="button" data-act="brgo17c" data-v="${esc(p.sessionId)}">${p.sessionId === B.sid ? t("window.chat.branches.keep-going") : t("window.chat.branches.continue")}</button></section>`;
}
function compare() {
  closePop();
  if (B.paths.length < 2) { toast(t("window.chat.branches.only-one")); return; }
  const cur = here() ?? B.paths[0], other = pathOf(cur.parentSessionId) ?? B.paths.find((p) => p !== cur);
  const picked = (B.pick ?? []).map(pathOf).filter(Boolean), two = picked.length === 2 ? picked : [other, cur];
  const sel = (k) => gsel({ id: `br-sel${k}17c`, label: t("window.chat.branches.path-n", { n: k + 1 }), options: B.paths.map((p) => [p.sessionId, nameOf(p)]), value: two[k]?.sessionId });
  openDlg({ title: t("window.chat.branches.compare-paths"), wide: true, body: `${B.paths.length > 2 ? `<div class="cmpsel17c">${sel(0)}${sel(1)}</div>` : ""}<div class="cmp17c">${two.map(column).join("")}</div>` });
}

export function initBranches(context) {
  X = context;
  addMoreItem((m) => ((m.role === "user" || (m.role === "assistant" && !m.toolCalls?.length)) && m.messageId ? mi("br17c", "branch", t("window.chat.branches.from-here"), "", `data-mid="${esc(m.messageId)}"`) : ""));
  extraTabs.push(branchesTab);
  markLive(["br17c", "brmodel17c", "brmake17c", "brgo17c", "brcmp17c", "sw:br-name17c", "sw:br-sel017c", "sw:br-sel117c"]);
  on("br17c", (el) => openBranch(el));
  on("brmodel17c", (el) => pickModel(el));
  on("brmake17c", () => makePath());
  on("brgo17c", (el) => go(el));
  on("brcmp17c", () => compare());
  document.addEventListener("keydown", (e) => { if (e.target.id === "br-name17c" && e.key === "Enter") { e.preventDefault(); makePath(); } });
  document.addEventListener("change", (e) => {
    if (e.target.id !== "br-sel017c" && e.target.id !== "br-sel117c") return;
    B.pick = [$("#br-sel017c")?.value, $("#br-sel117c")?.value];
    compare();
  });
}
