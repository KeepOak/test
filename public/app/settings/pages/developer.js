import { settingsRow, switchRow, segmentedRow, linkRow } from "../row-kit.js";
/* Settings › Developer, 1:1 with the prototype (only shown at the Technical level). The local address is the one this
   window is talking to; Copy puts it on the clipboard. A switch shows the engine's own value and is live only where a
   route changes it (WIRES); a three-way feature switch reads as on unless its mode is "off", turns on as "when-needed"
   and off as "off". The session key is never shown; making a new one, sandboxed tool scripts and tools that join from
   outside stay greyed (tools joining over a WebSocket shows the engine's mode). "Load tools only when needed" is what
   the engine always does (src/tool-loading.ts), so it shows on and has no switch. Finding Branch on other computers
   happens only while "Add a computer" is open (src/devices/find.ts), so its row opens that dialog (flows/computers.js,
   "addcomp"). Every other greyed row says why (core/why.js). A row of choices or a button with a translated title
   carries its English title's id as its reason key. Turn an OpenAPI file into tools reads a chosen file and
   lets the owner pick its operations (../openapi-pick.js). The Playground's Open runs one tool by hand through the engine's
   own approval gate (../playground.js). */
import { esc, render } from "../../core/dom.js";
import { api, token } from "../../core/api.js";
import { toast } from "../../core/ui.js";
import { on } from "../../core/actions.js";
import { markLive } from "../../core/features.js";
import { id15, btn15, code15, sec15 } from "../rows15.js";
import { developer17 } from "../p17-more.js";
import { level as level17, E, S, activeId } from "../../core/state.js";
import { initPlayground } from "../playground.js";
import { initOpenApiPick } from "../openapi-pick.js";
import { say } from "../../core/words.js";
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
const locked = () => ["locked", "locked-b17"].some(name => document.getElementById("app")?.classList.contains(name));
const owner = () => E.profiles?.isOwner === true && S.signedIn && !locked();
let scopeEpoch = 0, pendingChange = false;
const snapshot = () => ({profile:E.profiles, id:activeId(), credential:token.get(), epoch:scopeEpoch});
const valid = state => state.epoch === scopeEpoch && owner() && E.profiles === state.profile && activeId() === state.id && token.get() === state.credential;
const sw = (title, sub) => switchRow({title:say(title), description:say(sub), id:id15(title), checked:owner() && value(id15(title)), attributes:`data-sw="set"${owner() ? "" : ' disabled data-why="knobs-owner-only"'}`});
async function freshOwner(state) {
  if (!valid(state)) throw new Error(t("settings.catalogue.changed"));
  const profiles = await api("profiles");
  if (!valid(state) || !profiles.isOwner || (profiles.active?.id ?? null) !== state.id) throw new Error(t("settings.catalogue.changed"));
}

/* The terminal's status line (the comfort card "display", statusLine): Default is the engine's null (the line as it has
   always been), Minimal is the model and the room used. My script stays greyed: Branch builds the line from its own
   pieces and runs no script of yours for it (window.why.f15-status-line-script). */
const MINIMAL = ["model", "context"];
function statusRow() {
  const items = D.comfort?.values?.display?.statusLine, title = t("comfort.field.statusLine");
  const cur = !D.comfort ? null : items == null ? "default" : JSON.stringify(items) === JSON.stringify(MINIMAL) ? "minimal" : null;
  return segmentedRow({title, description:t("settings.developer.status-help"), options:[["default",t("voice.default")],["minimal",t("window.settings.developer.minimal")],["script",t("window.settings.developer.my-script")]], current:owner() ? cur : null, optionAction:v => v === "script" ? "dv-status-script" : "dv-status", attributes:v => `${v === "script" ? 'data-why="f15-status-line-script"' : ""}${owner() ? "" : " disabled"}`});
}
async function setStatusLine(v) {
  const state = snapshot(); if (!valid(state) || pendingChange || !["default", "minimal"].includes(v)) return;
  pendingChange = true;
  try { await freshOwner(state); await api("comfort", { card: "display", values: { statusLine: v === "minimal" ? MINIMAL : null } }); } catch (error) { if (valid(state)) toast(error.message); }
  finally { pendingChange = false; }
  if (valid(state)) await loadAll();
}

export function draw() {
  let html = `<h1>${t("settings.card.developer")}</h1><p class=\"lede\">${t("settingsGrown.bucket.advanced.dev.line")}</p>`;
  html += `<div class=\"sec\"><h2>${t("window.settings.developer.local-address")}</h2>`;
  html += linkRow({title:location.host, description:t("settings.developer.address-help"), label:t("asks.examples.copy"), action:"dv-copy"});
  html += settingsRow({title:t("window.settings.developer.session-key"), description:t("settings.developer.key-help"), control:`<span aria-hidden="true">••••••••••••</span><button class="btn sm" type="button" data-act="soon" data-why="session-key">${esc(t("window.settings.developer.make-a-new-one"))}</button>`});
  html += "</div>";
  html += `<div class=\"sec\"><h2>${t("settings.advanced.code.title")}</h2>`;
  html += switchRow({title:t("window.settings.developer.use-language-servers"), description:t("settings.developer.language-help"), id:"dv-ls", checked:owner() && value("dv-ls"), attributes:`data-sw="set"${owner() ? "" : " disabled"}`});
  html += switchRow({title:t("window.settings.developer.use-a-debugger"), description:t("settings.developer.debug-help"), id:"dv-dbg", checked:owner() && value("dv-dbg"), attributes:`data-sw="set"${owner() ? "" : " disabled"}`});
  html += "</div>";
  html += sec15(t("window.settings.developer.tools-technical"),
    btn15(t("window.settings.developer.turn-an-openapi-file-into-tools"), t("window.settings.openapi.row"), t("delight.bg.choose"), "openapi-pick")
    + sw("Tool scripts and WebAssembly", "Sandboxed JavaScript and .wasm add-ons.")
    + sw("Tools that join over a WebSocket", t("settings.developer.client-tools-help"))
    + switchRow({title:say("Load tools only when needed"), description:t("settings.developer.lazy-tools-help"), id:id15("Load tools only when needed"), checked:true, attributes:'data-sw="set"'}) // always on, no write route
    + btn15(t("window.settings.developer.playground"), t("window.settings.developer.try-any-tool-through-a-form"), t("ov.open"), "playground-open"));
  html += sec15(t("window.settings.developer.automations-technical"),
    sw("Flow search", "Tries four versions of a flow on examples and keeps the best.")
    + code15(t("window.settings.developer.loop-a-prompt"), t("window.settings.developer.or-heartbeat-for-the-check-in"), "/loop 10m check the build"));
  html += sec15(t("window.settings.developer.system"),
    sw("Portable mode", "Data beside the program, for a USB stick.")
    + statusRow()
    + btn15(say("Find Branch on other computers nearby"), say("Tools and models on your network."), t("ov.open"), "addcomp", "f15-find-branch-on-other-computers-nearby"));
  html += sec15(t("settings.developer.diagnostics"),
    sw("Send metrics with OpenTelemetry", t("settings.developer.metrics-help"))
    + sw("Is Branch keeping up", t("settings.developer.loop-help"))
    + sw("Save task trajectories", "Every step as JSON Lines, for analysis."));
  return html + developer17(level17());
}

async function loadAll() {
  const state = snapshot();
  if (!valid(state)) { Object.keys(D).forEach(key => { D[key] = null; }); render(); return; }
  const [ls, dbg, interop, counters, loop, comfort, tracing] = await Promise.all(
    ["developer/language-servers", "developer/debug-adapters", "interop", "usage/counters", "event-loop", "comfort", "tracing/settings"]
      .map((path) => api(path).catch((error) => { if (valid(state)) toast(error.message); return null; })));
  if (!valid(state)) return;
  Object.assign(D, { ls, dbg, interop, counters: counters?.counters ?? null, loop: loop?.settings ?? null, comfort, tracing: tracing?.settings ?? null });
  render();
}

async function copyAddress() {
  try { await navigator.clipboard.writeText(location.host); toast(t("window.core.copied")); } catch (error) { toast(error.message); }
}

export function init() {
  const app = document.getElementById("app");
  if (app) new MutationObserver(() => { if (locked()) { scopeEpoch++; Object.keys(D).forEach(key => { D[key] = null; }); } }).observe(app, {attributes:true, attributeFilter:["class"]});
  on("dv-copy", () => copyAddress());
  on("dv-status", (el) => setStatusLine(el.dataset.v));
  initPlayground();
  initOpenApiPick();
  markLive(["dv-copy", "dv-status", "sw:dv-ls", "sw:dv-dbg", "sw:f15-flow-search", "sw:f15-send-metrics-with-opentelemetry", "sw:f15-is-branch-keeping-up"]);
  document.addEventListener("change", async (e) => {
    const wire = WIRES[e.target.id];
    const state = snapshot(); if (!wire || !valid(state)) return;
    if (pendingChange) { render(); return; }
    const wanted = e.target.checked; pendingChange = true; e.target.disabled = true;
    try {
      await freshOwner(state);
      const path = e.target.id === "dv-ls" ? "developer/language-servers" : e.target.id === "dv-dbg" ? "developer/debug-adapters" : null;
      if (path) { const fresh = await api(path); if (!valid(state)) return; D[e.target.id === "dv-ls" ? "ls" : "dbg"] = fresh; }
      if (!valid(state)) return;
      await wire[1](wanted);
    } catch (error) { if (valid(state)) toast(error.message); }
    finally { pendingChange = false; if (e.target.isConnected) e.target.disabled = false; }
    if (valid(state)) await loadAll();
  });
  loadAll();
}

export async function load() { await loadAll(); }

export const live = { "dv-copy": true, "dv-status": true };
