/* Customize: Trunks, Tools, Specialists, Channels, Everywhere. Every list is the engine's: the Trunks (E.trunks), the
   tool servers (your own from GET /api/mcp/servers, the launch file's from GET /api/mcp/connections), command-line tools
   (GET /api/clis: the ones you allowed and the launch file's), skills (E.state.skills), plugins (GET /api/plugins), other assistants
   (GET /api/agents/remote), suggested skills (GET /api/skills/suggest), better versions of skills
   (GET /api/skill-revisions) and the chat apps (GET /api/channel-setup, connected ones from GET /api/channels).
   A better version is tried, kept or thrown away through POST /api/skill-revisions/try|accept|reject; a suggested skill
   you have switched off is switched on through POST /api/skills/{id}/activate. */

import { esc, renderNow, paint } from "../core/dom.js";
import { S, E, refresh } from "../core/state.js";
import { ic, av, toast } from "../core/ui.js";
import { markLive, greyOut } from "../core/features.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { logo } from "../core/logos.js";
import { face, TEMPLATES, TEMPLATE_WORDS } from "../flows/trunk.js";
import { specLine, toolsSection, codingAgentsSection, initCustomize17 } from "./customize17.js";
import { t } from "../../i18n.js";
import { say } from "../core/words.js";
import { LEARN_ID, learnItem, learnTile, learnDetail, initLearn17d } from "./learn17d.js"; // pass 17 part D §3
import { offlineIn } from "../settings/pages/chatapps.js"; // pass 17 part D §8

function tabBar(tabs, place, current) {
  return `<div class="tabs" role="tablist">${tabs.map(([id, label, count]) =>
    `<button class="tab" role="tab" type="button" aria-selected="${id === current ? 'true' : 'false'}" data-act="ptab" data-place="${place}" data-v="${id}">${esc(label)}${count > 0 ? `<span class="n">${count}</span>` : ''}</button>`
  ).join('')}</div>`;
}

let channelSetup = [];
let connected = [];
let mcpServers = [];
let ownServers = [];
let clis = { programs: [], launch: [] };
let plugins = [];
let agents = [];
let suggestions = [];
let revisions = [];
let policyRules = [];
const T9 = { k: "mcp", sel: null };
const CH = { fam: "all", q: "" };

const KINDS = [
  ["mcp", "Connectors", "plug", "MCP servers: apps and data a Trunk can reach"],
  ["skills", "Skills", "bolt", "Step-by-step know-how, as SKILL.md"],
  ["plugins", "Plugins", "puzzle", "Packs of skills, servers and tools"],
  ["clis", "Command-line tools", "term", "Programs on this computer it may run"],
  ["agents", "Agents", "users", "Other assistants over A2A, and Trunks on other computers"],
];
/* Each kind's items as {id, name, sub}. Your own servers and tools carry `own`: they can be switched on or off (a
   server) and removed; the launch file's cannot be from here. */
function itemsOf(k) {
  if (k === "mcp") return [...ownServers.map((s) => ({ id: s.id, name: s.name, sub: s.how, error: s.error ?? "", own: s })),
    ...mcpServers.filter((s) => !ownServers.some((o) => o.id === s.id)).map((s) => ({ id: s.id, name: s.id, sub: s.summary ?? "", error: s.lastError ?? "" }))];
  if (k === "clis") return [...clis.programs.map((c) => ({ id: c.name, name: c.name, sub: c.path, own: c })), ...clis.launch.map((n) => ({ id: n, name: n, sub: "" }))];
  if (k === "skills") return [learnItem(), ...(E.state?.skills ?? []).map((s) => ({ id: s.id, name: s.activeName || s.name, sub: s.description ?? "" }))]; // pass 17 part D §3: learn-this first
  if (k === "plugins") return plugins.map((p) => ({ id: p.id ?? p.name, name: p.name ?? p.id, sub: p.description ?? "" }));
  if (k === "agents") return agents.map((a) => ({ id: a.name, name: a.name, sub: a.description ?? a.cardUrl ?? "" }));
  return [];
}
/* The add button: a server, a skill, a command-line tool or an agent opens its dialog; a plugin has its own. */
const ADD = { mcp: ["tool-add", "Add a server"], skills: ["tool-add", "Add a skill"], plugins: ["plug-add", "Add a plugin"], clis: ["tool-add", "Add a tool"], agents: ["tool-add", "Connect another agent"] };

function trunksTab() {
  const rows = E.trunks.map((tr) => `<div class="prow">${av(face(tr), 36)}<span class="grow"><b>${esc(tr.name)}${tr.paused ? ` · ${t("autonomy.orders.paused")}` : ""}</b><small>${esc(tr.title ?? "")}</small></span>
    <button class="btn sm" type="button" data-act="edit" data-id="${esc(tr.id)}">${t("prompts.action.edit")}</button>
    <button class="btn ghost sm" type="button" data-act="pausetrunk" data-id="${esc(tr.id)}">${tr.paused ? t("autonomy.resume") : t("autonomy.pause")}</button></div>`).join("");
  /* The jobs in the language in force (flows/trunk.js TEMPLATE_WORDS, the same jobs in the same order); the face keeps the job's own name. */
  const words = (i, n, x) => (TEMPLATE_WORDS[i] ? TEMPLATE_WORDS[i].map((key) => t(key)) : [n, x]);
  const jobs = TEMPLATES.map(([n, x, col, sh], i) => `<div class="tile"><div class="th">${av({ name: n, color: col, shape: sh }, 34)}<b>${esc(words(i, n, x)[0])}</b></div><p>${esc(words(i, n, x)[1])}</p><div class="acts"><button class="btn sm" type="button" data-act="tmpl" data-i="${i}">${t("window.places.customize.use-this-job")}</button></div></div>`).join("");
  return `<div class="rows"><div class="acts" data-css="margin:6px 0 4px"><button class="btn pri" type="button" data-act="chat" data-id="new">${ic('plus', 's')}${t("studio.tab.trunk")}</button>
    <button class="btn" type="button" data-act="grp-new">${ic('room', 's')}${t("window.places.customize.a-new-room")}</button></div>${rows}
    <div class="sec"><h2>${t("window.places.customize.start-from-a-job")}</h2><div class="grid2">${jobs}</div></div></div>`;
}

/* The engine's changed lines, as the file history writes them: "+" added, "-" taken out, anything else kept. */
const diffLines = (diff) => String(diff ?? "").split("\n").map((l) => `<span class="${l.startsWith("+") ? "d-add" : l.startsWith("-") ? "d-del" : ""}">${esc(l)}</span>`).join("");

/* The newest drafted version still waiting for a yes or a no. Each button names its skill and version, the exact body the
   engine's try, accept and reject take; switching a draft on without trying it (force) is never offered. */
function learnedCard() {
  const r = revisions.find((x) => !x.decision);
  if (T9.k !== "skills" || !r) return "";
  const at = `data-id="${esc(r.skillId)}" data-version="${esc(r.version)}"`;
  return `<div class="tile t9-learn"><div class="th"><b>${t("window.places.customize.a-better-version-of-skillname", { skillName: esc(r.skillName) })}</b><span class="pill work ml"><i></i>${t("window.places.customize.suggested")}</span></div><p>${t("window.places.customize.nothing-changes-on-its-own")}</p><pre class="diff6">${diffLines(r.diff)}</pre><div class="acts"><button class="btn sm" type="button" data-act="rev" data-v="tried" ${at}>${r.trial ? t("first-run-trouble.retry") : t("window.places.customize.practice-run-on-the-last-3")}</button><button class="btn pri sm" type="button" data-act="rev" data-v="kept" ${at}>${t("window.core.keep-it")}</button><button class="btn ghost sm" type="button" data-act="rev" data-v="gone" ${at}>${t("window.places.customize.throw-it-away")}</button></div></div>`;
}

/* A switched-off skill you already have is switched on (sugg15). One a registry lists would be installed from that
   registry (POST /api/registry/install), which this engine's network rules keep from being tried here, so its Add is
   drawn under its own name and stays greyed. */
function suggested() {
  if (T9.k !== "skills" || !suggestions.length) return "";
  return `<div class="sugg15"><h3>${t("window.places.customize.suggested-for-you")}</h3>${suggestions.map((s) => `<div class="sg-row15"><span class="grow"><b>${esc(s.name)}</b><small>${esc(s.description)}</small></span><button type="button" class="btn sm" data-act="${s.source === "installed" ? "sugg15" : "sugg15-reg"}" data-v="${esc(s.id)}">${t("asks.runtimes.add")}</button></div>`).join("")}</div>`;
}

/* What each of a server's tools may do: its tools are the engine's own list (GET /api/state tools, named mcp.<server>.…),
   shown by the description the server gave; the pressed choice is the approval rule that names that exact tool, else none.
   Every choice stays greyed (seg has no handler): changing one loosens or tightens approvals. */
const DECISIONS = [["allow", "Allowed"], ["ask", "Ask first"], ["deny", "Never"]];
function toolPerms(x) {
  const tools = (E.state?.tools ?? []).filter((t) => t.name.startsWith(`mcp.${x.id}.`));
  const rows = tools.map((t) => {
    const rule = policyRules.find((r) => r.tool === t.name);
    return `<div class="prow t9-perm"><code>${esc(t.description)}</code><span class="grow"></span><span class="seg">${DECISIONS.map(([d, l]) => `<button type="button" data-act="seg" aria-pressed="${rule?.decision === d}">${say(l)}</button>`).join("")}</span></div>`;
  }).join("");
  return `<div class="sec"><h2>${t("window.places.customize.what-each-tool-may-do")}</h2><div class="rows">${rows}</div></div>`;
}
/* A server that would not start says why, in the engine's words; trying again and its log stay greyed. */
const startProblem = (x) => (x.error ? `<div class="status"><span class="sdot bad"></span><div><b>${t("window.places.customize.it-didnt-start")}</b><p>${esc(String(x.error).replace(/\.$/, ""))}. <button class="link" type="button" data-act="tool-retry">${t("first-run-trouble.retry")}</button> · <button class="link" type="button" data-act="tool-log">${t("window.places.customize.see-its-log")}</button></p></div></div>` : "");
/* Remove is live for skills, and for your own servers and command-line tools (tool-rm). A launch-file server, a plugin
   or an agent here has no removal this window checks, so theirs is drawn disabled. Test it would start the server's
   program without the approval gate, and no route checks a server or a tool for updates, so both stay greyed. */
function detailActs(k, x) {
  const rmOff = k === "skills" || x.own ? "" : ` disabled aria-disabled="true" data-tip="${t("window.places.automations.coming-soon")}"`;
  const test = k === "mcp" ? `<button class="btn sm" type="button" data-act="tool-test">${t("window.places.customize.test-it")}</button>` : "";
  return `<div class="acts" data-css="margin-top:16px">${test}<button class="btn sm" type="button" data-act="tool-upd">${t("action.check-for-updates")}</button><span class="grow"></span><button class="btn ghost sm${rmOff ? " soon" : ""}" type="button" data-act="tool-rm" data-k="${k}" data-id="${esc(x.id)}"${rmOff}>${t("accounts.action.remove")}</button></div>`;
}
/* Which Trunks may use a server or a skill is drawn from each Trunk's own lists (servers by id, skills by name), and stays
   greyed: adding a server to a Trunk widens what it can reach. */
/* Branch's own assistant, by its name (state.identity): it may use a server whose tools are in its list (state.tools). */
const mainChip = (x) => `<button type="button" class="chip6" data-act="tool-who" data-k="mcp" data-id="${esc(x.id)}" data-v="main" aria-pressed="${(E.state?.tools ?? []).some((t) => t.name.startsWith(`mcp.${x.id}.`))}">${esc(E.state?.identity?.name ?? "")}</button>`;
function detail(k, x) {
  if (k === "skills" && x.id === LEARN_ID) return learnDetail(); // pass 17 part D §3
  const list = k === "mcp" ? "mcpServers" : k === "skills" ? "skills" : null;
  const who = list ? `<div class="sec"><h2>${t("window.places.customize.which-trunks-may-use-it")}</h2><div class="chips8">${E.trunks.map((t) => `<button type="button" class="chip6" data-act="tool-who" data-k="${k}" data-id="${esc(x.id)}" data-v="${esc(t.id)}" aria-pressed="${(t[list] ?? []).includes(k === "skills" ? x.name : x.id)}">${esc(t.name)}</button>`).join("")}${k === "mcp" ? mainChip(x) : ""}</div></div>` : "";
  /* Your own server's switch is live: on asks the engine to start it (a command waits for your yes in the Inbox), off stops
     it. A launch-file server's stays greyed under its own name. */
  const onOff = k === "mcp" ? `<input type="checkbox" class="sw" data-sw="${x.own ? "tool9g" : "tool9g-launch"}" data-k="${k}" data-id="${esc(x.id)}" ${x.own?.on ? "checked" : ""} aria-label="${t("window.places.customize.name-on-or-off", { name: esc(x.name) })}">` : "";
  return `<div class="t9-detail"><div class="t9-dh"><span class="ico-tile t9i" data-css="width:40px;height:40px">${ic(KINDS.find(([id]) => id === k)[2], 's')}</span><span class="grow"><b>${esc(x.name)}</b><small>${esc(x.sub)}</small></span>${onOff}</div>
    ${startProblem(x)}${who}${k === "mcp" ? toolPerms(x) : ""}${detailActs(k, x)}</div>`;
}

function toolsTab() {
  const k = T9.k, items = itemsOf(k), sel = items.find((x) => x.id === T9.sel) ?? items[0];
  const nav = KINDS.map(([id, label, icon, desc]) => `<button type="button" data-act="t9-kind" data-v="${id}" aria-current="${k === id}">${ic(icon, 's')}<span><b>${esc(say(label))}</b><small>${esc(say(desc))}</small></span><em>${itemsOf(id).length}</em></button>`).join("");
  const [act, words] = ADD[k], label = say(words);
  const rows = items.map((x) => `<button type="button" class="t9-item" data-act="t9-sel" data-v="${esc(x.id)}" aria-current="${sel?.id === x.id}"><span class="ico-tile t9i" data-css="width:32px;height:32px">${ic(x.icon ?? KINDS.find(([id]) => id === k)[2], 's')}</span><span class="grow"><b>${esc(x.name)}</b><small>${esc(x.sub)}</small></span></button>`).join("");
  return `<div class="t9"><nav class="t9-nav" aria-label="${t("window.places.customize.kinds-of-tools")}">${nav}<button type="button" class="btn pri t9-addbtn" data-act="${act}" data-v="${k}">${ic('plus', 's')}${label}</button></nav>
    <div class="t9-list">${k === "skills" && sel?.id !== LEARN_ID ? learnTile() : ""}${learnedCard()}${rows}${suggested()}</div>${sel ? detail(k, sel) : ""}</div>${toolsSection(k, sel?.id)}`;
}

/* The engine keeps each specialist as {id, data: {definition: {name, instructions}}}. */
const specName = (s) => s.data?.definition?.name ?? "";
const specWhat = (s) => String(s.data?.definition?.instructions ?? "").split("\n")[0];

/* The prototype's patterns. The one checked is the engine's (GET /api/state orchestration.pattern); "auto", its default,
   leaves it to Branch per job, so none is checked. Choosing one saves it (POST /api/orchestration {pattern}); choosing the
   checked one again gives it back to Branch. Teams has no engine form, so its card keeps its own greyed act. */
const PATTERNS = [
  ["one", "One at a time", "A Trunk calls a specialist, waits, carries on.", "M30 14v14M30 38v10", [[30, 10], [30, 33], [30, 52]]],
  ["super", "A lead and helpers", "One Trunk plans and hands out the parts.", "M30 14L14 42M30 14v28M30 14l16 28", [[30, 10], [14, 46], [30, 46], [46, 46]]],
  ["swarm", "Swarm", "Equals pass the work to whoever fits best.", "M14 18L46 18M14 18L30 46M46 18L30 46", [[14, 18], [46, 18], [30, 46]]],
  ["router", "Router", "Sends each request to the one Trunk that matches.", "M10 30h12M22 30l20-16M22 30h20M22 30l20 16", [[8, 30], [22, 30], [46, 14], [46, 30], [46, 46]]],
  ["parallel", "In parallel", "The same job split up, then gathered.", "M30 10L14 30M30 10v20M30 10l16 20M14 30L30 50M30 30v20M46 30L30 50", [[30, 8], [14, 30], [30, 30], [46, 30], [30, 52]]],
  ["teams", "Teams", "Small groups, each with its own lead.", "M18 12L10 30M18 12l8 18M42 12l-8 18M42 12l8 18M18 12h24", [[18, 12], [42, 12], [10, 32], [26, 32], [34, 32], [50, 32]]],
];
const patSvg = ([, , , d, dots]) => `<svg viewBox="0 0 60 60" aria-hidden="true"><path d="${d}"></path>${dots.map(([x, y], i) => `<circle cx="${x}" cy="${y}" r="${i === 0 ? 5 : 4}" class="${i === 0 ? "lead15" : ""}"></circle>`).join("")}</svg>`;

/* Who is on call: the engine's Trunks and Branch's own assistant, how many tasks are working, how many specialists. */
function fleet(specs) {
  const n = E.trunks.length, working = (E.state.runs ?? []).filter((r) => r.status === "running").length;
  const dots = [...E.trunks.map((t) => av(face(t), 22)), av({ kind: "main" }, 22)].join("");
  return `<div class="fleet15"><span class="fl-dots15">${dots}</span><span><b>${n} ${n === 1 ? t("window.places.customize.trunk") : t("settingsDirectory.trunks")}</b><small>${(specs.length === 1 ? t("window.places.customize.working-now-one-specialist", { working }) : t("window.places.customize.working-now-count-specialists", { working, count: specs.length }))}</small></span></div>`;
}

function specialistsTab() {
  const specs = E.state.specialists || [];
  const rows = specs.map((s) => `<div class="prow"><span class="ico-tile">${ic('bolt', 's')}</span><span class="grow"><b>${esc(specName(s))}</b><small>${esc(specWhat(s))}</small>${specLine(s)}</span><button class="btn sm" type="button" data-act="specb17" data-id="${esc(s.id ?? "")}">${t("prompts.action.edit")}</button></div>`).join('');
  const chosen = E.state.orchestration?.pattern;
  const pats = PATTERNS.map((p) => `<button type="button" role="radio" class="pat15" aria-checked="${chosen === p[0]}" data-act="${p[0] === "teams" ? "pat15-teams" : "pat15"}" data-v="${p[0]}">${patSvg(p)}<b>${esc(say(p[1]))}</b><small>${esc(say(p[2]))}</small></button>`).join("");
  return `<div class="rows"><p class="hint" data-css="margin:4px 0 8px">${t("window.places.customize.helpers-a-trunk-calls-in-for")}</p>${rows}</div>
    <div class="sec x15-sec">${fleet(specs)}<h2 data-css="margin-top:22px">${t("window.places.customize.how-trunks-work-together")}</h2><p class="hint" data-css="margin:0 0 10px">${t("window.places.customize.the-pattern-a-room-or-a")}</p>
    <div class="pats15" role="radiogroup" aria-label="${t("window.places.customize.how-trunks-work-together")}">${pats}</div></div>${codingAgentsSection()}`;
}

const FAM_WORDS = { core: "Two minutes to set up", chat: "Text through a webhook" };
function channelGrid() {
  const q = CH.q.trim().toLowerCase();
  const on = new Set(connected.map((c) => c.id ?? c.kind));
  const list = channelSetup.filter((c) => (CH.fam === "all" || c.family === CH.fam) && (!q || [c.name, say(c.name)].some((n) => String(n).toLowerCase().includes(q))));
  return list.map((c) => `<button type="button" class="ch12 ${on.has(c.id) ? "on12" : ""}" data-act="ch-open" data-v="${esc(c.id)}">${logo(c.id, c.name, 32)}<span><b>${esc(say(c.name))}</b><small>${offlineIn(connected, c.id) ? t("window.p17d.offline-token-revoked") : on.has(c.id) ? t("window.places.customize.connected-reaches-branch") : say(FAM_WORDS[c.family]) ?? t("addons.switch.on")}</small></span>${on.has(c.id) ? `<i class="dot12${offlineIn(connected, c.id) ? " off17d" : ""}"></i>` : ""}</button>`).join("");
}

function channelsTab() {
  const fams = [["all", t("look.filter.all")], ["core", t("window.places.customize.popular")], ["chat", t("window.places.customize.work-chat")], ["parity", t("more.label")]].map(([v, l]) => `<button type="button" data-act="ch-fam" data-v="${v}" aria-pressed="${CH.fam === v}">${l}</button>`).join("");
  return `<p class="hint" data-css="margin:4px 0 10px">${t("window.places.customize.talk-to-branch-from-other-apps")}</p>
    <div class="ch-wrap12"><div class="ch-top12"><label class="set-search" data-css="margin:0;flex:1">${ic('search', 's')}<input id="ch-q" value="${esc(CH.q)}" placeholder="${t("window.places.customize.search-count-chat-apps", { count: channelSetup.length })}" aria-label="${t("window.places.customize.search-chat-apps")}" autocomplete="off"></label>
    <span class="seg">${fams}</span></div>
    <div class="ch-grid12">${channelGrid()}</div><div class="tile phone12"><div class="th"><span class="ico-tile">${ic('phone', 's')}</span><b>${t("studio.tab.phone")}</b></div><p>${t("window.places.customize.answer-approvals-and-talk-to-trunks")}</p>
    <div class="acts"><button class="btn pri sm" type="button" data-act="pair">${t("window.places.customize.pair-a-phone")}</button></div></div></div>`;
}

function everywhereTab() {
  const version = E.state?.version ?? "";
  const tile = (icon, name, text, extra = "", v = "") => `<div class="tile"><div class="th"><span class="ico-tile">${ic(icon, 's')}</span><b>${name}</b></div><p>${text}</p><div class="acts"><button class="btn sm ml" type="button" data-act="surface" data-v="${v}">${t("window.places.customize.open-this-view")}</button>${extra}</div></div>`;
  const pair = `<button class="btn ghost sm" type="button" data-act="pair">${t("pair.step.pair")}</button>`;
  return `<div class="rows"><p class="hint" data-css="margin:4px 0 10px">${t("window.places.customize.one-branch-everywhere-you-are-open")}</p><div class="grid2">
    ${tile("win", "Windows", t("window.places.customize.this-computer-branch-version", { version: esc(version) }), "", "desktop")}
    ${tile("mac", "Mac", t("window.places.customize.the-same-app-on-a-mac"), "", "mac")}
    ${tile("term", t("pane.terminal"), t("window.places.customize.type-branch-in-any-terminal-same"), "", "terminal")}
    ${tile("phone", "iPhone", t("window.places.customize.pair-with-the-square-code-lock"), pair, "iphone")}
    ${tile("android", "Android", t("window.places.customize.pair-with-the-square-code-answer"), pair, "android")}
    ${tile("globe", "keepoak.com", t("window.places.customize.connect-your-account-to-reach-branch"), "", "web")}
    <div class="tile"><div class="th"><span class="ico-tile">${ic('chat', 's')}</span><b>${t("dashboard.links.chats")}</b></div><p>${t("window.places.customize.telegram-whatsapp-discord-slack-talk-to")}</p><div class="acts"><button class="btn sm ml" type="button" data-act="ptab" data-place="customize" data-v="channels">${t("place.customize.channels")}</button></div></div>
    <div class="tile"><div class="th"><span class="ico-tile">${ic('doc', 's')}</span><b>${t("window.places.customize.a-page-of-your-own")}</b></div><p>${t("window.places.customize.a-small-box-on-your-own")}</p><div class="acts"><button class="btn sm" type="button" data-act="widget6">${t("window.places.customize.get-the-snippet")}</button></div></div>
    </div></div>`;
}

const DRAW = { trunks: trunksTab, tools: toolsTab, specialists: specialistsTab, channels: channelsTab, everywhere: everywhereTab };

export function draw() {
  const tab = S.tabs.customize || "trunks";
  if (!E.state) return `<main class="main enter11" id="main"><div class="scroll"><div class="place"></div></div></main>`;
  const tabs = [["trunks", t("settingsDirectory.trunks"), E.trunks.length], ["tools", t("dashboard.filter.tools"), 0], ["specialists", t("nav.specialists"), 0], ["channels", t("place.customize.channels"), 0], ["everywhere", t("window.places.customize.everywhere"), 0]];
  const lockBanner = E.state.lock ? `<div class="lock-banner">${ic('lock', 's')}${t("window.places.automations.lockdown-is-on-trunks-can-read")}<button type="button" data-act="lock">${t("lockdown.turnOff")}</button></div>` : "";
  return `<main class="main enter11" id="main">${lockBanner}<div class="scroll"><div class="place${tab === "tools" ? " t9-place" : ""}">
    <h1>${t("place.customize")}</h1><p class="lede">${t("window.places.customize.who-your-trunks-are-what-they")}</p>
    ${tabBar(tabs, "customize", tab)}${(DRAW[tab] ?? trunksTab)()}</div></div></main>`;
}

/* The engine answers with objects ({servers}, {channels}…); each is reduced to its list before it is kept, and the tab is
   drawn again only when a list really changed. A list the engine refuses is shown as its words, once. */
const listOf = (x, key) => (Array.isArray(x) ? x : Array.isArray(x?.[key]) ? x[key] : []);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const said = new Set();
const read = (path) => api(path).catch((error) => { if (!said.has(path)) { said.add(path); toast(error.message); } return null; });

/* Q261: the tool servers, programs, add-ons, assistants and skill suggestions are the owner's setup, which a household
   person may not read; their Tools tab draws from empty lists instead of asking. */
const owners = (path) => (E.profiles?.isOwner === false ? Promise.resolve(null) : read(path));
async function readTools() {
  const [mcp, own, cl, plugs, ag, sug, rev, pol] = await Promise.all([owners("mcp/connections"), owners("mcp/servers"), owners("clis"), owners("plugins"), owners("agents/remote"), owners("skills/suggest"), owners("skill-revisions"), read("policy")]);
  return { mcpServers: listOf(mcp, "servers"), ownServers: listOf(own, "servers"), clis: { programs: listOf(cl, "programs"), launch: listOf(cl, "launch") },
    plugins: listOf(plugs, "plugins"), agents: listOf(ag, "agents"), suggestions: listOf(sug, "suggestions"), revisions: listOf(rev, "revisions"), policyRules: listOf(pol?.policy, "rules") };
}
/* Another area (an add dialog) reads the tool lists again after it added something. */
export async function reloadTools() {
  ({ mcpServers, ownServers, clis, plugins, agents, suggestions, revisions, policyRules } = await readTools());
}

export async function after() {
  const tab = S.tabs.customize || "trunks";
  const before = JSON.stringify([mcpServers, ownServers, clis, plugins, agents, suggestions, revisions, policyRules, channelSetup, connected]);
  if (tab === "tools") await reloadTools();
  else if (tab === "channels") {
    const [setup, live] = await Promise.all([read("channel-setup"), read("channels")]);
    channelSetup = listOf(setup, "channels");
    connected = listOf(live, "channels");
  }
  if (!same(before, JSON.stringify([mcpServers, ownServers, clis, plugins, agents, suggestions, revisions, policyRules, channelSetup, connected]))) renderNow();
}

/* Removing a skill (POST /api/skills/{id}/remove, naming the revision it was shown at), one of your own servers
   (POST /api/mcp/servers/{id}/remove, which stops it first) or command-line tools (POST /api/clis/remove). */
const REMOVE = {
  skills: (id) => api(`skills/${encodeURIComponent(id)}/remove`, { expectedRevision: (E.state?.skills ?? []).find((s) => s.id === id)?.revision }),
  mcp: (id) => api(`mcp/servers/${encodeURIComponent(id)}/remove`, {}),
  clis: (id) => api("clis/remove", { name: id }),
};
async function removeTool(el) {
  const { k, id } = el.dataset;
  try {
    if (!REMOVE[k]) return;
    const name = itemsOf(k).find((x) => x.id === id)?.name ?? "";
    await REMOVE[k](id);
    T9.sel = null;
    await refresh();
    await after();
    renderNow();
    toast(t("window.places.customize.name-removed", { name }));
  } catch (error) { toast(error.message); }
}

/* A drafted version: a practice run (POST /api/skill-revisions/try, where nothing is really done), keeping it (accept,
   which the engine refuses until a practice run did no worse) or throwing it away (reject). */
const REV = { tried: "try", kept: "accept", gone: "reject" };
async function revise(el) {
  const { v, id } = el.dataset, version = Number(el.dataset.version);
  const before = revisions.find((r) => r.skillId === id && r.version === version);
  el.disabled = true;
  try {
    await api(`skill-revisions/${REV[v]}`, { skillId: id, version });
    if (v === "tried") toast(t("window.places.customize.practice-run-done-nothing-was-really"));
    if (v === "gone" && before?.activeVersion) toast(t("window.places.customize.thrown-away-the-skill-stays-on", { activeVersion: before.activeVersion }));
    await refresh();
  } catch (error) { toast(error.message); }
  el.disabled = false;
  await after();
  renderNow();
}

/* Switching on a skill you have: POST /api/skills/{id}/activate with the version and revision the engine has now. A skill
   the scan found something in is refused by the engine, in its own words. */
async function addSuggested(el) {
  try {
    const skill = await api(`skills/${encodeURIComponent(el.dataset.v)}`);
    await api(`skills/${encodeURIComponent(skill.id)}/activate`, { version: skill.headVersion, expectedRevision: skill.revision });
    await refresh();
  } catch (error) { toast(error.message); }
  await after();
  renderNow();
}

/* Your own server on or off: POST /api/mcp/servers/{id}/start or /stop; the engine's words say what happened, and for a
   command the question it now waits on in the Inbox. */
async function switchServer(el) {
  try {
    const said = await api(`mcp/servers/${encodeURIComponent(el.dataset.id)}/${el.checked ? "start" : "stop"}`, {});
    toast(said.said);
  } catch (error) { toast(error.message); }
  await reloadTools();
  renderNow();
}

/* How Trunks work together: the owner's default, saved with the orchestration settings; the engine keeps the rest. */
async function choosePattern(el) {
  const v = el.dataset.v, again = E.state.orchestration?.pattern === v;
  try {
    await api("orchestration", { pattern: again ? "auto" : v });
    await refresh();
    const p = PATTERNS.find((x) => x[0] === v);
    if (!again) toast(t("window.places.customize.value-used-for-rooms-and-big", { value: say(p[1]) }));
  } catch (error) { toast(error.message); }
}

/* Filtering the chat apps redraws only the grid, so the search box keeps its caret. */
function redrawGrid() {
  const grid = document.querySelector("#main .ch-grid12");
  if (grid) greyOut(paint(grid, channelGrid()));
}

export function init() {
  markLive(["sw:ch-q", "ptab", "t9-kind", "t9-sel", "tool-rm", "ch-fam", "rev", "sugg15", "pat15", "sw:tool9g"]);
  document.addEventListener("change", (e) => { if (e.target.dataset?.sw === "tool9g") switchServer(e.target); });
  on("pat15", (el) => choosePattern(el));
  initCustomize17();
  initLearn17d(); // pass 17 part D §3
  on("rev", (el) => revise(el));
  on("sugg15", (el) => addSuggested(el));
  on("t9-kind", (el) => { T9.k = el.dataset.v; T9.sel = null; renderNow(); });
  on("t9-sel", (el) => { T9.sel = el.dataset.v; renderNow(); });
  on("tool-rm", (el) => removeTool(el));
  on("ch-fam", (el) => { CH.fam = el.dataset.v; renderNow(); });
  document.addEventListener("input", (e) => { if (e.target.id === "ch-q") { CH.q = e.target.value; redrawGrid(); } });
}

/* Another area (the Add a skill dialog) shows a skill it just added. */
export function showTool(kind, id) {
  S.view = "customize";
  S.tabs.customize = "tools";
  T9.k = kind;
  T9.sel = id;
}
