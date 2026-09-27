/* Settings › Developer, 1:1 with the prototype (only shown at the Technical level). The local address is the one this
   window is talking to; Copy puts it on the clipboard. A switch shows the engine's own value and is live only where a
   route changes it (WIRES); a three-way feature switch reads as on unless its mode is "off", turns on as "when-needed"
   and off as "off". The session key is never shown; making a new one, sandboxed tool scripts, tools that join from
   outside and finding other computers stay greyed. The Playground's Open runs one tool by hand through the engine's own
   approval gate (../playground.js). */
import { esc, render } from "../../core/dom.js";
import { api } from "../../core/api.js";
import { toast } from "../../core/ui.js";
import { on } from "../../core/actions.js";
import { markLive } from "../../core/features.js";
import { id15, sw15, btn15, code15, seg15, sec15 } from "../rows15.js";
import { developer17 } from "../p17-more.js";
import { level as level17 } from "../../core/state.js";
import { initPlayground } from "../playground.js";
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
const value = (id) => WIRES[id]?.[0]() ?? false;
const sw = (title, sub) => sw15(title, sub, value(id15(title)));

export function draw() {
  const statusLine = D.comfort ? (D.comfort.values?.display?.statusLine == null ? "default" : null) : null;
  let html = `<h1>${t("settings.card.developer")}</h1><p class=\"lede\">${t("settingsGrown.bucket.advanced.dev.line")}</p>`;
  html += `<div class=\"sec\"><h2>${t("window.settings.developer.local-address")}</h2>`;
  html += `<div class="ctl"><b>${esc(location.host)}</b><span class="right"><button class="btn sm" type="button" data-act="dv-copy">${t("asks.examples.copy")}</button></span><small>${t("window.settings.developer.only-this-computer-can-reach-it")}</small></div>`;
  html += `<div class=\"ctl\"><b>${t("window.settings.developer.session-key")}</b><span class=\"right\"><span data-css=\"font:12px var(--mono);color:var(--ink-3)\">&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;</span><button class=\"btn sm\" type=\"button\" data-act=\"soon\">${t("window.settings.developer.make-a-new-one")}</button></span><small>${t("window.settings.developer.never-shown-in-full-here")}</small></div>`;
  html += "</div>";
  html += `<div class=\"sec\"><h2>${t("settings.advanced.code.title")}</h2>`;
  html += `<div class="ctl"><b>${t("window.settings.developer.use-language-servers")}</b><input class="sw" type="checkbox" id="dv-ls" ${value("dv-ls") ? "checked" : ""} aria-label="${t("window.settings.developer.use-language-servers")}" data-sw="set"><small>${t("window.settings.developer.programs-you-already-installed-one-per")}</small></div>`;
  html += `<div class="ctl"><b>${t("window.settings.developer.use-a-debugger")}</b><input class="sw" type="checkbox" id="dv-dbg" ${value("dv-dbg") ? "checked" : ""} aria-label="${t("window.settings.developer.use-a-debugger")}" data-sw="set"><small>${t("window.settings.developer.nothing-downloads-and-nothing-runs-until")}</small></div>`;
  html += "</div>";
  html += sec15(t("window.settings.developer.tools-technical"),
    btn15(t("window.settings.developer.turn-an-openapi-file-into-tools"), "", t("delight.bg.choose"))
    + sw("Tool scripts and WebAssembly", "Sandboxed JavaScript and .wasm add-ons.")
    + sw("Tools that join over a WebSocket", `ws://${location.host}/api/interop/client-tools/ws`)
    + seg15(t("window.settings.developer.hardware-adapters"), "", [["off", t("accounts.switch.off")], ["serial", t("window.settings.developer.serial")], ["gpio", "GPIO"], ["i2c", "I2C"], ["spi", "SPI"]], null)
    + sw("Load tools only when needed", "Thousands of tools at the cost of dozens.")
    + btn15(t("window.settings.developer.playground"), t("window.settings.developer.try-any-tool-through-a-form"), t("ov.open"), "playground-open"));
  html += sec15(t("window.settings.developer.automations-technical"),
    sw("Flow search", "Tries four versions of a flow on examples and keeps the best.")
    + code15(t("window.settings.developer.loop-a-prompt"), t("window.settings.developer.or-heartbeat-for-the-check-in"), "/loop 10m check the build"));
  html += sec15(t("window.settings.developer.system"),
    sw("Portable mode", "Data beside the program, for a USB stick.")
    + sw("Send metrics with OpenTelemetry", D.tracing?.endpoint ?? "")
    + seg15(t("comfort.field.statusLine"), "", [["default", t("voice.default")], ["minimal", t("window.settings.developer.minimal")], ["script", t("window.settings.developer.my-script")]], statusLine)
    + sw("Find Branch on other computers nearby", "Tools and models on your network.")
    + sw("Is Branch keeping up", "Warns when the engine stalls for more than 5 seconds.")
    + sw("Save task trajectories", "Every step as JSON Lines, for analysis."));
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
  initPlayground();
  markLive(["dv-copy", "sw:dv-ls", "sw:dv-dbg", "sw:f15-flow-search", "sw:f15-send-metrics-with-opentelemetry", "sw:f15-is-branch-keeping-up"]);
  document.addEventListener("change", async (e) => {
    const wire = WIRES[e.target.id];
    if (!wire) return;
    try { await wire[1](e.target.checked); } catch (error) { toast(error.message); }
    await loadAll();
  });
  loadAll();
}

export async function load() { await loadAll(); }

export const live = { "dv-copy": true };
