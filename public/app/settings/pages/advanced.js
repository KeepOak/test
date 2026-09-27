/* Settings › advanced: bind real engine data and wire controls. */
import { esc, render } from "../../core/dom.js";
import { level, E } from "../../core/state.js";
import { api, token } from "../../core/api.js";
import { on } from "../../core/actions.js";
import { markLive } from "../../core/features.js";
import { toast, openDlg } from "../../core/ui.js";
import { seg15 } from "../rows15.js";
import { sections17, init17, load17 } from "../p17-advanced.js";
import { t } from "../../../i18n.js";

/* The engine's own values: show the thinking (GET/POST /api/knobs, reasoning card, merged), the activity log
   (GET/POST /api/diagnostics/log/settings, merged; a three-way switch, on unless "off", turned on as "when-needed"),
   the model on this computer (GET /api/local-models), the browser's profiles (GET /api/browser/profiles) and the
   standing orders (GET /api/autonomy/orders). Crash reports need a linked destination first, so they stay greyed. */
const D = { knobs: null, log: null, local: null, profiles: null, orders: null };

const WIRES = {
  "ad-think": (on) => api("knobs", { card: "reasoning", values: { showReasoning: on } }),
  "ad-log": (on) => api("diagnostics/log/settings", { mode: on ? "when-needed" : "off" }),
};

async function loadAll() {
  const [knobs, log, local, profiles, orders] = await Promise.all(["knobs", "diagnostics/log/settings", "local-models", "browser/profiles", "autonomy/orders"]
    .map((path) => api(path).catch((error) => { toast(error.message); return null; })));
  Object.assign(D, { knobs: knobs?.values ?? null, log, local, profiles: profiles?.profiles ?? null, orders: orders?.orders ?? null });
  render();
}

const kv = (rows) => rows.filter(([, v]) => v != null && v !== "").map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("");
const tile = (title, rows) => `<div class="tile" data-css="margin-top:12px"><div class="th"><b>${title}</b></div><dl class="kv" data-css="background:none;padding:0">${kv(rows)}</dl><div class="acts"><button class="btn sm" type="button" data-act="soon">${t("server.restart")}</button><button class="btn ghost sm" type="button" data-act="soon">${t("window.settings.advanced.open-logs")}</button></div></div>`;

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
  /* Restart relaunches through the desktop app's bridge only (the engine's own route refuses on Windows and outside a
     supervisor), so it stays greyed here. Open logs shows what the engine wrote down (GET /api/logs) in a new window. */
  html += `<div class=\"acts\"><button class=\"btn sm\" type=\"button\" data-act=\"restart16\">${t("server.restart")}</button><button class=\"btn ghost sm\" type=\"button\" data-act=\"adv-logs\">${t("window.settings.advanced.open-logs")}</button></div>`;
  html += "</div>";
  html += localTile() + browserTile();

  // Seeing more section
  html += `<div class=\"sec\"><h2>${t("window.settings.advanced.seeing-more")}</h2>`;
  html += `<div class="ctl"><b>${t("window.settings.advanced.show-the-thinking")}</b><input class="sw" type="checkbox" id="ad-think" ${D.knobs?.reasoning?.showReasoning === true ? "checked" : ""} aria-label="${t("window.settings.advanced.show-the-thinking")}" data-sw="set"><small>${t("window.settings.advanced.adds-the-models-reasoning-under-each")}</small></div>`;
  const keep = D.log?.keepDays ? t("window.settings.advanced.every-step-kept-for-days", { days: esc(D.log.keepDays) }) : "";
  html += `<div class="ctl"><b>${t("field.activity-log-mode")}</b><input class="sw" type="checkbox" id="ad-log" ${D.log?.mode && D.log.mode !== "off" ? "checked" : ""} aria-label="${t("field.activity-log-mode")}" data-sw="set"><small>${keep}</small></div>`;
  html += `<div class=\"ctl\"><b>${t("window.settings.advanced.send-crash-reports")}</b><input class=\"sw\" type=\"checkbox\" id=\"ad-crash\" aria-label=\"${t("window.settings.advanced.send-crash-reports")}\" data-sw=\"set\"><small>${t("window.settings.advanced.only-the-error-never-your-conversations")}</small></div>`;
  html += "</div>";

  // Level-specific content (shown at advanced level and above)
  if (lv >= 1) {
    html += `<div class=\"sec x15-sec\"><h2>${t("memory.movein.kind.memory")}</h2>`;
    html += `<div class=\"ctl\"><b>${t("window.settings.advanced.most-facts-it-keeps")}</b><span class=\"right num15\"><input class=\"inp\" id=\"ad-facts\" value=\"` + esc(E.state?.memoryCapacity?.maxFacts ?? "") + `\" aria-label=\"${t("window.settings.advanced.most-facts-it-keeps")}\" data-sw=\"set\" disabled><small>${t("window.settings.advanced.facts")}</small></span><small>${t("window.settings.advanced.tidy-up-suggests-what-to-archive")}</small></div>`;
    html += `<div class=\"ctl\"><b>${t("window.settings.advanced.match-by-meaning")}</b><input class=\"sw\" type=\"checkbox\" id=\"f15-match-by-meaning\" aria-label=\"${t("window.settings.advanced.match-by-meaning")}\" data-sw=\"set\"><small>${t("window.settings.advanced.finds-invoice-when-the-fact-says")}</small></div>`;
    html += `<div class=\"ctl\"><b>${t("window.settings.advanced.share-memory-between-trunks")}</b><input class=\"sw\" type=\"checkbox\" id=\"f15-share-memory-between-trunks\" aria-label=\"${t("window.settings.advanced.share-memory-between-trunks")}\" data-sw=\"set\"><small>${t("window.settings.advanced.off-each-trunk-keeps-its-own")}</small></div>`;
    html += `<div class=\"ctl\"><b>${t("window.settings.advanced.outside-memory")}</b><span class=\"right\"><span class=\"seg\" role=\"group\" aria-label=\"${t("window.settings.advanced.outside-memory")}\"><button type=\"button\" aria-pressed=\"false\" data-act=\"seg\">${t("comfort.placeholder.none")}</button><button type=\"button\" aria-pressed=\"false\" data-act=\"seg\">Mem0</button><button type=\"button\" aria-pressed=\"false\" data-act=\"seg\">Honcho</button><button type=\"button\" aria-pressed=\"false\" data-act=\"seg\">Hindsight</button></span></span><small></small></div>`;
    html += `<div class=\"ctl\"><b>${t("window.settings.advanced.keep-a-history-in-git")}</b><input class=\"sw\" type=\"checkbox\" id=\"f15-keep-a-history-in-git\" aria-label=\"${t("window.settings.advanced.keep-a-history-in-git")}\" data-sw=\"set\"><small>${t("window.settings.advanced.every-change-to-memory-as-a")}</small></div>`;
    html += `<div class=\"ctl\"><b>${t("window.settings.advanced.archive-facts-unused-for")}</b><span class=\"right\"><span class=\"seg\" role=\"group\" aria-label=\"${t("window.settings.advanced.archive-facts-unused-for")}\"><button type=\"button\" aria-pressed=\"false\" data-act=\"seg\">${t("window.settings.advanced.90-days")}</button><button type=\"button\" aria-pressed=\"false\" data-act=\"seg\">${t("window.settings.advanced.180-days")}</button><button type=\"button\" aria-pressed=\"false\" data-act=\"seg\">${t("window.settings.advanced.never")}</button></span></span><small></small></div>`;
    html += "</div>";

    html += `<div class=\"sec x15-sec\"><h2>${t("dashboard.automations.title")}</h2>`;
    html += `<div class=\"ctl\"><b>${t("window.settings.advanced.report-only-what-changed")}</b><input class=\"sw\" type=\"checkbox\" id=\"f15-report-only-what-changed\" aria-label=\"${t("window.settings.advanced.report-only-what-changed")}\" data-sw=\"set\"><small>${t("window.settings.advanced.checks-compare-with-last-time-and")}</small></div>`;
    html += `<div class=\"ctl\"><b>${t("window.settings.advanced.checks-and-retries-in-procedures")}</b><input class=\"sw\" type=\"checkbox\" id=\"f15-checks-and-retries-in-procedures\" aria-label=\"${t("window.settings.advanced.checks-and-retries-in-procedures")}\" data-sw=\"set\"><small>${t("window.settings.advanced.a-step-can-check-its-own")}</small></div>`;
    html += `<div class=\"ctl\"><b>${t("autonomy.part.procedures")}</b><input class=\"sw\" type=\"checkbox\" id=\"f15-procedures-that-start-themselves\" aria-label=\"${t("autonomy.part.procedures")}\" data-sw=\"set\"><small>${t("window.settings.advanced.on-a-clock-or-after-a")}</small></div>`;
    html += `<div class=\"ctl\"><b>${t("window.settings.advanced.start-when-a-usb-device-is")}</b><input class=\"sw\" type=\"checkbox\" id=\"f15-start-when-a-usb-device-is-plugged-in\" aria-label=\"${t("window.settings.advanced.start-when-a-usb-device-is")}\" data-sw=\"set\"><small>${t("window.settings.advanced.only-for-triggers-you-make")}</small></div>`;
    html += `<div class=\"ctl\"><b>${t("window.settings.advanced.reach-webhooks-from-outside")}</b><span class=\"right\"><span class=\"seg\" role=\"group\" aria-label=\"${t("window.settings.advanced.reach-webhooks-from-outside")}\"><button type=\"button\" aria-pressed=\"false\" data-act=\"seg\">${t("accounts.switch.off")}</button><button type=\"button\" aria-pressed=\"false\" data-act=\"seg\">cloudflared</button><button type=\"button\" aria-pressed=\"false\" data-act=\"seg\">ngrok</button><button type=\"button\" aria-pressed=\"false\" data-act=\"seg\">Tailscale</button></span></span><small></small></div>`;
    html += `<div class=\"ctl\"><b>${t("window.settings.advanced.use-what-the-trigger-sent")}</b><input class=\"sw\" type=\"checkbox\" id=\"f15-use-what-the-trigger-sent\" aria-label=\"${t("window.settings.advanced.use-what-the-trigger-sent")}\" data-sw=\"set\"><small>${t("window.settings.advanced.payload-and-field-path-in-the")}</small></div>`;
    html += "</div>";

    html += `<div class=\"sec x15-sec\"><h2>${t("window.settings.advanced.tools-and-skills")}</h2>`;
    html += `<div class=\"ctl\"><b>${t("window.settings.advanced.check-a-skill-is-ready-first")}</b><input class=\"sw\" type=\"checkbox\" id=\"f15-check-a-skill-is-ready-first\" aria-label=\"${t("window.settings.advanced.check-a-skill-is-ready-first")}\" data-sw=\"set\"><small>${t("window.settings.advanced.programs-keys-and-systems-it-needs")}</small></div>`;
    html += `<div class=\"ctl\"><b>${t("window.settings.advanced.only-signed-skill-packages")}</b><input class=\"sw\" type=\"checkbox\" id=\"f15-only-signed-skill-packages\" aria-label=\"${t("window.settings.advanced.only-signed-skill-packages")}\" data-sw=\"set\"><small></small></div>`;
    html += `<div class=\"ctl\"><b>${t("window.settings.advanced.check-install-requests-for-malware")}</b><input class=\"sw\" type=\"checkbox\" id=\"f15-check-install-requests-for-malware\" aria-label=\"${t("window.settings.advanced.check-install-requests-for-malware")}\" data-sw=\"set\"><small>${t("window.settings.advanced.against-the-osv-database-before-you")}</small></div>`;
    html += `<div class=\"ctl\"><b>${t("window.settings.advanced.web-search")}</b><span class=\"right\"><span class=\"seg\" role=\"group\" aria-label=\"${t("window.settings.advanced.web-search")}\"><button type=\"button\" aria-pressed=\"false\" data-act=\"seg\">DuckDuckGo</button><button type=\"button\" aria-pressed=\"false\" data-act=\"seg\">Brave</button><button type=\"button\" aria-pressed=\"false\" data-act=\"seg\">SearXNG</button><button type=\"button\" aria-pressed=\"false\" data-act=\"seg\">Tavily</button><button type=\"button\" aria-pressed=\"false\" data-act=\"seg\">Exa</button></span></span><small>${t("window.settings.advanced.duckduckgo-needs-no-key-so-search")}</small></div>`;
    html += `<div class=\"ctl\"><b>${t("personal.x.search")}</b><input class=\"sw\" type=\"checkbox\" id=\"f15-search-x\" aria-label=\"${t("personal.x.search")}\" data-sw=\"set\"><small>${t("window.settings.advanced.turns-on-when-an-x-account")}</small></div>`;
    html += `<div class=\"ctl\"><b>${t("window.settings.advanced.video-tools")}</b><input class=\"sw\" type=\"checkbox\" id=\"f15-video-tools\" aria-label=\"${t("window.settings.advanced.video-tools")}\" data-sw=\"set\"><small>${t("window.settings.advanced.download-read-captions-and-make-short")}</small></div>`;
    html += "</div>";

    html += `<div class=\"sec x15-sec\"><h2>${t("window.settings.advanced.trunks-more")}</h2>`;
    html += `<div class=\"ctl\"><b>${t("window.settings.advanced.projects-pick-up-matching-work")}</b><input class=\"sw\" type=\"checkbox\" id=\"f15-projects-pick-up-matching-work\" aria-label=\"${t("window.settings.advanced.projects-pick-up-matching-work")}\" data-sw=\"set\"><small>${t("window.settings.advanced.a-message-in-a-project-goes")}</small></div>`;
    html += `<div class=\"ctl\"><b>${t("window.settings.advanced.follow-up-tasks")}</b><input class=\"sw\" type=\"checkbox\" id=\"f15-follow-up-tasks\" aria-label=\"${t("window.settings.advanced.follow-up-tasks")}\" data-sw=\"set\"><small>${t("window.settings.advanced.a-trunk-can-leave-itself-a")}</small></div>`;
    html += `<div class=\"ctl\"><b>${t("autonomy.orders.title")}</b><span class=\"right\"><button class=\"btn sm\" type=\"button\" data-act=\"soon\">${t("window.settings.p17-permissions.see")} ` + esc(D.orders?.length ?? "") + `</button></span><small>${t("window.settings.advanced.named-programmes-a-trunk-keeps-running")}</small></div>`;
    html += `<div class=\"ctl\"><b>${t("window.settings.advanced.from-now-on-for-a-specialist")}</b><span class=\"right\"><button class=\"btn sm\" type=\"button\" data-act=\"soon\">${t("window.settings.advanced.add-one")}</button></span><small>${t("window.settings.advanced.a-standing-instruction-kept-by-one")}</small></div>`;
    html += `<div class=\"ctl\"><b>${t("window.settings.advanced.share-a-trunk")}</b><span class=\"right\"><button class=\"btn sm\" type=\"button\" data-act=\"soon\">${t("window.settings.p17-usage.export-2")}</button></span><small>${t("window.settings.advanced.through-git-as-a-skill-bundle")}</small></div>`;
    html += `<div class=\"ctl\"><b>${t("window.settings.advanced.custom-modes")}</b><span class=\"right\"><code class=\"code15\">.branch/modes.json</code></span><small>${t("window.settings.advanced.your-own-modes-one-can-hand")}</small></div>`;
    html += `<div class=\"ctl\"><b>${t("window.settings.advanced.agent-marketplace")}</b><span class=\"right\"><button class=\"btn sm\" type=\"button\" data-act=\"soon\">${t("window.settings.advanced.browse")}</button></span><small>${t("window.settings.advanced.trunks-others-made-each-with-a")}</small></div>`;
    html += "</div>";

    html += `<div class=\"sec x15-sec\"><h2>${t("window.settings.advanced.library-more")}</h2>`;
    html += `<div class=\"ctl\"><b>${t("window.settings.advanced.search-documents-by-meaning")}</b><input class=\"sw\" type=\"checkbox\" id=\"f15-search-documents-by-meaning\" aria-label=\"${t("window.settings.advanced.search-documents-by-meaning")}\" data-sw=\"set\"><small>${t("window.settings.advanced.finds-the-lease-clause-about-repairs")}</small></div>`;
    html += `<div class=\"ctl\"><b>${t("window.settings.advanced.a-local-index-of-mail-calendar")}</b><input class=\"sw\" type=\"checkbox\" id=\"f15-a-local-index-of-mail-calendar-and-messa\" aria-label=\"${t("window.settings.advanced.a-local-index-of-mail-calendar")}\" data-sw=\"set\"><small>${t("window.settings.advanced.built-and-kept-on-this-computer")}</small></div>`;
    html += `<div class=\"ctl\"><b>${t("window.settings.advanced.keep-versions-of-what-trunks-make")}</b><input class=\"sw\" type=\"checkbox\" id=\"f15-keep-versions-of-what-trunks-make\" aria-label=\"${t("window.settings.advanced.keep-versions-of-what-trunks-make")}\" data-sw=\"set\"><small>${t("window.settings.advanced.every-file-in-made-for-you")}</small></div>`;
    html += `<div class=\"ctl\"><b>${t("window.settings.advanced.rewrite-short-notes")}</b><span class=\"right\"><button class=\"btn sm\" type=\"button\" data-act=\"soon\">${t("personal.signin.try")}</button></span><small>${t("window.settings.advanced.clearer-shorter-fixed-or-more-formal")}</small></div>`;
    html += "</div>";

    html += `<div class=\"sec x15-sec\"><h2>${t("window.settings.advanced.pinned-skills")}</h2>`;
    // The choices are the engine's own skills (E.state.skills), never the prototype's examples.
    const skills = (E.state?.skills ?? []).map((k) => [String(k.name ?? k.id ?? ""), String(k.name ?? k.id ?? "")]).filter(([v]) => v);
    html += seg15(t("window.settings.advanced.always-read-in-full"), t("window.settings.advanced.a-pinned-skills-whole-instructions-go"), [["none", t("comfort.placeholder.none")], ...skills], null);
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

export function init() {
  init17();
  on("adv-logs", () => openLogs());
  markLive(["adv-logs", "sw:ad-think", "sw:ad-log"]);
  document.addEventListener("change", async (e) => {
    const wire = WIRES[e.target.id];
    if (!wire) return;
    try { await wire(e.target.checked); } catch (error) { toast(error.message); }
    await loadAll();
  });
  loadAll();
}

export async function load() { await Promise.all([loadAll(), load17()]); }

export const live = { "adv-logs": true };
