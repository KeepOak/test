/* The local-model picker, one piece used in four places: setup's "Which models should answer?", the composer's model menu
   (as a dialog), Settings › Models › On this computer, and the Add an account wizard's "On this computer" tab.
   Everything it shows is the engine's (GET /api/local-models): the models Ollama and LM Studio really have, the model the
   engine suggests for this hardware (`suggested`) and its three sizes (`recommendations`). One click does the rest, and
   only on the owner's click; nothing here starts by itself:
     1. switch models on this computer on (POST /api/local-models/switch) when they are off;
     2. when Ollama is not installed, show the engine's own install plan (POST /api/local-models/one-button/plan), and on
        the owner's second click install exactly that plan (POST /api/local-models/one-button { agreedPlan, name }), which
        then starts the setup of the picked model; when the engine cannot install it, show its install page and carry on
        once the engine finds the program;
     3. otherwise start the setup (POST /api/local-models/setup { runtime, name }) and follow the engine's job (its bytes
        and percent) until it is done, with Cancel (POST /api/local-models/setup/stop);
     4. select the connection the setup made for answering (POST /api/models, and the open conversation's model) and say
        hello through it (POST /api/models/test { preset }).
   Every refusal is shown in the engine's own words. */

import { esc, applyCss } from "../core/dom.js";
import { ic, toast, openDlg } from "../core/ui.js";
import { S, E, refresh } from "../core/state.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive, greyOut } from "../core/features.js";
import { t } from "../../i18n.js";

const LP = { data: null, loading: false, phase: null, req: null, job: null, plan: null, error: "", force: false, hello: null, ready: null };
const pause = (ms) => new Promise((done) => setTimeout(done, ms));

/* Bytes the way the engine counts them in its own sentences (1024³ to a GB), smaller units for small files. */
export function bytes(n) {
  if (!n) return "";
  if (n >= 2 ** 30) return `${(n / 2 ** 30).toFixed(1)} GB`;
  if (n >= 2 ** 20) return `${Math.round(n / 2 ** 20)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

const ollamaRuntime = () => (LP.data?.oneClick?.runtimes ?? []).find((r) => r.id === "ollama") ?? null;
/* Whether the program is on this computer (found on disk), not whether it is answering right now. */
const ollamaThere = () => !!ollamaRuntime()?.installed || !!LP.data?.ollama?.installed;
const baseName = (model) => String(model ?? "").replace(/-branch\d+k$/, "");
const connectionFor = (name) => (LP.data?.oneClick?.connections ?? []).find((c) => baseName(c.model) === name);

/* What is really on this computer: Ollama's models (without the sized copies setup makes) and LM Studio's. */
function detected() {
  const ollama = (LP.data?.ollama?.models ?? []).filter((m) => !/-branch\d+k$/.test(m.name)).map((m) => ({ runtime: "ollama", name: m.name, size: m.size }));
  const studio = (LP.data?.lmStudio?.models ?? []).map((m) => ({ runtime: "lm-studio", name: m.name, size: m.sizeBytes }));
  return [...ollama, ...studio];
}

export async function loadPick() {
  LP.loading = true;
  try { LP.data = await api("local-models"); } catch (error) { toast(error.message); }
  LP.loading = false;
  paint();
  return LP.data;
}

/* ---------- drawing ---------- */

function foundRow(m) {
  const runtime = (LP.data?.oneClick?.runtimes ?? []).find((r) => r.id === m.runtime)?.name ?? "";
  const made = m.runtime === "ollama" && connectionFor(m.name);
  /* LM Studio loads its own models: Branch's setup would fetch a Hugging Face copy again, so that control stays greyed. */
  const act = m.runtime === "ollama" ? "lp-use" : "lp-use-studio";
  /* The one answering now (the engine's active model) says so; any other is one click from answering. */
  const answering = made && E.state?.activeModel?.presetId === made.id;
  const pill = answering ? `<span class="pill work"><i></i>${t("window.local1c.answering")}</span>` : made ? `<span class="pill done"><i></i>${t("window.local1c.set-up")}</span>` : "";
  const use = answering ? "" : `<button class="btn sm" type="button" data-act="${act}" data-v="${esc(m.name)}" ${LP.phase ? "disabled" : ""}>${t("window.local1c.use")}</button>`;
  return `<div class="prow lp-row lp-found"><span class="ico-tile">${ic("cpu", "s")}</span><span class="grow"><b>${esc(m.name)}</b><small>${esc([bytes(m.size), runtime].filter(Boolean).join(" · "))}</small></span>${pill}${use}</div>`;
}

function found() {
  const list = detected();
  if (!list.length) return `<p class="lp-none">${t("window.local1c.none")}</p>`;
  return `<div class="lp-sub">${t("window.local1c.found")}</div><div class="rows">${list.map(foundRow).join("")}</div>`;
}

const sizeWord = (size) => ({ small: t("window.local1c.small"), medium: t("window.local1c.medium"), large: t("window.local1c.large") })[size] ?? size;
const haveIt = (model) => detected().some((m) => m.runtime === "ollama" && m.name === model);

function hero(r) {
  const hw = LP.data?.hardware?.summary;
  const act = haveIt(r.model) ? t("window.local1c.use") : t("window.local1c.choose-go", { size: bytes(r.downloadBytes) });
  return `<div class="lp-hero ${r.fits ? "" : "lp-warn"}"><div class="lp-hero-h"><span class="pill work"><i></i>${t("window.local1c.recommended")}</span><small>${esc(sizeWord(r.size))}</small></div>
    <b class="lp-model">${esc(r.model)}</b><p>${esc(r.expectation)}</p>
    <small class="lp-meta">${esc(t("window.local1c.meta", { size: bytes(r.downloadBytes), memory: bytes(r.needsMemoryBytes) }))}${hw ? ` · ${esc(t("window.local1c.for-this", { hardware: hw }))}` : ""}</small>
    ${r.fits ? "" : `<p class="lp-note">${esc(r.note)}</p>`}
    <div class="acts"><button class="btn pri" type="button" data-act="lp-auto" data-v="${esc(r.model)}" ${LP.phase ? "disabled" : ""}>${ic("spark", "s")}${t("window.local1c.choose")}<span class="lp-btn-sub">${esc(act)}</span></button></div></div>`;
}

function pickRow(r) {
  const fit = r.fits ? `<span class="pill ok"><i></i>${t("window.local1c.fits")}</span>` : `<span class="pill warn"><i></i>${t("window.local1c.no-fit")}</span>`;
  const label = haveIt(r.model) ? t("window.local1c.use") : t("window.local1c.get", { size: bytes(r.downloadBytes) });
  return `<div class="prow lp-row ${r.fits ? "" : "lp-warn"}"><span class="lp-size">${esc(sizeWord(r.size))}</span><span class="grow"><b>${esc(r.model)}</b><small>${esc(r.expectation)}</small><small>${esc(t("window.local1c.meta", { size: bytes(r.downloadBytes), memory: bytes(r.needsMemoryBytes) }))}</small>${r.fits ? "" : `<small class="lp-note">${esc(r.note)}</small>`}</span>${fit}<button class="btn sm ${r.fits ? "" : "ghost"}" type="button" data-act="lp-pick" data-v="${esc(r.model)}" ${LP.phase ? "disabled" : ""}>${esc(label)}</button></div>`;
}

function picker() {
  const recs = LP.data?.recommendations ?? [];
  const best = recs.find((r) => r.model === LP.data?.suggested);
  if (!recs.length) return "";
  return `${best ? hero(best) : ""}<div class="lp-sub">${t("window.local1c.pick")}</div><div class="rows">${recs.map(pickRow).join("")}</div>`;
}

const percentOf = (j) => Math.max(0, Math.min(100, Math.round(j?.percent ?? 0)));
/* The engine's bytes once it has counted some ("1 MB of 3 MB · 35%"), else its percent alone. */
const amountOf = (j) => (j?.total && j.completed
  ? t("window.local1c.amount", { done: bytes(j.completed), total: bytes(j.total), percent: percentOf(j) })
  : t("window.local1c.percent", { percent: percentOf(j) }));

function jobPanel() {
  const j = LP.job, pct = percentOf(j);
  const said = j?.message ?? t("window.local1c.starting");
  return `<div class="lp-busy" data-job="${esc(j?.id ?? "")}"><b>${esc(t("window.local1c.setting-up", { name: LP.req?.name ?? "" }))}</b><small class="lp-said">${esc(said)}</small>
    <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><u data-css="width:${pct}%"></u></div><small class="lp-amount">${esc(amountOf(j))}</small>
    <div class="acts"><button class="btn ghost sm" type="button" data-act="lp-cancel" ${j?.id ? "" : "disabled"}>${t("first-run-steps.restore-no")}</button></div></div>`;
}

/* The engine's install page. Opening it also starts waiting, so the picker carries on by itself once the program is there. */
const pageLink = () => {
  const page = ollamaRuntime()?.installPage ?? LP.data?.ollama?.downloadPage ?? "";
  return /^https?:\/\//i.test(page) ? `<a class="btn ghost sm" href="${esc(page)}" target="_blank" rel="noopener" data-act="lp-page">${t("window.local1c.by-hand")}</a>` : "";
};

function planPanel() {
  const p = LP.plan, i = p?.install;
  const lines = [p?.downloadNote, i?.verify, i?.after, i?.leavesBehindNote].filter(Boolean).map((x) => `<li>${esc(x)}</li>`).join("");
  return `<div class="lp-busy"><b>${esc(t("window.local1c.install-title", { name: p?.name ?? "" }))}</b><ul class="lp-plan">${lines}</ul>
    <div class="acts"><button class="btn pri sm" type="button" data-act="lp-install">${esc(t("window.local1c.install-go", { name: p?.name ?? "" }))}</button>${pageLink()}<button class="btn ghost sm" type="button" data-act="lp-back">${t("first-run-steps.restore-no")}</button></div></div>`;
}

function waitPanel(installing) {
  const name = ollamaRuntime()?.name ?? "";
  const words = installing ? t("window.local1c.installing", { name }) : t("window.local1c.waiting", { name });
  return `<div class="lp-busy"><b>${esc(words)}</b>${LP.error ? `<small class="lp-said">${esc(LP.error)}</small>` : ""}<div class="progress lp-spin"><u></u></div>
    <div class="acts">${installing ? "" : pageLink()}<button class="btn ghost sm" type="button" data-act="lp-back">${t("window.local1c.stop-waiting")}</button></div></div>`;
}

function errorPanel() {
  /* Too big: Try anyway (the same request with the engine's force). Anything else: Try again, and the install page only
     while the program is missing. */
  const next = LP.force ? `<button class="btn sm" type="button" data-act="lp-force">${t("window.local1c.try-anyway")}</button>` : `<button class="btn sm" type="button" data-act="lp-retry">${t("window.local1c.retry")}</button>`;
  return `<div class="status"><span class="sdot bad"></span><div><b>${esc(LP.error)}</b><div class="acts lp-acts">${next}${ollamaThere() ? "" : pageLink()}<button class="btn ghost sm" type="button" data-act="lp-back">${t("first-run-steps.restore-no")}</button></div></div></div>`;
}

function donePanel() {
  const h = LP.hello;
  const said = !h ? t("window.flows.setup.saying-hello") : h.ok ? t("window.local1c.hello", { s: (h.ms / 1000).toFixed(1), reply: h.reply }) : h.error;
  return `<div class="status"><span class="sdot ${h && !h.ok ? "bad" : ""}"></span><div><b>${esc(t("window.local1c.ready", { name: LP.ready ?? "" }))}</b><p>${esc(said)}</p><div class="acts lp-acts"><button class="btn ghost sm" type="button" data-act="lp-back">${t("window.local1c.another")}</button></div></div></div>`;
}

const PANELS = { starting: jobPanel, job: jobPanel, plan: planPanel, installing: () => waitPanel(true), waiting: () => waitPanel(false), error: errorPanel, done: donePanel };

function body() {
  if (!LP.data) {
    if (!LP.loading) loadPick();
    return `<div class="hw12 scan12"><span class="spin12"></span><b>${t("window.settings.local.looking-at-this-computer")}</b><small>${t("window.settings.local.memory-graphics-card-free-space-and")}</small></div>`;
  }
  const panel = LP.phase ? PANELS[LP.phase]() : "";
  return `${found()}${panel}${LP.phase ? "" : picker()}`;
}

/* Hosts draw this once in their own markup; every change after that is drawn in place here. */
export function localPicker() { return `<div class="lp">${body()}</div>`; }

function paint() {
  for (const box of document.querySelectorAll(".lp")) {
    if (updateBar(box)) continue;
    box.innerHTML = body();
    applyCss(box);
    greyOut(box);
  }
}

/* While the same download is running only its words and bar change, so Cancel keeps the keyboard. */
function updateBar(box) {
  const busy = box.querySelector(".lp-busy[data-job]");
  if (LP.phase !== "job" || !busy || !LP.job?.id || busy.dataset.job !== LP.job.id) return false;
  const pct = percentOf(LP.job);
  busy.querySelector(".progress u").style.width = `${pct}%`;
  busy.querySelector(".progress").setAttribute("aria-valuenow", String(pct));
  busy.querySelector(".lp-said").textContent = LP.job.message ?? "";
  busy.querySelector(".lp-amount").textContent = amountOf(LP.job);
  return true;
}

/* ---------- doing it ---------- */

function fail(message, canForce = false) {
  Object.assign(LP, { phase: "error", error: message, force: canForce });
  paint();
}

/* Models on this computer ship off; picking one is the owner asking for them, so the switch goes to "when needed". */
async function switchOn() {
  if ((LP.data?.mode ?? "off") === "off") LP.data.mode = (await api("local-models/switch", { mode: "when-needed" })).mode;
}

/* The engine refuses a model too big for this computer unless asked again with force; that one refusal offers Try anyway. */
const tooBig = (message) => /won.t fit/i.test(message);

async function begin(name, force = false) {
  if (!name) return;
  Object.assign(LP, { req: { name, force }, job: null, plan: null, error: "", force: false, hello: null, ready: null, phase: "starting" });
  paint();
  try {
    await switchOn();
    const made = connectionFor(name);
    if (made) return select(made.id, name);
    if (!ollamaThere()) return showPlan();
    await setup(name, force);
  } catch (error) { fail(error.message, !force && tooBig(error.message)); }
}

async function setup(name, force) {
  const job = await api("local-models/setup", { runtime: "ollama", name, ...(force ? { force: true } : {}) });
  if (job.needsRuntime) return waitForRuntime(job.message);
  LP.job = job;
  LP.phase = "job";
  paint();
  await follow(job.id);
}

/* The engine's plan for installing the program, shown before anything is installed. Install is offered only when the one
   thing in the way is the install switch, which the owner's click may turn on; under Lockdown, or for someone else's
   profile, the engine's refusal is shown as it is and the picker waits for the program instead. */
async function showPlan() {
  LP.plan = await api("local-models/one-button/plan", {});
  if (LP.plan.alreadyInstalled) return setup(LP.req.name, LP.req.force);
  if (LP.plan.install?.instead) return waitForRuntime(LP.plan.install.instead);
  if (LP.plan.refusal) {
    const locked = (await api("lockdown")).on === true;
    const someoneElse = !!E.profiles?.active?.id;
    if (locked || someoneElse || (LP.data?.installMode ?? "off") !== "off") return waitForRuntime(LP.plan.refusal);
  }
  LP.phase = "plan";
  paint();
}

/* The owner agreed to the plan on screen: installing is allowed for this install only, then set back as it was. */
async function install() {
  const plan = LP.plan, name = LP.req?.name;
  if (!plan?.install || !name) return;
  const before = LP.data?.installMode ?? "off";
  LP.phase = "installing";
  LP.error = "";
  paint();
  try {
    if (before === "off") await api("local-models/install/switch", { mode: "when-needed" });
    const answer = await api("local-models/one-button", { agreedPlan: plan.install.fingerprint, name });
    if (answer.needsAgreement) { await restoreInstall(before); LP.plan = { ...plan, install: answer.needsAgreement }; LP.phase = "plan"; toast(answer.message); paint(); return; }
    await restoreInstall(before);
    await loadPick();
    if (!answer.job) return setup(name, LP.req?.force);
    Object.assign(LP, { job: answer.job, phase: "job" });
    paint();
    await follow(answer.job.id);
  } catch (error) {
    await restoreInstall(before);
    /* The connection dropped while the engine was still installing: keep waiting for the program. */
    if (!error.status) return waitForRuntime("", "installing");
    /* The engine refused or the install failed: its words, its install page, and the picker carries on once the program
       is there, whoever installs it. */
    return waitForRuntime(error.message);
  }
}

async function restoreInstall(before) {
  if (before === "off") await api("local-models/install/switch", { mode: "off" }).catch((error) => toast(error.message));
}

/* Nothing to install with: say why and where to get it, then carry on by itself once the engine finds the program. */
async function waitForRuntime(said = "", phase = "waiting") {
  const req = LP.req;
  Object.assign(LP, { phase, error: said });
  paint();
  while (LP.req === req && (LP.phase === "waiting" || LP.phase === "installing")) {
    await pause(3000);
    await loadPick();
    if (LP.req === req && ollamaThere()) {
      try { return await setup(req.name, req.force); } catch (error) { return fail(error.message, !req.force && tooBig(error.message)); }
    }
  }
}

/* "Install it yourself": the page opens, and the picker waits for the program from here. */
function openPage(el) {
  if (/^https?:\/\//i.test(el.href)) window.open(el.href, "_blank", "noopener");
  if (LP.req && (LP.phase === "plan" || LP.phase === "error")) waitForRuntime(LP.phase === "error" ? LP.error : "");
}

/* Follows the engine's job; a finished one is connected and selected, a failed or stopped one says why. */
async function follow(id) {
  while (LP.phase === "job" && LP.job?.id === id) {
    await pause(700);
    const data = await api("local-models").catch((error) => { toast(error.message); return null; });
    if (!data) continue;
    LP.data = data;
    const job = (data.oneClick?.setups ?? []).find((j) => j.id === id);
    if (!job || LP.job?.id !== id) return;
    LP.job = job;
    if (!job.finishedAt) { paint(); continue; }
    if (job.stage === "done" && job.connectionId) return select(job.connectionId, LP.req?.name ?? job.label);
    return fail(job.message);
  }
}

/* Answers with it from now on: new conversations, and the open one too, then one hello through this very connection. */
async function select(id, name) {
  try {
    await api("models", { activePreset: id });
    if (S.chat) await api(`sessions/${encodeURIComponent(S.chat)}/model`, { preset: id });
    await refresh();
  } catch (error) { return fail(error.message); }
  Object.assign(LP, { phase: "done", ready: name, hello: null });
  paint();
  document.dispatchEvent(new CustomEvent("branch-model-picked"));
  LP.hello = await api("models/test", { preset: id }).catch((error) => ({ ok: false, error: error.message }));
  await loadPick();
}

async function cancel() {
  if (!LP.job?.id) return;
  try { await api("local-models/setup/stop", { id: LP.job.id }); } catch (error) { toast(error.message); }
}

function back() {
  Object.assign(LP, { phase: null, req: null, job: null, plan: null, error: "", force: false, hello: null, ready: null });
  paint();
}

/* The composer's model menu opens the same picker in a dialog. */
export function openLocalPicker() {
  if (LP.phase === "done" || LP.phase === "error") clearFinished();
  openDlg({ title: t("glance.local"), body: localPicker(), wide: true });
  loadPick();
}

/* A host opening anew: a finished panel (done or failed) gives way to the choices again; a running one stays. */
function clearFinished() {
  Object.assign(LP, { phase: null, req: null, job: null, plan: null, error: "", force: false, hello: null, ready: null });
}
export function freshPick() {
  if (LP.phase === "done" || LP.phase === "error") clearFinished();
  return loadPick();
}

let ready = false;
export function initLocalPick() {
  if (ready) return;
  ready = true;
  on("lp-auto", (el) => begin(el.dataset.v));
  on("lp-pick", (el) => begin(el.dataset.v));
  on("lp-use", (el) => begin(el.dataset.v));
  on("lp-cancel", () => cancel());
  on("lp-install", () => install());
  on("lp-retry", () => begin(LP.req?.name, LP.req?.force));
  on("lp-force", () => begin(LP.req?.name, true));
  on("lp-back", () => back());
  on("lp-open", () => openLocalPicker());
  on("lp-page", (el) => openPage(el));
  markLive(["lp-auto", "lp-pick", "lp-use", "lp-cancel", "lp-install", "lp-retry", "lp-force", "lp-back", "lp-open", "lp-page"]);
}
