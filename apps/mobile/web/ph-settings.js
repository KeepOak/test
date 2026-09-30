/**
 * Settings and its pages (the prototype's phSettings with pass 13's Connections and pass 15's Lend this phone):
 *   This Branch      the computer's name (GET /api/reach) and the gateway (GET /api/never-break); Connect another Branch
 *   Accounts         GET /api/accounts, read here; accounts are added on the computer, as the page says
 *   Theme            the 44 themes (theme-catalogue.js); a pick is POST /api/look { theme }, so every surface changes
 *   Notifications    which kinds this phone tells (kept on the phone with its switches)
 *   Chat apps        GET /api/channel-setup and /api/channel-setup/<id>; the phone's own setup panel checks and saves
 *                    a token with POST /api/channel-setup/<id>/check
 *   Models on this computer   GET /api/local-models, read here (installing is heavy work for the computer, so it
 *                    stays on the computer)
 *   On this phone    the phone's switches, Lockdown, the language (POST /api/look { language }, as the window's picker)
 *   Lend this phone  shown once this phone is lent (paired from the window's square or Your devices): which Branch it
 *                    is lent to, what this phone does for it and whether the computer switched each on (the live
 *                    device socket's own list, ph-lend.js), and "Stop lending this phone": the engine forgets the
 *                    device (POST /api/devices/<id>/revoke) and the phone throws its key away, in one step
 *   Forget this Branch   asks first, then throws the pairing away
 */
import { E, P, attempt, draw, esc, go, ic, nav, on, post, say, soon, toast, w } from "/ph-core.js";
import { loadAccounts, loadChannels, loadGateway, loadLocal, loadLook, loadLockdown, loadProfiles, loadReach, loadState } from "/ph-data.js";
import { kindRows, lockdownRow, switchRows } from "/ph-switches.js";
import { LANGUAGES, language, setLanguage } from "/i18n.js";
import { THEMES } from "/theme-catalogue.js";
import { applyTheme } from "/theme.js";
import { phone, platform, plugin } from "/phone-common.js";
import { APP_OFFERS } from "/phone-node.js";
import { lendState } from "/ph-lend.js";
import { drawPanel, loadPanel } from "/phone-connect.js";

const S = { lend: null, version: "" };
const row = (v, key, english, value, extra = "") => `<button type="button" class="p-li" data-act="go" data-v="${v}" ${extra}><span class="grow"><b>${w(key, english)}</b></span><span class="p-val">${value}</span>›</button>`;
const langLabel = () => LANGUAGES.find((l) => l.id === language())?.label ?? "";

function thisBranch() {
  const name = E.reach?.machineName || (phone.session?.origin ?? "");
  const line = E.gateway ? (E.gateway.on ? w("phone8.set.viaGateway", "Connected through the gateway") : w("phone8.set.gwOff", "Connected · gateway off")) : "";
  return `<div class="p-group-h">${w("phone8.set.thisBranch", "This Branch")}</div><div class="p-list"><div class="p-li"><span class="grow"><b>${esc(name)}</b><small>${line}</small></span><span class="p-ok">●</span></div>${row("pair", "phone8.set.another", "Connect another Branch", "")}</div>`;
}
function lendRow() {
  if (!S.lend?.paired) return "";
  return `<button type="button" class="p-li" data-act="go" data-v="lend"><span class="grow"><b>${w("phone8.lend.title", "Lend this phone")}</b></span>›</button>`;
}
export function drawSettings() {
  const pools = E.accounts ?? [], count = pools.reduce((n, p) => n + (p.accounts?.length ?? 0), 0);
  const theme = THEMES.find((x) => x[0] === E.look?.theme)?.[1] ?? "";
  const channels = E.channels?.channels ?? [], installed = (E.local?.ollama?.models ?? []).length + (E.local?.lmStudio?.models ?? []).length;
  const account = `<div class="p-list"><button type="button" class="p-li" ${soon}><img class="p-ko" src="/assets/keepoak-mark.png" alt=""><span class="grow"><b>${w("phone8.more.signin", "Sign in with keepoak.com")}</b><small>${w("phone8.set.signinNote", "Reach every computer and your team")}</small></span>›</button></div>`;
  const assistant = `<div class="p-group-h">${w("phone.home.title", "Your assistant")}</div><div class="p-list">${row("accounts", "settings.page.accounts", "Accounts", esc(String(count)))}${row("themes", "look.theme", "Theme", esc(theme))}${row("notif", "settings.page.notifications", "Notifications", w("phone8.set.kinds", "5 kinds"))}</div>`;
  const connections = `<div class="p-group-h">${w("settings.page.connections", "Connections")}</div><div class="p-list">${row("chatapps", "dashboard.links.chats", "Chat apps", w("phone8.set.nOf", "{n} of {total}", { n: channels.filter((c) => c.saved).length, total: channels.length }))}${row("localm", "settings.card.models-on-this-computer", "Models on this computer", w("phone8.set.installed", "{n} installed", { n: installed }))}</div>`;
  const onPhone = `<div class="p-group-h">${w("phone.settings.title", "On this phone")}</div><div class="p-list">${switchRows()}${lockdownRow()}<button type="button" class="p-li" data-act="ph-sheet" data-v="language"><span class="grow"><b>${w("appearance.language", "Language")}</b></span><span class="p-val">${esc(langLabel())}</span>›</button>${lendRow()}</div>`;
  const end = `<div class="p-list"><div class="p-li"><span class="grow"><b>${w("phone8.set.version", "Version")}</b></span><span class="p-val">${w("phone8.set.versions", "Branch {branch} · app {app}", { branch: E.state?.version ?? "", app: S.version })}</span></div><button type="button" class="p-li p-bad" data-act="ph-sheet" data-v="forget"><span class="grow"><b>${w("phone.settings.forget", "Forget this Branch")}</b></span></button></div>`;
  return nav(say("nav.settings", "Settings"), say("more.label", "More")) + `<div class="p-scroll">${account}${thisBranch()}${assistant}${connections}${onPhone}${end}</div>`;
}
export async function loadSettings() {
  S.lend = await plugin.deviceStatus?.().catch(() => null) ?? null;
  S.version = S.version || (await fetch("/app-version.json").then((r) => r.json()).then((x) => String(x.version ?? "")).catch(() => ""));
  await Promise.all([loadState(), loadReach(), loadGateway(), loadAccounts(), loadLook(), loadChannels(), loadLocal(), loadLockdown(), loadProfiles()]);
}

function drawThemes() {
  const buttons = THEMES.map(([id, name]) => `<button type="button" data-act="theme" data-v="${esc(id)}" aria-pressed="${E.look?.theme === id}"><span class="sw6" data-swatch="${esc(id)}"><i></i><i></i><i></i></span><b>${esc(name)}</b></button>`).join("");
  return nav(say("look.theme", "Theme"), say("nav.settings", "Settings")) + `<div class="p-scroll"><p class="p-note8">${w("phone8.theme.note", "Pick on the phone and every surface changes: the window, the terminal and keepoak.com.")}</p><div class="p-themes8">${buttons}</div></div>`;
}
function drawAccounts() {
  const rows = (E.accounts ?? []).flatMap((p) => (p.accounts ?? []).map((a, i) => `<div class="p-li"><span class="grow"><b>${esc(p.name ?? p.pool)}</b><small>${esc(a.label ?? a.id)}</small></span>${i === 0 && a.id === p.defaultAccount ? `<span class="p-val">${w("phone8.acc.first", "first")}</span>` : ""}</div>`)).join("");
  return nav(say("settings.page.accounts", "Accounts"), say("nav.settings", "Settings")) + `<div class="p-scroll">${rows ? `<div class="p-list">${rows}</div>` : ""}<p class="p-note8">${w("phone8.acc.note", "Add accounts on the computer: Settings › Accounts.")}</p></div>`;
}
function drawNotif() {
  return nav(say("settings.page.notifications", "Notifications"), say("nav.settings", "Settings")) + `<div class="p-scroll"><div class="p-list">${kindRows()}</div></div>`;
}
function drawChatApps() {
  const all = E.channels?.channels ?? [], on = all.filter((c) => c.saved), list = P.chF === "on" ? on : all;
  const rowOf = (c) => `<button type="button" class="p-li" data-act="ph-ch" data-v="${esc(c.id)}"><span class="grow"><b>${esc(c.name)}</b><small>${c.saved ? w("window.places.customize.connected-reaches-branch", "Connected · reaches Branch") : c.family === "core" ? w("phone8.apps.popular", "Popular · two minutes") : w("phone8.apps.token", "Set up with a token")}</small></span>${c.saved ? '<span class="p-ok">●</span>' : "›"}</button>`;
  const chips = [["on", "phone8.apps.connectedN", "Connected ({n})", on.length], ["all", "phone8.apps.allN", "All {n}", all.length]].map(([v, k, e, n]) => `<button type="button" data-act="ph-chf" data-v="${v}" aria-pressed="${P.chF === v}">${w(k, e, { n })}</button>`).join("");
  const empty = P.chF === "on" ? `<p class="p-empty">${w("phone8.apps.none", "None connected yet. Tap All to pick one.")}</p>` : "";
  return nav(say("dashboard.links.chats", "Chat apps"), say("nav.settings", "Settings")) + `<div class="p-scroll"><p class="p-note8">${w("phone8.apps.note", "Message Branch from {n} chat apps. Each one talks to the same Branch and the same Trunks.", { n: all.length })}</p><div class="p-chips8">${chips}</div>${list.length ? `<div class="p-list">${list.map(rowOf).join("")}</div>` : empty}</div>`;
}
function drawChatApp() {
  const c = (E.channels?.channels ?? []).find((x) => x.id === P.chApp);
  if (!c) return nav("", say("dashboard.links.chats", "Chat apps"));
  const head = `<div class="p-card8"><span class="grow"><b>${esc(c.name)}</b><span>${c.saved ? w("phone8.apps.isOn", "Connected. Messages reach Branch and it answers there.") : w("phone8.apps.isOff", "Not connected yet.")}</span></span></div>`;
  return nav(c.name, say("dashboard.links.chats", "Chat apps")) + `<div class="p-scroll">${head}<div class="p-group-h">${c.saved ? w("phone8.apps.how", "How it was set up") : w("phone8.apps.toConnect", "How to connect")}</div><div id="connect-body" class="phone-connect">${drawPanel()}</div></div>`;
}
function drawLocal() {
  const L = E.local ?? {}, name = E.reach?.machineName || "";
  const installed = [...(L.ollama?.models ?? []), ...(L.lmStudio?.models ?? [])].map((m) => `<div class="p-li"><span class="grow"><b>${esc(m.name ?? m.id ?? m)}</b></span><button type="button" class="p-btn13" ${soon}>${w("commands.dashboard.run", "Run")}</button></div>`);
  const offered = (L.recommendations ?? []).map((m) => `<div class="p-li"><span class="grow"><b>${esc(m.model)}</b><small><i class="fit13 ${m.fits ? "" : "no"}"></i>${esc(m.expectation ?? m.note ?? "")}</small></span>${m.fits ? `<button type="button" class="p-btn13" ${soon}>${w("safety.wasm.install", "Install")}</button>` : `<span class="p-val">${w("phone8.local.tooBig", "too big")}</span>`}</div>`);
  const title = name ? say("phone8.local.title", "Models on {name}", { name }) : say("settings.card.models-on-this-computer", "Models on this computer");
  return nav(title, say("nav.settings", "Settings")) + `<div class="p-scroll"><p class="p-note8">${w("phone8.local.note", "Models that run on your computer, not in the cloud. Installing from the phone downloads them on {name} ({hardware}).", { name, hardware: L.hardware?.summary ?? "" })}</p><div class="p-list">${[...installed, ...offered].join("")}</div></div>`;
}
/* PH-03: what this phone does when lent, in the engine's own words for each ability (devices.cap.*). */
const ABILITY = { camera: ["devices.cap.camera", "Take a photo with the camera"], listen: ["devices.cap.listen", "Listen for a few seconds"],
  speak: ["devices.cap.speak", "Say something out loud"], screen: ["phone.screenLend.ability", "Take a picture of the foreground Branch app"] };
function screenConsent(state, never) {
  if (platform() !== "ios" || !plugin?.lendScreenConsent || never.includes("screen")) return "";
  const enabled = state.screenOptIn === true;
  const label = enabled ? w("phone.screenLend.off", "Stop sharing this app's screen") : w("phone.screenLend.on", "Allow pictures of this app while open");
  return `<p class="p-note8">${w("phone.screenLend.note", "Only this foreground Branch app is captured. Its visible content is sent to your paired Branch after its device screen switch is on and the capture request is approved. iOS may ask for capture permission. This permission resets when lending disconnects or the app leaves the foreground.")}</p><div class="p-list"><button type="button" class="p-li" data-act="screen-lend-consent" data-v="${enabled ? "off" : "on"}" aria-pressed="${enabled}" ${state.connected ? "" : "disabled"}><span class="grow"><b>${label}</b></span></button></div>`;
}
function drawLend() {
  const state = lendState(), never = S.lend?.never ?? [];
  const offers = (APP_OFFERS[platform() === "ios" ? "ios" : "android"] ?? []).filter((c) => !never.includes(c));
  // Each ability's switch as the computer set it, read from the live connection; while not connected nothing is claimed.
  const value = (c) => (state.connected ? (state.enabled.includes(c) ? w("accounts.switch.on", "On") : w("accounts.switch.off", "Off")) : "");
  const rows = offers.map((c) => `<div class="p-li"><span class="grow"><b>${w(...ABILITY[c])}</b></span><span class="p-val">${value(c)}</span></div>`).join("");
  return nav(say("phone8.lend.title", "Lend this phone"), say("nav.settings", "Settings")) + `<div class="p-scroll"><p class="p-note8">${w("phone.device.pairedWith", "Lending to {address}", { address: S.lend?.origin ?? "" })}</p>${state.error ? `<p class="p-note8 subtle bad">${esc(state.error)}</p>` : ""}
    <div class="p-list">${rows}</div>${screenConsent(state, never)}<div class="p-list"><button type="button" class="p-li p-bad" data-act="lend-stop"><span class="grow"><b>${w("phone.device.forget", "Stop lending this phone")}</b></span></button></div></div>`;
}
export const SETTINGS_PAGES = { themes: drawThemes, accounts: drawAccounts, notif: drawNotif, chatapps: drawChatApps, chatapp: drawChatApp, localm: drawLocal, lend: drawLend };
export const SETTINGS_LOADS = { themes: loadLook, accounts: loadAccounts, chatapps: loadChannels, chatapp: () => loadPanel(P.chApp), localm: () => Promise.all([loadLocal(), loadReach()]), lend: loadSettings };

/** The sheets Settings opens: the language, and Forget this Branch's confirmation. */
export function settingsSheet() {
  if (P.sheet === "language") return `<b>${w("appearance.language", "Language")}</b><div class="p-list">${LANGUAGES.map((l) => `<button type="button" class="p-li" data-act="language" data-v="${l.id}"><span class="grow"><b>${esc(l.label)}</b></span>${l.id === language() ? '<span class="p-ok">✓</span>' : ""}</button>`).join("")}</div>`;
  if (P.sheet === "forget") return `<b>${w("phone.settings.forget", "Forget this Branch")}</b><button type="button" class="p-big p-danger" data-act="forget-go">${w("phone.settings.forget", "Forget this Branch")}</button><button type="button" class="p-big p-quiet" data-act="ph-sheet" data-v="">${w("phone.share.cancel", "Cancel")}</button>`;
  return "";
}
/** Paints each theme's little swatch from the catalogue (the page may not carry inline styles). */
export function paintSwatches(root) {
  for (const node of root.querySelectorAll("[data-swatch]")) {
    const theme = THEMES.find((x) => x[0] === node.dataset.swatch);
    if (!theme) continue;
    const values = theme[3][document.documentElement.dataset.mode === "light" ? "light" : "dark"];
    const [ground, copper, text] = [0, 12, 9].map((i) => values[i]);
    const [a, b, c] = node.querySelectorAll("i");
    a.style.background = ground; b.style.background = copper; c.style.background = text;
  }
}
async function stopLending() {
  await attempt(async () => {
    const lent = S.lend;
    await plugin.deviceForget();
    S.lend = await plugin.deviceStatus?.().catch(() => null) ?? null;
    go("settings");
    if (lent?.nodeId && /^[a-f0-9]{16}$/.test(lent.nodeId) && lent.origin === phone.session?.origin) await post(`/api/devices/${lent.nodeId}/revoke`, {});
  });
}
export function initSettings(onForgotten) {
  on("ph-chf", (el) => { P.chF = el.dataset.v; draw(); });
  on("ph-ch", (el) => { P.chApp = el.dataset.v; go("chatapp"); });
  // The look and language are saved in the engine and worn by this page; neither native side has a look to set.
  on("theme", (el) => attempt(async () => { E.look = await post("/api/look", { theme: el.dataset.v }); applyTheme({ ...E.look, mode: document.documentElement.dataset.mode }); }));
  on("language", (el) => attempt(async () => { E.look = await post("/api/look", { language: el.dataset.v }); P.sheet = null; await setLanguage(el.dataset.v); }));
  on("forget-go", async () => { P.sheet = null; await phone.vault.forget(); onForgotten(); });
  on("lend-stop", () => stopLending());
  on("screen-lend-consent", (el) => attempt(async () => {
    await plugin.lendScreenConsent({ enabled: el.dataset.v === "on" });
    await loadSettings(); draw();
  }));
  void toast; void ic;
}
