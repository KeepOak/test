/* Settings › Permissions, pass 17 (prototype patch17b), from the engine:
   Test a rule: POST /api/rules/test { tool, target } says which rule decides; nothing runs. An address is asked as
   web.fetch, words with a space as a command (shell.session.run), anything else as a file (files.write).
   What Trunks may reach: GET /api/firewall's sentences, and POST /api/firewall/test { address } for one address.
   Why is this set?: every setting whose value differs from how Branch ships (GET /api/settings-kit), each with the
   engine's own words (GET /api/settings-kit/why/<key>.<field>); Put back is POST /api/settings-kit/apply with that one
   field's shipped value and never confirmLoosening, so the engine itself refuses a put-back that loosens anything.
   Emergency stop: drawn from GET /api/safety-extras (stop.everything). Stop everything asks first ("Stop everything?"),
   then POST /api/safety-extras/stop { everything: true } holds every task. Let them resume is
   POST /api/safety-extras/stop/release, sent again with confirmLoosening only after the owner's yes to the engine's words;
   when the engine refuses it for want of the authenticator code, its words are
   shown with a box for the code and the release is sent again with it. The release lets go of every level, so it is
   live only while every-task is the only level held, read again from the engine just before it is sent.
   Every change to what Branch may reach: the engine's record (GET /api/audit), and Export as CSV saves
   GET /api/audit/export.csv.
   A second look before approvals: the engine's approval_reviewer switch, from GET /api/settings-kit. On is POST
   /api/settings-kit/apply { plan: { source: "set", key: "approval_reviewer", field: "mode", value: "on" } }, which only
   tightens. Off makes Branch less careful, so it is sent first without confirmLoosening; the engine refuses it and its
   words are shown in a confirm, and only "Turn it off" there sends it again with confirmLoosening. Lockdown refuses
   both in its own words. The switch is drawn again from the engine after every answer.
   App lock: live, from ./applock17.js (GET /api/lock, POST /api/lock/pin and /api/lock/settings).
   "Hold back keys found in answers" is words, not a switch: the engine's leak guard is always on and has none, and an off
   switch would weaken a guard (rows15.js fact15). The rows under "Guards that are always on" open the engine's readouts (./demos-b5.js) where it
   keeps one. */
import { esc, render } from "../core/dom.js";
import { api, token } from "../core/api.js";
import { onDemo17 } from "../places/demo17.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { toast, openDlg, closeDlg, dialog, $ } from "../core/ui.js";
import { sw15, seg15, fact15 } from "./rows15.js";
import { demos17, demo17, row17, sec17, pill17 } from "./rows17.js";
import { t, language } from "../../i18n.js";
import { say } from "../core/words.js";
import { applockRow, initApplock } from "./applock17.js";

const P = { kit: null, safety: null, result: null, fw: null, why: [] };

export async function load17() {
  const [kit, safety] = await Promise.all(["settings-kit", "safety-extras"].map((path) => api(path).catch((error) => { toast(error.message); return null; })));
  Object.assign(P, { kit, safety });
  render();
}

/* Every field whose value is not the one Branch ships, as { spec, field }. */
const changed = () => (P.kit?.settings ?? []).flatMap((spec) => spec.fields.filter((f) => f.value !== undefined && f.value !== null
  && JSON.stringify(f.value) !== JSON.stringify(f.initial)).map((field) => ({ spec, field })));
const kitMode = (key) => P.kit?.settings?.find((s) => s.key === key)?.fields?.find((f) => f.field === "mode")?.value;

export function sections17(lv) {
  if (lv < 1) return "";
  const n = P.kit ? changed().length : null;
  /* "Stopped" is the stop's every-task level; Let them resume lets go of every level at once (the engine's only release),
     so it is live only when every-task is the one level held, and greyed when a network, site or tool stop set elsewhere
     would go with it. */
  const stop = P.safety?.stop, stopped = stop?.everything === true, onlyEverything = onlyEveryTask(stop);
  let html = sec17(t("window.settings.p17-permissions.test-and-explain"),
    row17(t("window.settings.p17-permissions.test-a-rule"), t("window.settings.p17-permissions.type-a-command-a-file-or"), t("window.settings.p17-permissions.test"), "ruletestb17")
    + row17(t("window.settings.p17-permissions.what-trunks-may-reach-in-sentences"), t("window.settings.p17-permissions.every-site-and-network-rule-written"), t("window.settings.p17-permissions.read-it"), "fwb17")
    + row17(t("window.settings.p17-permissions.why-is-this-set"), t("window.settings.p17-permissions.each-setting-that-differs-from-the"), n == null ? t("window.settings.p17-permissions.see") : t("window.settings.p17-permissions.see-count", { count: n }), "whyb17")
    + sw15("A second look before approvals", "Another model reads risky actions first and says what worries it.", (kitMode("approval_reviewer") ?? "off") !== "off")
    + fact15("Hold back keys found in answers", "f15-hold-back-keys-found-in-answers")
    + demo17("trust"));
  html += sec17(t("window.settings.p17-permissions.locks-and-records"),
    applockRow()
    + (stopped ? row17(t("safety.stop.title"), t("window.settings.p17-permissions.stopped-every-task-is-halted-nothing"), t("window.settings.p17-permissions.let-them-resume"), onlyEverything ? "estoprelb17" : "estoprelb17-soon")
      : row17(t("safety.stop.title"), t("window.settings.p17-permissions.stops-every-task-at-once-on"), t("window.settings.p17-permissions.stop-everything"), "estopb17"))
    + demos17(["audit", "practice"]));
  /* The loop guard ships on (src/loop-guard.ts loopGuardShipsAs); it is listed as always on only while the engine says it is. */
  const guards = ["injection", "chatperm", ...(kitMode("loop_guard") === "off" ? [] : ["loopguard"]), "leakguard", "codecheck"];
  if (lv >= 2) html += sec17(t("window.settings.p17-permissions.guards-that-are-always-on"), demos17(guards));
  return html;
}

/* ---------- Test a rule ---------- */
const DECIDES = { allow: ["ok", "Allowed"], ask: ["warn", "Asks"], deny: ["no", "Never"] };
function ruleDlg() {
  const r = P.result;
  const res = r ? `<div class="res-line-b17">${DECIDES[r.decision] ? pill17(DECIDES[r.decision][0], say(DECIDES[r.decision][1])) : pill17("idle", r.decision)}<span><b>${esc(r.because)}</b><small></small></span></div>` : "";
  openDlg({ title: t("window.settings.p17-permissions.test-a-rule"), body: `<p class="lead-b17">${t("window.settings.p17-permissions.nothing-runs-branch-only-says-what")}</p><div class="test-b17"><input class="inp" id="rule-in-b17" value="${esc(P.ruleQ ?? "")}" aria-label="${t("window.settings.p17-permissions.command-file-or-site")}"><button class="btn pri sm" type="button" data-act="rulerunb17" ${(P.ruleQ ?? "").trim() ? "" : "disabled"}>${t("window.settings.p17-permissions.test")}</button></div><div class="chips-b17">${[t("window.settings.p17-permissions.git-status")].map((t) => `<button type="button" class="chip-b17" data-act="rulepickb17" data-v="${esc(t)}">${esc(t)}</button>`).join("")}</div>${res}`,
    foot: `<button class="btn" type="button" data-act="dlg-close">${t("delight.ach.close")}</button>` });
}
const toolFor = (q) => (/^https?:\/\//i.test(q) ? "web.fetch" : /\s/.test(q) ? "shell.session.run" : "files.write");
async function runRule() {
  const q = ($("#rule-in-b17")?.value ?? "").trim();
  P.ruleQ = q;
  if (!q) return;
  try { P.result = await api("rules/test", { tool: toolFor(q), target: q }); } catch (error) { toast(error.message); return; }
  ruleDlg();
}

/* ---------- What Trunks may reach ---------- */
function fwDlg(out = "") {
  const sentences = P.fw?.sentences ?? [];
  openDlg({ title: t("window.settings.p17-permissions.what-trunks-may-reach"), body: `<ol class="fw-b17">${sentences.map((s) => `<li>${esc(s)}</li>`).join("")}</ol><div class="test-b17"><input class="inp" id="fw-in-b17" value="${esc(P.fwQ ?? "")}" aria-label="${t("window.settings.p17-permissions.an-address-to-check")}"><button class="btn sm" type="button" data-act="fwtestb17">${t("window.settings.p17-permissions.check-an-address")}</button></div><p class="hint" id="fw-out-b17" data-css="margin:0">${esc(out)}</p>`,
    foot: `<button class="btn" type="button" data-act="dlg-close">${t("delight.ach.close")}</button>` });
}
async function openFw() {
  try { P.fw = await api("firewall"); } catch (error) { toast(error.message); return; }
  fwDlg();
}
async function testFw() {
  const address = ($("#fw-in-b17")?.value ?? "").trim();
  P.fwQ = address;
  if (!address) return;
  try {
    const r = await api("firewall/test", { address });
    fwDlg(r.reason ? `${r.address}: ${r.reason}` : r.address);
  } catch (error) { toast(error.message); }
}

/* ---------- Why is this set? ---------- */
const title = ({ spec, field }) => (spec.fields.length > 1 ? `${spec.name} · ${field.label}` : spec.name);
async function readWhy() {
  const rows = changed();
  P.why = await Promise.all(rows.map(async (row) => {
    const id = row.spec.key + "." + row.field.field;
    const words = await api(`settings-kit/why/${encodeURIComponent(id)}`).then((w) => w.words, (error) => error.message);
    return { ...row, words };
  }));
}
function whyDlg() {
  const body = P.why.map((row) => `<div class="prow why-b17"><span class="grow"><b>${esc(title(row))}</b><small>${esc(row.words)}</small></span>${pill17("ok", String(row.field.value))}<button class="btn ghost sm" type="button" data-act="whyputb17" data-key="${esc(row.spec.key)}" data-field="${esc(row.field.field)}">${t("activityLog.action.putBack")}</button></div>`).join("");
  openDlg({ title: t("window.settings.p17-permissions.why-is-this-set"), wide: true, body: `<div class="rows">${body}</div>`, foot: `<button class="btn" type="button" data-act="dlg-close">${t("delight.ach.close")}</button>` });
}
async function openWhy() {
  try { P.kit = await api("settings-kit"); await readWhy(); } catch (error) { toast(error.message); return; }
  whyDlg();
  render();
}
async function putBack(el) {
  const row = P.why.find((r) => r.spec.key === el.dataset.key && r.field.field === el.dataset.field);
  if (!row) return;
  try {
    const done = await api("settings-kit/apply", { plan: { source: "set", key: row.spec.key, field: row.field.field, value: row.field.initial }, accept: [`${row.spec.key}.${row.field.field}`] });
    const why = done.skipped?.[0]?.why ?? done.refused?.[0]?.why ?? done.refused?.[0]?.reason;
    if (!done.applied?.length && why) toast(why);
    else if (done.applied?.length) toast(t("window.settings.p17-permissions.put-back-row", { row: title(row) }));
    P.kit = done.overview ?? await api("settings-kit");
    await readWhy();
  } catch (error) { toast(error.message); }
  if (dialog()) whyDlg();
  render();
}

/* ---------- A second look before approvals ---------- */
const REVIEWER = "f15-a-second-look-before-approvals";
const reviewerPlan = (value) => ({ plan: { source: "set", key: "approval_reviewer", field: "mode", value }, accept: ["approval_reviewer.mode"] });
async function setReviewer(on, confirmLoosening = false) {
  try {
    const done = await api("settings-kit/apply", { ...reviewerPlan(on ? "on" : "off"), ...(confirmLoosening ? { confirmLoosening } : {}) });
    const why = done.skipped?.[0]?.why ?? done.refused?.[0]?.why ?? done.refused?.[0]?.reason;
    if (!done.applied?.length && why) toast(why);
    if (done.overview) P.kit = done.overview;
  } catch (error) {
    // Turning it off without the owner's yes: the engine says what would loosen, and the owner decides here.
    if (!on && !confirmLoosening && /less careful/.test(error.message)) {
      openDlg({ title: t("settings-kit.name.reviewer"), body: `<p data-css="margin:0">${esc(error.message)}</p>`,
        foot: `<button class="btn ghost" type="button" data-act="revkeepb17">${t("mode.cancel")}</button><button class="btn pri" type="button" data-act="revoffb17">${t("window.settings.p17-permissions.turn-it-off")}</button>` });
    } else toast(error.message);
  }
  await load17();
}

/* ---------- the record of every widening or narrowing ---------- */
async function openAudit() {
  const { entries } = await api("audit?limit=100");
  const day = (at) => new Date(at).toLocaleString(language(), { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const rows = (entries ?? []).map((e) => `<div class="prow"><span class="grow"><b>${esc(e.subject)}</b><small>${esc(day(e.at))} · ${esc(e.reason)}</small></span>${pill17("idle", e.outcome)}</div>`).join("");
  openDlg({ title: t("window.settings.p17-permissions.every-change-to-what-branch-may"), body: `<div class="rows demo-b17">${rows}</div>`,
    foot: `<button class="btn ghost" type="button" data-act="dlg-close">${t("delight.ach.close")}</button><button class="btn pri" type="button" data-act="demodob17" data-k="audit">${t("window.places.automations17.export-as-csv")}</button>` });
}
/* The CSV is not JSON, so it is fetched with the session key and saved as it came. */
async function saveAudit() {
  const key = token.get();
  const response = await fetch("/api/audit/export.csv", { cache: "no-store", headers: key ? { authorization: "Bearer " + key } : {} });
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || String(response.status));
  const url = URL.createObjectURL(await response.blob());
  const a = Object.assign(document.createElement("a"), { href: url, download: `branch-record-${new Date().toISOString().slice(0, 10)}.csv` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---------- the emergency stop ---------- */
async function stopAll() {
  closeDlg();
  try { await api("safety-extras/stop", { everything: true }); toast(t("window.settings.p17-permissions.everything-stopped")); } catch (error) { toast(error.message); }
  await load17();
}
/* Let them resume lets go of every level, so the stop is read again first: a network, site or tool stop set meanwhile
   leaves the release greyed instead of going with it. When the engine wants the authenticator code for the release, its
   own words are shown with a box for the code, and the release is sent again with it. */
const onlyEveryTask = (stop) => stop?.everything === true && !stop.network && !(stop.sites ?? []).length && !(stop.tools ?? []).length;
/* Letting it go is refused by the engine until the owner says yes: its words are shown in a confirm, and only "Yes, make it
   less careful" sends the release again with confirmLoosening (and the code box keeps that yes). Lockdown refuses in its
   own words, shown as they come. */
async function resume(code, yes = false) {
  try {
    const now = await api("safety-extras");
    if (!onlyEveryTask(now?.stop)) { closeDlg(); await load17(); return; }
    await api("safety-extras/stop/release", { ...(code ? { code } : {}), ...(yes ? { confirmLoosening: true } : {}) });
    closeDlg();
    toast(t("window.settings.p17-permissions.tasks-may-resume"));
  } catch (error) {
    if (!yes && error.status === 409 && /less careful/.test(error.message)) loosenDlg(error.message);
    else if (yes && !code && error.status === 401 && P.safety?.codes?.enrolled) codeDlg(error.message);
    else toast(error.message);
  }
  await load17();
}
function loosenDlg(words) {
  openDlg({ title: t("settings-kit.loosens"), body: `<p>${esc(words)}</p>`,
    foot: `<button class="btn ghost" type="button" data-act="dlg-close">${t("mode.cancel")}</button><button class="btn pri" type="button" data-act="estopyesb17">${t("settings-kit.confirm")}</button>` });
}
function codeDlg(words) {
  const label = t("window.settings.permissions.authenticator-code-for-sensitive-tools");
  openDlg({ title: t("safety.stop.title"), body: `<p class="lead-b17">${esc(words)}</p><input class="inp" id="estop-code-b17" inputmode="numeric" autocomplete="one-time-code" maxlength="12" aria-label="${esc(label)}">`,
    foot: `<button class="btn ghost" type="button" data-act="dlg-close">${t("mode.cancel")}</button><button class="btn pri" type="button" data-act="estopcodeb17">${t("window.settings.p17-permissions.let-them-resume")}</button>` });
}

let started = false;
export function init17() {
  if (started) return;
  started = true;
  onDemo17("audit", { open: () => openAudit(), go: () => saveAudit() });
  initApplock();
  on("estopb17", () => openDlg({ title: t("window.settings.p17-permissions.stop-everything-q"), body: `<p class="lead-b17">${t("window.settings.p17-permissions.every-task-on-every-computer-stops")}</p>`,
    foot: `<button class="btn ghost" type="button" data-act="dlg-close">${t("mode.cancel")}</button><button class="btn bad" type="button" data-act="estopgob17">${t("window.settings.p17-permissions.stop-everything")}</button>` }));
  on("estopgob17", () => stopAll());
  on("estoprelb17", () => resume());
  on("estopyesb17", () => { closeDlg(); resume(undefined, true); });
  on("estopcodeb17", () => { const code = ($("#estop-code-b17")?.value ?? "").trim(); if (code) resume(code, true); });
  on("ruletestb17", () => { P.result = null; ruleDlg(); });
  on("rulerunb17", () => runRule());
  /* Audit (batch D): "Test" does nothing on an empty box, so it waits, disabled, until something is typed. */
  document.addEventListener("input", (e) => {
    if (e.target?.id !== "rule-in-b17") return;
    const test = document.querySelector('[data-act="rulerunb17"]');
    if (test) test.disabled = !e.target.value.trim();
  });
  on("rulepickb17", (el) => { const box = $("#rule-in-b17"); if (box) box.value = el.dataset.v; runRule(); });
  on("fwb17", () => openFw());
  on("fwtestb17", () => testFw());
  on("whyb17", () => openWhy());
  on("whyputb17", (el) => putBack(el));
  on("revoffb17", () => { closeDlg(); setReviewer(false, true); });
  on("revkeepb17", () => { closeDlg(); render(); });
  document.addEventListener("change", (e) => { if (e.target?.id === REVIEWER) setReviewer(e.target.checked); });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    if (e.target?.id === "rule-in-b17") { e.preventDefault(); runRule(); }
    if (e.target?.id === "fw-in-b17") { e.preventDefault(); testFw(); }
  });
  markLive(["estopb17", "estopgob17", "estoprelb17", "estopyesb17", "estopcodeb17", "sw:estop-code-b17", "ruletestb17", "rulerunb17", "rulepickb17", "fwb17", "fwtestb17", "whyb17", "whyputb17", "sw:rule-in-b17", "sw:fw-in-b17",
    "sw:" + REVIEWER, "revoffb17", "revkeepb17"]);
  load17();
}
