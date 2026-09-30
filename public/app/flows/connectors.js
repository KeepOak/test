/* Adding a tool, from Customize › Tools (design doc 5.7, the prototype's toolAdd): a connector, a skill, a command-line
   tool or another agent.
   - The connector catalogue is the engine's (GET /api/mcp/catalogue), searched and filtered by category here. Choosing a
     connector fills "Add your own MCP server" with what the catalogue knows of it (its name, and its address or command
     where the catalogue lists one), so every server is added the one way: POST /api/mcp/servers. The engine saves a
     server that starts a program switched off; switching it on asks for the owner's yes (Customize › Tools).
   - "Test it" stays greyed: trying a server starts the typed program (POST /api/mcp/try) without the approval gate.
   - A command-line tool: the tools the engine found on this computer (GET /api/clis), each allowed through POST
     /api/clis by its name, or one added by its full address (Enter in the path box).
   - The skill library browses the owner's curated HTTPS registry sources, inspects the actual document/hash/signature
     and static scan, then asks explicit approval for an inactive install. A file's SKILL.md goes to POST
     /api/skills/install. GitHub skill-github.js inspects one pinned public tree and installs only the owner's exact
     approved preview, switched off.
   - Another agent with an A2A card: its address goes to POST /api/agents/remote {cardUrl}; the engine reads its card
     (refusing a private or local address unless the owner allowed those) and keeps it. Branch on another computer is
     pairing (POST /api/agents/pair), held back for the security review; an agent on a KeepOak computer needs keepoak.com,
     which the engine does not reach. Both stay greyed. */

import { $, esc, renderNow, paint } from "../core/dom.js";
import { openDlg, closeDlg, closePop, toast, ic } from "../core/ui.js";
import { refresh } from "../core/state.js";
import { api } from "../core/api.js";
import { initGitHubSkills } from "./skill-github.js";
import { on } from "../core/actions.js";
import { markLive, greyOut } from "../core/features.js";
import { logo } from "../core/logos.js";
import { showTool, reloadTools } from "../places/customize.js";
import { t } from "../../i18n.js";
import { initSkillMarketplace } from "./skill-marketplace.js";

const prov = (act, v, icon, name, sub) => `<button class="prov" type="button" data-act="${act}" data-v="${v}">${icon}<b>${name}</b><small>${sub}</small></button>`;
const tile = (name) => `<span class="ico-tile">${ic(name, "s")}</span>`;
const CAT = { list: [], count: 0, q: "", cat: "All", entry: null };

/* ---------- the connector catalogue ---------- */
function catalogueList() {
  const q = CAT.q.trim().toLowerCase();
  const groups = CAT.list.filter((g) => CAT.cat === "All" || g.category === CAT.cat).map((g) => {
    const f = g.connectors.filter((c) => !q || c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q));
    return f.length ? `<div class="aa-grp12"><h3>${esc(g.category)} <span>${f.length}</span></h3><div class="provs">${f.map((c) => `<button class="prov prov12" type="button" data-act="mcp-add" data-v="${esc(c.id)}" data-tip="${esc(c.needs)}">${logo(c.id, c.name, 32)}<b>${esc(c.name)}</b><small>${esc(c.description)}</small></button>`).join("")}</div></div>` : "";
  }).join("");
  return groups || `<p class="empty">${t("window.flows.conn.nothing")}</p>`;
}
function catalogueBody() {
  /* "All" stays the tab's value; only its label follows the language. The categories are the engine's words. */
  const tabs = ["All", ...CAT.list.map((g) => g.category)].map((c) => `<button class="tab" type="button" aria-selected="${CAT.cat === c}" data-act="mcp-cat" data-v="${esc(c)}">${c === "All" ? t("look.filter.all") : esc(c)}</button>`).join("");
  return `<p data-css="margin:0 0 10px">${t("window.flows.conn.ready", { count: CAT.count })}</p><div class="ch-top12"><label class="set-search" data-css="margin:0;flex:1">${ic("search", "s")}<input id="mcp-q" value="${esc(CAT.q)}" placeholder="${t("window.flows.conn.search")}" aria-label="${t("window.flows.conn.search")}" autocomplete="off"></label></div>
    <div class="tabs aa-tabs12">${tabs}</div><div class="aa-list12">${catalogueList()}</div>`;
}
async function connectorCatalogue() {
  try {
    const got = await api("mcp/catalogue");
    CAT.list = got.categories ?? [];
    CAT.count = got.count ?? 0;
  } catch (error) { toast(error.message); return; }
  openDlg({ title: t("window.flows.conn.add-connector"), wide: true, body: catalogueBody(),
    foot: `<button class="btn ghost" type="button" data-act="dlg-close">${t("first-run-steps.restore-no")}</button><button class="btn" type="button" data-act="t9-own">${t("window.flows.conn.own")}</button>` });
}
/* Filtering redraws only the list and the tabs, so the search box keeps its caret. */
function redrawCatalogue() {
  const list = document.querySelector(".dlg .aa-list12");
  if (list) greyOut(paint(list, catalogueList()));
  for (const tab of document.querySelectorAll('.dlg [data-act="mcp-cat"]')) tab.setAttribute("aria-selected", String(tab.dataset.v === CAT.cat));
}

/* ---------- your own server ---------- */
function ownServer(entry = null) {
  CAT.entry = entry;
  const web = !entry?.command;
  const how = [t("window.flows.conn.command"), t("window.flows.conn.web")].map((o, i) => `<button type="button" data-act="mcp-how" data-v="${i ? "web" : "cmd"}" aria-pressed="${entry ? web === (i === 1) : i === 0}">${o}</button>`).join("");
  const reach = entry?.command ? entry.command.join(" ") : entry?.address ?? "";
  openDlg({ title: t("window.flows.conn.own-mcp"),
    body: `<div class="fld"><span>${t("window.flows.conn.how")}</span><span class="seg">${how}</span></div><label class="fld"><span>${t("accounts.field.name")}</span><input class="inp" id="mcp-name" value="${esc(entry?.name ?? "")}"></label><label class="fld"><span>${t("window.flows.conn.cmd")}</span><input class="inp code6" id="mcp-cmd" data-css="height:34px" value="${esc(reach)}"></label><label class="fld"><span>${t("window.flows.conn.secrets")}</span><input class="inp" id="mcp-secrets"></label><p class="hint" id="mcp-asks" data-css="margin:0" ${entry && web ? "hidden" : ""}>${t("window.flows.conn.asks-before-it-starts")}</p><div id="mcp-test"></div>`,
    foot: `<button class="btn" type="button" data-act="mcp-test">${t("window.flows.conn.test")}</button><button class="btn pri" type="button" data-act="mcp-save">${t("window.flows.conn.add-server")}</button>` });
}
/* Words on one line, a "quoted part" kept whole. */
const words = (line) => [...line.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]);
function typedServer() {
  const web = document.querySelector('.dlg [data-act="mcp-how"][data-v="web"]')?.getAttribute("aria-pressed") === "true";
  const reach = ($("#mcp-cmd")?.value ?? "").trim();
  const secrets = ($("#mcp-secrets")?.value ?? "").split(/[\s,]+/).filter((s) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s));
  if (web) return { transport: "http", url: reach, ...(secrets[0] ? { bearerEnv: secrets[0] } : {}) };
  const [command = "", ...args] = words(reach);
  return { transport: "stdio", command, args, envKeys: secrets };
}
async function saveServer() {
  const name = ($("#mcp-name")?.value ?? "").trim();
  try {
    const added = await api("mcp/servers", { name, server: typedServer(), ...(CAT.entry ? { catalogue: CAT.entry.id } : {}) });
    closeDlg();
    showTool("mcp", added.server.id);
    await reloadTools();
    renderNow();
    toast(added.said);
  } catch (error) { toast(error.message); }
}
function pickHow(el) {
  for (const b of el.parentElement.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b === el));
  $("#mcp-asks")?.toggleAttribute("hidden", el.dataset.v === "web"); // only a program on this computer is asked about
}

/* ---------- command-line tools ---------- */
const allowedPill = () => `<span class="pill ok"><i></i>${t("window.settings.self.allowed")}</span>`;
function cliRow(c) {
  const act = c.allowed ? allowedPill() : `<button class="btn sm" type="button" data-act="cli-add" data-v="${esc(c.name)}">${t("window.settings.permissions.rule-allow")}</button>`;
  return `<div class="prow"><span class="ico-tile">${ic("term", "s")}</span><span class="grow"><b>${esc(c.name)}</b><small>${esc(c.path)}</small></span>${act}</div>`;
}
async function addCliDialog() {
  let found;
  try { found = (await api("clis")).found ?? []; } catch (error) { toast(error.message); return; }
  openDlg({ title: t("window.flows.conn.add-cli"),
    body: `<p class="hint" data-css="margin:0 0 8px">${t("window.flows.conn.cli-found")}</p><div class="rows">${found.map(cliRow).join("")}</div><label class="fld" data-css="margin-top:12px"><span>${t("window.flows.conn.cli-path")}</span><input class="inp" id="cli-path"></label>`,
    foot: `<button class="btn ghost" type="button" data-act="dlg-close">${t("first-run-steps.done")}</button>` });
}
async function allowCli(body, el) {
  try {
    const added = await api("clis", body);
    if (el) el.outerHTML = allowedPill();
    else closeDlg();
    showTool("clis", added.program.name);
    await reloadTools();
    renderNow();
    toast(added.said);
  } catch (error) { toast(error.message); }
}

/* ---------- skills and agents ---------- */
function addSkill() {
  openDlg({ title: t("window.flows.conn.add-skill"),
    body: `<div class="provs">${prov("sk-lib", "lib", tile("book"), t("window.flows.conn.library"), t("window.flows.conn.library-hint"))}${prov("sk-src", "file", tile("doc"), t("window.flows.conn.file"), t("window.flows.conn.file-hint"))}${prov("sk-git", "git", logo("github", "GitHub", 32), t("window.flows.conn.github"), t("window.flows.conn.github-hint"))}${prov("sk-write", "write", tile("spark"), t("window.flows.conn.write"), t("window.flows.conn.write-hint"))}</div><input type="file" id="sk-file" accept=".md,text/markdown,text/plain" hidden>`,
    foot: `<button class="btn ghost" type="button" data-act="dlg-close">${t("first-run-steps.restore-no")}</button>` });
}

function connectAgent() {
  openDlg({ title: t("window.chat.beside.connect-agent"),
    body: `<div class="provs">${prov("ag-add", "card", tile("globe"), t("window.flows.conn.a2a"), t("window.flows.conn.a2a-hint"))}${prov("ag-pair", "pair", tile("monitor"), t("window.flows.conn.other-branch"), t("window.flows.conn.other-branch-hint"))}${prov("ag-ko", "ko", tile("layers"), t("window.flows.conn.keepoak"), t("window.flows.conn.keepoak-hint"))}</div><p class="hint">${t("window.flows.conn.a2a-card-too")}</p>`,
    foot: `<button class="btn ghost" type="button" data-act="dlg-close">${t("first-run-steps.restore-no")}</button>` });
}

/* An agent with an A2A card: its address, read by the engine. */
function agentCard() {
  openDlg({ title: t("window.flows.conn.a2a"),
    body: `<label class="fld"><span>${t("window.flows.conn.a2a-hint")}</span><input class="inp code6" id="ag-card" autocomplete="off" spellcheck="false" data-css="height:34px"></label>`,
    foot: `<button class="btn ghost" type="button" data-act="dlg-close">${t("first-run-steps.restore-no")}</button><button class="btn pri" type="button" data-act="ag-go">${t("action.connect")}</button>` });
}
async function addAgent() {
  const box = $("#ag-card"), cardUrl = (box?.value ?? "").trim();
  if (!cardUrl) { box?.setAttribute("aria-invalid", "true"); return; }
  try {
    const agent = await api("agents/remote", { cardUrl });
    closeDlg();
    showTool("agents", agent.id);
    await reloadTools();
    renderNow();
    toast(t("window.flows.conn.agent-connected", { name: agent.name }));
  } catch (error) { toast(error.message); }
}

/* The SKILL.md is sent as it is; the engine checks it, scans it and answers with the installed skill or its reason. */
async function installFile(file) {
  if (!file) return;
  try {
    const skill = await api("skills/install", { document: await file.text() });
    closeDlg();
    await refresh();
    showTool("skills", skill.id);
    renderNow();
    toast(t("window.flows.conn.skill-added"));
  } catch (error) { toast(error.message); }
}

const ADD = { mcp: connectorCatalogue, skills: addSkill, clis: addCliDialog, agents: connectAgent };
const entryOf = (id) => CAT.list.flatMap((g) => g.connectors).find((c) => c.id === id) ?? null;

export function init() {
  initSkillMarketplace();
  initGitHubSkills();
  markLive(["tool-add", "t9-own", "sk-src", "sw:sk-file", "mcp-cat", "sw:mcp-q", "mcp-add", "mcp-how", "mcp-save", "sw:mcp-name", "sw:mcp-cmd", "sw:mcp-secrets", "cli-add", "sw:cli-path", "ag-add", "ag-go", "sw:ag-card"]);
  on("ag-add", () => agentCard());
  on("ag-go", () => addAgent());
  /* A plugin has no add form the engine backs yet: the button opens that kind in Customize. */
  on("tool-add", (el) => { if (ADD[el.dataset.v]) ADD[el.dataset.v](); else { closePop(); showTool(el.dataset.v, null); renderNow(); } });
  on("t9-own", () => ownServer());
  on("mcp-cat", (el) => { CAT.cat = el.dataset.v; redrawCatalogue(); });
  on("mcp-add", (el) => ownServer(entryOf(el.dataset.v)));
  on("mcp-how", (el) => pickHow(el));
  on("mcp-save", () => saveServer());
  on("cli-add", (el) => allowCli({ name: el.dataset.v }, el));
  on("sk-src", () => $("#sk-file")?.click());
  document.addEventListener("change", (e) => { if (e.target.id === "sk-file") installFile(e.target.files?.[0]); });
  document.addEventListener("input", (e) => { if (e.target.id === "mcp-q") { CAT.q = e.target.value; redrawCatalogue(); } });
  document.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.id === "cli-path" && e.target.value.trim()) allowCli({ path: e.target.value.trim() }, null); });
}
