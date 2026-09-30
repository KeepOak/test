import { initNativeWindowViewer, nativeWindowViewerSection } from "../../chat/native-window-viewer.js";
/* Settings › Computer & browser, 1:1 with the prototype at each level. The computers are this one and the owner's other
   devices (GET /api/devices); the Trunks are the engine's. A switch shows the engine's own value; it is live only where a
   route changes it (WIRES below), and a three-way feature switch reads as on unless its mode is "off", turns on as
   "when-needed" and off as "off". On a computer: "See the screen and use the mouse" is the engine's screen-and-keyboard
   switch (POST /api/desktop/settings {enabled}); "Where scripts run" is the wall around programs (GET/POST /api/os-sandbox,
   the whole record sent back with only its mode changed: Sealed box is "on", This computer is "off"), and where this
   computer cannot build the wall the engine's own reason is shown under it; "Work in apps in the background" is the reach
   part background-screen (POST /api/reach/switch). Lockdown still wins over each: the engine reads them as off and refuses
   the tools while it is on. "Ask before opening an app it hasn’t used" is the engine's own switch for it
   (GET/POST /api/desktop/app-ask, src/desktop-app-ask.ts): a program a Trunk has never opened is asked about once, for
   that Trunk; the approval preset is not touched. Borrowing your own browser stays greyed: it is lent one task at a
   time, never as a standing choice. The browser's own switches are the owner's comfort card "browser" (GET/POST
   /api/comfort): Ask before a site it hasn't visited, Open the browser full size, Record browser tasks and Number the
   clickable things; Run the browser in a sandbox is the sandbox's own mode (GET/POST /api/browser/container).
   Paired devices (GET /api/devices): "Stop lending" switches off everything a phone lends (POST
   /api/devices/<id>/switch, on: false, for each), and "Remove" unpairs a device after a confirm (POST
   /api/devices/<id>/revoke; its key stops working at once). Both are the owner's alone in the engine.
   Parity B2 (pane-stage-014): each computer card says whether it is ready (This computer always, the engine runs on it;
   a paired one while it is connected, GET /api/devices `connected`, else Offline) and which Trunks may use it (each
   Trunk's list, GET /api/trunks/<id>/computers; a Trunk with nothing saved may use every computer). The prototype's
   sleep line needs this PC's power plan, which the engine does not read, so it is not drawn. */
import { level, E } from "../../core/state.js";
import { api, token } from "../../core/api.js";
import { markLive } from "../../core/features.js";
import { esc, render } from "../../core/dom.js";
import { av, toast, ic, openDlg, closeDlg } from "../../core/ui.js";
import { on } from "../../core/actions.js";
import { onPaired } from "../../flows/pair.js";
import { glyphSvg, hexOr } from "../../flows/name-device.js"; // finish-soon-a
import { t } from "../../../i18n.js";
import { trunkRow17, settingsCloudOffer, loadAll as loadComputers17, viewOf } from "../../flows/computers17.js"; // pass 17 part D §9, §1
import { id15, sw15, btn15, code15, seg15, sec15, fact15 } from "../rows15.js";
import { computer17 } from "../p17-more.js";
import { siteRow, loadSites, initSites } from "../sites17.js"; // Site skills (siteb17)
import { initCiSetup } from "../ci-setup.js"; // wire-greyed: Branch in CI › Copy the setup

const D = { coding: null, notes: null, prs: null, devices: null, desktop: null, wall: null, reach: null, appAsk: null, care: null, container: null };
/* The owner's browser care card (src/comfort/settings.ts ComfortBrowserSchema); only the fields changed are sent. */
const setCare = async (values) => { D.care = (await api("comfort", { card: "browser", values })).values?.browser ?? D.care; };
const onMode = (mode) => (mode ? mode !== "off" : false);
const coding = (part) => onMode(D.coding?.modes?.[part]);
const setCoding = (part, on) => api("coding/switch", { part, mode: on ? "when-needed" : "off" });

/* Each live switch: its current value from the engine, and the route that changes it. */
/* Keys are the switches' ids (id15 of each title), written out so each can be found by name. */
const WIRES = {
  "f15-page-notes-and-send-to-branch-": [() => onMode(D.notes?.mode), (on) => api("browser/notes/settings", { mode: on ? "when-needed" : "off" })],
  "f15-try-ideas-on-a-branch": [() => coding("worktrees"), (on) => setCoding("worktrees", on)],
  "f15-check-and-format-files-after-editing": [() => coding("format-on-edit"), (on) => setCoding("format-on-edit", on)],
  "f15-draft-a-pull-request-from-a-task": [() => onMode(D.prs?.mode), (on) => api("developer/pull-requests", { mode: on ? "when-needed" : "off" })],
  "f15-remember-the-shell": [() => coding("shell-snapshot"), (on) => setCoding("shell-snapshot", on)],
  "f15-read-a-file-before-editing-it": [() => coding("read-first"), (on) => setCoding("read-first", on)],
  "f15-keep-large-tool-outputs": [() => coding("large-output"), (on) => setCoding("large-output", on)],
  "f15-read-jupyter-notebooks": [() => coding("notebooks"), (on) => setCoding("notebooks", on)],
  "f15-review-checks-and-a-checklist-per-task": [() => coding("review-checks") && coding("checklist"),
    async (on) => { await setCoding("review-checks", on); await setCoding("checklist", on); }],
  "c-screen": [() => D.desktop?.enabled === true, (on) => api("desktop/settings", { enabled: on })],
  "c-ask": [() => D.appAsk?.on === true, (on) => api("desktop/app-ask", { on })],
  "f15-work-in-apps-in-the-background": [() => onMode(D.reach?.modes?.["background-screen"]),
    (on) => api("reach/switch", { part: "background-screen", mode: on ? "when-needed" : "off" })],
  "b-new": [() => D.care?.askNewSites === true, (on) => setCare({ askNewSites: on })],
  "b-watch": [() => D.care?.openFullSize === true, (on) => setCare({ openFullSize: on })],
  "f15-record-browser-tasks": [() => D.care?.recordTasks === true, (on) => setCare({ recordTasks: on })],
  "f15-number-the-clickable-things": [() => D.care?.numberMarks === true, (on) => setCare({ numberMarks: on })],
};
const sw = (title, sub) => sw15(title, sub, WIRES[id15(title)]?.[0]() ?? false);

async function loadAll() {
  const [c, n, p, d, desktop, wall, reach, appAsk, comfort, container] = await Promise.all(["coding", "browser/notes/settings", "developer/pull-requests", "devices", "desktop/settings", "os-sandbox", "reach", "desktop/app-ask", "comfort", "browser/container"]
    .map((path) => api(path).catch((error) => { toast(error.message); return null; })));
  Object.assign(D, { coding: c, notes: n?.settings ?? null, prs: p, devices: d, desktop, wall, reach, appAsk, care: comfort?.values?.browser ?? null, container });
  await loadSites();
  render();
  await loadComputers17();
}

export function init() {
  initNativeWindowViewer();
  markLive(["sw:f15-page-notes-and-send-to-branch-", "sw:f15-try-ideas-on-a-branch", "sw:f15-check-and-format-files-after-editing",
    "sw:f15-draft-a-pull-request-from-a-task", "sw:f15-remember-the-shell", "sw:f15-read-a-file-before-editing-it",
    "sw:f15-keep-large-tool-outputs", "sw:f15-read-jupyter-notebooks", "sw:f15-review-checks-and-a-checklist-per-task",
    "lend15", "dev-remove", "dev-remove-yes", "sw:c-screen", "sw:c-ask", "sw:f15-work-in-apps-in-the-background", "c-where",
    "sw:b-new", "sw:b-watch", "sw:f15-record-browser-tasks", "sw:f15-number-the-clickable-things", "b-sandbox"]);
  on("b-sandbox", (el) => sandbox(el.dataset.v));
  on("lend15", (el) => stopLending(el.dataset.v));
  initCiSetup();
  on("dev-remove", (el) => removeDialog(el.dataset.v));
  on("dev-remove-yes", (el) => removeDevice(el.dataset.v));
  on("c-where", (el) => where(el.dataset.v));
  onPaired.add(() => loadAll());
  initSites(render);
  document.addEventListener("change", async (e) => {
    const wire = WIRES[e.target.id];
    if (!wire) return;
    try { await wire[1](e.target.checked); } catch (error) { toast(error.message); }
    await loadAll();
  });
  loadAll();
}

export async function load() { await loadAll(); }

/* Run the browser in a sandbox: the sandbox's own three-way mode; the rest of its record (Docker or a server) is kept. */
async function sandbox(mode) {
  try { D.container = await api("browser/container", { mode }); } catch (error) { toast(error.message); }
  await loadAll();
}

/* Where scripts run: the wall's whole record goes back with only its mode changed, as the route replaces it. */
async function where(v) {
  if (!D.wall?.settings) return;
  try { await api("os-sandbox", { ...D.wall.settings, mode: v === "sealed" ? "on" : "off" }); } catch (error) { toast(error.message); }
  await loadAll();
}

export const live = {};

/* ---------- computers ---------- */
const DESKTOP = ["win32", "darwin", "linux"];
const PLATFORM = { win32: "Windows", darwin: "macOS", linux: "Linux", ios: "iOS", android: "Android" };
const card = (icon, name, sub, extra = "", side = "") => `<div class="comp7-card">${icon.startsWith("<") ? icon : `<span class="ico-tile">${ic(icon, "s")}</span>`}<span class="grow"><b>${name}</b><small>${sub}</small>${extra}</span>${side}</div>`;
const removeBtn = (d) => `<button class="btn ghost sm" type="button" data-act="dev-remove" data-v="${esc(d.id)}">${esc(t("devices.paired.remove"))}</button>`;

/* A computer named after pairing shows the glyph and colour chosen then (flows/name-device.js, GET /api/devices). */
const lookTile = (d) => (d.glyph ? `<span class="ico-tile"${hexOr(d.color) ? ` data-css="color:${d.color}"` : ""}>${glyphSvg(d.glyph)}</span>` : "monitor");

/* The Trunks that may use this computer, by their own lists; "" before the lists are read. */
function usedBy(cid) {
  const names = (E.trunks ?? []).filter((tr) => viewOf(tr.id)?.allowed.includes(cid)).map((tr) => tr.name).filter(Boolean);
  return names.length ? `<span class="c7-users">${esc(t("window.settings.computer.used-by", { names: names.join(", ") }))}</span>` : "";
}
const readyPill = (ready) => `<span class="pill ${ready ? "ok" : "idle"}"><i></i>${ready ? t("strip.status.on") : t("window.shell.machines.offline")}</span>`;

function computers() {
  const others = (D.devices?.devices ?? []).filter((d) => DESKTOP.includes(d.platform));
  const mine = card("monitor", t("dashboard.computer.title"), t("window.settings.computer.your-windows-desktop"), `<span class="c7-reach">${t("window.settings.computer.your-screen-mouse-and-apps-it")}</span>${usedBy("this")}`, readyPill(true));
  const theirs = others.length ? `<div class="grp8">${t("settings.card.remote-computers")}</div><div class="comps7">${others.map((d) => card(lookTile(d), esc(d.name), esc(PLATFORM[d.platform] ?? d.platform), usedBy(d.id), readyPill(d.connected === true) + removeBtn(d))).join("")}</div>` : "";
  const cloud = `<div class="grp8">${t("window.settings.computer.in-the-cloud")}</div><div class="comps7"><div class="comp7-card off7"><span class="ico-tile">${ic("globe", "s")}</span><span class="grow"><b>${t("window.settings.computer.keepoak-computer")}</b><small>${t("window.settings.computer.linux-in-the-cloud-stays-on")}</small><span class="c7-reach">${t("window.settings.computer.keeps-working-while-this-pc-sleeps")}</span></span><button class="btn sm" type="button" data-act="ko-start">${t("window.settings.computer.connect-keepoak-com")}</button></div></div>`;
  return `<div class="sec"><h2>${t("window.settings.computer.computers-they-may-use")}</h2><div class="grp8">${t("window.settings.computer.on-this-pc")}</div><div class="comps7">${mine}</div>${theirs}${cloud}${settingsCloudOffer()}
    <div class="acts" data-css="margin-top:10px"><button class="btn pri" type="button" data-act="comp-add">${ic("plus", "s")}${t("window.settings.computer.add-a-computer")}</button></div></div>`;
}

/* Which Trunk uses which: each Trunk's computers and its At once (pass 17 part D §9, flows/computers17.js). */
function trunkRow(trunk) {
  const id = esc(trunk.id ?? trunk.name ?? "");
  const nums = [1, 2, 3, 4].map((n) => `<button type="button" data-act="comp-max" data-id="${id}" data-v="${n}" aria-pressed="false">${n}</button>`).join("");
  return `<div class="prow percomp8">${av(trunk, 32)}<span class="grow"><b>${esc(trunk.name ?? "")}</b><span class="chips8"><button type="button" class="chip6" data-act="comp-chip" data-id="${id}" data-v="this" aria-pressed="false">${t("dashboard.computer.title")}</button></span></span><label class="max8"><small>${t("window.settings.computer.at-once")}</small><span class="seg">${nums}</span></label></div>`;
}

function whichTrunk() {
  return `<div class="sec"><h2>${t("window.settings.computer.which-trunk-uses-which")}</h2><p class="hint" data-css="margin:0 0 8px">${t("window.settings.computer.a-trunk-can-use-several-computers")}</p><div class="rows">${(E.trunks ?? []).map(trunkRow17).join("")}</div></div>`;
}

function onAComputer() {
  const wall = D.wall?.settings, here = D.wall?.computer;
  const cur = wall ? (wall.mode === "off" ? "this" : "sealed") : null;
  // Where this computer cannot build the wall, the engine's own reason is shown instead of the promise.
  const sub = here && !here.available ? here.reason : t("window.settings.computer.a-sealed-box-keeps-scripts-away");
  return `<div class="sec"><h2>${t("window.settings.computer.on-a-computer")}</h2><div class="ctl"><b>${t("window.settings.computer.see-the-screen-and-use-the")}</b><input class="sw" type="checkbox" id="c-screen" ${D.desktop?.enabled ? "checked" : ""} aria-label="${t("window.settings.computer.see-the-screen-and-use-the")}" data-sw="set"><small>${t("window.settings.computer.needed-for-apps-without-a-connection")}</small></div><div class="ctl"><b>${t("window.settings.computer.ask-before-opening-an-app-it")}</b><input class="sw" type="checkbox" id="c-ask" ${D.appAsk?.on ? "checked" : ""} aria-label="${t("window.settings.computer.ask-before-opening-an-app-it")}" data-sw="set"><small>${t("window.settings.computer.once-per-app-per-trunk")}</small></div>${seg15(t("settings.card.where-scripts-run"), sub, [["sealed", t("window.settings.computer.sealed-box")], ["this", t("dashboard.computer.title")]], cur, "c-where", "f15-where-scripts-run")}</div>`;
}

const BROWSER = () => `<div class="sec"><h2>${t("settingsGrown.bucket.computer.browser")}</h2>${seg15(t("window.settings.computer.which-browser"), t("window.settings.computer.its-own-profile-keeps-your-tabs"), [["own", t("window.settings.computer.branchs-own")], ["chrome", t("window.settings.computer.your-chrome")]], null, "seg", "f15-which-browser")}<div class="ctl"><b>${t("window.settings.computer.ask-before-a-site-it-hasnt")}</b><input class="sw" type="checkbox" id="b-new" ${D.care?.askNewSites ? "checked" : ""} aria-label="${t("window.settings.computer.ask-before-a-site-it-hasnt")}" data-sw="set"><small>${t("window.settings.computer.you-say-yes-once-per-site")}</small></div><div class="ctl"><b>${t("window.settings.computer.open-the-browser-full-size-when")}</b><input class="sw" type="checkbox" id="b-watch" ${D.care?.openFullSize ? "checked" : ""} aria-label="${t("window.settings.computer.open-the-browser-full-size-when")}" data-sw="set"><small>${t("window.settings.computer.otherwise-it-stays-small-in-the")}</small></div></div>`;

/* Phones lent to Branch: every paired phone, with what it lends in the engine's words, so one lending nothing can
   still be removed. A phone a Tailscale invitation let in has no device record (GET /api/devices doorPhones); it lends
   nothing and is removed the same way. */
const doorPhones = () => (D.devices?.doorPhones ?? []).map((d) => ({ ...d, enabled: [] }));
const phoneList = () => [...(D.devices?.devices ?? []).filter((d) => !DESKTOP.includes(d.platform)), ...doorPhones()];
const capLabel = (id) => (D.devices?.capabilities ?? []).find((c) => c.id === id)?.label?.toLowerCase() ?? id;
function phones() {
  const rows = phoneList().map((d) => {
    const lent = d.enabled ?? [];
    const stop = lent.length ? `<button class="btn ghost sm" type="button" data-act="lend15" data-v="${esc(d.id)}">${t("window.settings.computer.stop-lending")}</button>` : "";
    return `<div class="prow"><span class="ico-tile">${ic("phone", "s")}</span><span class="grow"><b>${esc(d.name)}</b><small>${esc(lent.map(capLabel).join(", ") || t("window.settings.computer.nothing-switched-on"))}</small></span>${stop}${removeBtn(d)}</div>`;
  }).join("");
  const empty = D.devices && !rows ? `<p class="empty">${t("window.settings.computer.no-phone-is-lent-turn-it")}</p>` : "";
  // B6: Get Branch on your phone (flows/pair.js, the same download `branch phone` opens).
  const getApp = `<div class="acts" data-css="margin-top:10px"><button class="btn sm" type="button" data-act="phone-app">${ic("phone", "s")}${esc(t("phoneApp.title"))}</button></div>`;
  return `<div class="sec x15-sec"><h2>${t("window.settings.computer.phones-lent-to-branch")}</h2><div class="rows">${rows}${empty}</div>${getApp}</div>`;
}

/* Stop lending: everything the phone lends goes off, one switch at a time, as the engine keeps them. */
async function stopLending(id) {
  const device = phoneList().find((d) => d.id === id);
  if (!device) return;
  try {
    for (const capability of device.enabled ?? []) await api(`devices/${encodeURIComponent(id)}/switch`, { capability, on: false });
    toast(t("window.settings.computer.stopped-branch-cant-use-this-phones"));
  } catch (error) { toast(error.message); }
  await loadAll();
}

/* Remove: unpairing asks first, naming the device. */
function removeDialog(id) {
  const device = [...(D.devices?.devices ?? []), ...doorPhones()].find((d) => d.id === id);
  if (!device) return;
  openDlg({ title: t("devices.device.remove"), body: `<p data-css="margin:0"><b>${esc(device.name)}</b></p>`,
    foot: `<button class="btn ghost" type="button" data-act="dlg-close">${t("first-run-steps.restore-no")}</button><button class="btn bad" type="button" data-act="dev-remove-yes" data-v="${esc(id)}">${esc(t("devices.paired.remove"))}</button>` });
}
async function removeDevice(id) {
  // A phone that was handed this window's key takes it with it: the engine makes a new one. A window signed in with the
  // key asks for the new one and keeps working; the desktop app holds none and reads it again itself.
  const hasKey = Boolean(token.get());
  try {
    const answer = await api(`devices/${encodeURIComponent(id)}/revoke`, hasKey ? { keepKey: true } : {});
    if (hasKey && answer.key) token.set(answer.key);
  } catch (error) { toast(error.message); return; }
  closeDlg();
  await loadAll();
}

const browserMore = () => sec15(t("window.settings.computer.the-browser-more"),
  seg15(t("window.settings.computer.run-the-browser-in-a-sandbox"), t("window.settings.computer.sandbox-sub"), [["off", t("accounts.switch.off")], ["when-needed", t("accounts.switch.when-needed")], ["on", t("accounts.switch.on")]], D.container?.mode ?? null, "b-sandbox", "f15-run-the-browser-in-a-sandbox")
  + sw("Record browser tasks", "A step-by-step trace you can replay.")
  + sw("Number the clickable things", "Faster and steadier on busy pages.")
  // Site skills: the websites the owner's skills know about, with See N and Forget (settings/sites17.js).
  + siteRow()
  + sw("Page notes and “Send to Branch”", "A right-click in Chrome or Edge sends the page to a Trunk. Turns on when the browser extension is installed."));

const code = () => sec15(t("window.settings.computer.code"),
  sw("Try ideas on a branch", "A plan can be tried, compared and merged; a forked conversation gets its own copy.")
  + fact15("Code map", "f15-code-map")
  + sw("Check and format files after editing", "")
  + sw("AI! and AI? comments start tasks", "Write “AI! add tests” in a file and a Trunk picks it up.")
  + sw("Draft a pull request from a task", "Never merged by Branch.")
  + sw("Remember the shell", "PATH, aliases and functions, so commands behave as in your terminal."));

const codeTechnical = () => sec15(t("window.settings.computer.code-technical"),
  code15(t("window.settings.computer.files-branch-never-reads"), t("window.settings.computer.like-gitignore"), ".branchignore")
  + sw("Read a file before editing it", "Refuses an edit to a file it hasn’t read in this task.")
  + sw("Keep large tool outputs", "Saved to a file instead of cut off.")
  + btn15(t("window.settings.computer.branch-in-ci"), t("window.settings.computer.a-github-action-and-a-gitlab"), t("window.settings.computer.copy-the-setup"), "ci-open"));

const computerMore = () => sec15(t("window.settings.computer.on-a-computer-more"),
  sw("Work in apps in the background", "Through the accessibility tree, without taking the screen.")
  + sw("Read Jupyter notebooks", "Cells, outputs and charts.")
  + sw("Review checks and a checklist per task", "Checks you write run before a task says it’s done; the checklist shows in the task.")
  + code15(t("window.settings.computer.write-agents-md-for-a-project"), t("window.settings.computer.branch-reads-the-project-and-writes"), "/init"));

export function draw() {
  const lev = level();
  let html = `<h1>${esc(t("settings.page.computer"))}</h1><p class="lede">${t("window.settings.computer.the-computers-your-trunks-may-use")}</p>`;
  html += computers() + whichTrunk() + onAComputer() + BROWSER();
  if (lev < 2) html += `<p class="hint">${t("window.settings.computer.switch-to-technical-bottom-left-to")}</p>`;
  else html += `<div class="sec"><h2>${t("settingsGrown.level.technical")}</h2><dl class="kv"></dl></div>`; // the engine gives no sandbox, profile or screen facts
  html += phones();
  if (lev >= 1) html += browserMore() + code();
  if (lev >= 2) html += codeTechnical();
  if (lev >= 1) html += computerMore();
  return html + nativeWindowViewerSection() + computer17(lev);
}
