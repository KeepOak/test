/* A project's own place, 1:1 with the prototype's renderProject(): the "Project" hint, its name, its conversations, its
   instructions and a new conversation in it. Everything drawn is the engine's (src/projects.ts, src/owner-data-api.ts):
   - GET /api/projects answers { active, all, conversations: { <id>: count } };
   - GET /api/projects/<id>/conversations the conversations whose latest task ran under it, newest first;
   - POST /api/projects saves a project whole: its schema is strict, so a body is built from the project's own fields;
   - POST /api/projects/active makes one the project new tasks are filed under (src/store.ts createRun), which is why
     starting a conversation in a project makes it the active one; opening a project's page only shows it, as the
     prototype's own project action does;
   - POST /api/projects/<id>/remove removes one and the secrets saved in it, never its conversations; the default project
     cannot be removed.
   The engine keeps a project's instructions as text, not as a PROJECT.md file, and a project has no note, so neither is
   shown. Projects are the owner's: a household person is refused them, so nothing of them is drawn for one. */

import { $, esc, render, renderNow, onRender } from "../core/dom.js";
import { S, E, ownerHere, projectName, chatFace, ownName } from "../core/state.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { ic, av, openDlg, closeDlg, toast } from "../core/ui.js";
import { markLive } from "../core/features.js";
import { text } from "../chat/markdown.js";
import { startConversation } from "../chat/chat.js";
import { t } from "../../i18n.js";

/* The engine's projects and how many conversations each has, shared with the sidebar (shell.js) and Settings › General. */
export const P = { all: [], counts: {}, active: null };
/* Each project page's conversations, by project id: { sessions, at, failed }, where sessions is null until the engine has
   answered, so an empty list is only ever a real one. `inFlight` holds the ids whose read is still in flight: each page
   has its own, so a slow read of one project never holds up another's. */
const pages = new Map(), inFlight = new Set();
const page = (id) => pages.get(id) ?? { sessions: null, at: 0, failed: false };
/* The fields a project is saved with (src/projects.ts ProjectSchema); anything else would be refused. */
const FIELDS = ["id", "name", "instructions", "modelPreset", "repository", "folder", "profile", "knowledgeBases", "branch"];
const fields = (pr) => Object.fromEntries(FIELDS.filter((key) => key in pr).map((key) => [key, pr[key]]));
const byId = (id) => P.all.find((pr) => pr.id === id);

export async function loadProjects() {
  const got = await api("projects");
  P.all = got.all ?? [];
  P.counts = got.conversations ?? {};
  P.active = got.active?.id ?? null;
}

const count = (id) => P.counts[id] ?? 0;
export const conversationsWord = (id) => t(count(id) === 1 ? "window.places.project.conversation-one" : "window.places.project.conversations-many", { n: count(id) });

/* The sidebar's rows, as the prototype's: the name, its conversation count on the right, and New project at the end. */
export const projectRows = () => (!ownerHere() ? "" : P.all.map((pr) => `<button class="nav" type="button" data-act="project" data-v="${esc(pr.id)}" aria-current="${S.view === "project" && S.project === pr.id}">${ic("folder", "s")}${esc(projectName(pr))}<span class="proj-n">${count(pr.id)}</span></button>`).join("")
  + `<button class="nav" type="button" data-act="proj-new">${ic("plus", "s")}${t("action.new-project")}</button>`);

const lines = (words) => {
  const kept = (words ?? "").replace(/\s+$/, ""), n = kept ? kept.split("\n").length : 0;
  return n ? t(n === 1 ? "window.places.project.line-one" : "window.places.project.lines-many", { n }) : t("agent-files.empty");
};

const convRow = (s) => `<div class="prow">${av(chatFace(s.sessionId), 34)}<span class="grow"><b>${esc(ownName(s.sessionId) || s.opening || t("comfort.field.newConversation"))}</b><small>${esc(s.lastMessage ?? "")}</small></span><button class="btn sm" type="button" data-act="chat" data-id="${esc(s.sessionId)}">${t("ov.open")}</button></div>`;

function conversations(id) {
  const { sessions } = page(id);
  if (sessions === null) return "";
  return sessions.length ? sessions.map(convRow).join("") : `<p class="hint">${t("field.no-conversations-yet")}</p>`;
}

export function draw() {
  const pr = byId(S.project);
  if (!pr) return `<main class="main enter11" id="main"><div class="scroll"><div class="place"></div></div></main>`;
  const name = esc(projectName(pr)), id = esc(pr.id);
  const remove = pr.id === "default" ? "" : `<button class="btn ghost" type="button" data-act="proj-remove" data-v="${id}">${t("action.remove-project")}</button>`;
  return `<main class="main enter11" id="main"><div class="scroll"><div class="place">
    <p class="hint proj-hint">${ic("folder", "s")}${t("field.project")}</p><h1>${name}</h1>
    <div class="sec"><h2>${t("window.places.project.conversations")}</h2><div class="rows">${conversations(pr.id)}</div></div>
    <div class="sec"><h2>${t("field.instructions-for-this-project")}</h2><div class="frow proj-frow"><span><b>${t("window.places.project.read-before", { name })}</b><small>${lines(pr.instructions)}</small></span><button class="btn sm" type="button" data-act="proj-edit" data-v="${id}">${t("prompts.action.edit")}</button></div></div>
    <div class="acts proj-acts"><button class="btn" type="button" data-act="proj-newconv" data-v="${id}">${ic("plus", "s")}${t("window.places.project.new-conversation-in", { name })}</button><span class="tb-grow"></span><button class="btn ghost" type="button" data-act="proj-rename" data-v="${id}">${t("accounts.action.rename")}</button>${remove}</div>
  </div></div></main>`;
}

/* Runs after every draw of the page, so it reads again at most every few seconds, and draws only when something changed. */
export function after() {
  const id = S.project, was = page(id);
  if (!id || inFlight.has(id) || was.failed || Date.now() - was.at < 3000) return;
  inFlight.add(id);
  Promise.all([api(`projects/${encodeURIComponent(id)}/conversations`), loadProjects()]).then(([got]) => {
    const before = JSON.stringify(page(id).sessions), sessions = got.sessions ?? [];
    pages.set(id, { sessions, at: Date.now(), failed: false });
    const shown = S.view === "project" && S.project === id;
    if (shown && (JSON.stringify(sessions) !== before || !byId(id))) render();
  }, (error) => { pages.set(id, { ...page(id), at: Date.now(), failed: true }); toast(error.message); })
    .finally(() => { inFlight.delete(id); });
}

/* Opening a project only shows its page (the prototype's project action): the active project changes when a conversation
   is started in it. Its conversations are read again on opening; one read still in flight for it is kept, not repeated. */
function openProject(id) {
  S.view = "project";
  S.project = id;
  pages.delete(id);
  $("#app")?.classList.remove("side-open");
  renderNow();
}

async function newConversationIn(id) {
  try { P.active = (await api("projects/active", { active: id })).id; } catch (error) { toast(error.message); return; }
  startConversation();
}

/* The instructions editor, as the prototype's file editor: the words and how they read, side by side. */
function editDlg(id) {
  const pr = byId(id);
  if (!pr) return;
  openDlg({ title: t("field.instructions-for-this-project"), wide: true,
    body: `<div class="split"><textarea id="proj-text" maxlength="4000" aria-label="${t("field.instructions-for-this-project")}">${esc(pr.instructions)}</textarea><div class="prev" id="proj-prev">${text(pr.instructions)}</div></div>`,
    foot: `<button class="btn ghost" type="button" data-act="dlg-close">${t("first-run-steps.restore-no")}</button><button class="btn pri" type="button" data-act="proj-save" data-v="${esc(pr.id)}">${t("action.save")}</button>` });
}

async function save(id, change) {
  const pr = byId(id);
  if (!pr) return false;
  try {
    const saved = await api("projects", { ...fields(pr), ...change });
    P.all = P.all.map((p) => (p.id === saved.id ? saved : p));
  } catch (error) { toast(error.message); return false; }
  closeDlg();
  renderNow();
  return true;
}

function nameDlg(title, act, id, name) {
  openDlg({ title, body: `<div class="field"><label for="proj-name">${t("accounts.field.name")}</label><input class="inp" id="proj-name" maxlength="80" value="${esc(name)}"></div>`,
    foot: `<button class="btn ghost" type="button" data-act="dlg-close">${t("first-run-steps.restore-no")}</button><button class="btn pri" type="button" data-act="${act}" data-v="${esc(id)}">${t("action.save-project")}</button>` });
  setTimeout(() => $("#proj-name")?.select(), 0);
}
const typedName = () => {
  const name = ($("#proj-name")?.value ?? "").trim();
  if (!name) $("#proj-name")?.setAttribute("aria-invalid", "true");
  return name;
};

/* A new project's id is made from its name, and never one already in use: saving an id that exists replaces that project.
   Nor one the engine keeps for its own secrets (src/projects.ts reservedProjectId), which the owner never chose. */
const reserved = (id) => id === "model-connections" || id === "branch-safety" || /^acct-[0-9a-f]{12}$/.test(id);
function newId(name) {
  const base = name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "project";
  const taken = new Set(P.all.map((pr) => pr.id));
  let id = base;
  for (let n = 2; taken.has(id) || reserved(id); n++) id = `${base}-${n}`;
  return id;
}

async function create() {
  const name = typedName();
  if (!name) return;
  try {
    await loadProjects();
    const made = await api("projects", { id: newId(name), name });
    await loadProjects();
    closeDlg();
    openProject(made.id);
  } catch (error) { toast(error.message); }
}

function removeDlg(id) {
  const pr = byId(id);
  if (!pr || pr.id === "default") return;
  openDlg({ title: t("action.remove-project"), body: `<p data-css="margin:0">${t("window.places.project.remove-confirm", { name: esc(projectName(pr)) })}</p>`,
    foot: `<button class="btn ghost" type="button" data-act="dlg-close">${t("first-run-steps.restore-no")}</button><button class="btn bad" type="button" data-act="proj-remove-yes" data-v="${esc(pr.id)}">${t("action.remove-project")}</button>` });
}

async function remove(id) {
  try {
    await api(`projects/${encodeURIComponent(id)}/remove`, {});
    await loadProjects();
  } catch (error) { toast(error.message); return; }
  closeDlg();
  if (S.project === id) { S.project = null; S.view = "chat"; }
  renderNow();
}

/* While the sidebar's fold is open its counts follow the engine: read again when a conversation or a task comes or goes. */
let seen = "", reading = false;
function followCounts() {
  if (!S.projOpen || !ownerHere() || reading) return;
  const runs = E.state?.runs ?? [], now = [E.sessions.length, E.sessions[0]?.sessionId, runs.length, runs[0]?.id, runs.at(-1)?.id].join("|");
  if (now === seen) return;
  const first = !seen;
  seen = now;
  if (first) return;
  reading = true;
  loadProjects().then(() => render(), (error) => toast(error.message)).finally(() => { reading = false; });
}

export function init() {
  onRender(followCounts);
  markLive(["project", "proj-new", "proj-newconv", "proj-edit", "proj-save", "proj-rename", "proj-rename-save", "proj-create", "proj-remove", "proj-remove-yes", "sw:proj-text", "sw:proj-name"]);
  on("project", (el) => openProject(el.dataset.v));
  on("proj-newconv", (el) => newConversationIn(el.dataset.v));
  on("proj-edit", (el) => editDlg(el.dataset.v));
  on("proj-save", (el) => save(el.dataset.v, { instructions: $("#proj-text")?.value ?? "" }));
  on("proj-rename", (el) => nameDlg(t("accounts.action.rename"), "proj-rename-save", el.dataset.v, byId(el.dataset.v)?.name ?? ""));
  on("proj-rename-save", (el) => { const name = typedName(); if (name) save(el.dataset.v, { name }); });
  on("proj-new", () => nameDlg(t("action.new-project"), "proj-create", "", ""));
  on("proj-create", () => create());
  on("proj-remove", (el) => removeDlg(el.dataset.v));
  on("proj-remove-yes", (el) => remove(el.dataset.v));
  document.addEventListener("input", (e) => { if (e.target.id === "proj-text") { const prev = $("#proj-prev"); if (prev) prev.innerHTML = text(e.target.value); } });
  document.addEventListener("keydown", (e) => {
    if (e.target.id !== "proj-name" || e.key !== "Enter") return;
    e.preventDefault();
    document.querySelector('.dlg [data-act="proj-create"], .dlg [data-act="proj-rename-save"]')?.click();
  });
}
