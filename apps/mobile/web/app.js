/**
 * The phone app (apps/mobile), 1:1 with the prototype's pass 8: its own screens (Home, Chats, Inbox, More and what is
 * behind them), a tab bar, sheets, pairing, the lock, and the phone's own switches, all drawn from the paired
 * Branch's own routes. It never shows the desktop window in a web view. See docs/configuration.md, "Phone apps".
 */
import { applyLanguage, followLook, initLanguage } from "/i18n.js";
import { applyTheme, modeOf } from "/theme.js";
import { createVault } from "/vault.js";
import { $, esc, phone, platform, plugin, say, status, w } from "/phone-common.js";
import { BACK, E, P, TABS, act, draw, go, ic, on, setRedraw } from "/ph-core.js";
import { loadLook, loadState, needsCount } from "/ph-data.js";
import { drawHome, initHome, loadHome } from "/ph-home.js";
import { attachFiles, chatNow, drawChat, drawChats, drawSheet, initChats, loadChat, loadChats } from "/ph-chats.js";
import { allowAllSheet, drawInbox, initInbox, loadInbox } from "/ph-inbox.js";
import { PLACES, PLACE_LOADS, drawMore, initMore, loadMore } from "/ph-more.js";
import { SETTINGS_LOADS, SETTINGS_PAGES, drawSettings, initSettings, loadSettings, paintSwatches, settingsSheet } from "/ph-settings.js";
import { drawPair, initPair, stopScan } from "/ph-pair.js";
import { drawVoice, initVoice, scanPicture, shareSheet } from "/ph-voice.js";
import { initSwitches, loadSwitches, switchesNow } from "/ph-switches.js";
import { restartChecks, watchFront } from "/notify.js";
import { savePanel } from "/phone-connect.js";
import { startLending } from "/ph-lend.js";

const AWAY_MS = 5 * 60_000;
const SCREENS = { home: drawHome, chats: drawChats, chat: drawChat, inbox: drawInbox, more: drawMore, settings: drawSettings, voice: drawVoice, ...PLACES, ...SETTINGS_PAGES };
const LOADS = { home: loadHome, chats: loadChats, chat: loadChat, inbox: loadInbox, more: loadMore, settings: loadSettings, ...PLACE_LOADS, ...SETTINGS_LOADS };
const FULL = ["voice", "lock"];

function drawLock() {
  return `<div class="p-lockv"><img class="mark" src="/assets/icon-192.png" alt=""><h2>${w("phone.lock.title", "Branch is locked")}</h2><p>${w("phone.lock.intro", "Unlock with your face or fingerprint to see your assistant.")}</p>
    <button type="button" class="p-big" data-act="unlock">${w("phone.lock.unlock", "Unlock")}</button><p class="subtle" id="lock-status" role="status"></p></div>`;
}
function screenHtml() {
  if (P.scr === "lock") return drawLock();
  if (P.scr === "pair") return drawPair(Boolean(phone.session));
  return (SCREENS[P.scr] ?? drawHome)();
}
function tabsHtml() {
  if (!["home", "chats", "inbox", "more"].includes(P.scr)) return "";
  const n = needsCount();
  return TABS.map(([id, icon, key, english]) => `<button type="button" data-act="tab" data-v="${id}" aria-current="${P.scr === id}"><span class="p-ti">${ic(icon, "s")}${id === "inbox" && n ? `<em>${esc(String(n))}</em>` : ""}</span>${w(key, english)}</button>`).join("");
}
function sheetHtml() {
  const body = P.sheet === "allowall" ? allowAllSheet() : P.sheet === "share" ? shareSheet() : ["language", "forget"].includes(P.sheet) ? settingsSheet() : drawSheet();
  return body ? `<div class="p-sheet-bg" data-act="ph-sheet" data-v=""></div><div class="p-sheet" role="dialog"><div class="p-grab"></div>${body}</div>` : "";
}
/** What the owner is typing survives a redraw: values, focus and the caret, by element id. */
function keepTyping(root) {
  const values = [...root.querySelectorAll("input[id], textarea[id]")].map((node) => [node.id, node.type === "checkbox" ? null : node.value]);
  const focused = document.activeElement?.id, caret = document.activeElement?.selectionStart;
  return () => {
    for (const [id, value] of values) { const node = document.getElementById(id); if (node && value !== null && node.type !== "checkbox" && !node.value) node.value = value; }
    const node = focused && document.getElementById(focused);
    if (node && node !== document.activeElement) { node.focus({ preventScroll: true }); if (typeof caret === "number" && /^(text|search|url|tel|password)$/.test(node.type ?? "text")) node.setSelectionRange(caret, caret); }
  };
}
/** The prototype sets sizes and bars with inline styles; the page's policy refuses those, so they are set here. */
function finishDraw(root) {
  for (const node of root.querySelectorAll("[data-size]")) { const px = `${Number(node.dataset.size)}px`; node.style.width = px; node.style.height = px; node.style.fontSize = `${Math.round(Number(node.dataset.size) * 0.42)}px`; }
  for (const node of root.querySelectorAll("[data-w]")) node.style.width = `${Math.max(0, Math.min(100, Number(node.dataset.w)))}%`;
  for (const node of root.querySelectorAll("[data-dash]")) node.style.strokeDasharray = `${((Number(node.dataset.dash) / 100) * 97.4).toFixed(1)} 97.4`;
  paintSwatches(root);
  const messages = root.querySelector("[data-bottom]");
  if (messages) messages.scrollTop = messages.scrollHeight;
}
function render() {
  const main = $("phone");
  const restore = keepTyping(main);
  main.className = `${platform()} ${FULL.includes(P.scr) ? "fullscr" : ""}`;
  $("screen").innerHTML = screenHtml();
  const tabs = tabsHtml();
  $("tabs").innerHTML = tabs;
  $("tabs").hidden = !tabs;
  $("sheet").innerHTML = sheetHtml();
  finishDraw(main);
  restore();
}

/* ---------- moving between screens, and reading what each needs ---------- */
let loading = 0;
async function loadScreen() {
  const mine = ++loading, scr = P.scr;
  await (LOADS[scr]?.() ?? null);
  if (mine === loading && scr === P.scr) draw();
}
let lastScreen = null;
setRedraw(() => {
  if (P.scr !== lastScreen) { if (lastScreen === "pair") stopScan(); lastScreen = P.scr; render(); void loadScreen(); return; }
  render();
});

/** The owner's look and language, read from the paired Branch and worn by the app's page (no native side has a look). */
async function followBranch() {
  const [look, state] = await Promise.all([loadLook(), loadState()]);
  const mode = modeOf(state?.preferences) ?? document.documentElement.dataset.mode ?? "dark";
  applyTheme({ theme: look?.theme, contrast: look?.contrast, mode });
  if (look) await followLook(look);
}
async function openApp() {
  phone.session = await phone.vault.current();
  if (!phone.session) { P.scr = "pair"; draw(); return; }
  await loadSwitches();
  restartChecks(switchesNow());
  phone.shared = ((await plugin.takeShared?.())?.items ?? []).concat(phone.shared);
  P.scr = phone.shared.length ? P.scr : "home";
  P.sheet = phone.shared.length ? "share" : null;
  if (platform() === "and" && plugin?.takeWidget) {
    const widget = await plugin.takeWidget().catch(() => null);
    if (/^[a-f0-9-]{36}$/.test(widget?.sessionId ?? "")) { P.chat = widget.sessionId; P.scr = "chat"; }
  }
  lastScreen = null;
  draw();
  void followBranch().then(draw);
  // PH-03: while the app's own page is open, a lent phone answers Branch (the native side knows whether it is lent, and
  // closes the socket while the app is off the screen, dialling again when it is back).
  void startLending(() => { if (P.scr === "lend") draw(); });
}
async function route() {
  const session = await phone.vault.current();
  if (!session) { phone.session = null; P.scr = "pair"; draw(); return; }
  const { lock } = await phone.vault.switches();
  const away = Date.now() - Number((await plugin.lastSeen?.())?.at ?? 0);
  if (lock === "on" || (lock === "when-needed" && away > AWAY_MS)) { P.scr = "lock"; draw(); return; }
  await openApp();
}
async function unlock() {
  status("lock-status", "");
  const result = await plugin.unlock({ reason: say("phone.lock.reason", "Unlock Branch") }).catch(() => ({ unlocked: false }));
  if (result?.unlocked) await openApp();
  else status("lock-status", say("phone.lock.failed", "Not unlocked. Try again."), true);
}

function wire() {
  // Tapping the tab already showing reads its screen again (a question may have come in since).
  on("tab", (el) => { if (P.scr === el.dataset.v) void loadScreen(); else go(el.dataset.v); });
  on("back", () => { P.scr = P.scr === "voice" ? P.prev || "home" : BACK[P.scr] || "home"; if (P.scr === "chat" && !P.chat && P.prev !== "chat") P.scr = "chats"; P.sheet = null; draw(); });
  on("unlock", () => unlock());
  on("scan", () => $("pick-camera").click());
  on("connect-save", () => savePanel(document));
  document.addEventListener("click", (event) => {
    const el = event.target.closest?.("[data-act]");
    if (!el || el.disabled || el.getAttribute("aria-disabled") === "true") return;
    act(el.dataset.act)?.(el);
  });
  $("pick-camera").addEventListener("change", (event) => { void scanPicture(event.target.files?.[0]); event.target.value = ""; });
  for (const id of ["pick-photos", "pick-files"]) $(id).addEventListener("change", (event) => { void attachFiles([...event.target.files]); event.target.value = ""; });
  document.addEventListener("branch-shared", () => void openApp());
  document.addEventListener("branch-widget", () => void route());
  document.addEventListener("branch-language", () => draw());
  initHome(); initChats(); initInbox(); initMore(); initSwitches(); initVoice();
  initSettings(() => { phone.session = null; P.scr = "pair"; draw(); });
  initPair(async () => { phone.session = await phone.vault.current(); await openApp(); });
  watchFront((state) => { E.state = state; if (["home", "inbox", "chats"].includes(P.scr)) draw(); });
  void chatNow;
}
async function boot() {
  await initLanguage().catch(() => "en");
  applyTheme((await plugin?.look?.().catch(() => null)) ?? {});
  applyLanguage();
  wire();
  if (!plugin) { P.scr = "pair"; draw(); status("pair-status", say("phone.notInApp", "This page only works inside the Branch phone app."), true); return; }
  phone.vault = createVault(plugin);
  await route();
  document.body.dataset.ready = "true";
}
void boot();
