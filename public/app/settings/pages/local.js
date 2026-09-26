/* Settings › On this computer: what the engine says about models here (GET /api/local-models): this computer's memory
   and graphics, the models the one-click catalogue offers with how each size fits, what Ollama has installed, and the
   runtimes. Removing an installed model is POST /api/local-models/remove. Install starts the engine's one-click setup of
   exactly that catalogue size (POST /api/local-models/setup { model, quant }: the engine resolves the runtime's own
   download name, which the offers do not carry), follows the job in oneClick.setups, and shows the engine's refusal
   verbatim (switched off, or no runtime program installed). Running a model stays greyed. */
import { esc, render } from "../../core/dom.js";
import { S, E } from "../../core/state.js";
import { api } from "../../core/api.js";
import { on } from "../../core/actions.js";
import { markLive } from "../../core/features.js";
import { ic, toast, closeDlg } from "../../core/ui.js";
import { logo } from "../../core/logos.js";
import { t, language } from "../../../i18n.js";
import { say } from "../../core/words.js";

/* The engine's answer, shared with Models › On this computer. */
export const L = { data: null, catalog: null };
/* Which size of each offer is chosen (window state): offer id → quant. */
const chosen = {};

/* Counted the way the engine counts in its own sentences ("31.4 GB memory"): 1024³ bytes to a GB. */
export const gb = (bytes) => (bytes ? `${(bytes / 2 ** 30).toFixed(1)} GB` : "");
export const DOWNLOAD_ICON = '<svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"></path></svg>';

export async function loadLocal() {
  /* Q261: the models on this computer are the owner's setup, which a household person may not read. */
  if (E.profiles?.isOwner === false) { render(); return L.data; }
  try { L.data = await api("local-models"); } catch (error) { toast(error.message); }
  render();
  return L.data;
}
async function loadCatalog() {
  try { L.catalog = (await api("connections/catalog")).services ?? []; } catch (error) { toast(error.message); }
  render();
}

function hardware() {
  const d = L.data, hw = d?.hardware;
  if (!hw) return "";
  const tile = (icon, label, value) => (value ? `<div class="hw-c12"><span class="ico-tile">${ic(icon, "s")}</span><span><small>${label}</small><b>${esc(value)}</b></span></div>` : "");
  const graphics = hw.graphics?.name ? `${hw.graphics.name}${hw.graphics.memoryBytes ? ` · ${gb(hw.graphics.memoryBytes)}` : ""}` : "";
  const runtime = d.ollama?.installed ? `Ollama ${d.ollama.version ?? ""}`.trim() : d.lmStudio?.running ? "LM Studio" : "";
  return `<div class="hw12">${tile("layers", t("memory.movein.kind.memory"), gb(hw.totalMemoryBytes))}${tile("monitor", t("window.settings.local.graphics"), graphics)}${tile("term", t("window.settings.local.runtime"), runtime)}</div>`;
}

/* The engine's unfinished one-click setup of this offer, if one is running. */
const setupFor = (o) => (L.data?.oneClick?.setups ?? []).find((j) => j.request?.model === o.id && !j.finishedAt);

const FIT = { well: ["great", "ok"], tight: ["ok", "warn"], no: ["no", "no"] };
const summaryOf = (o) => (typeof o.summary === "string" ? o.summary : o.summary?.[language()] ?? o.summary?.en ?? "");

function offer(o) {
  const pick = chosen[o.id] ?? o.suggested ?? o.variants[0]?.quant;
  const v = o.variants.find((x) => x.quant === pick) ?? o.variants[0];
  const [fit, pill] = FIT[v?.fit] ?? FIT.no;
  const tags = `${o.tools ? `<span class="tag6">${t("window.settings.local.tools")}</span>` : ""}${o.vision ? `<span class="tag6">${t("window.settings.local.sees-pictures")}</span>` : ""}${o.params ? `<span class="tag6">${esc(o.params)}</span>` : ""}${v?.context ? `<span class="tag6">${t("window.settings.local.count-k-words-of-memory", { count: Math.round(v.context / 1024) })}</span>` : ""}`;
  const sizes = o.variants.map((x) => `<button type="button" data-act="lm-v" data-id="${esc(o.id)}" data-v="${esc(x.quant)}" aria-pressed="${x.quant === v?.quant}">${esc(x.label || x.quant)} · ${gb(x.downloadBytes)}</button>`).join("");
  /* The engine's note starts with its verdict ("Fits well: …"); the pill shows the verdict and the tip the rest. */
  const note = v?.note ?? "";
  const job = setupFor(o);
  const act = job
    ? `<div class="lm-bar12"><i data-css="width:${Math.round(job.percent)}%"></i></div><small class="lm-st12">${esc(job.message)} · ${Math.round(job.percent)}%</small>`
    : `<div class="acts"><button class="btn ${fit === "no" ? "ghost" : "pri"} sm" type="button" data-act="lm-get" data-id="${esc(o.id)}" data-v="${esc(v?.quant ?? "")}" ${fit === "no" ? "disabled" : ""}>${DOWNLOAD_ICON}${t("window.settings.local.install-size", { size: gb(v?.downloadBytes) })}</button></div>`;
  return `<div class="lm12 fit-${fit}"><div class="lm-h12"><b>${esc(o.name)}</b><span class="pill ${pill}" data-tip="${esc(note)}"><i></i>${esc(say(note.split(":")[0]))}</span></div><p>${esc(summaryOf(o))}</p>
    <div class="lm-tags12">${tags}</div><div class="seg lm-v12">${sizes}</div>
    ${act}</div>`;
}

/* What Ollama has installed; the one it has in memory is running on its own port. */
function installed(m) {
  const loaded = (L.data?.oneClick?.loaded ?? []).some((x) => x.name === m.name);
  const port = new URL(L.data?.oneClick?.runtimes?.find((r) => r.id === "ollama")?.baseUrl ?? "http://127.0.0.1").port;
  const state = loaded ? t("window.settings.local.running-port", { port }) : t("window.settings.local.installed");
  return `<div class="lm12 fit-great"><div class="lm-h12"><b>${esc(m.name)}</b></div><div class="acts"><span class="pill done"><i></i>${esc(state)}</span>${loaded ? `<button class="btn sm" type="button" data-act="lm-chat">${t("first-run-next.hello")}</button>` : `<button class="btn sm" type="button" data-act="lm-run" data-id="${esc(m.name)}">${t("playground.run")}</button>`}<button class="btn ghost sm" type="button" data-act="lm-rm" data-id="${esc(m.name)}">${t("accounts.action.remove")}</button></div></div>`;
}

function runtimes() {
  const d = L.data;
  const found = (id) => (d?.oneClick?.runtimes ?? []).some((r) => r.id === id && r.installed) || (id === "ollama" && d?.ollama?.installed) || (id === "lm-studio" && d?.lmStudio?.running);
  return (L.catalog ?? []).filter((s) => s.kind === "local").map((s) => `<div class="prow">${logo(s.id, s.name, 30)}<span class="grow"><b>${esc(s.name)}</b><small>${esc(s.note ?? "")}</small></span>${found(s.id) ? `<span class="pill ok"><i></i>${t("window.settings.local.found")}</span>` : `<button class="btn ghost sm" type="button" data-act="toast">${t("window.settings.local.look-for-it")}</button>`}</div>`).join("");
}

export function draw() {
  const head = `<h1>${t("glance.local")}</h1><p class="lede">${t("window.settings.local.models-that-run-here-free-and")}</p>`;
  if (!L.data) return head + `<div class="hw12 scan12"><span class="spin12"></span><b>${t("window.settings.local.looking-at-this-computer")}</b><small>${t("window.settings.local.memory-graphics-card-free-space-and")}</small></div>`;
  const offers = L.data.oneClick?.offers ?? [];
  const have = L.data.ollama?.models ?? [];
  return head + hardware()
    + `<div class="sec"><h2>${t("window.settings.local.recommended-for-you")}</h2><div class="lm-grid12">${have.map(installed).join("")}${offers.map(offer).join("")}</div></div>`
    + `<div class="sec"><h2>${t("window.settings.local.runtimes")}</h2><div class="rows">${runtimes()}</div></div>`;
}

async function remove(el) {
  try {
    await api("local-models/remove", { model: el.dataset.id });
    toast(t("window.settings.local.removed-the-space-is-free-again"));
  } catch (error) { toast(error.message); }
  await loadLocal();
}

/* Starts the setup; a refusal comes back as an error or as needsRuntime with the engine's own sentence. */
async function install(el) {
  let job;
  try { job = await api("local-models/setup", { model: el.dataset.id, quant: el.dataset.v }); } catch (error) { toast(error.message); return; }
  if (job.needsRuntime) { toast(job.message); return; }
  await follow(job.id);
}

/* Re-reads the engine's jobs until this one finishes; a failed or stopped setup says why in the engine's words. */
async function follow(id) {
  while (S.view === "settings" && S.setPage === "local") {
    const data = await loadLocal();
    const job = (data?.oneClick?.setups ?? []).find((j) => j.id === id);
    if (!job || job.finishedAt) { if (job && job.stage !== "done") toast(job.message); return; }
    await new Promise((done) => setTimeout(done, 1000));
  }
}

export function init() {
  loadLocal();
  loadCatalog();
  on("lm-v", (el) => { chosen[el.dataset.id] = el.dataset.v; render(); });
  on("lm-rm", (el) => remove(el));
  on("lm-get", (el) => install(el));
  on("lm-chat", () => { closeDlg(); S.view = "chat"; S.chat = null; render(); });
  markLive(["lm-v", "lm-rm", "lm-chat", "lm-get"]);
}

export function load() { loadCatalog(); return loadLocal(); }

export const live = { "lm-v": true, "lm-rm": true, "lm-chat": true, "lm-get": true };
