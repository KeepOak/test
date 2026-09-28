/* Library, pass 17 (patch17b.js, SHOWCASE17 rows 20-22, 127-131, 140, 143-145, 148, 153, 212 and 213).
   Documents:
   - Ask a spreadsheet: one read-only SQL question over a spreadsheet in the library that was added from a workspace file
     (POST /api/data/ask), answered with the engine's table and a bar chart drawn from its rows. Once the engine has said
     the file's columns, a ready-made question per text column ("By <column>": the first number column summed by it) is
     offered; its words are the column's own. "Save as a report" keeps the table as a Markdown document in Library ›
     Documents (POST /api/documents {name, text}), the one place the engine keeps a finished text.
   - Compare or edit exactly: two library documents compared by the engine's documents.compare (POST /api/action, a read).
     "Save the comparison" keeps what the engine found as a Markdown document the same way. "Make the edit" stays greyed:
     an exact edit is a change a Trunk makes from a request (documents.edit, a task's tool), and the window has no
     request to draw.
   - Labels (Advanced): the engine's label catalogue (GET /api/labels); a label shows only the documents that carry it.
   - Map: a picture of the first map the engine has built (GET /api/knowledge/extras): its most-mentioned names as topics
     (POST /api/knowledge/graph/names), each joined to the documents its links were read from (POST /api/knowledge/graph,
     one hop around each topic; every link carries its passage's document). Ask the map: a name shows what the documents
     say about it.
   - Managing what it reads (Advanced): knowledge bases (GET /api/knowledge), a guided tour of this workspace's code
     (POST /api/learn/tour, refused in the engine's words while switched off), synced sources (GET /api/asks/sources;
     "Sync now" brings in what is new from the owner's own sources, POST /api/asks/sources/sync, refused in the engine's
     words while that part is off) and kept pages (GET /api/asks/pages). Merging, starting the tour in a conversation and
     writing an article stay greyed: each needs words from the owner the dialog has no place for.
   Memory › How it learns (Advanced): patterns it noticed (GET /api/memory/learned; Keep all stages them and accepts each,
   POST /api/memory/learned then /api/memory/proposals/<id>/accept), the timeline (GET /api/learning-more/journey), the
   versions of the newest fact (GET /api/memory/versions, put back with POST /api/memory/versions/restore), forgetting what
   one conversation taught (POST /api/memory/forget/preview, then /api/memory/forget), checkpoints (GET and POST
   /api/memory/checkpoints) and bringing memories in from a JSON Lines file (POST /api/memory/import). */

import { esc, renderNow } from "../core/dom.js";
import { E, level, refresh, ownName } from "../core/state.js";
import { ic, toast, openDlg, closeDlg, dialog } from "../core/ui.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { onDemo17, demoPlace17, demoDlg17 } from "./demo17.js";
import { startWith } from "../chat/chat.js";
import { list17, when17 } from "./parts17.js";
import { t, language } from "../../i18n.js";
import { gsel } from "../core/gsel.js";

const L = { labels: { catalog: [], labels: [] }, label: null, graph: null, names: [], kg: null, links: [], problem: "", picture: { topics: [], docs: [], edges: [] } };
const askable = (d) => Boolean(d.filePath || d.uploaded) && /\.(csv|tsv|json|xlsx)$/i.test(d.filePath ?? d.name);
const tableName = (path) => { const base = String(path).split("/").pop().replace(/\.[a-z0-9]+$/i, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 39); return /^[a-z]/.test(base) ? base : `t_${base || "data"}`.slice(0, 40); };
const documents = async () => (await api("documents")).documents ?? [];

/* ---------- Work with documents ---------- */
export function workSection() {
  const tools = [["sqlb17", "term", t("window.places.library17.ask-a-spreadsheet"), t("window.places.library17.questions-in-plain-words-or-sql")], ["doccmpb17", "doc", t("window.places.library17.compare-or-edit-exactly"), t("window.places.library17.what-changed-between-two-versions-and")]];
  const labels = level() >= 1 && L.labels.catalog.length ? `<div class="labels-b17" role="group" aria-label="${t("onscreen.labels")}"><span>${t("onscreen.labels")}</span>${L.labels.catalog.map((l) => `<button type="button" class="chip-b17" data-act="labelb17" data-v="${esc(l.label)}" aria-pressed="${L.label === l.label}">${esc(l.label)} <em>${esc(l.count)}</em></button>`).join("")}</div>` : "";
  return `<div class="sec x15-sec"><h2>${t("window.places.library17.work-with-documents")}</h2><div class="tools-b17">${tools.map(([a, i, t, s]) => `<button type="button" class="tool-b17" data-act="${a}"><span class="ico-tile">${ic(i, "s")}</span><span><b>${t}</b><small>${s}</small></span></button>`).join("")}</div>${labels}</div>`;
}
/* The documents a chosen label leaves showing; every document while none is chosen. */
export function labelled(docs) {
  if (!L.label) return docs;
  const ids = new Set(L.labels.labels.filter((x) => x.target === "document" && x.label === L.label).map((x) => x.targetId));
  return docs.filter((d) => ids.has(d.id));
}

/* ---------- Ask a spreadsheet ---------- */
const SQ = { files: [], f: null, sql: "", result: null, types: {}, q: null };
const quote = (name) => `"${String(name).replace(/"/g, '""')}"`;
/* "By <column>": for each text column the engine named, the first number column summed by it, largest first. */
function questions() {
  const cols = SQ.types[SQ.f]?.columns ?? [], table = SQ.types[SQ.f]?.table;
  const num = cols.find((c) => c.type === "number");
  if (!num || !table) return [];
  return cols.filter((c) => c.type === "text").slice(0, 3).map((c) => [t("window.places.library17.by-value", { value: c.name }),
    `SELECT ${quote(c.name)}, SUM(${quote(num.name)}) AS total FROM ${table} GROUP BY ${quote(c.name)} ORDER BY total DESC`]);
}
function sqlChart(columns, rows) {
  if (columns.length !== 2 || !rows.length || !rows.every((r) => typeof r[1] === "number")) return "";
  const mx = Math.max(...rows.map((r) => Math.abs(r[1]))) || 1, h = 24;
  return `<svg class="chart-b17" viewBox="0 0 320 ${rows.length * h + 6}" role="img" aria-label="${t("window.places.library17.bar-chart-of-the-result")}">${rows.map(([l, v], i) => `<text x="0" y="${i * h + 16}">${esc(String(l).slice(0, 18))}</text><rect x="110" y="${i * h + 5}" width="${Math.max(2, (Math.abs(v) / mx) * 160).toFixed(1)}" height="14" rx="3"/><text class="v-b17" x="${(116 + (Math.abs(v) / mx) * 160).toFixed(1)}" y="${i * h + 16}">${esc(v.toLocaleString(language()))}</text>`).join("")}</svg>`;
}
function sqlResult() {
  const r = SQ.result;
  if (!r) return `<p class="hint" data-css="margin:0">${t("window.places.library17.run-it-to-see-the-table")}</p>`;
  const head = r.columns.map((c) => `<th>${esc(c)}</th>`).join("");
  const body = r.rows.map((row) => `<tr>${row.map((v) => `<td>${esc(v === null ? "" : typeof v === "number" ? v.toLocaleString(language()) : v)}</td>`).join("")}</tr>`).join("");
  return `<div class="res-b17"><table class="tbl-b17"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>${sqlChart(r.columns, r.rows)}</div>`;
}
function drawSql() {
  const files = SQ.files.map((d) => `<button type="button" data-act="sqlfileb17" data-v="${esc(d.id)}" aria-pressed="${SQ.f === d.id}">${esc(d.name)}</button>`).join("");
  const chips = questions().map(([l], i) => `<button type="button" class="chip-b17" data-act="sqlqb17" data-i="${i}" aria-pressed="${SQ.q === i}">${esc(l)}</button>`).join("");
  openDlg({ title: t("window.places.library17.ask-a-spreadsheet"), wide: true,
    body: `<button class="btn" type="button" data-act="sqlimportb17">${t("window.places.library17.import-spreadsheet")}</button>${!files ? `<p class="hint">${t("window.places.library17.import-spreadsheet-hint")}</p>` : ""}<div class="seg" role="group" aria-label="${t("window.places.library17.file")}">${files}</div>${chips ? `<div class="chips-b17">${chips}</div>` : ""}<label for="sql-q-b17">SQL</label><textarea class="inp sql-b17" id="sql-q-b17" rows="3" aria-label="SQL" spellcheck="false">${esc(SQ.sql)}</textarea>${sqlResult()}<p class="hint" data-css="margin:0">${t("window.places.library17.read-only-only-select-runs-and")}</p>`,
    foot: `${SQ.result ? `<button class="btn ghost" type="button" data-act="sqlsaveb17">${t("window.places.library17.save-as-a-report")}</button>` : ""}<button class="btn pri" type="button" data-act="sqlrunb17" ${SQ.f ? "" : "disabled"}>${SQ.result ? t("window.places.library17.run-again") : t("commands.dashboard.run")}</button>` });
}
async function openSql() {
  try { SQ.files = (await documents()).filter(askable); } catch (error) { toast(error.message); return; }
  if (!SQ.files.some((d) => d.id === SQ.f)) pickFile(SQ.files[0]?.id ?? null);
  drawSql();
}
function pickFile(id) {
  SQ.f = id;
  SQ.result = null;
  SQ.q = null;
  const doc = SQ.files.find((d) => d.id === id);
  SQ.sql = doc ? `SELECT * FROM ${tableName(doc.filePath ?? doc.name)}` : "";
}
function importSpreadsheet() {
  SQ.sql = document.getElementById("sql-q-b17")?.value ?? SQ.sql;
  const input = Object.assign(document.createElement("input"), { type: "file", accept: ".csv,.tsv,.json,.xlsx" });
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) { toast(t("window.places.library17.import-spreadsheet-limit")); return; }
    try {
      const content = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1]);
        reader.onerror = () => reject(new Error(t("window.places.library17.import-spreadsheet-read-error")));
        reader.readAsDataURL(file);
      });
      const doc = await api("documents", { name: file.name, content });
      SQ.files = (await documents()).filter(askable);
      pickFile(doc.id);
      drawSql();
    } catch (error) { toast(error.message); }
  });
  input.click();
}
async function runSql() {
  SQ.sql = document.getElementById("sql-q-b17")?.value ?? SQ.sql;
  try { SQ.result = await api("data/ask", { document: SQ.f, sql: SQ.sql }); } catch (error) { toast(error.message); return; }
  if (SQ.result.types?.length) SQ.types[SQ.f] = { table: SQ.result.table, columns: SQ.result.types };
  drawSql();
}
function pickQuestion(i) {
  const q = questions()[i];
  if (!q) return;
  SQ.q = i;
  SQ.sql = q[1];
  SQ.result = null;
  drawSql();
}
/* A result as a Markdown table, every cell the engine's. */
const cellText = (v) => String(v ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
const mdTable = (columns, rows) => [`| ${columns.map(cellText).join(" | ")} |`, `| ${columns.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.map(cellText).join(" | ")} |`)].join("\n");
async function keep(name, text) {
  try { await api("documents", { name, text }); } catch (error) { toast(error.message); return; }
  closeDlg();
  toast(t("window.shell.extras.saved-as-markdown-to-documents"));
}
function saveReport() {
  const doc = SQ.files.find((d) => d.id === SQ.f), r = SQ.result;
  if (!doc || !r) return;
  const label = SQ.q !== null ? questions()[SQ.q]?.[0] : "";
  const base = doc.name.replace(/\.[a-z0-9]+$/i, "");
  keep(`${[base, label].filter(Boolean).join(", ")}.md`, `# ${[base, label].filter(Boolean).join(", ")}\n\n\`\`\`sql\n${SQ.sql}\n\`\`\`\n\n${mdTable(r.columns, r.rows)}\n`);
}

/* ---------- Compare or edit exactly ---------- */
const DC = { mode: "compare", docs: [], a: null, b: null, result: null };
const docSelect = (id, value) => gsel({ id, sw: id, label: id === "doc-a-b17" ? t("window.places.library17.first-document") : t("window.places.library17.second-document"), options: DC.docs.map((d) => [d.id, d.name]), value });
function compareBody() {
  const r = DC.result;
  const diffs = r ? `<p class="lead-b17">${esc(r.summary)}</p><div class="diffs-b17">${r.changes.map((c) => `<div class="dif-b17"><small>${esc(c.section)}</small>${c.before ? `<del>${esc(c.before)}</del>` : ""}${c.after ? `<ins>${esc(c.after)}</ins>` : ""}</div>`).join("")}</div><p class="hint" data-css="margin:0">${t("window.places.library17.the-other-unchanged-paragraphs-are-identical", { unchanged: esc(r.unchanged) })}</p>` : "";
  return `<div class="test-b17">${docSelect("doc-a-b17", DC.a)}${docSelect("doc-b-b17", DC.b)}</div>${diffs}`;
}
function drawDoc() {
  const m = DC.mode;
  openDlg({ title: m === "compare" ? t("window.places.library17.compare-two-documents") : t("window.places.library17.edit-exactly"), wide: true,
    body: `<div class="seg" role="group" aria-label="${t("addons.filters.action")}">${[["compare", t("action.compare")], ["edit", t("window.places.library17.edit-exactly")]].map(([v, l]) => `<button type="button" data-act="docmodeb17" data-v="${v}" aria-pressed="${m === v}">${l}</button>`).join("")}</div>${m === "compare" ? compareBody() : ""}`,
    foot: m === "compare" ? `<button class="btn" type="button" data-act="dlg-close">${t("delight.ach.close")}</button><button class="btn pri" type="button" data-act="docsaveb17" data-v="compare" ${DC.result ? "" : "disabled"}>${t("window.places.library17.save-the-comparison")}</button>` : `<button class="btn ghost" type="button" data-act="dlg-close">${t("updates.busy.cancel")}</button><button class="btn pri" type="button" data-act="docedit17" data-v="edit">${t("window.places.library17.make-the-edit")}</button>` });
}
async function compareNow() {
  const a = DC.docs.find((d) => d.id === DC.a), b = DC.docs.find((d) => d.id === DC.b);
  DC.result = null;
  if (a && b && a !== b) {
    try { DC.result = await api("action", { tool: "documents.compare", args: { file: a.filePath, against: b.filePath } }); } catch (error) { toast(error.message); }
  }
  drawDoc();
}
function saveComparison() {
  const a = DC.docs.find((d) => d.id === DC.a), b = DC.docs.find((d) => d.id === DC.b), r = DC.result;
  if (!a || !b || !r) return;
  const title = t("window.places.library17.a-vs-b", { a: a.name, b: b.name });
  const changes = r.changes.map((c) => [`## ${c.section}`, c.before ? `- ${c.before}` : "", c.after ? `+ ${c.after}` : ""].filter(Boolean).join("\n")).join("\n\n");
  keep(`${title}.md`, `# ${title}\n\n${r.summary}\n\n${changes}\n`);
}
async function openDoc() {
  try { DC.docs = (await documents()).filter((d) => d.filePath); } catch (error) { toast(error.message); return; }
  if (!DC.docs.some((d) => d.id === DC.a)) DC.a = DC.docs[1]?.id ?? null;
  if (!DC.docs.some((d) => d.id === DC.b)) DC.b = DC.docs[0]?.id ?? null;
  await compareNow();
}

/* ---------- Ask the map ---------- */
/* The picture: topics on the upper row, the documents they were read from below, a line for each topic-document pair. */
const spread = (n, i, w = 640, pad = 90) => (n > 1 ? pad + (i * (w - 2 * pad)) / (n - 1) : w / 2);
function mapPicture() {
  const { topics, docs, edges } = L.picture;
  if (!topics.length) return "";
  const at = new Map([...topics.map((name, i) => [`t:${name}`, [spread(topics.length, i), 70]]), ...docs.map((name, i) => [`d:${name}`, [spread(docs.length, i), i % 2 ? 250 : 200]])]);
  const lines = edges.map(([a, b]) => { const [x1, y1] = at.get(`t:${a}`), [x2, y2] = at.get(`d:${b}`); return `<line x1="${x1.toFixed(1)}" y1="${y1}" x2="${x2.toFixed(1)}" y2="${y2}"/>`; }).join("");
  const dot = (kind, name) => { const [x, y] = at.get(`${kind}:${name}`); return `<g class="${kind === "t" ? "topic15" : "doc15"}" transform="translate(${x.toFixed(1)} ${y})"><circle r="${kind === "t" ? 9 : 6}"/><text y="${kind === "t" ? -16 : 20}" text-anchor="middle">${esc(String(name).length > 20 ? `${String(name).slice(0, 19)}…` : String(name))}</text></g>`; };
  return `<div class="kmap15"><svg viewBox="0 0 640 300" role="img" aria-label="${t("window.places.library17.how-your-documents-connect")}">${lines}${topics.map((n) => dot("t", n)).join("")}${docs.map((n) => dot("d", n)).join("")}</svg><p class="hint" data-css="margin:6px 2px 0">${t("window.places.library17.topics-are-the-larger-dots")}</p></div>`;
}
export function mapSection(view) {
  if (view !== "map") return "";
  const chips = L.names.map((n) => `<button type="button" class="chip-b17" data-act="kgb17" data-v="${esc(n.name)}" aria-pressed="${L.kg === n.name}">${esc(n.name)}</button>`).join("");
  const links = L.kg ? `<ul class="kgl-b17">${L.links.map((k) => `<li><b>${esc(k.from)}</b> <span>${esc(k.relation)}</span> <b>${esc(k.to)}</b><small>${t("window.places.library17.from-value", { value: esc(k.citation?.document ?? "") })}</small></li>`).join("")}</ul>` : "";
  return `${mapPicture()}<div class="sec x15-sec kg-b17"><h2>${t("window.places.library17.ask-the-map")}</h2><p class="hint" data-css="margin:0 0 8px">${t("window.places.library17.pick-a-name-to-see-what")}</p><div class="chips-b17">${chips}</div>${links}</div>`;
}
async function askMap(el) {
  const name = el.dataset.v;
  if (L.kg === name) { L.kg = null; renderNow(); return; }
  try { L.links = (await api("knowledge/graph", { collection: L.graph, entity: name })).links ?? []; } catch (error) { toast(error.message); return; }
  L.kg = name;
  renderNow();
}

/* ---------- Managing what it reads ---------- */
const MANAGE = [
  ["kbmanage", "folder", ["Knowledge bases", "Folders it reads, kept as quotable passages. Rename, merge, split and choose how long they stay.", "Manage"]],
  ["learnfolder", "teach", ["Understand a folder", "A map of a folder, then a short guided tour of what’s in it.", "Try it"]],
  ["sources", "retry", ["Bring things in from other services", "Keeps a copy of chosen items from Drive, Notion or a notes vault, in sync.", "See sources"]],
  ["pages", "doc", ["Kept answers and long articles", "An answer you like becomes a page you can reopen; a long article is written section by section.", "See pages"]],
];
export const manageSection = () => (level() >= 1 ? `<div class="sec x15-sec"><h2>${t("window.places.library17.managing-what-it-reads")}</h2><div class="rows">${MANAGE.map(([k, i, w]) => demoPlace17(k, i, w)).join("")}</div></div>` : "");

/* ---------- Memory › How it learns ---------- */
const LEARN = [
  ["habits", "spark", ["Habits it noticed", "Patterns in how you work, offered as memories you keep or drop.", "See them"]],
  ["learnlog", "clock", ["What it learned, week by week", "A timeline of new facts, skills and habits, and where each came from.", "Open the timeline"]],
  ["factver", "retry", ["Earlier versions of a fact", "Every change to a fact is kept, so an older one can come back.", "See an example"]],
  ["forgetconv", "x", ["Forget what one conversation taught", "Removes every fact that came from one conversation, and nothing else.", "Choose one"]],
  ["memckpt", "shield", ["Memory checkpoints", "A snapshot of memory and every skill version, to go back to all at once.", "See checkpoints"]],
  ["memimport", "folder", ["Bring memories in", "From a JSON Lines file or an archive Branch exported, here or on another computer.", "Choose a file"]],
];
export const learnSection = () => (level() >= 1 ? `<div class="sec x15-sec"><h2>${t("window.places.library17.how-it-learns")}</h2><div class="rows">${LEARN.map(([k, i, w]) => demoPlace17(k, i, w)).join("")}</div></div>` : "");

const FV = { memory: null, versions: [] };
const FC = { session: null, remove: [] };

function registerManage() {
  onDemo17("kbmanage", { open: async () => {
    const { collections } = await api("knowledge");
    demoDlg17("kbmanage", { title: t("window.places.library17.knowledge-bases"), lead: t("window.places.library17.your-knowledge-bases"), rows: list17(collections).map((c) => [c.name, t("window.places.library17.documents-documents-chunks-passages", { documents: c.documents, chunks: c.chunks }), c.note ? ["warn", c.note] : null]) });
  } });
  /* Start the tour: the tour's steps are shown here; Start goes through them with Branch in a new conversation, which asks
     the model as any conversation does (chat/chat.js startWith). */
  onDemo17("learnfolder", { open: async () => {
    const tour = await api("learn/tour", { subject: "code", of: "" });
    demoDlg17("learnfolder", { title: t("window.places.library17.understand-a-folder"), go: t("action.start-the-tour"), rows: (tour.steps ?? []).map((s) => [`${s.order} · ${s.title}`, s.words, null]) });
  }, go: async () => { closeDlg(); await startWith(t("window.places.library17.tour-ask")); } });
  const openSources = async () => {
    const { status } = await api("asks/sources");
    demoDlg17("sources", { title: t("window.places.library17.bring-things-in-from-other-services"), lead: t("window.places.library17.syncing"), go: t("window.places.library17.sync-now"), rows: list17(status).map((s) => [s.id, [s.kind, s.syncedAt ? when17(s.syncedAt) : "", s.error].filter(Boolean).join(" · "), s.error ? ["warn", s.error.slice(0, 30)] : null]) });
  };
  /* One sync at a time: a second press while one is on its way is dropped, so the owner's sources are asked once. */
  let syncing = false;
  onDemo17("sources", { open: openSources, go: async (el) => {
    if (syncing) return;
    syncing = true;
    el.disabled = true;
    try { await api("asks/sources/sync", {}); await openSources(); } finally { syncing = false; el.disabled = false; }
  } });
  onDemo17("pages", { open: async () => {
    const { pages } = await api("asks/pages");
    demoDlg17("pages", { title: t("window.places.library17.kept-answers-and-long-articles"), lead: t("window.places.library17.kept"), go: t("window.places.library17.write-an-article"), rows: list17(pages).map((p) => [p.title, p.question || when17(p.updatedAt), null]) });
  } });
}

function registerLearn() {
  onDemo17("habits", { open: async () => {
    const { noticed } = await api("memory/learned");
    demoDlg17("habits", { title: t("window.places.library17.habits-it-noticed"), go: noticed.length ? t("window.places.library17.keep-all") : undefined, rows: noticed.map((n) => [n.text, n.evidence?.[0] ?? "", ["idle", t("window.places.customize.suggested")]]) });
  }, go: async () => {
    const { proposals } = await api("memory/learned", {});
    for (const p of proposals) await api(`memory/proposals/${encodeURIComponent(p.id)}/accept`, {});
    closeDlg();
    await refresh();
    toast(t("window.places.library17.kept-count-habits-each-one-is", { count: proposals.length }));
  } });
  onDemo17("learnlog", { open: async () => {
    const { entries } = await api("learning-more/journey?limit=50");
    demoDlg17("learnlog", { title: t("window.places.library17.what-it-learned-week-by-week"), rows: entries.map((e) => [e.title, [when17(e.at), e.detail].filter(Boolean).join(" · "), ["idle", e.kind]]) });
  } });
  onDemo17("factver", { open: openVersions, go: restoreVersion });
  onDemo17("forgetconv", { open: () => openForget(), go: forgetConversation });
  onDemo17("memckpt", { open: async () => {
    const { checkpoints } = await api("memory/checkpoints");
    demoDlg17("memckpt", { title: t("window.places.library17.memory-checkpoints"), lead: t("window.places.library17.checkpoints"), go: t("window.places.library17.make-one-now"), rows: checkpoints.map((c) => [when17(c.createdAt), t("window.places.library17.label-memories-facts-skills-skills", { label: c.label, memories: c.memories, skills: c.skills }), ["ok", t("window.places.kept")]]) });
  }, go: async () => {
    const made = await api("memory/checkpoints", {});
    closeDlg();
    toast(t("window.places.library17.checkpoint-made-memories-facts-and-skills", { memories: made.memories, skills: made.skills }));
  } });
  onDemo17("memimport", { open: importMemories });
}

/* The versions of the most recently changed fact that has more than one; the one before the current is offered back. */
async function openVersions() {
  const changed = (E.state?.memory ?? []).filter((m) => Number(m.revision) > 1);
  const newest = changed.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
  FV.memory = newest ?? null;
  FV.versions = newest ? (await api(`memory/versions?id=${encodeURIComponent(newest.id)}`)).versions ?? [] : [];
  const earlier = FV.versions.find((v) => v.revision < newest?.revision);
  demoDlg17("factver", { title: t("window.places.library17.earlier-versions-of-a-fact"), lead: newest?.data?.text ?? "", go: earlier ? t("window.places.library17.put-back-the-createdat-version", { createdAt: when17(earlier.createdAt) }) : undefined,
    rows: FV.versions.map((v) => [v.data?.text ?? "", when17(v.createdAt), v.revision === newest.revision ? ["ok", t("window.places.library17.current")] : ["idle", t("window.places.customize17.earlier")]]) });
}
async function restoreVersion() {
  const earlier = FV.versions.find((v) => v.revision < FV.memory?.revision);
  if (!earlier) return;
  await api("memory/versions/restore", { id: FV.memory.id, revision: earlier.revision });
  closeDlg();
  await refresh();
  toast(t("window.places.library17.put-back-value-the-newer-one", { value: earlier.data?.text ?? "" }));
}

/* Forgetting one conversation: the conversations to choose from, then what the engine would remove from the chosen one. */
async function openForget(sessionId = FC.session) {
  FC.session = sessionId;
  FC.remove = sessionId ? (await api("memory/forget/preview", { sessionId })).remove ?? [] : [];
  const title = (s) => ownName(s.sessionId ?? s.id) || s.opening || s.title || "";
  const chips = E.sessions.slice(0, 12).map((s) => `<button type="button" class="chip-b17" data-act="fconvb17" data-v="${esc(s.sessionId ?? s.id)}" aria-pressed="${(s.sessionId ?? s.id) === FC.session}">${esc(title(s))}</button>`).join("");
  demoDlg17("forgetconv", { title: t("window.places.library17.forget-what-one-conversation-taught"), go: FC.remove.length ? t("window.places.library17.forget-these-remove", { remove: FC.remove.length }) : undefined, rows: FC.remove.map((m) => [m.text, when17(m.createdAt), ["idle", t("window.places.library17.fact")]]) });
  dialog()?.querySelector(".dlg-b")?.insertAdjacentHTML("afterbegin", `<div class="chips-b17">${chips}</div>`);
}
async function forgetConversation() {
  const answer = await api("memory/forget", { sessionId: FC.session, ids: FC.remove.map((m) => m.id) });
  closeDlg();
  await refresh();
  toast(t("window.places.library17.forgot-value-facts-the-conversation-itself", { value: answer.removed?.length ?? answer.removed ?? 0 }));
}

/* Bringing memories in: a JSON Lines file (or an archive Branch exported), sent as the engine's import takes it. */
function importMemories() {
  const input = Object.assign(document.createElement("input"), { type: "file", accept: ".jsonl,.json,application/json" });
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const body = file.name.endsWith(".jsonl") ? { jsonl: text } : JSON.parse(text);
      const report = await api("memory/import", body);
      await refresh();
      if (!report.imported && report.skipped?.length) toast(report.skipped[0].reason);
      else toast(t("window.places.library17.brought-in-value-facts", { value: report.imported ?? 0 }));
    } catch (error) { toast(error.message); }
  });
  input.click();
}

/* ---------- reading ---------- */
async function readMap() {
  const { graphs } = await api("knowledge/extras");
  L.graph = list17(graphs)[0]?.collection ?? null;
  L.names = L.graph ? (await api("knowledge/graph/names", { collection: L.graph })).names ?? [] : [];
  const key = JSON.stringify([L.graph, L.names]);
  if (key === L.pictureKey) return; // the picture is read again only when the map's names change
  const topics = L.names.slice(0, 6).map((n) => n.name), docs = [], edges = [];
  for (const name of topics) {
    const { links = [] } = await api("knowledge/graph", { collection: L.graph, entity: name });
    for (const doc of new Set(links.map((k) => k.citation?.document).filter(Boolean))) {
      if (!docs.includes(doc)) { if (docs.length >= 8) continue; docs.push(doc); }
      edges.push([name, doc]);
    }
  }
  L.picture = { topics, docs, edges };
  L.pictureKey = key;
}
export async function readLibrary17(tab, view) {
  if (tab !== "documents") return { changed: false };
  const before = JSON.stringify([L.labels, L.names, L.picture]);
  try {
    L.labels = await api("labels");
    if (view === "map") await readMap();
  } catch (error) { return { changed: false, error }; }
  return { changed: JSON.stringify([L.labels, L.names, L.picture]) !== before };
}

export function initLibrary17() {
  markLive(["sqlimportb17", "sqlqb17", "sqlsaveb17", "docsaveb17", "sqlb17", "sqlfileb17", "sqlrunb17", "sw:sql-q-b17", "doccmpb17", "docmodeb17", "sw:doc-a-b17", "sw:doc-b-b17", "labelb17", "kgb17", "fconvb17"]);
  on("sqlimportb17", () => importSpreadsheet());
  on("sqlb17", () => openSql());
  on("sqlfileb17", (el) => { pickFile(el.dataset.v); drawSql(); });
  on("sqlrunb17", () => runSql());
  on("sqlqb17", (el) => pickQuestion(Number(el.dataset.i)));
  on("sqlsaveb17", () => saveReport());
  on("docsaveb17", () => saveComparison());
  on("doccmpb17", () => openDoc());
  on("docmodeb17", (el) => { DC.mode = el.dataset.v; drawDoc(); });
  on("labelb17", (el) => { L.label = L.label === el.dataset.v ? null : el.dataset.v; renderNow(); });
  on("kgb17", (el) => askMap(el));
  on("fconvb17", (el) => openForget(el.dataset.v).catch((error) => toast(error.message)));
  document.addEventListener("change", (e) => {
    const id = e.target?.id;
    if (id !== "doc-a-b17" && id !== "doc-b-b17") return;
    if (id === "doc-a-b17") DC.a = e.target.value; else DC.b = e.target.value;
    compareNow();
  });
  registerManage();
  registerLearn();
}
