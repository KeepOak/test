/* Settings › advanced: bind real engine data and wire controls. */
import { esc, render } from "../../core/dom.js";
import { level, E, refresh } from "../../core/state.js";
import { api, token } from "../../core/api.js";
import { on } from "../../core/actions.js";
import { markLive } from "../../core/features.js";
import { toast, openDlg } from "../../core/ui.js";
import { fact15 } from "../rows15.js";
import { sections17, init17, load17 } from "../p17-advanced.js";
import { initMarket } from "../market.js"; // RES-720
import { t } from "../../../i18n.js";
import { tunnelSeg, loadTunnel, initTunnel, tunnelLive } from "../tunnel-seg.js";
import { restart as restartEngine } from "./self.js";

/* The engine's own values: show the thinking (GET/POST /api/knobs, reasoning card, merged), the activity log
   (GET/POST /api/diagnostics/log/settings, merged), the model on this computer (GET /api/local-models), the browser's
   profiles (GET /api/browser/profiles) and the standing orders (GET /api/autonomy/orders, listed by "See").
   Memory: most facts it keeps (state.memoryCapacity, saved with POST /api/memory/capacity { maxFacts }), match by
   meaning (GET/POST /api/memory/retrieval useEmbeddings, merged), outside memory (GET/POST /api/learning-more/providers
   { active }, merged; choosing one sends nothing by itself, its tools have their own switch) and the history in Git
   (GET/POST /api/memory/history { mode }). Automations: report only what changed (GET /api/heartbeat switches.notifyGate,
   POST /api/heartbeat/switches, merged), checks and retries (flows-boards part "recipe-checks"), USB triggers (reach part
   "usb"). Tools: the readiness check (autonomy part "readiness"), searching X (personal part "x-search") and video tools
   (GET/POST /api/media/programs { mode }, merged). A three-way switch shows on unless "off" and turns on as "when-needed".
   Reach webhooks from outside is the owner's public door for webhooks only (../tunnel-seg.js).
   Crash reports need a linked destination first, so they stay greyed; every other greyed row says why under itself
   (core/why.js, the locale's window.why.*). */
const D = { knobs: null, log: null, local: null, profiles: null, orders: null, retrieval: null, providers: null, history: null,
  heartbeat: null, boards: null, reach: null, autonomy: null, personal: null, media: null, archive: null };
const PATHS = { knobs: "knobs", log: "diagnostics/log/settings", local: "local-models", profiles: "browser/profiles", orders: "autonomy/orders",
  retrieval: "memory/retrieval", providers: "learning-more/providers", history: "memory/history", heartbeat: "heartbeat",
  boards: "flows-boards", reach: "reach", autonomy: "autonomy", personal: "personal", media: "media/programs", archive: "memory/auto-archive" };
/* The owner's own settings: every change here is refused to a household profile (src/household-routes.ts fails closed),
   so for one the window neither reads them nor draws them live: each control is drawn without its id and greys with the
   owner-only reason (as models.js num() does, Q261), never showing an "off" it did not read. */
const household = () => E.profiles?.isOwner === false;
const own = (id) => (household() ? 'data-why="knobs-owner-only"' : `id="${id}" ${WIRES[id] ? checked(id) : ""}`);
const OWNER_ONLY = new Set(["retrieval", "providers", "history", "heartbeat", "boards", "reach", "autonomy", "personal", "media", "archive"]);
const onMode = (mode) => Boolean(mode) && mode !== "off";
const mode = (on) => (on ? "when-needed" : "off");
const part = (path, name) => (on) => api(path, { part: name, mode: mode(on) });

/* Each switch: [the engine's value now, the change]. */
const WIRES = {
  "ad-think": [() => D.knobs?.reasoning?.showReasoning === true, (on) => api("knobs", { card: "reasoning", values: { showReasoning: on } })],
  "ad-log": [() => onMode(D.log?.mode), (on) => api("diagnostics/log/settings", { mode: mode(on) })],
  "f15-match-by-meaning": [() => D.retrieval?.settings?.useEmbeddings === true, (on) => api("memory/retrieval", { useEmbeddings: on })],
  "f15-keep-a-history-in-git": [() => onMode(D.history?.mode), (on) => api("memory/history", { mode: mode(on) })],
  "f15-report-only-what-changed": [() => onMode(D.heartbeat?.switches?.notifyGate), (on) => api("heartbeat/switches", { notifyGate: mode(on) })],
  "f15-checks-and-retries-in-procedures": [() => onMode(D.boards?.modes?.["recipe-checks"]), part("flows-boards/switch", "recipe-checks")],
  "f15-start-when-a-usb-device-is-plugged-in": [() => onMode(D.reach?.modes?.usb), part("reach/switch", "usb")],
  "f15-check-a-skill-is-ready-first": [() => onMode(D.autonomy?.modes?.readiness), part("autonomy/switch", "readiness")],
  "f15-search-x": [() => onMode(D.personal?.modes?.["x-search"]), part("personal/switch", "x-search")],
  "f15-video-tools": [() => onMode(D.media?.settings?.mode), (on) => api("media/programs", { mode: mode(on) })],
};
const checked = (id) => (WIRES[id][0]() ? "checked" : "");

async function loadAll() {
  const keys = Object.keys(PATHS).filter((key) => !household() || !OWNER_ONLY.has(key));
  const [got] = await Promise.all([Promise.all(keys.map((key) => api(PATHS[key]).catch((error) => { toast(error.message); return null; }))),
    household() ? null : loadTunnel()]);
  const raw = Object.fromEntries(keys.map((key, i) => [key, got[i]]));
  Object.assign(D, raw, { knobs: raw.knobs?.values ?? null, profiles: raw.profiles?.profiles ?? null, orders: raw.orders?.orders ?? null });
  render();
}

/* Archive facts unused for: 90 days, 180 days or never (GET/POST /api/memory/auto-archive, src/memory-auto-archive.ts),
   pressed from the engine's value. A fact set aside keeps its versions and comes back from Library › Memory › Archive;
   the row says how many would go now. */
function archiveRow() {
  const label = t("window.settings.advanced.archive-facts-unused-for");
  const after = D.archive?.settings?.afterDays ?? null, owner = !household() && D.archive;
  const opt = (v, words) => `<button type="button" aria-pressed="${owner ? String(after) === v : false}" data-act="${owner ? "ad-archive" : "ad-archive-owner"}"${owner ? "" : ' data-why="knobs-owner-only"'} data-v="${v}">${words}</button>`;
  const sub = after ? t("window.settings.advanced.archive-would", { count: D.archive.wouldSetAside ?? 0 }) : t("window.settings.advanced.archive-never");
  return `<div class="ctl"><b>${label}</b><span class="right"><span class="seg" role="group" aria-label="${label}">${opt("90", t("window.settings.advanced.90-days"))}${opt("180", t("window.settings.advanced.180-days"))}${opt("null", t("window.settings.advanced.never"))}</span></span><small>${owner ? sub : ""}</small></div>`;
}
async function chooseArchive(v) {
  try { await api("memory/auto-archive", { afterDays: v === "null" ? null : Number(v) }); } catch (error) { toast(error.message); }
  await loadAll();
}

/* Outside memory: the engine's four choices (none, Mem0, Honcho, Hindsight), pressed from its own value. */
// Words are read as the row is drawn, never at load, when the language is not in yet.
const OUTSIDE = () => [["none", t("comfort.placeholder.none")], ["mem0", "Mem0"], ["honcho", "Honcho"], ["hindsight", "Hindsight"]];
const outsideSeg = () => OUTSIDE().map(([v, words]) => `<button type="button" aria-pressed="${D.providers?.active === v}" data-act="${household() ? "ad-outside-owner" : "ad-outside"}"${household() ? ' data-why="knobs-owner-only"' : ""} data-v="${v}">${words}</button>`).join("");

const kv = (rows) => rows.filter(([, v]) => v != null && v !== "").map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("");
const tile = (title, rows) => `<div class="tile" data-css="margin-top:12px"><div class="th"><b>${title}</b></div><dl class="kv" data-css="background:none;padding:0">${kv(rows)}</dl></div>`;

/* The first model the engine finds on this computer: its name and how much it can hold. */
function localTile() {
  const l = D.local;
  const m = l?.oneClick?.loaded?.[0] ?? l?.ollama?.models?.[0] ?? l?.lmStudio?.models?.[0] ?? null;
  return tile(t("window.settings.advanced.model-on-this-computer"), [[t("coding.ci.model"), m?.name], [t("window.settings.advanced.room"), m?.contextLength]]);
}

function browserTile() {
  return tile(t("pane.browser"), [[t("window.settings.advanced.profile"), (D.profiles ?? []).map((p) => p.name ?? p.id ?? "").filter(Boolean).join(", ")]]);
}

export function draw() {
  const lv = level();
  const s = E.state || {};

  let html = `<h1>${t("settings.page.advanced")}</h1><p class=\"lede\">${t("window.settings.advanced.whats-running-under-the-hood-for")}</p>`;

  // Service diagnostics
  html += `<div class=\"tile\" data-css=\"margin-top:12px\"><div class=\"th\"><b>${t("window.settings.advanced.branch-service")}</b><span class=\"pill done ml\"><i></i>${t("dashboard.running")}</span></div>`;
  html += "<dl class=\"kv\" data-css=\"background:none;padding:0\">";
  html += [[t("window.settings.advanced.version"), s.version], [t("addons.pipelines.address"), location.host]].filter(([, v]) => v).map(([k, v]) => "<dt>" + k + "</dt><dd>" + esc(v) + "</dd>").join("");
  html += "</dl>";
  /* Restart: the desktop app starts itself again through its own bridge; in a browser tab the engine is restarted
     (POST /api/dashboard/restart, as Branch itself › Restart the engine), and the engine says in its own words when it
     cannot. Open logs shows what the engine wrote down (GET /api/logs) in a new window. */
  html += `<div class=\"acts\"><button class=\"btn sm\" type=\"button\" data-act=\"restart16\">${t("server.restart")}</button><button class=\"btn ghost sm\" type=\"button\" data-act=\"adv-logs\">${t("window.settings.advanced.open-logs")}</button></div>`;
  html += "</div>";
  html += localTile() + browserTile();

  // Seeing more section
  html += `<div class=\"sec\"><h2>${t("window.settings.advanced.seeing-more")}</h2>`;
  html += `<div class="ctl"><b>${t("window.settings.advanced.show-the-thinking")}</b><input class="sw" type="checkbox" id="ad-think" ${checked("ad-think")} aria-label="${t("window.settings.advanced.show-the-thinking")}" data-sw="set"><small>${t("window.settings.advanced.adds-the-models-reasoning-under-each")}</small></div>`;
  const keep = D.log?.keepDays ? t("window.settings.advanced.every-step-kept-for-days", { days: esc(D.log.keepDays) }) : "";
  html += `<div class="ctl"><b>${t("field.activity-log-mode")}</b><input class="sw" type="checkbox" id="ad-log" ${checked("ad-log")} aria-label="${t("field.activity-log-mode")}" data-sw="set"><small>${keep}</small></div>`;
  html += `<div class=\"ctl\"><b>${t("window.settings.advanced.send-crash-reports")}</b><input class=\"sw\" type=\"checkbox\" id=\"ad-crash\" aria-label=\"${t("window.settings.advanced.send-crash-reports")}\" data-sw=\"set\"><small>${t("window.settings.advanced.only-the-error-never-your-conversations")}</small></div>`;
  html += "</div>";

  // Level-specific content (shown at advanced level and above)
  if (lv >= 1) {
    html += `<div class=\"sec x15-sec\"><h2>${t("memory.movein.kind.memory")}</h2>`;
    html += `<div class=\"ctl\"><b>${t("window.settings.advanced.most-facts-it-keeps")}</b><span class=\"right num15\"><input class=\"inp\" ${own("ad-facts")} value=\"` + esc(E.state?.memoryCapacity?.maxFacts ?? "") + `\" aria-label=\"${t("window.settings.advanced.most-facts-it-keeps")}\" data-sw=\"set\"><small>${t("window.settings.advanced.facts")}</small></span><small>${t("window.settings.advanced.tidy-up-suggests-what-to-archive")}</small></div>`;
    html += `<div class=\"ctl\"><b>${t("window.settings.advanced.match-by-meaning")}</b><input class=\"sw\" type=\"checkbox\" ${own("f15-match-by-meaning")} aria-label=\"${t("window.settings.advanced.match-by-meaning")}\" data-sw=\"set\"><small>${t("window.settings.advanced.finds-invoice-when-the-fact-says")}</small></div>`;
    html += fact15(t("window.settings.advanced.share-memory-between-trunks"), "f15-share-memory-between-trunks");
    html += `<div class=\"ctl\"><b>${t("window.settings.advanced.outside-memory")}</b><span class=\"right\"><span class=\"seg\" role=\"group\" aria-label=\"${t("window.settings.advanced.outside-memory")}\">${outsideSeg()}</span></span><small>${t("window.settings.explain.outside-memory")}</small></div>`;
    html += `<div class=\"ctl\"><b>${t("window.settings.advanced.keep-a-history-in-git")}</b><input class=\"sw\" type=\"checkbox\" ${own("f15-keep-a-history-in-git")} aria-label=\"${t("window.settings.advanced.keep-a-history-in-git")}\" data-sw=\"set\"><small>${t("window.settings.advanced.every-change-to-memory-as-a")}</small></div>`;
    html += archiveRow();
    html += "</div>";

    html += `<div class=\"sec x15-sec\"><h2>${t("dashboard.automations.title")}</h2>`;
    html += `<div class=\"ctl\"><b>${t("window.settings.advanced.report-only-what-changed")}</b><input class=\"sw\" type=\"checkbox\" ${own("f15-report-only-what-changed")} aria-label=\"${t("window.settings.advanced.report-only-what-changed")}\" data-sw=\"set\"><small>${t("window.settings.advanced.checks-compare-with-last-time-and")}</small></div>`;
    html += `<div class=\"ctl\"><b>${t("window.settings.advanced.checks-and-retries-in-procedures")}</b><input class=\"sw\" type=\"checkbox\" ${own("f15-checks-and-retries-in-procedures")} aria-label=\"${t("window.settings.advanced.checks-and-retries-in-procedures")}\" data-sw=\"set\"><small>${t("window.settings.advanced.a-step-can-check-its-own")}</small></div>`;
    html += fact15(t("autonomy.part.procedures"), "f15-procedures-that-start-themselves");
    html += `<div class=\"ctl\"><b>${t("window.settings.advanced.start-when-a-usb-device-is")}</b><input class=\"sw\" type=\"checkbox\" ${own("f15-start-when-a-usb-device-is-plugged-in")} aria-label=\"${t("window.settings.advanced.start-when-a-usb-device-is")}\" data-sw=\"set\"><small>${t("window.settings.advanced.only-for-triggers-you-make")}</small></div>`;
    html += household() ? `<div class=\"ctl\"><b>${t("window.settings.advanced.reach-webhooks-from-outside")}</b><span class=\"right\"><span class=\"seg\" role=\"group\" aria-label=\"${t("window.settings.advanced.reach-webhooks-from-outside")}\"><button type=\"button\" aria-pressed=\"false\" data-act=\"seg\" data-why=\"knobs-owner-only\">${t("accounts.switch.off")}</button><button type=\"button\" aria-pressed=\"false\" data-act=\"seg\" data-why=\"knobs-owner-only\">cloudflared</button><button type=\"button\" aria-pressed=\"false\" data-act=\"seg\" data-why=\"knobs-owner-only\">ngrok</button><button type=\"button\" aria-pressed=\"false\" data-act=\"seg\" data-why=\"knobs-owner-only\">Tailscale</button></span></span><small></small></div>` : tunnelSeg(); // the owner's public door for webhooks (../tunnel-seg.js)
    html += fact15(t("window.settings.advanced.use-what-the-trigger-sent"), "f15-use-what-the-trigger-sent");
    html += "</div>";

    html += `<div class=\"sec x15-sec\"><h2>${t("window.settings.advanced.tools-and-skills")}</h2>`;
    html += `<div class=\"ctl\"><b>${t("window.settings.advanced.check-a-skill-is-ready-first")}</b><input class=\"sw\" type=\"checkbox\" ${own("f15-check-a-skill-is-ready-first")} aria-label=\"${t("window.settings.advanced.check-a-skill-is-ready-first")}\" data-sw=\"set\"><small>${t("window.settings.advanced.programs-keys-and-systems-it-needs")}</small></div>`;
    html += `<div class=\"ctl\"><b>${t("window.settings.advanced.only-signed-skill-packages")}</b><input class=\"sw\" type=\"checkbox\" id=\"f15-only-signed-skill-packages\" aria-label=\"${t("window.settings.advanced.only-signed-skill-packages")}\" data-sw=\"set\"><small></small></div>`;
    html += `<div class=\"ctl\"><b>${t("window.settings.advanced.check-install-requests-for-malware")}</b><input class=\"sw\" type=\"checkbox\" id=\"f15-check-install-requests-for-malware\" aria-label=\"${t("window.settings.advanced.check-install-requests-for-malware")}\" data-sw=\"set\"><small>${t("window.settings.advanced.against-the-osv-database-before-you")}</small></div>`;
    html += `<div class=\"ctl\"><b>${t("window.settings.advanced.web-search")}</b><span class=\"right\"><span class=\"seg\" role=\"group\" aria-label=\"${t("window.settings.advanced.web-search")}\"><button type=\"button\" aria-pressed=\"false\" data-act=\"seg\" data-why=\"web-search\">DuckDuckGo</button><button type=\"button\" aria-pressed=\"false\" data-act=\"seg\" data-why=\"web-search\">Brave</button><button type=\"button\" aria-pressed=\"false\" data-act=\"seg\" data-why=\"web-search\">SearXNG</button><button type=\"button\" aria-pressed=\"false\" data-act=\"seg\" data-why=\"web-search\">Tavily</button><button type=\"button\" aria-pressed=\"false\" data-act=\"seg\" data-why=\"web-search\">Exa</button></span></span><small>${t("window.settings.advanced.duckduckgo-needs-no-key-so-search")}</small></div>`;
    html += `<div class=\"ctl\"><b>${t("personal.x.search")}</b><input class=\"sw\" type=\"checkbox\" ${own("f15-search-x")} aria-label=\"${t("personal.x.search")}\" data-sw=\"set\"><small>${t("window.settings.advanced.turns-on-when-an-x-account")}</small></div>`;
    html += `<div class=\"ctl\"><b>${t("window.settings.advanced.video-tools")}</b><input class=\"sw\" type=\"checkbox\" ${own("f15-video-tools")} aria-label=\"${t("window.settings.advanced.video-tools")}\" data-sw=\"set\"><small>${t("window.settings.advanced.download-read-captions-and-make-short")}</small></div>`;
    html += "</div>";

    html += `<div class=\"sec x15-sec\"><h2>${t("window.settings.advanced.trunks-more")}</h2>`;
    html += fact15(t("window.settings.advanced.projects-pick-up-matching-work"), "f15-projects-pick-up-matching-work");
    html += fact15(t("window.settings.advanced.follow-up-tasks"), "f15-follow-up-tasks");
    html += `<div class=\"ctl\"><b>${t("autonomy.orders.title")}</b><span class=\"right\"><button class=\"btn sm\" type=\"button\" data-act=\"ad-orders\">${t("window.settings.p17-permissions.see")} ` + esc(D.orders?.length ?? "") + `</button></span><small>${t("window.settings.advanced.named-programmes-a-trunk-keeps-running")}</small></div>`;
    html += `<div class=\"ctl\"><b>${t("window.settings.advanced.from-now-on-for-a-specialist")}</b><span class=\"right\"><button class=\"btn sm\" type=\"button\" data-act=\"soon\" data-why=\"from-now-on-for-a-specialist\">${t("window.settings.advanced.add-one")}</button></span><small>${t("window.settings.advanced.a-standing-instruction-kept-by-one")}</small></div>`;
    html += `<div class=\"ctl\"><b>${t("window.settings.advanced.share-a-trunk")}</b><span class=\"right\"><button class=\"btn sm\" type=\"button\" data-act=\"soon\" data-why=\"share-a-trunk\">${t("window.settings.p17-usage.export-2")}</button></span><small>${t("window.settings.advanced.through-git-as-a-skill-bundle")}</small></div>`;
    html += `<div class=\"ctl\"><b>${t("window.settings.advanced.custom-modes")}</b><span class=\"right\"><code class=\"code15\">.branch/modes.json</code></span><small>${t("window.settings.advanced.your-own-modes-one-can-hand")}</small></div>`;
    html += `<div class=\"ctl\"><b>${t("window.settings.advanced.agent-marketplace")}</b><span class=\"right\"><button class=\"btn sm\" type=\"button\" data-act=\"mk-open\">${t("window.settings.advanced.browse")}</button></span><small>${t("window.settings.advanced.trunks-others-made-each-with-a")}</small></div>`;
    html += "</div>";

    html += `<div class=\"sec x15-sec\"><h2>${t("window.settings.advanced.library-more")}</h2>`;
    html += `<div class=\"ctl\"><b>${t("window.settings.advanced.search-documents-by-meaning")}</b><input class=\"sw\" type=\"checkbox\" id=\"f15-search-documents-by-meaning\" aria-label=\"${t("window.settings.advanced.search-documents-by-meaning")}\" data-sw=\"set\"><small>${t("window.settings.advanced.finds-the-lease-clause-about-repairs")}</small></div>`;
    html += `<div class=\"ctl\"><b>${t("window.settings.advanced.a-local-index-of-mail-calendar")}</b><input class=\"sw\" type=\"checkbox\" id=\"f15-a-local-index-of-mail-calendar-and-messa\" aria-label=\"${t("window.settings.advanced.a-local-index-of-mail-calendar")}\" data-sw=\"set\"><small>${t("window.settings.advanced.built-and-kept-on-this-computer")}</small></div>`;
    html += `<div class=\"ctl\"><b>${t("window.settings.advanced.keep-versions-of-what-trunks-make")}</b><input class=\"sw\" type=\"checkbox\" id=\"f15-keep-versions-of-what-trunks-make\" aria-label=\"${t("window.settings.advanced.keep-versions-of-what-trunks-make")}\" data-sw=\"set\"><small>${t("window.settings.advanced.every-file-in-made-for-you")}</small></div>`;
    html += `<div class=\"ctl\"><b>${t("window.settings.advanced.rewrite-short-notes")}</b><span class=\"right\"><button class=\"btn sm\" type=\"button\" data-act=\"soon\" data-why=\"rewrite-short-notes\">${t("personal.signin.try")}</button></span><small>${t("window.settings.advanced.clearer-shorter-fixed-or-more-formal")}</small></div>`;
    html += "</div>";

    html += `<div class=\"sec x15-sec\"><h2>${t("window.settings.advanced.pinned-skills")}</h2>`;
    html += fact15(t("window.settings.advanced.always-read-in-full"), "f15-always-read-in-full");
    html += "</div>";
  }

  return html + sections17(lv);
}

/* GET /api/logs answers lines of JSON (what the owner's tasks wrote down, keys and passwords taken out), not one JSON
   document, so it is read as text and shown as it is. */
async function openLogs() {
  try {
    const key = token.get();
    const response = await fetch("/api/logs", { cache: "no-store", headers: key ? { authorization: "Bearer " + key } : {} });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || String(response.status));
    const text = await response.text();
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    /* The desktop app refuses new windows (src/desktop/main.ts), so there the same lines open in a dialog instead. */
    if (window.open(url, "_blank")) toast(t("window.settings.advanced.logs-open-in-a-new-window"));
    else openDlg({ title: t("window.settings.advanced.open-logs"), wide: true, body: `<pre class="code6" data-css="white-space:pre-wrap;margin:0;max-height:60vh;overflow:auto">${esc(text)}</pre>`, foot: `<button class="btn" type="button" data-act="dlg-close">${t("delight.ach.close")}</button>` });
  } catch (error) { toast(error.message); }
}

/* Standing orders: the engine's own list (GET /api/autonomy/orders), each by its name and what it may do. */
function openOrders() {
  const rows = (D.orders ?? []).map((o) => `<div class="prow"><span class="grow"><b>${esc(o.order?.name)}</b><small>${esc(o.pausedBecause || o.order?.authority)}</small></span></div>`).join("");
  openDlg({ title: t("autonomy.orders.title"), body: `<div class="rows demo-b17">${rows || `<p class="empty">${t("inspector.nothing")}</p>`}</div>`, foot: `<button class="btn" type="button" data-act="dlg-close">${t("delight.ach.close")}</button>` });
}

/* Most facts it keeps: a whole number goes to the engine (it refuses one out of range, or below the facts already kept,
   in its own words); anything else leaves the box showing the engine's value again. */
async function saveFacts(box) {
  const typed = box.value.trim();
  if (/^\d+$/.test(typed)) {
    try { await api("memory/capacity", { maxFacts: Number(typed) }); } catch (error) { toast(error.message); }
  }
  try { await refresh(); } catch (error) { toast(error.message); }
  render();
}

async function chooseOutside(el) {
  try { await api("learning-more/providers", { active: el.dataset.v }); } catch (error) { toast(error.message); }
  await loadAll();
}

function restartNow() {
  const desktop = window.branchDesktop?.restartBranch;
  if (!desktop) return restartEngine();
  return Promise.resolve().then(() => desktop()).catch((error) => toast(error.message));
}

export function init() {
  initMarket(); // RES-720
  init17();
  on("adv-logs", () => openLogs());
  on("restart16", () => restartNow());
  on("ad-orders", () => openOrders());
  on("ad-outside", (el) => chooseOutside(el));
  on("ad-archive", (el) => chooseArchive(el.dataset.v));
  initTunnel();
  markLive(["adv-logs", "restart16", "ad-orders", "ad-outside", "ad-archive", "sw:ad-facts", ...tunnelLive, ...Object.keys(WIRES).map((id) => "sw:" + id)]);
  document.addEventListener("change", async (e) => {
    if (e.target.id === "ad-facts") { await saveFacts(e.target); return; }
    const wire = WIRES[e.target.id];
    if (!wire) return;
    try { await wire[1](e.target.checked); } catch (error) { toast(error.message); }
    await loadAll();
  });
  loadAll();
}

export async function load() { await Promise.all([loadAll(), load17()]); }

export const live = { "adv-logs": true, "ad-orders": true, "ad-outside": true, "ad-archive": true, "sw:ad-facts": true, "tunnel-seg": true, ...Object.fromEntries(Object.keys(WIRES).map((id) => ["sw:" + id, true])) };
