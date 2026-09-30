/* Settings › Developer, 1:1 with the prototype (only shown at the Technical level). The local address is the one this
   window is talking to; Copy puts it on the clipboard. A switch shows the engine's own value and is live only where a
   route changes it (WIRES); a three-way feature switch reads as on unless its mode is "off", turns on as "when-needed"
   and off as "off". The session key is never shown; making a new one, sandboxed tool scripts and tools that join from
   outside stay greyed (tools joining over a WebSocket shows the engine's mode). "Load tools only when needed", portable mode and
   saving task trajectories are how Branch always works, so they are words, not switches (settings/rows15.js fact15). Finding Branch on other computers
   happens only while "Add a computer" is open (src/devices/find.ts), so its row opens that dialog (flows/computers.js,
   "addcomp"). Every other greyed row says why (core/why.js). A row of choices or a button with a translated title
   carries its English title's id as its reason key. Turn an OpenAPI file into tools reads a chosen file and
   lets the owner pick its operations (../openapi-pick.js). The Playground's Open runs one tool by hand through the engine's
   own approval gate (../playground.js). */
import { esc, render } from "../../core/dom.js";
import { api } from "../../core/api.js";
import { toast } from "../../core/ui.js";
import { on } from "../../core/actions.js";
import { markLive } from "../../core/features.js";
import { id15, sw15, btn15, code15, sec15, fact15 } from "../rows15.js";
import { developer17 } from "../p17-more.js";
import { level as level17 } from "../../core/state.js";
import { initPlayground } from "../playground.js";
import { initOpenApiPick } from "../openapi-pick.js";
import { say } from "../../core/words.js";
import { reason } from "../../core/why.js";
import { t } from "../../../i18n.js";

const D = { ls: null, dbg: null, interop: null, counters: null, loop: null, comfort: null, tracing: null };
const onMode = (mode) => (mode ? mode !== "off" : false);
const mode = (on) => (on ? "when-needed" : "off");
const part = (name) => D.interop?.parts?.find((p) => p.part === name)?.mode;

/* Language servers and debug adapters: the route replaces the whole record, so the one read is sent back with only
   "enabled" changed. */
const WIRES = {
  "dv-ls": [() => D.ls?.enabled === true, (on) => api("developer/language-servers", { ...D.ls, enabled: on })],
  "dv-dbg": [() => D.dbg?.enabled === true, (on) => api("developer/debug-adapters", { ...D.dbg, enabled: on })],
  "f15-flow-search": [() => onMode(part("flow-search")), (on) => api("interop/switch", { part: "flow-search", mode: mode(on) })],
  "f15-send-metrics-with-opentelemetry": [() => onMode(D.counters?.mode), (on) => api("usage/counters", { mode: mode(on) })],
  "f15-is-branch-keeping-up": [() => onMode(D.loop?.mode), (on) => api("event-loop", { mode: mode(on) })],
};
/* Shown as the engine holds it, never changed from here (security-greyed). */
const SHOWN = {
  "f15-tools-that-join-over-a-websocket": () => onMode(part("client-tools")),
};
const value = (id) => (WIRES[id]?.[0] ?? SHOWN[id])?.() ?? false;
const sw = (title, sub) => sw15(title, sub, value(id15(title)));

/* The terminal's status line (the comfort card "display", statusLine): Default is the engine's null (the line as it has
   always been), Minimal is the model and the room used. There is no third choice: Branch builds the line from its own
   pieces and runs no script of yours for it, which the row says in words (window.why.f15-status-line-script). */
const MINIMAL = ["model", "context"];
function statusRow() {
  const items = D.comfort?.values?.display?.statusLine, title = t("comfort.field.statusLine");
  const cur = !D.comfort ? null : items == null ? "default" : JSON.stringify(items) === JSON.stringify(MINIMAL) ? "minimal" : null;
  const opt = (v, words) => `<button type="button" aria-pressed="${cur === v}" data-act="dv-status" data-v="${v}">${esc(words)}</button>`;
  return `<div class="ctl"><b>${esc(title)}</b><span class="right"><span class="seg" role="group" aria-label="${esc(title)}">${opt("default", t("voice.default"))}${opt("minimal", t("window.settings.developer.minimal"))}</span></span><small>${esc(t("window.settings.developer.status-line-where"))} ${esc(reason("f15-status-line-script"))}</small></div>`;
}
async function setStatusLine(v) {
  try { await api("comfort", { card: "display", values: { statusLine: v === "minimal" ? MINIMAL : null } }); } catch (error) { toast(error.message); }
  await loadAll();
}

export function draw() {
  let html = `<h1>${t("settings.card.developer")}</h1><p class=\"lede\">${t("settingsGrown.bucket.advanced.dev.line")}</p>`;
  html += `<div class=\"sec\"><h2>${t("window.settings.developer.local-address")}</h2>`;
  html += `<div class="ctl"><b>${esc(location.host)}</b><span class="right"><button class="btn sm" type="button" data-act="dv-copy">${t("asks.examples.copy")}</button></span><small>${t("window.settings.developer.only-this-computer-can-reach-it")}</small></div>`;
  html += `<div class=\"ctl\"><b>${t("window.settings.developer.session-key")}</b><span class=\"right\"><span data-css=\"font:12px var(--mono);color:var(--ink-3)\">&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;</span><button class=\"btn sm\" type=\"button\" data-act=\"soon\" data-why=\"session-key\">${t("window.settings.developer.make-a-new-one")}</button></span><small>${t("window.settings.developer.never-shown-in-full-here")}</small></div>`;
  html += "</div>";
  html += `<div class=\"sec\"><h2>${t("settings.advanced.code.title")}</h2>`;
  html += `<div class="ctl"><b>${t("window.settings.developer.use-language-servers")}</b><input class="sw" type="checkbox" id="dv-ls" ${value("dv-ls") ? "checked" : ""} aria-label="${t("window.settings.developer.use-language-servers")}" data-sw="set"><small>${t("window.settings.developer.programs-you-already-installed-one-per")}</small></div>`;
  html += `<div class="ctl"><b>${t("window.settings.developer.use-a-debugger")}</b><input class="sw" type="checkbox" id="dv-dbg" ${value("dv-dbg") ? "checked" : ""} aria-label="${t("window.settings.developer.use-a-debugger")}" data-sw="set"><small>${t("window.settings.developer.nothing-downloads-and-nothing-runs-until")}</small></div>`;
  html += "</div>";
  html += sec15(t("window.settings.developer.tools-technical"),
    btn15(t("window.settings.developer.turn-an-openapi-file-into-tools"), t("window.settings.openapi.row"), t("delight.bg.choose"), "openapi-pick")
    + sw("Tool scripts and WebAssembly", "Sandboxed JavaScript and .wasm add-ons.")
    + sw("Tools that join over a WebSocket", `ws://${location.host}/api/interop/client-tools/ws`)
    + fact15("Load tools only when needed", "f15-load-tools-only-when-needed") // always, every round (src/tool-loading.ts)
    + btn15(t("window.settings.developer.playground"), t("window.settings.developer.try-any-tool-through-a-form"), t("ov.open"), "playground-open"));
  html += sec15(t("window.settings.developer.automations-technical"),
    sw("Flow search", "Tries four versions of a flow on examples and keeps the best.")
    + code15(t("window.settings.developer.loop-a-prompt"), t("window.settings.developer.or-heartbeat-for-the-check-in"), "/loop 10m check the build"));
  html += sec15(t("window.settings.developer.system"),
    fact15("Portable mode", "f15-portable-mode")
    + sw("Send metrics with OpenTelemetry", D.tracing?.endpoint ?? "")
    + statusRow()
    + btn15(say("Find Branch on other computers nearby"), say("Tools and models on your network."), t("ov.open"), "addcomp", "f15-find-branch-on-other-computers-nearby")
    + sw("Is Branch keeping up", "Warns when the engine stalls for more than 5 seconds.")
    + fact15("Save task trajectories", "f15-save-task-trajectories"));
  return html + developer17(level17());
}

async function loadAll() {
  const [ls, dbg, interop, counters, loop, comfort, tracing] = await Promise.all(
    ["developer/language-servers", "developer/debug-adapters", "interop", "usage/counters", "event-loop", "comfort", "tracing/settings"]
      .map((path) => api(path).catch((error) => { toast(error.message); return null; })));
  Object.assign(D, { ls, dbg, interop, counters: counters?.counters ?? null, loop: loop?.settings ?? null, comfort, tracing: tracing?.settings ?? null });
  render();
}

async function copyAddress() {
  try { await navigator.clipboard.writeText(location.host); toast(t("window.core.copied")); } catch (error) { toast(error.message); }
}

export function init() {
  on("dv-copy", () => copyAddress());
  on("dv-status", (el) => setStatusLine(el.dataset.v));
  initPlayground();
  initOpenApiPick();
  markLive(["dv-copy", "dv-status", "sw:dv-ls", "sw:dv-dbg", "sw:f15-flow-search", "sw:f15-send-metrics-with-opentelemetry", "sw:f15-is-branch-keeping-up"]);
  document.addEventListener("change", async (e) => {
    const wire = WIRES[e.target.id];
    if (!wire) return;
    try { await wire[1](e.target.checked); } catch (error) { toast(error.message); }
    await loadAll();
  });
  loadAll();
}

export async function load() { await loadAll(); }

export const live = { "dv-copy": true, "dv-status": true };
