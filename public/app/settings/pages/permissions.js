/* Settings > permissions: bind Trunks' permissions. Mount Mac/Windows OS permissions module. */
import { level } from "../../core/state.js";
import { E } from "../../core/state.js";
import { on } from "../../core/actions.js";
import { markLive } from "../../core/features.js";
import { render, esc } from "../../core/dom.js";
import { api } from "../../core/api.js";
import { toast, ic, openPop, closePop, openDlg, closeDlg } from "../../core/ui.js";
import { setLockdown } from "../../chat/approvals.js";
import { sections17, init17, load17 } from "../p17-permissions.js";
import { t } from "../../../i18n.js";
import { say } from "../../core/words.js";

const HEAD = () => `<h1>${t("settings.page.permissions")}</h1><p class="lede">${t("window.settings.permissions.what-trunks-may-do-without-asking")}</p>`;

const BASE_SWITCHES = () => `@@STATUS@@
    <div class="sec"><h2>${t("window.settings.permissions.without-asking-trunks-may")}</h2>
      <div class="ctl"><b>${t("window.settings.permissions.read-files-in-documents-and-downloads")}</b><input class="sw" type="checkbox" id="p-read" @@read@@ aria-label="${t("window.settings.permissions.read-files-in-documents-and-downloads")}" data-sw="set"><small>${t("window.settings.permissions.reading-never-changes-a-file")}</small></div>
      <div class="ctl"><b>${t("window.settings.permissions.use-the-browser-on-this-computer")}</b><input class="sw" type="checkbox" id="p-browse" @@browse@@ aria-label="${t("window.settings.permissions.use-the-browser-on-this-computer")}" data-sw="set"><small>${t("window.settings.permissions.signs-in-with-your-saved-sign")}</small></div>
      <div class="ctl"><b>${t("window.settings.permissions.send-email-and-messages")}</b><input class="sw" type="checkbox" id="p-send" @@message@@ aria-label="${t("window.settings.permissions.send-email-and-messages")}" data-sw="set"><small>${t("window.settings.permissions.off-means-every-message-waits-for")}</small></div>
      <div class="ctl"><b>${t("window.settings.permissions.install-tools-and-packages")}</b><input class="sw" type="checkbox" id="p-install" aria-label="${t("window.settings.permissions.install-tools-and-packages")}" data-sw="set"><small>${t("window.settings.permissions.off-means-a-request-shows-up")}</small></div>
      <div class="ctl"><b>${t("window.settings.permissions.record-tasks-so-you-can-watch")}</b><input class="sw" type="checkbox" id="p-record" aria-label="${t("window.settings.permissions.record-tasks-so-you-can-watch")}" data-sw="set"><small>${t("window.settings.permissions.recordings-stay-on-this-computer")}</small></div>
    </div>
    <details class="adv"><summary><svg class="i s chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"></path></svg>${t("settings.page.advanced")}</summary>
      <div class="ctl"><b>${t("window.settings.permissions.when-tools-are-loaded")}</b><span class="right"><span class="seg" role="group" aria-label="${t("window.settings.permissions.when-tools-are-loaded")}"><button type="button" aria-pressed="false" data-act="seg">${t("window.settings.advanced.never")}</button><button type="button" aria-pressed="false" data-act="seg">${t("accounts.switch.when-needed")}</button><button type="button" aria-pressed="false" data-act="seg">${t("window.places.automations.always")}</button></span></span><small>${t("window.settings.permissions.when-needed-keeps-a-tool-one")}</small></div>
      <div class="ctl"><b>${t("window.settings.permissions.stop-a-trunk-that-repeats-itself")}</b><input class="sw" type="checkbox" id="p-loop" aria-label="${t("window.settings.permissions.stop-a-trunk-that-repeats-itself")}" data-sw="set"><small>${t("window.settings.permissions.after-5-identical-steps-it-pauses")}</small></div>
      <div class="ctl"><b>${t("settings-kit.name.folder-trust")}</b><span class="right"><button class="btn sm" type="button" data-act="soon">${t("asks.runtimes.add")}</button></span><small></small></div>
    </details>
    <div class="danger"><div><b>${t("lockdown.label")}</b><p>${t("window.settings.permissions.one-switch-that-stops-every-trunk")}</p></div><button class="btn bad" type="button" data-act="perm-lock">@@LOCK@@</button></div>`;

const PINNED = () => `<div class="sec"><h2>${t("window.settings.permissions.pinned-settings")}</h2><p class="hint" data-css="margin:0 0 8px">${t("window.settings.permissions.a-pinned-setting-is-fixed-someone")}</p>@@PINS@@<div class="acts" data-css="margin-top:8px"><button class="btn sm" type="button" data-act="pin-add8"><svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg>${t("window.settings.permissions.pin-a-setting")}</button></div></div>`;

const RULES = () => `<div class="sec x15-sec"><h2>${t("window.settings.permissions.rules-for-each-tool-and-folder")}</h2><p class="hint" data-css="margin:0 0 6px">${t("window.settings.permissions.the-first-rule-that-matches-wins")}</p>@@RULES@@<div class="acts" data-css="margin-top:8px"><button class="btn sm" type="button" data-act="rule-add8"><svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg>${t("window.settings.permissions.add-a-rule")}</button></div><div class="ctl"><b>${t("window.settings.permissions.practice-runs")}</b><input class="sw" type="checkbox" id="f15-practice-runs" aria-label="${t("window.settings.permissions.practice-runs")}" data-sw="set"><small>${t("window.settings.permissions.a-trunk-can-show-what-it")}</small></div><div class="ctl"><b>${t("window.settings.permissions.messages-per-conversation-per-hour")}</b><span class="right num15"><input class="inp" id="p-rate" aria-label="${t("window.settings.permissions.messages-per-conversation-per-hour")}" data-sw="set" disabled></span><small>${t("window.settings.permissions.stops-a-runaway-loop")}</small></div></div><div class="sec x15-sec"><h2>${t("window.settings.permissions.checks-before-anything-runs")}</h2><div class="ctl"><b>${t("window.settings.permissions.scan-commands-for-hidden-characters")}</b><input class="sw" type="checkbox" id="f15-scan-commands-for-hidden-characters" aria-label="${t("window.settings.permissions.scan-commands-for-hidden-characters")}" data-sw="set"><small>${t("window.settings.permissions.invisible-and-look-alike-characters-that")}</small></div><div class="ctl"><b>${t("window.settings.permissions.scan-for-personal-details")}</b><input class="sw" type="checkbox" id="f15-scan-for-personal-details" aria-label="${t("window.settings.permissions.scan-for-personal-details")}" data-sw="set"><small>${t("window.settings.permissions.card-numbers-id-numbers-and-addresses")}</small></div><div class="ctl"><b>${t("window.settings.permissions.authenticator-code-for-sensitive-tools")}</b><input class="sw" type="checkbox" id="f15-authenticator-code-for-sensitive-tools" aria-label="${t("window.settings.permissions.authenticator-code-for-sensitive-tools")}" data-sw="set"><small>${t("window.settings.permissions.a-six-digit-code-before-sending")}</small></div></div>`;

const ISOLATION = () => `<div class="sec x15-sec"><h2>${t("window.settings.permissions.isolation")}</h2><div class="ctl"><b>${t("window.settings.permissions.a-container-per-trunk")}</b><span class="right"><span class="seg" role="group" aria-label="${t("window.settings.permissions.a-container-per-trunk")}"><button type="button" aria-pressed="false" data-act="seg">${t("accounts.switch.off")}</button><button type="button" aria-pressed="false" data-act="seg">${t("window.settings.permissions.for-code")}</button><button type="button" aria-pressed="false" data-act="seg">${t("window.places.automations.always")}</button></span></span><small></small></div><div class="ctl"><b>${t("window.settings.permissions.system-sandbox-for-commands")}</b><span class="right"><span class="seg" role="group" aria-label="${t("window.settings.permissions.system-sandbox-for-commands")}"><button type="button" aria-pressed="false" data-act="seg">${t("accounts.switch.off")}</button><button type="button" aria-pressed="false" data-act="seg">${t("accounts.switch.when-needed")}</button><button type="button" aria-pressed="false" data-act="seg">${t("window.places.automations.always")}</button></span></span><small></small></div><div class="ctl"><b>${t("window.settings.permissions.add-sign-ins-from-outside-the")}</b><input class="sw" type="checkbox" id="f15-add-sign-ins-from-outside-the-sandbox" aria-label="${t("window.settings.permissions.add-sign-ins-from-outside-the")}" data-sw="set"><small>${t("window.settings.permissions.the-sandbox-never-holds-a-password")}</small></div><div class="ctl"><b>${t("window.settings.permissions.verify-each-release")}</b><input class="sw" type="checkbox" id="f15-verify-each-release" aria-label="${t("window.settings.permissions.verify-each-release")}" data-sw="set"><small>${t("window.settings.permissions.checks-the-signature-before-installing-an")}</small></div><div class="ctl"><b>${t("window.settings.permissions.pin-ssh-hosts")}</b><input class="sw" type="checkbox" id="f15-pin-ssh-hosts" aria-label="${t("window.settings.permissions.pin-ssh-hosts")}" data-sw="set"><small>${t("window.settings.permissions.refuses-a-computer-whose-fingerprint-changed")}</small></div><div class="ctl"><b>${t("window.settings.permissions.downloads-may-come-from")}</b><span class="right"><span class="seg" role="group" aria-label="${t("window.settings.permissions.downloads-may-come-from")}"><button type="button" aria-pressed="false" data-act="seg">${t("os-sandbox.network.open")}</button><button type="button" aria-pressed="false" data-act="seg">${t("window.settings.permissions.known-sites")}</button><button type="button" aria-pressed="false" data-act="seg">${t("window.settings.permissions.ask-each-time")}</button></span></span><small></small></div></div>`;

/* The approval policy as the engine keeps it (GET /api/policy, GET /api/approvals/categories, GET /api/lockdown), and
   its rules in the engine's own sentences (GET /api/rules). */
const P = { policy: null, presets: [], categories: [], locked: false, loaded: false, was: {}, rules: [], loosen: null };
const SWITCH = { "p-read": "read", "p-browse": "browse", "p-send": "message" };

async function load() {
  const [pol, cats, lock, os, kit, rules] = await Promise.all([api("policy").catch(() => null), api("approvals/categories").catch(() => null), api("lockdown").catch(() => null),
    api("os-permissions").catch((error) => { toast(error.message); return null; }), api("settings-kit").catch((error) => { toast(error.message); return null; }),
    api("rules").catch((error) => { toast(error.message); return null; })]);
  Object.assign(P, { policy: pol?.policy ?? null, presets: pol?.presets ?? [], categories: cats?.categories ?? [], locked: !!lock?.on, loaded: true,
    os: os ?? null, pins: kit?.pins ?? [], kit: kit?.settings ?? [], rules: rules?.rules ?? [] });
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
    foot: `<button class="btn ghost" type="button" data-act="dlg-close">${t("mode.cancel")}</button><button class="btn pri" type="button" data-act="rule-save8">${add}</button>` });
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

/* This Mac / This PC (GET /api/os-permissions): one row for each permission the engine checked, in the prototype's words
   and order, with its pill from the engine's state. Opening the computer's own settings stays greyed. */
const OS_ROWS = {
  darwin: [["screen", "screen16", "Screen Recording", "Seeing the screen, so a Trunk can find what to click"],
    ["microphone", "mic", "Microphone", "Talking to Branch and the wake word"], ["camera", "cam16", "Camera", "Photos and scanning a code"]],
  win32: [["microphone", "mic", "Microphone", "Talking to Branch and the wake word"], ["camera", "cam16", "Camera", "Photos and scanning a code"]],
};
const PILL = () => ({ allowed: `<span class="pill ok"><i></i>${t("window.settings.permissions.granted")}</span>`, refused: `<span class="pill bad16"><i></i>${t("window.settings.permissions.turned-off")}</span>` });
function osSection() {
  const mac = P.os?.platform === "darwin";
  const rows = (OS_ROWS[P.os?.platform] ?? []).map(([cap, icon, title, sub]) => [P.os.permissions.find((x) => x.capability === cap), icon, title, sub]).filter(([x]) => x);
  if (!rows.length) return "";
  const html = rows.map(([x, icon, title, sub]) => `<div class="prow perm16"><span class="ico-tile">${ic(icon, "s")}</span><span class="grow"><b>${esc(say(title))}</b><small>${esc(say(sub))}</small></span>${PILL()[x.state] ?? `<span class="pill idle"><i></i>${t("window.settings.permissions.not-yet")}</span>`}${x.state === "allowed" ? "" : `<button class="btn sm" type="button" data-act="sys16" data-v="${esc(x.capability)}">${mac ? t("action.open-system-settings") : t("window.settings.permissions.open-windows-settings")}</button>`}</div>`).join("");
  const granted = rows.filter(([x]) => x.state === "allowed").length;
  const hint = mac ? esc(t("window.settings.permissions.granted-of-count-granted-macos", { granted, count: rows.length }))
    : t("window.settings.mac-permissions.windows-asks-for-very-little-seeing");
  return `<div class="sec x15-sec"><h2>${mac ? t("window.settings.permissions.this-mac") : t("window.settings.permissions.this-pc")}</h2><p class="hint" data-css="margin:0 0 6px">${hint}</p><div class="rows">${html}</div></div>`;
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

function fill(html) {
  const preset = P.presets.find((x) => x.id === P.policy?.preset);
  const status = preset ? `<div class="status"><span class="sdot ${P.policy.preset === "off" ? "warn" : ""}"></span><div><b>${esc(say(preset.label))}</b><p>${esc(say(preset.description))}</p></div></div>` : "";
  return html.replace("@@STATUS@@", status).replace("@@PINS@@", pinRows()).replace("@@RULES@@", ruleRows()).replace("@@LOCK@@", P.locked ? t("dashboard.controls.lockdownOff") : t("dashboard.controls.lockdownOn"))
    .replace(/@@(read|browse|message)@@/g, (_, id) => (allowed(id) ? "checked" : ""));
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
  let html = HEAD() + osSection() + BASE_SWITCHES() + PINNED();
  if (lev >= 1) html += RULES();
  if (lev >= 2) html += ISOLATION();
  return fill(html) + sections17(lev);
}

/* Q257: a kind made less strict is refused by the engine (409) until the owner says yes to loosening. The dialog shows
   the engine's own words and asks; anything else refused (Lockdown included) is shown as the engine said it. */
function askLoosen(error, body) {
  if (error.status !== 409 || !/less careful/.test(error.message)) { toast(error.message); return; }
  P.loosen = body;
  openDlg({ title: t("settings-kit.loosens"), body: `<p>${esc(error.message)}</p>`,
    foot: `<button class="btn ghost" type="button" data-act="dlg-close">${t("mode.cancel")}</button><button class="btn pri" type="button" data-act="perm-loosen8">${t("settings-kit.confirm")}</button>` });
}

export function init() {
  markLive(["sw:p-read", "sw:p-browse", "sw:p-send", "perm-lock", "pin-add8", "pin-do8", "pin-rm8",
    "rule-add8", "rule-dec8", "rule-save8", "rule-rm8", "sw:rule-new8", "perm-loosen8"]);
  on("pin-add8", (el) => pinMenu(el));
  on("pin-do8", (el) => setPinned(el, true));
  on("pin-rm8", (el) => setPinned(el, false));
  on("rule-add8", () => { NEW.decision = "ask"; addDlg(); });
  on("rule-dec8", (el) => { NEW.decision = el.dataset.v; NEW.text = document.getElementById("rule-new8")?.value ?? ""; addDlg(); });
  on("rule-save8", () => addRule());
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
    const body = P.loosen;
    P.loosen = null;
    closeDlg();
    if (body) try { await api("approvals/categories", { ...body, confirmLoosening: true }); } catch (error) { toast(error.message); }
    await load();
  });
  load();
  init17();
}

/* Re-opening the page re-reads both halves. */
const reload = () => Promise.all([load(), load17()]);
export { reload as load };


