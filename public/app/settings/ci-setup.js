import { controlRow, segmentedControl } from "./row-kit.js";
/* Settings › Computer › Branch in CI › Copy the setup: the few lines to paste into a GitHub or GitLab workflow, written by
   the engine from the boxes here (POST /api/coding/ci, src/coding/ci.ts): where the check runs, the model service, the
   model, its address and the name of the CI secret that holds its key. The key itself is never asked for or written.
   The engine refuses while "Running Branch in GitHub Actions or GitLab CI" is off, in its own words. */
import { esc } from "../core/dom.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { openDlg, toast } from "../core/ui.js";
import { t } from "../../i18n.js";

const CI = { kind: "github", provider: "anthropic", model: "", endpoint: "", key: "", out: null };
/* Each service's own address and the secret name its docs use; the model is the owner's to type. */
const DEFAULTS = { anthropic: ["https://api.anthropic.com", "ANTHROPIC_API_KEY"], openai: ["https://api.openai.com/v1", "OPENAI_API_KEY"] };

const seg = (act, pairs, cur, label) => segmentedControl({title: label, options: pairs, current: cur, action: act});
const box = (id, label, value) => `<div class="fld"><label for="${id}">${esc(label)}</label><input class="inp" id="${id}" value="${esc(value)}" spellcheck="false"><small>${esc(t("settings.help." + id))}</small></div>`;

/* What the boxes hold now, kept across a redraw. */
function keep() {
  const typed = (el, field) => { if (el) CI[field] = el.value.trim(); };
  typed(document.getElementById("ci-model"), "model");
  typed(document.getElementById("ci-endpoint"), "endpoint");
  typed(document.getElementById("ci-key"), "key");
}

function draw() {
  const where = t("window.settings.computer.ci-where"), service = t("window.settings.computer.ci-service");
  const body = `${controlRow(`<b>${esc(where)}</b><span class="right">${seg("ci-kind", [["github", "GitHub Actions"], ["gitlab", "GitLab CI"]], CI.kind, where)}</span><small>${esc(t("settings.help.ci-kind"))}</small>`)}`
    + `${controlRow(`<b>${esc(service)}</b><span class="right">${seg("ci-provider", [["anthropic", "Anthropic"], ["openai", t("window.settings.computer.ci-openai-shape")]], CI.provider, service)}</span><small>${esc(t("settings.help.ci-provider"))}</small>`)}`
    + box("ci-model", t("window.settings.computer.ci-model"), CI.model)
    + box("ci-endpoint", t("window.settings.computer.ci-endpoint"), CI.endpoint)
    + box("ci-key", t("window.settings.computer.ci-key"), CI.key)
    + (CI.out ? `<p class="lead-b17">${esc(t("window.settings.computer.ci-paste", { file: CI.out.file }))}</p><pre class="code6" data-css="white-space:pre;margin:0;max-height:40vh;overflow:auto">${esc(CI.out.text)}</pre>` : "");
  const foot = `<button class="btn ghost" type="button" data-act="dlg-close">${t("delight.ach.close")}</button>`
    + `<button class="btn" type="button" data-act="ci-write">${t("window.settings.computer.ci-write")}</button>`
    + (CI.out ? `<button class="btn pri" type="button" data-act="ci-copy">${t("asks.examples.copy")}</button>` : "");
  openDlg({ title: t("window.settings.computer.branch-in-ci"), body, foot, wide: true });
}

function pickProvider(v) {
  keep();
  const [endpoint, key] = DEFAULTS[v] ?? DEFAULTS.anthropic;
  const was = DEFAULTS[CI.provider] ?? [];
  CI.provider = v;
  // A box still holding the other service's usual value follows the change; one the owner typed in stays.
  if (!CI.endpoint || CI.endpoint === was[0]) CI.endpoint = endpoint;
  if (!CI.key || CI.key === was[1]) CI.key = key;
  CI.out = null;
  draw();
}

async function write() {
  keep();
  try { CI.out = await api("coding/ci", { kind: CI.kind, provider: CI.provider, model: CI.model, endpoint: CI.endpoint, keyVariable: CI.key }); } catch (error) { toast(error.message); return; }
  draw();
}

async function copy() {
  try { await navigator.clipboard.writeText(CI.out?.text ?? ""); toast(t("window.core.copied")); } catch (error) { toast(error.message); }
}

export function openCiSetup() {
  CI.out = null;
  if (!CI.endpoint) pickProvider(CI.provider); else draw();
}

export function initCiSetup() {
  markLive(["ci-open", "ci-kind", "ci-provider", "ci-write", "ci-copy", "sw:ci-model", "sw:ci-endpoint", "sw:ci-key"]);
  on("ci-open", () => openCiSetup());
  on("ci-kind", (el) => { keep(); CI.kind = el.dataset.v; CI.out = null; draw(); });
  on("ci-provider", (el) => pickProvider(el.dataset.v));
  on("ci-write", () => write());
  on("ci-copy", () => copy());
}
