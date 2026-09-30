/* The owner's live, interactive Branch browser for one conversation (its Trunk's browser), drawn in the stage's own
   browser look: tabs to switch, open and close, Back, Forward and Reload, an address bar that also searches, each tab's
   title, icon and loading state, and the page itself to click, type into and scroll.

   The engine owns the page and every decision (src/browser-control-api.ts, /api/panels/browser): who may write (the
   owner's window or the conversation's task, one at a time), the network rules, the owner's approval rules (a question
   is asked for that exact page only, "Allow once"), Lockdown and each task's limits. This window keeps only its current
   grant, the last masked frame and a pending question.

   Take over and Hand back are real: Take over on a task's own window makes it the conversation's kept browser with the
   owner driving; the task's next step waits (it neither fails nor replays) until Hand back, and then carries on where
   the owner left it. With nobody driving, the owner's first click or address simply takes the browser. */
import { esc } from "../core/dom.js";
import { api } from "../core/api.js";
import { closeDlg, ic, openDlg, toast } from "../core/ui.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { t } from "../../i18n.js";
import { demonstrationButtons, forgetDemonstration, initDemonstrations } from './browser-demonstrations.js';
import { networkLearningButtons, initNetworkLearning } from './network-learning.js';

const B = { sid: null, clientId: crypto.randomUUID(), profile: null, control: null, page: null, found: null, foundAt: 0,
  frameId: "", tabId: "", ready: false, frame: "", pending: null, reading: null, timer: 0, shown: false,
  busy: false, onChange: null, meta: "", pointer: null, textJob: null, wheel: null, lockWatch: false,
  error: "", typed: "", opening: false, names: { name: "", runId: null } };
const MAX_TABS = 5;
const locked = () => document.getElementById("app")?.classList.contains("locked-b17") === true;
const visible = () => B.shown && !document.hidden && !locked();
const owned = () => B.control?.state === "owner" && B.control.writer?.kind === "owner" && B.control.writer.id === B.clientId;
/** Nobody drives: the owner's first input takes the browser without a separate Take over. */
const free = () => B.control?.state === "owner" && !B.control.writer && !B.control.paused;
const scope = () => ({ sessionId: B.sid, clientId: B.clientId, profile: B.profile });
const bound = () => ({ ...scope(), id: B.control.id, epoch: B.control.epoch });
const changed = (redraw = true) => {
  // Live metadata redraws replace the tab buttons. Keep keyboard focus on the same stable tab,
  // provided the redraw did not deliberately move focus to a dialog or another control.
  const focused = document.activeElement?.closest?.("#stage7 .ob7-tab, #stage7 .ob7-x");
  const sid = B.sid, control = B.control?.id;
  const tab = focused?.dataset.tabId, action = focused?.dataset.act;
  B.onChange?.(redraw);
  if (!redraw || !focused || focused.isConnected || B.sid !== sid || B.control?.id !== control
      || !visible() || ![document.body, null].includes(document.activeElement)) return;
  const buttons = [...document.querySelectorAll("#stage7 .ob7-tab, #stage7 .ob7-x")];
  const same = tab && buttons.find(button => button.dataset.tabId === tab && button.dataset.act === action && !button.disabled);
  const fallback = buttons.find(button => button.classList.contains("ob7-tab") && button.getAttribute("aria-pressed") === "true" && !button.disabled);
  (same ?? fallback)?.focus({ preventScroll: true });
};
const clearFrame = () => { B.frameId = ""; B.tabId = ""; B.ready = false; B.frame = ""; };
/* After an action the last picture stays up (no blink) until the next one arrives, but it no longer counts as the page
   the next input is aimed at. */
const staleFrame = () => { B.frameId = ""; B.ready = false; };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const hasOwnerBrowser = () => !!B.control && B.control.state !== "stopped";
/** The owner's browser, as the engine last described it, for the stage's own words and buttons. */
export const ownerBrowserState = () => ({ open: hasOwnerBrowser(), owned: owned(), free: free(), paused: B.control?.paused ?? null,
  writer: B.control?.writer ?? null, state: B.control?.state ?? null, page: B.page, error: B.error, opening: B.opening });

/* Words typed into the address bar: a web address, a site's name, or words to search for (DuckDuckGo's plain page). */
export function addressFor(typed) {
  const words = typed.trim();
  if (/^https?:\/\//i.test(words)) return words;
  if (!/\s/.test(words) && /^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(words)) return `https://${words}`;
  return `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(words)}`;
}

function schedule(delay = 750) {
  clearTimeout(B.timer); B.timer = 0;
  if (visible() && B.sid && !B.busy && !B.pending) B.timer = setTimeout(() => { B.timer = 0; void readView(); }, delay);
}
/* With no browser known yet, ask the engine whether the conversation has one (a window that reopened finds it again). */
async function find(sid, signal) {
  const params = new URLSearchParams({ sessionId: sid, clientId: B.clientId });
  const answer = await api(`panels/browser?${params}`, undefined, "GET", signal);
  if (B.sid !== sid) return;
  B.found = sid; B.foundAt = Date.now();
  if (answer.status === "found") { B.control = answer.control; B.profile = answer.control.binding?.profile ?? null; }
  changed(true);
}
async function readView() {
  if (!visible() || B.busy || B.pending || B.reading) return;
  const sid = B.sid, controller = new AbortController();
  B.reading = controller;
  try {
    if (!hasOwnerBrowser()) { if (B.found !== sid || Date.now() - B.foundAt > 5000) await find(sid, controller.signal); return; }
    const request = bound(), params = new URLSearchParams({ sessionId: sid, clientId: B.clientId, id: request.id, epoch: String(request.epoch) });
    if (B.profile) params.set("profile", B.profile);
    const answer = await api(`panels/browser?${params}`, undefined, "GET", controller.signal);
    if (B.reading !== controller || B.sid !== sid || !visible()) return;
    applyView(answer);
  } catch (error) {
    if (error.name !== "AbortError" && B.reading === controller) {
      clearFrame(); B.meta = "";
      // The browser was closed or control moved on elsewhere: find it again rather than show a stale grant.
      if (error.status === 409 || error.status === 404) { B.control = null; B.page = null; B.found = null; }
      else B.error = error.message;
      changed(true);
    }
  } finally { if (B.reading === controller) B.reading = null; schedule(); }
}
/** A view of the page (read, or handed back with an input's answer): the picture, and a redraw only when more changed. */
function applyView(answer) {
  B.control = answer.control; B.page = answer.page ?? B.page;
  B.frameId = answer.frameId ?? ""; B.tabId = answer.tabId ?? ""; B.ready = answer.ready === true;
  B.frame = answer.page?.frame ? `data:image/jpeg;base64,${answer.page.frame}` : "";
  const meta = JSON.stringify([B.control, B.page?.url, B.page?.title, B.page?.tabs, B.ready, !!B.frame, B.error]);
  const redraw = B.meta !== meta; B.meta = meta; changed(redraw);
}
function disconnect() {
  forgetDemonstration();
  clearTimeout(B.timer); B.timer = 0;
  B.reading?.abort(); B.reading = null; clearFrame();
  if (B.pending) { B.pending = null; closeDlg(); }
  if (hasOwnerBrowser() && owned() && B.sid) void api("panels/browser/disconnect", bound()).catch(() => undefined);
}
/** Called on every stage draw: the browser view is showing (or not) for this conversation. Hiding it releases input. */
export function watchOwnerBrowser(sid, show, onChange, names = {}) {
  B.onChange = onChange;
  B.names = { name: names.name ?? "", runId: names.runId ?? null };
  const next = show && sid ? sid : null;
  if (B.sid && next && B.sid !== next) { disconnect(); Object.assign(B, { control: null, page: null, meta: "", found: null, error: "", profile: null }); }
  if (next) B.sid = next;
  B.shown = !!next;
  if (!visible()) { if (B.reading || B.timer || owned()) disconnect(); return; }
  if (!B.timer && !B.reading) schedule(0);
}
export function paintOwnerBrowser() {
  for (const img of document.querySelectorAll("#stage7 .owner-browser7-img, #pip7 .owner-browser7-img")) {
    if (B.frame && img.getAttribute("src") !== B.frame) img.setAttribute("src", B.frame);
    if (!B.frame) img.removeAttribute("src");
  }
}

/** The stage's top buttons for the browser: Take over, Hand back to the waiting task, and Close browser. */
export function ownerBrowserButtons(runId, name) {
  const btn = (act, words, cls = "btn sm", id = "") => `<button class="${cls}" type="button" data-act="${act}"${id ? ` data-id="${esc(id)}"` : ""}>${words}</button>`;
  if (!hasOwnerBrowser()) return runId ? btn("owner-browser-adopt", t("action.take-over"), "btn pri sm", runId) : "";
  const stop = btn("owner-browser-stop", t("window.chat.stage.ob.close-browser"), "btn ghost sm");
  if (B.control.state === "transferring") return stop;
  // The task the owner took over from, or one whose next step waits for the browser while the owner has it.
  const task = B.control.paused ?? B.control.waiting;
  const back = task && (owned() || !B.control.writer)
    ? btn("owner-browser-handback", t("window.chat.stage.hand-back-to", { name: esc(name) }), "btn pri sm", task) : "";
  const take = owned() || free() ? "" : btn("owner-browser-take", t("action.take-over"), back ? "btn sm" : "btn pri sm");
  return back + take + demonstrationButtons() + networkLearningButtons() + stop;
}
/** Who is driving, in words, for the stage's pill. */
export function ownerBrowserHolder(name) {
  if (!hasOwnerBrowser()) return null;
  if (B.control.state === "transferring") return { cls: "idle", words: t("window.chat.stage.ob.switching") };
  if (B.control.writer?.kind === "agent") return { cls: "work", words: t("window.chat.stage.ob.trunk-driving", { name: esc(name) }) };
  if (B.control.paused || B.control.waiting) return { cls: "warn", words: t("window.chat.stage.ob.waiting", { name: esc(name) }) };
  if (owned()) return { cls: "you", words: t("window.chat.stage.ob.you-driving") };
  return { cls: "idle", words: t("window.chat.stage.ob.nobody") };
}

const canDrive = () => visible() && (owned() || free() || !hasOwnerBrowser()) && !B.pending;
/* The owner's input is sent in the order it was given, one request at a time: nothing typed or clicked while an earlier
   request is still going is dropped. */
let chain = Promise.resolve();
/* Any other input seals the letters waiting to go, so they reach the page before it, as they were typed. */
const inOrder = (work) => { B.textJob = null; chain = chain.then(work, work); return chain; };
const iconOf = (tab) => (tab.icon ? `<img class="ob7-ico" alt="" src="${esc(tab.icon)}">`
  : `<span class="ob7-ico ob7-letter" aria-hidden="true">${esc((hostOf(tab.url)[0] ?? "").toUpperCase())}</span>`);
function hostOf(url) { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; } }
function tabsHTML() {
  const tabs = B.page?.tabs ?? [], can = canDrive() && hasOwnerBrowser();
  const one = (tab, index) => `<span class="${tab.active ? "on7" : ""}">
    <button type="button" class="ob7-tab" data-act="owner-browser-tab" data-index="${index}" data-tab-id="${esc(B.control?.tabs?.[index] ?? "")}" aria-pressed="${tab.active ? "true" : "false"}"${can ? "" : " disabled"} title="${esc(tab.url)}">${tab.loading ? `${ic("spin", "s spin")}` : iconOf(tab)}<em>${esc(tab.title || hostOf(tab.url) || t("window.chat.stage.ob.new-tab"))}</em></button>
    ${tabs.length > 1 ? `<button type="button" class="ob7-x" data-act="owner-browser-tab-close" data-index="${index}" data-tab-id="${esc(B.control?.tabs?.[index] ?? "")}" aria-label="${esc(t("window.chat.stage.ob.close-tab"))}: ${esc(tab.title || hostOf(tab.url) || t("window.chat.stage.ob.new-tab"))}"${can ? "" : " disabled"}>${ic("x", "s")}</button>` : ""}</span>`;
  const add = `<button type="button" class="ob7-new" data-act="owner-browser-new-tab" aria-label="${t("window.chat.stage.ob.new-tab")}"${can && tabs.length < MAX_TABS ? "" : " disabled"}>${ic("plus", "s")}</button>`;
  return `<div class="dk-tabs ob7-tabs">${tabs.map(one).join("")}${hasOwnerBrowser() ? add : ""}</div>`;
}
function barHTML() {
  const nav = canDrive() && hasOwnerBrowser() && B.ready, tab = B.page?.tabs?.find((x) => x.active);
  const button = (kind, icon, words) => `<button type="button" class="ob7-nav" data-act="owner-browser-${kind}" aria-label="${words}" title="${words}"${nav ? "" : " disabled"}>${ic(icon, "s")}</button>`;
  const words = t("window.chat.stage.address"), typing = canDrive() && !B.opening;
  return `<div class="dk-url ob7-bar">${button("back", "back", t("window.chat.stage.ob.back"))}${button("forward", "chev", t("window.chat.stage.ob.forward"))}${button("reload", "retry", t("window.chat.stage.ob.reload"))}
    <form class="ob7-addr" data-form="owner-browser-address">${tab?.url?.startsWith("https:") ? ic("lock", "s") : ic("globe", "s")}<input id="st-addr" class="ob7-inp" autocomplete="off" spellcheck="false"
      aria-label="${words}" placeholder="${words}" value="${esc(B.typed || B.page?.url || "")}"${typing ? "" : " disabled"}><button type="submit" class="ob7-go" aria-label="${t("window.chat.stage.go")}"${typing ? "" : " disabled"}>${ic("up", "s")}</button></form></div>`;
}
function statusHTML() {
  const said = B.opening ? t("window.chat.stage.opening-page") : B.error;
  if (!said) return "";
  const title = B.opening ? "" : `<b>${t("window.chat.stage.opening-failed")}</b>`;
  return `<div class="browser-status7 ob7-status" role="status">${title}<small>${esc(said)}</small></div>`;
}
function pageHTML() {
  const ready = !!B.frame, input = owned() || free();
  const empty = !hasOwnerBrowser() ? t("window.chat.stage.ob.empty") : B.page?.borrowed ? t("window.chat.stage.borrowed-preview")
    : B.page?.url ? t("window.chat.stage.preview-unavailable") : t("window.chat.stage.loading-preview");
  // Keys reach the page through one small box of the window's own, so input methods, accents and pasting all work.
  return `<div class="owner-browser7-page${input ? " ob7-live" : ""}">
    <textarea id="ob7-keys" class="ob7-keys" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="${t("window.chat.stage.ob.page")}"${input ? "" : " disabled"}></textarea>
    <img class="shot7 owner-browser7-img" draggable="false" alt="${esc(B.page?.title || t("window.chat.stage.ob.page"))}"${ready ? "" : " hidden"}>
    ${ready ? "" : `<div class="browser-status7 owner-browser7-empty" role="status"><small>${empty}</small></div>`}</div>`;
}
/** The whole browser, drawn at the stage's 1280 × 800 like the task's live view. */
export function ownerBrowserHTML() {
  return `<div class="desk7 brfull7 live7 owner-browser7"><div class="dk-win br7">${tabsHTML()}${barHTML()}${statusHTML()}${pageHTML()}</div></div>`;
}
/** The small window shows only the page. */
export const ownerBrowserPip = () => `<div class="desk7 brfull7 live7"><div class="dk-win br7"><img class="shot7 owner-browser7-img" alt=""></div></div>`;

function question(path, body, answer) {
  B.pending = { path, body, token: answer.confirmToken };
  openDlg({ title: t("window.chat.stage.ob.question"), body: `<p data-css="margin:0">${esc(answer.question)}</p>`,
    foot: `<button class="btn ghost" type="button" data-act="owner-browser-no">${t("window.chat.term.no")}</button><button class="btn pri" type="button" data-act="owner-browser-yes">${t("window.chat.helpers.allow-once")}</button>` });
}
function accept(answer, path, body) {
  if (answer.status === "asked") { question(path, body, answer); return; }
  if (answer.control) { B.control = answer.control; B.profile = answer.control.binding?.profile ?? B.profile; }
  if (answer.status === "stopped") { B.control = null; B.page = null; B.found = null; }
  const failed = answer.status === "refused" || answer.status === "failed" || answer.ok === false;
  if (failed) B.error = answer.reason || answer.error || t("window.chat.stage.ob.failed");
  else if (path === "action") B.error = "";
  // An input's answer carries the page as it is now: drawn at once, and the next input is aimed at it.
  if (path === "action" && answer.view?.status === "ready" && B.control) { applyView(answer.view); return; }
  if (B.control && !failed) staleFrame(); else clearFrame();
  B.meta = ""; changed(true);
}
async function drain() {
  B.reading?.abort();
  while (B.reading) await pause(10);
}
async function send(path, body) {
  if (B.busy || !B.sid) return null;
  B.busy = true; clearTimeout(B.timer);
  let seen = false;
  try {
    await drain();
    const answer = await api(`panels/browser/${path}`, body);
    if (B.sid === body.sessionId) accept(answer, path, body);
    seen = answer?.view?.status === "ready";
    return answer;
  } catch (error) {
    B.error = error.message; clearFrame(); changed(true);
    return { status: "error", code: error.status, error: error.message };
  } finally { B.busy = false; schedule(seen ? undefined : 0); } // an answer that brought the page needs no second look
}
/** Nobody drives (or nothing is open yet): the owner's first input takes the browser, opening one if needed. */
async function ensureDriving() {
  if (owned()) return true;
  if (!hasOwnerBrowser()) { const answer = await send("start", scope()); return answer?.status === "ready" && owned(); }
  if (free()) { const answer = await send("control", { ...bound(), operation: "takeover" }); return answer?.status === "ready" && owned(); }
  return false;
}
async function action(tool, args, retried = false) {
  if (!B.sid || B.pending || !(await ensureDriving())) return;
  const body0 = { sid: B.sid };
  // Input goes to the page the owner can see: a fresh frame first (a picture can miss while the page is busy).
  for (let tries = 0; tries < 6 && (!B.frameId || (tool === "browser.owner_input" && !B.ready)); tries++) {
    await drain();
    if (tries) await pause(150);
    if (!visible() || B.sid !== body0.sid) return;
    await readView();
  }
  if (!B.frameId || (tool === "browser.owner_input" && !B.ready)) return;
  const body = { ...bound(), frameId: B.frameId, tabId: B.tabId, sequence: B.control.sequence + 1, tool, arguments: args };
  const answer = await send("action", body);
  // The page moved on between the frame and the input (checked before anything reaches the page): read it and try once more.
  if (!retried && answer?.status === "error" && answer.code === 409 && /refresh/i.test(answer.error ?? "")) {
    B.error = ""; await readView(); await action(tool, args, true);
  }
}
function confirm() {
  const pending = B.pending; B.pending = null; closeDlg();
  if (pending && visible()) void send(pending.path, { ...pending.body, confirmToken: pending.token });
  else schedule(0);
}
function cancelQuestion() { B.pending = null; closeDlg(); schedule(0); }
async function address(form) {
  const raw = form.querySelector("input")?.value.trim();
  if (!raw || B.opening) return;
  // What was typed stays in the bar until it opens, so a refused address can be corrected rather than typed again.
  B.opening = true; B.error = ""; B.typed = raw; changed(true);
  try { await inOrder(() => action("browser.navigate", { url: addressFor(raw) })); }
  finally { B.opening = false; if (!B.error) B.typed = ""; changed(true); }
}
/* A point on the frame as a fraction of the page: the frame is drawn whole, centred across and from the top. */
function point(event, img) {
  const rect = img.getBoundingClientRect(), width = img.naturalWidth || 1280, height = img.naturalHeight || 720;
  const scale = Math.min(rect.width / width, rect.height / height), w = width * scale, h = height * scale;
  const x = (event.clientX - rect.left - (rect.width - w) / 2) / w, y = (event.clientY - rect.top) / h;
  return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : null;
}
/* Typing: the first letter goes to the page at once. Letters typed while it is on its way join the next input that is
   still waiting its turn, so fast typing is a few inputs rather than one per letter, and nothing waits on a timer.
   Any other input (a key, click, scroll or address) seals it first, so the page gets everything in the order it was made. */
function flushText() { B.textJob = null; }
function typeText(text) {
  if (!text) return;
  if (B.textJob) { B.textJob.text += text; return; }
  const job = { text };
  void inOrder(async () => {
    if (B.textJob === job) B.textJob = null;
    while (B.pending && visible()) await pause(100);
    if (job.text.length > 8192) { toast(t("window.chat.stage.ob.paste-long")); return; }
    await action("browser.owner_input", { kind: "text", text: job.text });
  });
  B.textJob = job; // after inOrder, which seals whatever was waiting before
}
/* Scrolling arrives as many small steps: they are added up and sent as one while the last one is still going. */
function flushWheel() {
  const wheel = B.wheel;
  if (!wheel) return;
  if (B.busy) { setTimeout(flushWheel, 60); return; }
  B.wheel = null;
  const clamp = (v) => Math.max(-4000, Math.min(4000, Math.round(v)));
  void inOrder(() => action("browser.owner_input", { kind: "wheel", dx: clamp(wheel.dx), dy: clamp(wheel.dy) }));
}
const KEYS = ["Enter", "Tab", "Escape", "Backspace", "Delete", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"];
function key(event) {
  if (!visible() || !(owned() || free()) || B.pending || event.isComposing) return;
  const modifiers = [event.ctrlKey && "Control", event.metaKey && "Meta", event.altKey && "Alt", event.shiftKey && "Shift"].filter(Boolean);
  const name = event.key === " " ? "Space" : event.key;
  if (modifiers.some((m) => m !== "Shift") && /^[a-zA-Z0-9]$/.test(name)) {
    if (/^v$/i.test(name) && (event.ctrlKey || event.metaKey)) return; // the paste event carries the words
    event.preventDefault(); flushText(); void inOrder(() => action("browser.owner_input", { kind: "key", key: [...modifiers, name].join("+") })); return;
  }
  // A plain character is left to the box's own input event, which also carries an input method's words.
  if (!modifiers.some((m) => m !== "Shift") && event.key.length === 1) return;
  if (KEYS.includes(name)) { event.preventDefault(); flushText(); void inOrder(() => action("browser.owner_input", { kind: "key", key: [...modifiers, name].join("+") })); }
}
function pointerUp(event) {
  const start = B.pointer; B.pointer = null;
  if (!start || !canDrive()) return;
  const end = point(event, start.img); if (!end) return;
  const moved = Math.hypot(end.x - start.x, end.y - start.y) > 0.012;
  const args = moved ? { kind: "drag", x: start.x, y: start.y, toX: end.x, toY: end.y }
    : { kind: "click", x: end.x, y: end.y, button: start.button, count: Math.min(3, Math.max(1, event.detail || 1)) };
  flushText();
  void inOrder(() => action("browser.owner_input", args));
}
const inPage = (event) => event.target.closest?.("#stage7 .owner-browser7-page");

export function initOwnerBrowser() {
  initNetworkLearning({ bound: () => ({ ...bound(), tabId: B.tabId }), available: owned, onChange: changed });
  initDemonstrations({ bound: () => ({ ...bound(), tabId: B.tabId }), available: owned, onChange: changed,
    inOrder: work => { flushText(); return inOrder(work); } });
  markLive(["owner-browser-adopt", "owner-browser-stop", "owner-browser-take", "owner-browser-handback",
    "owner-browser-tab", "owner-browser-tab-close", "owner-browser-new-tab", "owner-browser-back", "owner-browser-forward",
    "owner-browser-reload", "owner-browser-yes", "owner-browser-no", "sw:ob7-keys"]);
  on("owner-browser-adopt", (el) => { if (B.sid && !hasOwnerBrowser()) void inOrder(() => send("start", { ...scope(), runId: el.dataset.id })); });
  on("owner-browser-stop", () => { if (hasOwnerBrowser()) void inOrder(() => send("stop", bound())); });
  on("owner-browser-take", () => { if (hasOwnerBrowser()) void inOrder(() => send("control", { ...bound(), operation: "takeover" })); });
  on("owner-browser-handback", (el) => { if (hasOwnerBrowser()) void inOrder(() => send("control", { ...bound(), operation: "handback", runId: el.dataset.id })); });
  on("owner-browser-tab", (el) => { void inOrder(() => action("browser.tab", { action: "select", index: Number(el.dataset.index) })); });
  on("owner-browser-tab-close", (el) => { void inOrder(() => action("browser.tab", { action: "close", index: Number(el.dataset.index) })); });
  on("owner-browser-new-tab", () => { void inOrder(() => action("browser.tab", { action: "open" })); });
  on("owner-browser-back", () => { void inOrder(() => action("browser.owner_input", { kind: "back" })); });
  on("owner-browser-forward", () => { void inOrder(() => action("browser.owner_input", { kind: "forward" })); });
  on("owner-browser-reload", () => { void inOrder(() => action("browser.owner_input", { kind: "reload" })); });
  on("owner-browser-yes", confirm); on("owner-browser-no", cancelQuestion);
  document.addEventListener("submit", (event) => {
    const form = event.target.closest?.('#stage7 form[data-form="owner-browser-address"]');
    if (form) { event.preventDefault(); void address(form); }
  }, true);
  document.addEventListener("pointerdown", (event) => {
    const img = event.target.closest?.("#stage7 .owner-browser7-img");
    if (!img || !canDrive()) return;
    const at = point(event, img); if (!at) return;
    event.preventDefault(); document.getElementById("ob7-keys")?.focus({ preventScroll: true });
    B.pointer = { ...at, img, button: event.button === 2 ? "right" : event.button === 1 ? "middle" : "left" };
  }, true);
  document.addEventListener("pointerup", (event) => { if (B.pointer) pointerUp(event); }, true);
  // Pressing on the picture never takes the keys away from the page: they stay in its own box.
  document.addEventListener("mousedown", (event) => {
    if (event.target.closest?.("#stage7 .owner-browser7-img") && canDrive()) { event.preventDefault(); document.getElementById("ob7-keys")?.focus({ preventScroll: true }); }
  }, true);
  document.addEventListener("contextmenu", (event) => { if (event.target.closest?.(".owner-browser7-img")) event.preventDefault(); }, true);
  document.addEventListener("wheel", (event) => {
    if (!inPage(event) || !canDrive() || !hasOwnerBrowser()) return;
    event.preventDefault();
    const scale = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? 800 : 1;
    B.wheel = { dx: (B.wheel?.dx ?? 0) + event.deltaX * scale, dy: (B.wheel?.dy ?? 0) + event.deltaY * scale };
    setTimeout(flushWheel, 40);
  }, { capture: true, passive: false });
  document.addEventListener("keydown", (event) => {
    const tab = event.target.closest?.("#stage7 .ob7-tab");
    if (tab && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.isComposing
        && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      const tabs = [...tab.closest(".ob7-tabs").querySelectorAll(".ob7-tab:not(:disabled)")];
      const index = tabs.indexOf(tab);
      if (index < 0 || !tabs.length) return;
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
        : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
      // Navigation only moves focus. Native Enter/Space activation selects the page.
      tabs[next].focus({ preventScroll: true });
      return;
    }
    if (inPage(event)) key(event);
  }, true);
  document.addEventListener("paste", (event) => {
    if (!inPage(event) || !visible() || !(owned() || free()) || B.pending) return;
    event.preventDefault(); typeText(event.clipboardData?.getData("text/plain") ?? "");
  }, true);
  // Words put together with an input method (Chinese, Japanese, Korean, accents) arrive whole when composing ends.
  document.addEventListener("compositionend", (event) => {
    if (event.target.id !== "ob7-keys") return;
    if (canDrive()) typeText(event.data ?? "");
    event.target.value = "";
  }, true);
  document.addEventListener("input", (event) => {
    if (event.target.id !== "ob7-keys" || event.isComposing) return;
    if (event.inputType === "insertText" && canDrive()) typeText(event.data ?? "");
    if (!event.isComposing) event.target.value = "";
  }, true);
  document.addEventListener("visibilitychange", () => { if (document.hidden) disconnect(); else schedule(0); });
  window.addEventListener("pagehide", disconnect);
  if (!B.lockWatch) {
    B.lockWatch = true;
    const root = document.getElementById("app");
    if (root) new MutationObserver(() => { if (locked()) disconnect(); }).observe(root, { attributes: true, attributeFilter: ["class"] });
  }
}
