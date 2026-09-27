/* Settings › Developer › Playground (the prototype's playDlgB17, "Tool playground"): run one tool by hand through the
   engine's own door, POST /api/tools/try, which holds it to exactly what a task's tool call meets: the owner's rules,
   Lockdown, the safety extras, a household person's role, and a short-lived key that can never confirm. The tools and the
   form for each come from GET /api/tools/forms (the prototype's three example tools are not drawn). When the engine asks
   first, its own question is shown with No and Allow once; Allow once sends back exactly the request that was asked about
   (captured when it was asked, and dropped as soon as the tool or a field changes), with confirm, once. Nothing here keeps
   a yes: there is no "always" and no "for this conversation". */
import { esc, applyCss } from "../core/dom.js";
import { api } from "../core/api.js";
import { openDlg, toast } from "../core/ui.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { t } from "../../i18n.js";

const P = { tools: [], name: "", pending: null, busy: false };
const chosen = () => P.tools.find((t) => t.name === P.name) ?? null;
const fieldsOf = (tool) => Object.entries(tool?.schema?.properties ?? {});
const kindOf = (property) => (Array.isArray(property?.type) ? property.type[0] : property?.type) || "string";

/* One row per property the tool's own form asks for, in the prototype's row. */
function fieldRow([name, property]) {
  const id = "play-field-" + name, kind = kindOf(property);
  const input = kind === "boolean"
    ? `<input class="sw" type="checkbox" id="${esc(id)}" aria-label="${esc(name)}" data-field="${esc(name)}" data-kind="boolean">`
    : `<input class="inp" id="${esc(id)}" ${kind === "number" || kind === "integer" ? 'type="number"' : ""} aria-label="${esc(name)}" data-field="${esc(name)}" data-kind="${esc(kind)}">`;
  return `<div class="ctl"><b>${esc(name)}</b><span class="right">${input}</span><small>${esc(property?.description ?? "")}</small></div>`;
}

/* The filled-in boxes as the object the tool expects; an empty box is left out. */
function collect() {
  const args = {};
  for (const node of document.querySelectorAll('.dlg [id^="play-field-"]')) {
    const name = node.dataset.field, kind = node.dataset.kind;
    if (kind === "boolean") { if (node.checked) args[name] = true; continue; }
    const raw = node.value.trim();
    if (!raw) continue;
    if (kind === "number" || kind === "integer") args[name] = Number(raw);
    else if (kind === "array" || kind === "object") args[name] = parsedOr(raw);
    else args[name] = raw;
  }
  return args;
}
function parsedOr(raw) {
  try { return JSON.parse(raw); } catch { return raw; } // not JSON: sent as typed, and the tool's own check answers
}

function draw() {
  const tool = chosen();
  markLive(["sw:play-tool", ...fieldsOf(tool).map(([name]) => "sw:play-field-" + name)]);
  const options = P.tools.map((t) => `<option value="${esc(t.name)}"${t.name === P.name ? " selected" : ""}>${esc(t.name)}</option>`).join(""); // state: the tool the person picked
  const body = `<p class="lead-b17">${t("window.chat.play.lead")}</p>
    <div class="ctl"><b>${t("window.chat.play.tool")}</b><span class="right"><select class="inp" id="play-tool" aria-label="${t("window.chat.play.tool")}">${options}</select></span><small>${esc(tool?.description ?? "")}</small></div>
    ${fieldsOf(tool).map(fieldRow).join("")}<div id="play-result"></div>`;
  const run = tool ? `<button class="btn pri" type="button" data-act="playrunb17">${t("window.chat.play.run", { tool: esc(tool.name) })}</button>` : "";
  openDlg({ title: t("window.chat.play.title"), body, foot: `<button class="btn" type="button" data-act="dlg-close">${t("window.chat.play.close")}</button>${run}` });
}

/* What came back: the engine's question with No and Allow once, its refusal in its own words, or the raw answer. */
function show(outcome) {
  const box = document.getElementById("play-result");
  if (!box) return;
  const raw = (text) => `<pre class="sql-b17 code-block"><code class="code-body">${esc(text)}</code></pre>`;
  if (outcome.status === "asked")
    box.innerHTML = `<p>${esc(outcome.question)}</p><div class="acts"><button class="btn ghost sm" type="button" data-act="playnob17">${t("window.chat.play.no")}</button><button class="btn pri sm" type="button" id="play-confirm" data-act="playyesb17">${t("window.chat.helpers.allow-once")}</button></div>`;
  else if (outcome.status === "refused") box.innerHTML = `<p class="hint">${esc(outcome.reason)}</p>`;
  else if (outcome.status === "ran") box.innerHTML = raw(JSON.stringify(outcome.result, null, 2) ?? "");
  else box.innerHTML = raw(outcome.error ?? "");
  applyCss(box);
}

/* The question is let go: nothing waits on a yes any more. */
function forget() {
  P.pending = null;
  const box = document.getElementById("play-result");
  if (box) box.innerHTML = "";
}

async function tryIt(request) {
  if (P.busy) return;
  P.busy = true;
  try {
    const outcome = await api("tools/try", request);
    // A field changed while it was being asked about: that question is not the request on the form any more.
    const same = request.name === P.name && JSON.stringify(request.arguments) === JSON.stringify(collect());
    P.pending = outcome.status === "asked" && same ? { name: request.name, arguments: request.arguments } : null;
    if (outcome.status === "asked" && !same) { P.busy = false; return; }
    show(outcome);
  } catch (error) { toast(error.message); }
  P.busy = false;
}

async function openPlayground() {
  try {
    P.tools = (await api("tools/forms")).tools ?? [];
  } catch (error) { toast(error.message); return; }
  if (!chosen()) P.name = P.tools[0]?.name ?? "";
  P.pending = null;
  draw();
}

export function initPlayground() {
  markLive(["playground-open", "playrunb17", "playyesb17", "playnob17", "sw:play-tool"]);
  on("playground-open", () => openPlayground());
  on("playrunb17", () => tryIt({ name: P.name, arguments: collect(), confirm: false }));
  // Only the request that was asked about, once; a changed tool or field has already dropped it.
  on("playyesb17", () => { const asked = P.pending; forget(); if (asked) tryIt({ ...asked, confirm: true }); });
  on("playnob17", () => forget());
  document.addEventListener("change", (e) => {
    if (e.target.id !== "play-tool") return;
    P.name = e.target.value;
    P.pending = null;
    draw();
  });
  document.addEventListener("input", (e) => { if (e.target.id?.startsWith("play-field-") && P.pending) forget(); });
  document.addEventListener("change", (e) => { if (e.target.id?.startsWith("play-field-") && P.pending) forget(); });
}
