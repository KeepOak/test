/* Settings › Developer › "Turn an OpenAPI file into tools": Choose a file reads a service's OpenAPI description here in the
   window (JSON or YAML, at most 900 KB) and hands its words to the engine's tools.from_openapi; the engine never opens a
   path of this computer. A dry run lists every operation the description has; the owner names the service, ticks the
   operations that may be used and, if the service needs one, picks a key already in the active project's locker (only its
   name is sent: the engine fetches the value at each call). Add registers only the ticked operations. Both calls go
   through POST /api/tools/try, the door the Playground uses, so they meet exactly the owner's rules: when the engine asks
   first, its question is shown with No and Allow once, and Allow once sends back that same request once. No yes is kept. */
import { esc } from "../core/dom.js";
import { api } from "../core/api.js";
import { openDlg, closeDlg, toast } from "../core/ui.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { gsel } from "../core/gsel.js";
import { t, plural } from "../../i18n.js";

const MAX_CHARS = 900 * 1024; // src/openapi-tools.ts openApiDocumentChars
const O = { name: "", label: "", document: "", dry: null, ticked: new Set(), secrets: [], secret: "", pending: null, busy: false };

/* A service name the engine takes: lowercase, starting with a letter, letters, digits and _ only, at most 30. */
const nameFrom = (file) => (file.replace(/\.[a-z0-9]+$/i, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^[^a-z]+/, "").slice(0, 30).replace(/_+$/, "") || "service");

function pickFile() {
  const input = Object.assign(document.createElement("input"), { type: "file", accept: ".json,.yaml,.yml" });
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file) return;
    if (file.size > MAX_CHARS) { toast(t("window.settings.openapi.too-large")); return; }
    try { O.document = await file.text(); } catch (error) { toast(error.message); return; }
    Object.assign(O, { label: file.name, name: nameFrom(file.name), dry: null, ticked: new Set(), secret: "", pending: null });
    await loadSecrets();
    await run(request(true));
  });
  input.click();
}

async function loadSecrets() {
  try {
    const project = (await api("projects")).active?.id ?? "default";
    O.secrets = ((await api(`secrets/${encodeURIComponent(project)}`)).secrets ?? []).map((s) => s.name);
  } catch { O.secrets = []; } // a household person reads no keys; the service is then added without one
}

/* The request as the engine takes it: the dry run names nothing; Add names the ticked operations and the key, if any. */
function request(dryRun) {
  const args = { name: O.name, document: O.document, label: O.label, dryRun };
  if (!dryRun) Object.assign(args, { allowlist: [...O.ticked], ...(O.secret ? { secret: O.secret, auth: "bearer" } : {}) });
  return { name: "tools.from_openapi", arguments: args };
}

async function run(req, confirm = false) {
  if (O.busy) return;
  O.busy = true;
  let outcome;
  try { outcome = await api("tools/try", { ...req, confirm }); } catch (error) { toast(error.message); }
  O.busy = false;
  if (!outcome) return;
  O.pending = outcome.status === "asked" ? req : null;
  if (outcome.status === "ran" && req.arguments.dryRun) { O.dry = outcome.result; draw(); return; }
  if (outcome.status === "ran") { closeDlg(); toast(plural(outcome.result?.registered?.length ?? 0, { one: "window.settings.openapi.added.one", other: "window.settings.openapi.added" }, { name: O.name })); return; }
  draw(outcome.status === "asked" ? outcome.question : outcome.reason ?? outcome.error ?? "", outcome.status === "asked");
}

const opRow = (op) => `<label class="prow oa-op"><input type="checkbox" data-sw="oa-op" data-op="${esc(op.operation)}" ${O.ticked.has(op.operation) ? "checked" : ""}><span class="grow"><b>${esc(`${String(op.method).toUpperCase()} ${op.path}`)}</b><small>${esc([op.operation, op.description].filter(Boolean).join(" · "))}</small></span></label>`;

function draw(said = "", asked = false) {
  const dry = O.dry, keys = [["", t("window.settings.openapi.no-key")], ...O.secrets.map((s) => [s, s])];
  const answer = said ? `<div class="oa-said"><p${asked ? "" : ' class="hint"'}>${esc(said)}</p>${asked ? `<div class="acts"><button class="btn ghost sm" type="button" data-act="oa-no">${t("window.chat.play.no")}</button><button class="btn pri sm" type="button" data-act="oa-yes">${t("window.chat.helpers.allow-once")}</button></div>` : ""}</div>` : "";
  const body = `<p class="lead-b17">${esc(t("window.settings.openapi.lead", { file: O.label }))}</p>
    <label class="fld"><span>${t("window.settings.openapi.name")}</span><input class="inp" id="oa-name" value="${esc(O.name)}" maxlength="30"><small class="hint">${esc(t("window.settings.openapi.name-hint"))}</small></label>
    ${dry ? `<p class="hint">${esc(t("window.settings.openapi.calls", { service: dry.service ?? "", base: dry.base ?? "" }))}</p><div class="rows oa-ops">${(dry.available ?? []).map(opRow).join("") || `<p class="empty">${t("window.settings.openapi.none")}</p>`}</div>
    <div class="fld"><span>${t("window.settings.openapi.key")}</span>${gsel({ id: "oa-key", label: t("window.settings.openapi.key"), options: keys, value: O.secret })}<small class="hint">${t("window.settings.openapi.key-hint")}</small></div>` : ""}
    ${answer}`;
  openDlg({ title: t("window.settings.developer.turn-an-openapi-file-into-tools"), wide: true, body,
    foot: `<button class="btn ghost" type="button" data-act="dlg-close">${t("updates.busy.cancel")}</button><button class="btn pri" type="button" data-act="oa-add" ${dry && O.ticked.size ? "" : "disabled"}>${t("window.settings.openapi.add")}</button>` });
}

export function initOpenApiPick() {
  markLive(["openapi-pick", "oa-add", "oa-yes", "oa-no", "sw:oa-name", "sw:oa-op", "sw:oa-key"]);
  on("openapi-pick", () => pickFile());
  on("oa-add", () => run(request(false)));
  on("oa-yes", () => { if (O.pending) run(O.pending, true); });
  on("oa-no", () => { O.pending = null; draw(); });
  document.addEventListener("change", (e) => {
    const el = e.target;
    if (el?.id === "oa-name") O.name = el.value.trim();
    else if (el?.id === "oa-key") O.secret = el.value;
    else if (el?.dataset?.sw === "oa-op") {
      if (el.checked) O.ticked.add(el.dataset.op); else O.ticked.delete(el.dataset.op);
      const add = document.querySelector('.dlg [data-act="oa-add"]');
      if (add) add.disabled = !O.ticked.size;
    }
  });
}
