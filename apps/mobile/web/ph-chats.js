/**
 * Chats and a chat (the prototype's phChats, phChat and phSheet, with pass 9's search and plug).
 *   the list      GET /api/sessions (limit=50) with GET /api/trunks for which are a Trunk's or a room's; search is
 *                 POST /api/sessions/search { query }; the chips filter what is loaded, "Needs you" by GET /api/policy
 *   a chat        GET /api/sessions/<id>; a message is POST /api/run { prompt, sessionId }, which answers when the task
 *                 stops, so the conversation is read again every two seconds until it does
 *   its question  Send it / Don't send answer exactly that request (POST /api/policy/approve with its fingerprint)
 *   the model     GET/POST /api/sessions/<id>/model { preset } (a new chat changes the default, as the window does)
 * How much a conversation may do, the tools sheet, "A Trunk", "A skill" and "Temporary" are drawn and not live.
 */
import { E, P, attempt, av, big, draw, esc, firstLine, get, go, ic, ios, on, post, say, soon, time, toast, w } from "/ph-core.js";
import { asks, chatName, exact, loadSession, loadSessionModel, loadSessions, loadState, loadTrunks, loadWaiting, roomOf, runs, trunkOf } from "/ph-data.js";
import { planShare } from "/rules.js";
import { switchesNow } from "/ph-switches.js";

const C = { results: null, searched: "", pending: "", draft: "", attach: [], timer: 0 };
let phoneFrame = null;
function phoneView() {
  if (!trunkOf(P.chat)) return "";
  const view = phoneFrame?.session === P.chat && phoneFrame.expiresAt > Date.now() ? phoneFrame : null;
  return `<section><p>Read-only view requires the owner’s local, expiring grant.</p><button type="button" data-act="ph-view" data-v="browser">Refresh Trunk browser</button><button type="button" data-act="ph-view" data-v="computer">Refresh shared computer</button><button type="button" data-act="ph-view-close">Hide view</button>${view?.frame ? `<img src="${esc(view.frame)}" alt="Read-only ${esc(view.kind)} snapshot" style="max-width:100%"><p>Snapshot; refresh to see changes. No control permission.</p>` : ""}</section>`;
}
const waitingIn = (id) => asks().some((q) => q.sessionId === id);
const runningIn = (id) => runs().some((r) => r.sessionId === id && r.status === "running");

function row(s) {
  const id = s.sessionId, name = chatName(s), waiting = waitingIn(id);
  return `<button type="button" class="p-row" data-act="open" data-id="${esc(id)}">${av(name, 46)}<span class="grow"><span class="p-rt"><b>${esc(name)}</b><small>${esc(time(s.createdAt))}</small></span>
    <span class="p-pv ${waiting ? "p-acc" : ""}">${runningIn(id) ? '<i class="p-work8"></i>' : ""}${esc(firstLine(s.lastMessage ?? s.preview ?? ""))}</span></span>${s.unread ? '<i class="p-dot"></i>' : ""}</button>`;
}
const FILTERS = [["all", "look.filter.all", "All"], ["trunks", "phone8.chats.trunks", "Trunks"], ["rooms", "trunks.rooms", "Rooms"], ["unread", "place.inbox.needs", "Needs you"]];
function filtered() {
  const list = E.sessions ?? [];
  if (P.chatF === "trunks") return list.filter((s) => trunkOf(s.sessionId));
  if (P.chatF === "rooms") return list.filter((s) => roomOf(s.sessionId));
  if (P.chatF === "unread") return list.filter((s) => s.unread || waitingIn(s.sessionId));
  return list;
}
function results() {
  const found = C.results ?? [];
  return `<div class="p-group-h">${w("phone8.chats.messages", "Messages")}</div>${found.map(row).join("") || `<p class="p-empty">${w("phone8.chats.noMessages", "No messages with that.")}</p>`}`;
}
export function drawChats() {
  const newIcon = ios() ? `<button type="button" class="p-icon8" data-act="new" aria-label="${w("phone8.home.new", "New chat")}">${ic("edit", "s")}</button>` : "";
  const search = `<label class="p-search ${ios() ? "" : "m3"} p-sq9">${ic("search", "s")}<input id="ph-q" type="search" value="${esc(P.q)}" placeholder="${w("phone8.chats.search", "Search chats, Trunks and words")}" autocomplete="off"></label>`;
  const chips = `<div class="p-chips8">${FILTERS.map(([v, k, e]) => `<button type="button" data-act="ph-cf" data-v="${v}" aria-pressed="${P.chatF === v}">${w(k, e)}</button>`).join("")}</div>`;
  const list = filtered();
  const body = P.q.trim() ? results() : P.chatF === "all" && list.length ? `<div class="p-group-h">${w("window.shell.shell.recent", "Recent")}</div>${list.map(row).join("")}` : list.map(row).join("") || `<p class="p-empty">${w("wsedit.empty", "Nothing here.")}</p>`;
  const fab = ios() ? "" : `<button type="button" class="p-fab" data-act="new">${ic("edit", "s")}${w("phone8.home.new", "New chat")}</button>`;
  return big(w("phone8.tab.chats", "Chats"), newIcon) + `<div class="p-scroll">${search}${chips}${body}</div>${fab}`;
}
export const loadChats = () => Promise.all([loadSessions(), loadTrunks(), loadWaiting(), loadState()]);

/* ---------- a chat ---------- */
function bubble(m) {
  if (m.role === "user") return m.system ? "" : `<div class="pmsg pme">${esc(m.content)}</div>`;
  if (m.role === "assistant" && String(m.content ?? "").trim()) return `<div class="pmsg bot">${esc(m.content)}</div>`;
  return "";
}
function askBlock(q) {
  const buttons = exact(q) ? `<span class="pa"><button type="button" class="p-pri" data-act="allow" data-sid="${esc(q.sessionId)}" data-fp="${esc(q.fingerprint)}">${w("window.chat.ask.send-it", "Send it")}</button><button type="button" data-act="deny" data-sid="${esc(q.sessionId)}" data-fp="${esc(q.fingerprint)}">${w("phone8.chat.dontSend", "Don’t send")}</button></span>` : "";
  return `<div class="pmsg pq q-on"><b>${esc(q.question || q.label)}</b>${q.target ? `<small>${esc(q.target)}</small>` : ""}${buttons}</div>`;
}
function modelPill() {
  const effective = P.chat ? E[`model:${P.chat}`]?.effective : null;
  const name = effective?.presetName ?? (E.state?.models?.presets ?? []).find((p) => p.id === E.state?.models?.activePreset)?.name ?? "";
  return `<button type="button" class="p-model8" data-act="ph-sheet" data-v="model">${esc(name || E.state?.modelNeeded || "")}${ic("down", "s")}</button>`;
}
export function drawChat() {
  const session = P.chat ? E[`session:${P.chat}`] : null;
  const name = P.chat ? chatName({ sessionId: P.chat, opening: session?.messages?.[0]?.content }) : say("phone8.home.new", "New chat");
  const sub = P.chat && waitingIn(P.chat) ? w("place.inbox.needs", "Needs you") : esc(trunkOf(P.chat)?.title ?? "");
  const talk = switchesNow().voice !== "off" ? "" : soon;
  const head = `<div class="p-nav chat8"><button type="button" data-act="back" aria-label="${w("pair.back", "Back")}">${ios() ? "‹" : "←"}</button><button type="button" class="p-who" data-act="open" data-id="${esc(P.chat ?? "")}" data-to="profile" ${trunkOf(P.chat) ? "" : soon}>${av(name, 30)}<span><b>${esc(name)}</b><small>${sub}</small></span></button><span class="p-navr"><button type="button" data-act="voice" aria-label="${w("phone8.home.talk", "Talk")}" ${talk}>${ic("wave", "s")}</button></span></div>`;
  const messages = (session?.messages ?? []).map(bubble).join("") + asks().filter((q) => q.sessionId === P.chat).map(askBlock).join("");
  const pending = C.pending ? `<div class="pmsg pme">${esc(C.pending)}</div><div class="pmsg sys"><i class="p-work8"></i></div>` : "";
  const attached = C.attach.length ? `<div class="p-attach">${C.attach.map((a) => `<span>${esc(a.name)}</span>`).join("")}</div>` : "";
  const composer = `<form class="p-comp" data-form="ph"><button type="button" class="p-plus" data-act="ph-sheet" data-v="plus" aria-label="${w("asks.runtimes.add", "Add")}">+</button><button type="button" class="p-plug9" aria-label="${w("safety.stop.tools", "Tools")}" ${soon}>${ic("plug", "s")}</button><input id="ph-in" value="${esc(C.draft)}" placeholder="${w("phone8.chat.message", "Message {name}", { name })}" autocomplete="off"><button type="button" class="p-mic8" data-act="voice" aria-label="${w("phone8.home.talk", "Talk")}" ${talk}>${ic("mic", "s")}</button><button type="submit" class="p-send" aria-label="${w("composer.send", "Send")}">${ic("up", "s")}</button></form>`;
  return head + `<div class="p-msgs" data-bottom>${messages}${pending}${phoneView()}</div>${attached}${modelPill()}${composer}`;
}
/** How much the conversation may do, read to show which is chosen (GET /api/conversation-mode). */
async function loadMode(id) {
  if (!id) return;
  E[`mode:${id}`] = await get("/api/conversation-mode", `sessionId=${id}`).catch(() => E[`mode:${id}`]);
}
export const loadChat = () => Promise.all([P.chat ? loadSession(P.chat) : null, P.chat ? loadSessionModel(P.chat) : null, loadMode(P.chat), loadWaiting(), loadState(), loadTrunks()]);

/* ---------- the sheets ---------- */
const PLUS = [["camera", "permissions.name.camera", "Camera", "camera"], ["image", "phone8.chat.photos", "Photos", "photos"], ["folder", "pane.files", "Files", "files"],
  ["at", "ov.trunk.eyebrow", "A Trunk", ""], ["bolt", "phone8.chat.skill", "A skill", ""], ["ghost", "composer.temporary", "Temporary", ""]];
const MODES = [["auto", "look.season.auto", "Auto"], ["ask", "mode.ask", "Ask first"], ["plan", "mode.plan", "Plan first"], ["full", "window.chat.mode.full", "Full access"]];
export function drawSheet() {
  if (P.sheet === "plus") return `<b>${w("phone8.chat.addTo", "Add to the message")}</b><div class="p-grid8">${PLUS.map(([i, k, e, v]) => `<button type="button" ${v ? `data-act="ph-pick" data-v="${v}"` : soon}>${ic(i)}<span>${w(k, e)}</span></button>`).join("")}</div>`;
  if (P.sheet !== "model") return "";
  const current = P.chat ? E[`model:${P.chat}`]?.effective?.presetId : E.state?.models?.activePreset;
  const models = (E.state?.models?.presets ?? []).map((m) => `<button type="button" class="p-li" data-act="ph-model" data-v="${esc(m.id)}"><span class="grow"><b>${esc(m.name)}</b><small>${esc(m.model ?? "")}</small></span>${m.id === current ? '<span class="p-ok">✓</span>' : ""}</button>`).join("");
  const mode = E[`mode:${P.chat}`]?.mode;
  return `<b>${w("phone8.chat.modelSheet", "Model and how much it may do")}</b><div class="p-list">${models}</div><div class="p-seg8">${MODES.map(([v, k, e]) => `<button type="button" aria-pressed="${mode === v}" ${soon}>${w(k, e)}</button>`).join("")}</div>`;
}

/* ---------- sending ---------- */
function pollWhileWorking(id) {
  clearInterval(C.timer);
  C.timer = setInterval(async () => {
    await Promise.all([loadSession(id), loadState(), loadWaiting()]);
    if (!C.pending && !runningIn(id)) clearInterval(C.timer);
    draw();
  }, 2000);
}
async function send(text) {
  const { requests, refused } = planShare(C.attach, text);
  if (!requests.length || C.pending) return;
  C.pending = text || C.attach.map((a) => a.name).join(", ");
  C.attach = [];
  if (P.chat) pollWhileWorking(P.chat);
  draw();
  for (const request of requests) {
    const body = request.path === "/api/run" && P.chat ? { ...request.body, sessionId: P.chat } : request.body;
    const answer = await post(request.path, body).catch(async (error) => {
      await loadState();
      if (!P.chat || !runningIn(P.chat)) toast(error.message); // a long task outlives the phone's wait; it is still read
      return null;
    });
    if (answer?.sessionId && !P.chat) { P.chat = answer.sessionId; pollWhileWorking(P.chat); }
  }
  if (refused.length) toast(refused.map((r) => r.name).join(", "));
  C.pending = "";
  await Promise.all([loadChat(), loadSessions()]);
  draw();
}
async function pickModel(id) {
  await attempt(async () => {
    if (P.chat) await post(`/api/sessions/${P.chat}/model`, { preset: id });
    else await post("/api/models", { activePreset: id });
    P.sheet = null;
    await Promise.all([loadState(), P.chat ? loadSessionModel(P.chat) : null]);
  });
}
async function runSearch(words) {
  C.searched = words;
  if (!words.trim()) { C.results = null; draw(); return; }
  const answer = await post("/api/sessions/search", { query: words.slice(0, 200) }).catch((error) => { toast(error.message); return null; });
  if (C.searched === words) { C.results = (answer?.sessions ?? []).map((s) => ({ ...s, lastMessage: s.preview })); draw(); }
}
const readFile = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(file);
});
export async function attachFiles(list) {
  for (const file of list) C.attach.push({ kind: "file", name: file.name, type: file.type, data: await readFile(file) });
  draw();
}
export function initChats() {
  on("ph-view-close", () => { phoneFrame = null; draw(); });
  on("ph-view", async el => {
    const session = P.chat; phoneFrame = null; draw();
    try {
      const view = await get("/api/phone/trunk-view", `session=${encodeURIComponent(session)}&kind=${el.dataset.v}`);
      if (P.chat !== session || document.hidden) return;
      phoneFrame = { ...view, session }; draw();
      setTimeout(() => { if (phoneFrame?.session === session) { phoneFrame = null; draw(); } }, Math.min(10000, Math.max(0, view.expiresAt - Date.now())));
    } catch (error) { toast(error.message); }
  });
  document.addEventListener("visibilitychange", () => { if (document.hidden) { phoneFrame = null; draw(); } });
  on("ph-cf", (el) => { P.chatF = el.dataset.v; draw(); });
  on("new", () => { P.chat = null; C.attach = []; go("chat"); });
  on("ph-sheet", (el) => { P.sheet = el.dataset.v || null; draw(); });
  on("ph-model", (el) => pickModel(el.dataset.v));
  on("ph-pick", (el) => { P.sheet = null; draw(); document.getElementById(el.dataset.v === "camera" ? "pick-camera" : el.dataset.v === "photos" ? "pick-photos" : "pick-files")?.click(); });
  let typing = 0;
  document.addEventListener("input", (event) => {
    if (event.target.id === "ph-in") C.draft = event.target.value;
    if (event.target.id !== "ph-q") return;
    P.q = event.target.value;
    clearTimeout(typing);
    typing = setTimeout(() => void runSearch(P.q), 300);
  });
  document.addEventListener("submit", (event) => {
    if (event.target.dataset?.form !== "ph") return;
    event.preventDefault();
    const input = document.getElementById("ph-in");
    const text = input.value.trim();
    input.value = "";
    C.draft = "";
    void send(text);
  });
}
export const chatNow = C;
