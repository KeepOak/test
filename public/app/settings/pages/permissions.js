/* Settings › Permissions, from the engine. Without asking: the approval kinds (GET/POST /api/approvals/categories);
   recording each task and stopping a Trunk that repeats itself are the settings kit's run-recording and loop_guard
   switches, and scanning commands for hidden characters its safety-command-scan (kit17.js: a change that makes Branch
   less careful waits for the engine's own words and the owner's yes). The system sandbox is the kit's os-sandbox switch
   where the engine says the computer has one; elsewhere it stays greyed with the engine's reason under it. This Mac /
   This PC is ../os17.js.
   Scanning for personal details, the authenticator code and adding a trusted folder go through the engine's own guards
   (../perm-guards.js).
   Greyed, each for its reason: installing without asking (no approval kind of its own: shown on only when both running
   commands and changing settings go without asking); when tools are loaded (the engine decides that itself every round;
   no setting); practice runs (an explicit next-task choice in the window and the terminal's /dry-run); a container per Trunk, sign-ins from outside the
   sandbox, verifying each release and pinning SSH hosts (no engine setting says these). Downloads may come from is the
   owner's browser care card (downloadsFrom: anywhere, only sites the task's pages were on, or ask each time).
   Messages per conversation per hour is the engine's limit on the tasks one conversation starts in an hour (rateAttrs). */
import { level } from "../../core/state.js";
import { E } from "../../core/state.js";
import { on } from "../../core/actions.js";
import { markLive } from "../../core/features.js";
import { render, esc } from "../../core/dom.js";
import { api } from "../../core/api.js";
import { toast, ic, openPop, closePop, openDlg, closeDlg } from "../../core/ui.js";
import { setLockdown } from "../../chat/approvals.js";
import { sections17, init17, load17 } from "../p17-permissions.js";
import { osSection17, initOs17, loadOs17 } from "../os17.js";
import { K, kitOn, kitSeg, changed, loadKit } from "../kit17.js";
import { t } from "../../../i18n.js";
import { loadPracticeRuns, practiceAttrs, initPracticeRuns } from "../practice-runs.js";
import { say } from "../../core/words.js";
import { fact15 } from "../rows15.js";
import { initGuards, guardsLive, piiOn, codesOn } from "../perm-guards.js";

const HEAD = () => `<h1>${t("settings.page.permissions")}</h1><p class="lede">${t("window.settings.permissions.what-trunks-may-do-without-asking")}</p>`;

const BASE_SWITCHES = () => `@@STATUS@@
    <div class="sec"><h2>${t("window.settings.permissions.without-asking-trunks-may")}</h2>
      <div class="ctl"><b>${t("window.settings.permissions.read-files-in-documents-and-downloads")}</b><input class="sw" type="checkbox" id="p-read" @@read@@ aria-label="${t("window.settings.permissions.read-files-in-documents-and-downloads")}" data-sw="set"><small>${t("window.settings.permissions.reading-never-changes-a-file")}</small></div>
      <div class="ctl"><b>${t("window.settings.permissions.use-the-browser-on-this-computer")}</b><input class="sw" type="checkbox" id="p-browse" @@browse@@ aria-label="${t("window.settings.permissions.use-the-browser-on-this-computer")}" data-sw="set"><small>${t("window.settings.permissions.signs-in-with-your-saved-sign")}</small></div>
      <div class="ctl"><b>${t("window.settings.permissions.send-email-and-messages")}</b><input class="sw" type="checkbox" id="p-send" @@message@@ aria-label="${t("window.settings.permissions.send-email-and-messages")}" data-sw="set"><small>${t("window.settings.permissions.off-means-every-message-waits-for")}</small></div>
      <div class="ctl"><b>${t("window.settings.permissions.install-tools-and-packages")}</b><input class="sw" type="checkbox" id="p-install" @@install@@ aria-label="${t("window.settings.permissions.install-tools-and-packages")}" data-sw="set"><small>${t("window.settings.permissions.off-means-a-request-shows-up")}</small></div>
      <div class="ctl"><b>${t("window.settings.permissions.record-tasks-so-you-can-watch")}</b><input class="sw" type="checkbox" id="p-record" @@record@@ aria-label="${t("window.settings.permissions.record-tasks-so-you-can-watch")}" data-sw="set"><small>${t("window.settings.permissions.recordings-stay-on-this-computer")}</small></div>
    </div>
    <details class="adv" @@ADVOPEN@@><summary><svg class="i s chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"></path></svg>${t("settings.page.advanced")}</summary>
      ${fact15(t("window.settings.permissions.when-tools-are-loaded"), "when-tools-are-loaded")}
      <div class="ctl"><b>${t("window.settings.permissions.stop-a-trunk-that-repeats-itself")}</b><input class="sw" type="checkbox" id="p-loop" @@loop@@ aria-label="${t("window.settings.permissions.stop-a-trunk-that-repeats-itself")}" data-sw="set"><small>${t("window.settings.permissions.after-5-identical-steps-it-pauses")}</small></div>
      <div class="ctl"><b>${t("settings-kit.name.folder-trust")}</b><span class="right"><button class="btn sm" type="button" data-act="ft-add8">${t("asks.runtimes.add")}</button></span><small></small></div>
    </details>
    <div class="danger"><div><b>${t("lockdown.label")}</b><p>${t("window.settings.permissions.one-switch-that-stops-every-trunk")}</p></div><button class="btn bad" type="button" data-act="perm-lock">@@LOCK@@</button></div>`;

const PINNED = () => `<div class="sec"><h2>${t("window.settings.permissions.pinned-settings")}</h2><p class="hint" data-css="margin:0 0 8px">${t("window.settings.permissions.a-pinned-setting-is-fixed-someone")}</p>@@PINS@@<div class="acts" data-css="margin-top:8px"><button class="btn sm" type="button" data-act="pin-add8"><svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg>${t("window.settings.permissions.pin-a-setting")}</button></div></div>`;

const RULES = () => `<div class="sec x15-sec"><h2>${t("window.settings.permissions.rules-for-each-tool-and-folder")}</h2><p class="hint" data-css="margin:0 0 6px">${t("window.settings.permissions.the-first-rule-that-matches-wins")}</p>@@RULES@@<div class="acts" data-css="margin-top:8px"><button class="btn sm" type="button" data-act="rule-add8"><svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg>${t("window.settings.permissions.add-a-rule")}</button></div><div class="ctl"><b>${t("window.settings.permissions.practice-runs")}</b><input class="sw" type="checkbox" id="f15-practice-runs" @@PRACTICE@@ aria-label="${t("window.settings.permissions.practice-runs")}" data-sw="set"><small>${t("window.settings.permissions.a-trunk-can-show-what-it")}</small></div><div class="ctl"><b>${t("window.settings.permissions.messages-per-conversation-per-hour")}</b><span class="right num15"><input class="inp" @@RATE@@ aria-label="${t("window.settings.permissions.messages-per-conversation-per-hour")}"></span><small>${t("window.settings.permissions.stops-a-runaway-loop")}</small></div></div><div class="sec x15-sec"><h2>${t("window.settings.permissions.checks-before-anything-runs")}</h2><div class="ctl"><b>${t("window.settings.permissions.scan-commands-for-hidden-characters")}</b><input class="sw" type="checkbox" id="f15-scan-commands-for-hidden-characters" @@scan@@ aria-label="${t("window.settings.permissions.scan-commands-for-hidden-characters")}" data-sw="set"><small>${t("window.settings.permissions.invisible-and-look-alike-characters-that")}</small></div><div class="ctl"><b>${t("window.settings.permissions.scan-for-personal-details")}</b><input class="sw" type="checkbox" id="f15-scan-for-personal-details" @@pii@@ aria-label="${t("window.settings.permissions.scan-for-personal-details")}" data-sw="set"><small>${t("window.settings.permissions.card-numbers-id-numbers-and-addresses")}</small></div><div class="ctl"><b>${t("window.settings.permissions.authenticator-code-for-sensitive-tools")}</b><input class="sw" type="checkbox" id="f15-authenticator-code-for-sensitive-tools" @@code@@ aria-label="${t("window.settings.permissions.authenticator-code-for-sensitive-tools")}" data-sw="set"><small>${t("window.settings.permissions.a-six-digit-code-before-sending")}</small></div></div>`;

const ISOLATION = () => `<div class="sec x15-sec"><h2>${t("window.settings.permissions.isolation")}</h2><div class="ctl"><b>${t("window.settings.permissions.a-container-per-trunk")}</b><span class="right"><span class="seg" role="group" aria-label="${t("window.settings.permissions.a-container-per-trunk")}"><button type="button" aria-pressed="false" data-act="seg" data-why="a-container-per-trunk">${t("accounts.switch.off")}</button><button type="button" aria-pressed="false" data-act="seg" data-why="a-container-per-trunk">${t("window.settings.permissions.for-code")}</button><button type="button" aria-pressed="false" data-act="seg" data-why="a-container-per-trunk">${t("window.places.automations.always")}</button></span></span><small></small></div>@@WALL@@<div class="ctl"><b>${t("window.settings.permissions.add-sign-ins-from-outside-the")}</b><input class="sw" type="checkbox" id="f15-add-sign-ins-from-outside-the-sandbox" aria-label="${t("window.settings.permissions.add-sign-ins-from-outside-the")}" data-sw="set"><small>${t("window.settings.permissions.the-sandbox-never-holds-a-password")}</small></div><div class="ctl"><b>${t("window.settings.permissions.verify-each-release")}</b><input class="sw" type="checkbox" id="f15-verify-each-release" aria-label="${t("window.settings.permissions.verify-each-release")}" data-sw="set"><small>${t("window.settings.permissions.checks-the-signature-before-installing-an")}</small></div><div class="ctl"><b>${t("window.settings.permissions.pin-ssh-hosts")}</b><input class="sw" type="checkbox" id="f15-pin-ssh-hosts" aria-label="${t("window.settings.permissions.pin-ssh-hosts")}" data-sw="set"><small>${t("window.settings.permissions.refuses-a-computer-whose-fingerprint-changed")}</small></div>@@DOWNLOADS@@</div>`;
/* Downloads may come from: the owner's browser care card (downloadsFrom). Ask each time holds each file outside the
   workspace until the owner says yes on the ordinary approval card (browser.keep_download). */
const DOWNLOADS = () => {
  const cur = P.care?.downloadsFrom ?? null, one = (v, words) => `<button type="button" aria-pressed="${cur === v}" data-act="p-dl" data-v="${v}">${words}</button>`;
  return `<div class="ctl"><b>${t("window.settings.permissions.downloads-may-come-from")}</b><span class="right"><span class="seg" role="group" aria-label="${t("window.settings.permissions.downloads-may-come-from")}">${one("anywhere", t("os-sandbox.network.open"))}${one("known", t("window.settings.permissions.known-sites"))}${one("ask", t("window.settings.permissions.ask-each-time"))}</span></span><small>${t("window.settings.permissions.downloads-sub")}</small></div>`;
};

/* The approval policy as the engine keeps it (GET /api/policy, GET /api/approvals/categories, GET /api/lockdown), and
   its rules in the engine's own sentences (GET /api/rules). */
const P = { policy: null, presets: [], categories: [], locked: false, loaded: false, was: {}, rules: [], loosen: null, privacy: null, safety: null, wall: null, care: null };
const SWITCH = { "p-read": "read", "p-browse": "browse", "p-send": "message" };

async function load() {
  const quiet = (path) => api(path).catch((error) => { toast(error.message); return null; });
  const [pol, cats, lock, kit, rules, privacy, safety, wall, comfort] = await Promise.all([api("policy").catch(() => null), api("approvals/categories").catch(() => null), api("lockdown").catch(() => null),
    quiet("settings-kit"), quiet("rules"), quiet("privacy"), quiet("safety-extras"), quiet("os-sandbox"), E.profiles?.isOwner === false ? null : quiet("comfort"), loadOs17(), loadKit(), loadPracticeRuns()]);
  // Messages per conversation per hour is the owner's own limit (GET /api/knobs limits), which a household person may not read.
  P.knobs = E.profiles?.isOwner === false ? null : await quiet("knobs");
  Object.assign(P, { policy: pol?.policy ?? null, presets: pol?.presets ?? [], categories: cats?.categories ?? [], locked: !!lock?.on, loaded: true,
    pins: kit?.pins ?? [], kit: kit?.settings ?? [], rules: rules?.rules ?? [], privacy, safety, wall, care: comfort?.values?.browser ?? null });
  render();
}

/* ---------- Rules for each tool and folder ----------
   Each rule as the prototype's row: Allow / Ask / Never, the engine's sentence for it, and its place in the list.
   Add a rule is POST /api/rules/add (in front of the others); Remove is POST /api/rules/remove { index }, sent only after
   the list is read again and the rule at that place is still the one drawn on the pressed button (not the list as last
   read, which a draw held under the press may not show yet), so a list changed meanwhile never loses the wrong rule. Both save the list as the owner's own (the preset reads "custom" afterwards) and are refused under
   Lockdown. Move up stays greyed: the engine has no route that moves one rule, and moving an allow above a refusal
   would loosen the list with nothing asking first. */
const PILLS = { allow: ["ok", "window.settings.permissions.rule-allow"], ask: ["idle", "window.settings.permissions.rule-ask"], deny: ["bad", "window.settings.permissions.rule-never"] };
function ruleRows() {
  const rows = P.rules.map(({ index, rule, sentence }) => {
    const [tone, key] = PILLS[rule.decision] ?? ["idle", null];
    const word = key ? t(key) : rule.decision;
    return `<div class="prow rule15"><span class="pill ${tone}">${esc(word)}</span><span class="grow"><b>${esc(sentence)}</b><small>${esc(t("window.settings.permissions.rule-n", { n: index + 1 }))}</small></span><button class="icon-btn" type="button" aria-label="${t("accounts.action.up")}" data-act="rule-up8">${ic("up", "s")}</button><button class="icon-btn" type="button" aria-label="${t("accounts.action.remove")}" data-act="rule-rm8" data-i="${index}" data-v="${esc(JSON.stringify(rule))}">${ic("x", "s")}</button></div>`;
  });
  return `<div class="rows">${rows.join("")}</div>`;
}

/* What was typed, as the rule the engine keeps: an address names a site, words with a space a command, anything else a
   file or folder, for every tool (the same reading as Test a rule). */
function ruleFor(text, decision) {
  const q = text.trim();
  if (!q) return null;
  let resource;
  if (/^https?:\/\//i.test(q)) { try { resource = { kind: "host", pattern: new URL(q).host }; } catch { resource = { kind: "host", pattern: q }; } }
  else resource = { kind: /\s/.test(q) ? "command" : "path", pattern: q };
  return { tool: "*", match: "*", decision, resource };
}
const NEW = { decision: "ask" };
function addDlg() {
  const seg = Object.entries(PILLS).map(([v, [, key]]) => `<button type="button" aria-pressed="${NEW.decision === v}" data-act="rule-dec8" data-v="${v}">${t(key)}</button>`).join("");
  const add = t("window.settings.permissions.add-a-rule");
  openDlg({ title: add, body: `<p class="lead-b17">${t("window.settings.permissions.new-rule-pick")}</p><div class="test-b17"><input class="inp" id="rule-new8" value="${esc(NEW.text ?? "")}" aria-label="${t("window.settings.p17-permissions.command-file-or-site")}"></div><span class="seg" role="group" aria-label="${add}">${seg}</span>`,
    foot: `<button class="btn ghost" type="button" data-act="dlg-close">${t("mode.cancel")}</button><button class="btn pri" type="button" data-act="rule-save8" ${(NEW.text ?? "").trim() ? "" : "disabled"}>${add}</button>` });
}
async function addRule() {
  const rule = ruleFor(document.getElementById("rule-new8")?.value ?? "", NEW.decision);
  if (!rule) return;
  try { P.rules = (await api("rules/add", rule)).rules ?? P.rules; } catch (error) { toast(error.message); return; }
  NEW.text = "";
  closeDlg();
  await load();
}
async function removeRule(el) {
  const at = Number(el.dataset.i), drawn = el.dataset.v;
  let now;
  try { now = (await api("rules")).rules ?? []; } catch (error) { toast(error.message); return; }
  if (!drawn || JSON.stringify(now[at]?.rule) !== drawn) { P.rules = now; render(); return; }
  try { await api("rules/remove", { index: at }); } catch (error) { toast(error.message); }
  await load();
}

/* Pinned settings from GET /api/settings-kit; pinning and unpinning are POST /api/settings-kit/pins {key, field, pinned},
   which only the owner reaches (the household table and settings-kit's own requireOwner). */
function pinRows() {
  if (!P.pins?.length) return '<div class="rows"></div>';
  return `<div class="rows">${P.pins.map((x) => `<div class="prow"><span class="ico-tile">${ic("pin", "s")}</span><span class="grow"><b>${esc(x.name)}</b><small>${esc(x.label)}</small></span><button class="btn ghost sm" type="button" data-act="pin-rm8" data-key="${esc(x.key)}" data-field="${esc(x.field)}">${t("accounts.action.unpin")}</button></div>`).join("")}</div>`;
}

/* "Pin a setting": every setting the engine's catalogue lists that is not pinned yet, in the engine's words; a setting
   with more than one part names the part beside it. */
function pinMenu(el) {
  const items = (P.kit ?? []).flatMap((s) => s.fields.filter((f) => !f.pinned).map((f) =>
    `<button class="mi" type="button" role="menuitem" data-act="pin-do8" data-key="${esc(s.key)}" data-field="${esc(f.field)}"><span class="mi-t">${esc(s.name)}</span>${s.fields.length > 1 ? `<span class="r">${esc(f.label)}</span>` : ""}</button>`));
  openPop(el, `<div class="ph">${t("window.settings.permissions.pin-a-setting")}</div>${items.join("")}`);
}

async function setPinned(el, pinned) {
  closePop();
  const name = (P.kit ?? []).find((s) => s.key === el.dataset.key)?.name ?? "";
  try {
    await api("settings-kit/pins", { key: el.dataset.key, field: el.dataset.field, pinned });
    toast(pinned ? t("window.settings.permissions.name-is-pinned", { name }) : t("window.settings.permissions.name-is-no-longer-pinned", { name }));
  } catch (error) { toast(error.message); }
  await load();
}

/* On means "without asking": the kind is set to allow, or it has no rule of its own and the preset lets it through
   (reading is free under every preset; everything is, under No approvals). */
function allowed(id) {
  const decision = P.categories.find((c) => c.id === id)?.decision ?? null;
  if (decision) return decision === "allow";
  return id === "read" || P.policy?.preset === "off";
}

/* The system sandbox: the kit's own switch where the engine says the computer has one; elsewhere greyed, its reason under it. */
function wall() {
  const title = t("window.settings.permissions.system-sandbox-for-commands");
  const opts = [["off", t("accounts.switch.off")], ["when-needed", t("accounts.switch.when-needed")], ["on", t("window.places.automations.always")]];
  if (P.wall?.computer?.available && K.kit) return kitSeg(title, "", "os-sandbox", "mode", opts);
  return `<div class="ctl"><b>${esc(title)}</b><span class="right"><span class="seg" role="group" aria-label="${esc(title)}">${opts.map(([, l]) => `<button type="button" aria-pressed="false" data-act="seg" data-why="p-wall">${esc(l)}</button>`).join("")}</span></span><small>${esc(P.wall?.computer?.reason ?? "")}</small></div>`;
}
const onIf = (yes) => (yes ? "checked" : "");
/* The switches under Advanced are drawn again from the engine after each change, so the part stays open as it was. */
let advOpen = false;

function fill(html) {
  const preset = P.presets.find((x) => x.id === P.policy?.preset);
  const status = preset ? `<div class="status"><span class="sdot ${P.policy.preset === "off" ? "warn" : ""}"></span><div><b>${esc(say(preset.label))}</b><p>${esc(say(preset.description))}</p></div></div>` : "";
  return html.replace("@@STATUS@@", status).replace("@@PINS@@", pinRows()).replace("@@RULES@@", ruleRows()).replace("@@LOCK@@", P.locked ? t("dashboard.controls.lockdownOff") : t("dashboard.controls.lockdownOn"))
    .replace(/@@(read|browse|message)@@/g, (_, id) => (allowed(id) ? "checked" : ""))
    .replace("@@record@@", onIf(kitOn("run-recording"))).replace("@@loop@@", onIf(kitOn("loop_guard"))).replace("@@scan@@", onIf(kitOn("safety-command-scan")))
    .replace("@@pii@@", onIf(piiOn(P))).replace("@@code@@", onIf(codesOn(P))).replace("@@install@@", onIf(allowed("commands") && allowed("settings")))
    .replace("@@PRACTICE@@", practiceAttrs()).replace("@@WALL@@", wall()).replace("@@DOWNLOADS@@", DOWNLOADS()).replace("@@ADVOPEN@@", advOpen ? "open" : "").replace("@@RATE@@", rateAttrs());
}

/* Lockdown can change elsewhere (the banner's "Turn it off"); the window marks #app "locked" from the engine
   (chat/approvals.js syncLockdown). When that mark changes, the page re-reads the engine once. */
let seenLock = null;
function followLockdown() {
  const mark = document.getElementById("app")?.classList.contains("locked") ?? null;
  if (mark === null || mark === seenLock) return;
  const first = seenLock === null;
  seenLock = mark;
  if (!first && P.loaded) load();
}

export function draw() {
  followLockdown();
  const lev = level();
  let html = HEAD() + osSection17() + BASE_SWITCHES() + PINNED();
  if (lev >= 1) html += RULES();
  if (lev >= 2) html += ISOLATION();
  return fill(html) + sections17(lev);
}

/* Q257: a kind made less strict is refused by the engine (409) until the owner says yes to loosening. The dialog shows
   the engine's own words and asks; anything else refused (Lockdown included) is shown as the engine said it. */
function askLoosen(error, body, path = "approvals/categories") {
  if (error.status !== 409 || !/less careful/.test(error.message)) { toast(error.message); return; }
  P.loosen = { path, body };
  openDlg({ title: t("settings-kit.loosens"), body: `<p>${esc(error.message)}</p>`,
    foot: `<button class="btn ghost" type="button" data-act="dlg-close">${t("mode.cancel")}</button><button class="btn pri" type="button" data-act="perm-loosen8">${t("settings-kit.confirm")}</button>` });
}

/* Messages per conversation per hour: the engine's own limit (knobs limits.messagesPerConversationHour), saved alone with
   POST /api/knobs { card: "limits", values: { messagesPerConversationHour } }, which keeps the card's other values. A
   household person's box is drawn without its id, greyed with the owner-only reason. */
const rateAttrs = () => {
  const value = P.knobs?.values?.limits?.messagesPerConversationHour;
  return value == null ? 'data-why="knobs-owner-only" disabled' : `id="p-rate" value="${esc(value)}" data-sw="set"`;
};
async function saveRate(box) {
  const typed = box.value.trim();
  if (!/^\d+$/.test(typed)) { render(); return; } // not a whole number: the box shows the engine's figure again
  try { await api("knobs", { card: "limits", values: { messagesPerConversationHour: Number(typed) } }); } catch (error) { toast(error.message); }
  await load();
}

/* The switches that are one engine setting each (kit17.js changed()). */
const KIT = {
  "p-record": { key: "run-recording", field: "mode" },
  "p-loop": { key: "loop_guard", field: "mode" },
  "f15-scan-commands-for-hidden-characters": { key: "safety-command-scan", field: "mode" },
};

export function init() {
  markLive(["sw:p-read", "sw:p-browse", "sw:p-send", "perm-lock", "pin-add8", "pin-do8", "pin-rm8",
    "rule-add8", "rule-dec8", "rule-save8", "rule-rm8", "sw:rule-new8", "perm-loosen8",
    "sw:p-record", "sw:p-loop", "sw:f15-scan-commands-for-hidden-characters", "kitseg17", "sw:p-rate", "p-dl", ...guardsLive]);
  on("p-dl", async (el) => {
    try { P.care = (await api("comfort", { card: "browser", values: { downloadsFrom: el.dataset.v } })).values?.browser ?? P.care; }
    catch (error) { toast(error.message); }
    await load();
  });
  initGuards({ P, load, askLoosen });
  initOs17();
  initPracticeRuns(load);
  document.addEventListener("change", (e) => { if (KIT[e.target?.id]) changed(e.target, KIT); else if (e.target?.id === "p-rate") saveRate(e.target); });
  document.addEventListener("toggle", (e) => { if (e.target?.matches?.(".set-col details.adv") && e.target.querySelector("#p-loop")) advOpen = e.target.open; }, true);
  on("pin-add8", (el) => pinMenu(el));
  on("pin-do8", (el) => setPinned(el, true));
  on("pin-rm8", (el) => setPinned(el, false));
  on("rule-add8", () => { NEW.decision = "ask"; addDlg(); });
  on("rule-dec8", (el) => { NEW.decision = el.dataset.v; NEW.text = document.getElementById("rule-new8")?.value ?? ""; addDlg(); });
  on("rule-save8", () => addRule());
  /* Audit (batch D): "Add a rule" does nothing on an empty box, so it waits, disabled, until something is typed. */
  document.addEventListener("input", (e) => {
    if (e.target?.id !== "rule-new8") return;
    const save = document.querySelector('[data-act="rule-save8"]');
    if (save) save.disabled = !e.target.value.trim();
  });
  on("rule-rm8", (el) => removeRule(el));
  // Through the same path as the banner, so the banner and this page agree; then the page re-reads.
  on("perm-lock", async () => { await setLockdown(!P.locked); await load(); });
  document.addEventListener("change", async (e) => {
    const id = SWITCH[e.target.id];
    if (!id) return;
    // Turning a kind back off restores a refusal the owner had written, rather than loosening it to "ask".
    const before = P.categories.find((c) => c.id === id)?.decision ?? null;
    if (e.target.checked) P.was[id] = before;
    const off = P.was[id] === "deny" ? "deny" : "ask";
    const body = { [id]: e.target.checked ? "allow" : off };
    try { await api("approvals/categories", body); } catch (error) { askLoosen(error, body); }
    await load();
  });
  // Q257: sent again with the owner's yes to loosening only from this dialog's own button; Cancel changes nothing.
  on("perm-loosen8", async () => {
    const held = P.loosen;
    P.loosen = null;
    closeDlg();
    if (held) try { await api(held.path, { ...held.body, confirmLoosening: true }); } catch (error) { toast(error.message); }
    await load();
  });
  load();
  init17();
}

/* Re-opening the page re-reads both halves. */
const reload = () => Promise.all([load(), load17()]);
export { reload as load };

