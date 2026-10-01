/**
 * bucket 19: a person's own page. They sign in with the checks the owner chose (a PIN, a passkey, an
 * identity service), then see only their own conversations and what the owner shared with them.
 * The same page opens a conversation handed over from the computer (#handoff=<id>) with the key
 * shown there, which reaches that one conversation and nothing else.
 *
 * Keys live in this tab only (sessionStorage) and are sent as a Bearer header, never in an address.
 */
import { applyLanguage, initLanguage, t } from "/i18n.js";

const $ = (id) => document.getElementById(id);
const PERSON = "branch-person-key", HANDOFF = "branch-handoff-key";
const words = (key, fallback, values) => (t(key) === key ? fallback : t(key, values));
const store = {
  get: (name) => { try { return sessionStorage.getItem(name) || ""; } catch { return ""; } },
  set: (name, value) => { try { value ? sessionStorage.setItem(name, value) : sessionStorage.removeItem(name); } catch { /* forgets */ } },
};
let ticket = "", left = [], openId = "", pollTimer = 0;
let openRoomId = "", roomGeneration = 0;

function say(text, bad = false) {
  $("people-status").textContent = text;
  $("people-status").className = bad ? "bad" : "";
}
function show(id) {
  roomGeneration += 1;
  openRoomId = "";
  for (const pane of ["people-signin", "people-handoff", "people-home", "people-conversation"]) $(pane).hidden = pane !== id;
  clearInterval(pollTimer);
}

async function call(path, body, key) {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 && key === store.get(PERSON)) { store.set(PERSON, ""); show("people-signin"); }
  if (!response.ok) throw new Error(data.error || words("people.error", "That did not work."));
  return data;
}
const personCall = (path, body) => call(path, body, store.get(PERSON));

/* ---------- base64url for passkeys ---------- */
const toBytes = (text) => Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4)), (c) => c.charCodeAt(0));
const toText = (buffer) => btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/* ---------- signing in ---------- */

function drawSteps() {
  $("people-steps").hidden = false;
  $("people-pin-form").hidden = !left.includes("pin");
  $("people-passkey").hidden = !left.includes("passkey");
  $("people-providers").hidden = !left.includes("oidc");
  if (left.includes("pin")) $("people-pin").focus();
}

async function afterStep(result) {
  left = result.left;
  if (left.length) { drawSteps(); say(words("people.signin.more", "That worked. One more check.")); return; }
  const done = await call("/api/people/sign-in/finish", { ticket });
  store.set(PERSON, done.key);
  ticket = "";
  await openHome();
}

async function step(method, stage, extra = {}) {
  return call("/api/people/sign-in/step", { ticket, method, stage, ...extra });
}

async function usePasskey() {
  const options = (await step("passkey", "begin")).result;
  const credential = await navigator.credentials.get({ publicKey: {
    challenge: toBytes(options.challenge), rpId: options.rpId, timeout: options.timeout, userVerification: options.userVerification,
    allowCredentials: options.allowCredentials.map((id) => ({ type: "public-key", id: toBytes(id) })),
  } });
  const answer = credential.response;
  await afterStep(await step("passkey", "finish", { credential: {
    id: credential.id, clientDataJSON: toText(answer.clientDataJSON),
    authenticatorData: toText(answer.authenticatorData), signature: toText(answer.signature),
  } }));
}

async function useProvider(provider) {
  const begun = await step("oidc", "begin", { provider });
  try { sessionStorage.setItem("branch-person-ticket", JSON.stringify({ ticket, left })); } catch { /* a private window */ }
  location.assign(begun.result.url);
}

async function loadProviders() {
  const info = await call("/api/people/sign-in").catch(() => null);
  if (!info) { say(words("people.off", "Signing in from other devices is switched off on this computer."), true); return; }
  const holder = $("people-providers");
  holder.replaceChildren(...info.providers.map((provider) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "quiet";
    button.textContent = words("people.signin.provider", `Continue with ${provider.label}`, { name: provider.label });
    button.addEventListener("click", () => useProvider(provider.id).catch((error) => say(error.message, true)));
    return button;
  }));
}

function wireSignIn() {
  $("people-name-form").addEventListener("submit", (event) => {
    event.preventDefault();
    call("/api/people/sign-in/start", { name: $("people-name").value, device: navigator.platform || "A device" })
      .then((started) => { ticket = started.ticket; left = started.steps; drawSteps(); say(""); })
      .catch((error) => say(error.message, true));
  });
  $("people-pin-form").addEventListener("submit", (event) => {
    event.preventDefault();
    step("pin", "finish", { pin: $("people-pin").value }).then(afterStep)
      .catch((error) => { $("people-pin").value = ""; say(error.message, true); });
  });
  $("people-passkey").addEventListener("click", () => usePasskey().catch((error) => say(error.message, true)));
  $("people-code-form").addEventListener("submit", (event) => {
    event.preventDefault();
    call("/api/people/sign-in/code", { name: $("people-code-name").value, code: $("people-code-value").value })
      .then((done) => { store.set(PERSON, done.key); return openHome(); })
      .catch((error) => say(error.message, true));
  });
}

/* ---------- a person's own page ---------- */

function link(text, onClick) {
  const anchor = document.createElement("a");
  anchor.href = "#";
  anchor.textContent = text;
  anchor.addEventListener("click", (event) => { event.preventDefault(); onClick(); });
  return anchor;
}

async function openHome() {
  const me = await personCall("/api/people/me");
  show("people-home");
  $("people-home-title").textContent = words("people.home.title", `Hello, ${me.name}`, { name: me.name });
  $("people-setup").hidden = !me.setupOnly;
  for (const id of ["people-list", "people-new", "people-home-note"]) $(id).hidden = me.setupOnly;
  $("people-security").open = me.setupOnly;
  $("people-current-pin").parentElement.querySelector("label[for=people-current-pin]").hidden = me.setupOnly;
  $("people-current-pin").hidden = me.setupOnly;
  await drawPasskeys();
  if (!me.setupOnly) await drawList();
  say("");
}

async function drawList() {
  const key = store.get(PERSON), generation = roomGeneration;
  const [lists, rooms] = await Promise.all([
    call("/api/people/conversations", undefined, key),
    call("/api/people/rooms", undefined, key).catch((error) => ({ rooms: [], unavailable: error.message })),
  ]);
  if (key !== store.get(PERSON) || generation !== roomGeneration || $("people-home").hidden) return;
  const heading = (key, fallback) => { const h = document.createElement("h3"); h.dataset.t = key; h.textContent = words(key, fallback); return h; };
  const own = lists.own.sessions.map((s) => link(s.opening || words("people.home.untitled", "A conversation"), () => openConversation(s.id)));
  const shared = lists.shared.map((s) => link(s.relation === "driver"
    ? words("people.home.shared-join", "Shared with you — you can join in")
    : words("people.home.shared-read", "Shared with you to read"), () => openConversation(s.sessionId)));
  const admitted = rooms.rooms.map((room) => link(room.name, () => openRoom(room.id)));
  $("people-list").replaceChildren(heading("people.home.own", "Yours"), ...(own.length ? own : [emptyLine()]),
    ...(shared.length ? [heading("people.home.shared", "Shared with you"), ...shared] : []),
    ...(admitted.length ? [heading("people.home.rooms", "Rooms you are invited to"), ...admitted] : []),
    ...(rooms.capped ? [heading("people.home.rooms-capped", "Showing the first 50 rooms")] : []));
}
function emptyLine() {
  const p = document.createElement("p");
  p.className = "subtle";
  p.textContent = words("people.home.empty", "Nothing yet. Start a conversation below.");
  return p;
}

async function drawPasskeys() {
  const { passkeys } = await personCall("/api/people/me/passkeys");
  $("people-passkey-list").replaceChildren(...passkeys.map((key) => {
    const item = document.createElement("li");
    item.textContent = `${key.name} `;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "text";
    remove.textContent = words("people.security.remove", "Remove");
    remove.addEventListener("click", () => personCall("/api/people/me/passkeys/remove", { id: key.id }).then(drawPasskeys));
    item.append(remove);
    return item;
  }));
}

async function addPasskey() {
  const options = await personCall("/api/people/me/passkeys/begin", {});
  const credential = await navigator.credentials.create({ publicKey: {
    challenge: toBytes(options.challenge), rp: options.rp, timeout: options.timeout, attestation: options.attestation,
    user: { ...options.user, id: toBytes(options.user.id) }, pubKeyCredParams: options.pubKeyCredParams,
    excludeCredentials: options.excludeCredentials.map((id) => ({ type: "public-key", id: toBytes(id) })),
  } });
  await personCall("/api/people/me/passkeys/finish", { name: navigator.platform || "A passkey", credential: {
    id: credential.id, clientDataJSON: toText(credential.response.clientDataJSON),
    attestationObject: toText(credential.response.attestationObject),
  } });
  await drawPasskeys();
  say(words("people.security.added", "Passkey added."));
}

function wireHome() {
  $("people-sign-out").addEventListener("click", () => personCall("/api/people/me/sign-out", {}).finally(() => {
    store.set(PERSON, ""); show("people-signin"); say(words("people.signed-out", "Signed out."));
  }));
  $("people-new").addEventListener("click", () => { enterConversation(); openId = ""; showConversation([], "own"); });
  $("people-back").addEventListener("click", () => (store.get(HANDOFF) ? undefined : openHome()));
  $("people-add-passkey").addEventListener("click", () => addPasskey().catch((error) => say(error.message, true)));
  $("people-new-pin-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const body = { pin: $("people-new-pin").value, ...($("people-current-pin").hidden ? {} : { current: $("people-current-pin").value }) };
    personCall("/api/people/me/pin", body).then(() => say(words("people.security.saved", "Your new PIN is saved.")))
      .catch((error) => say(error.message, true));
  });
}

/* ---------- one conversation ---------- */

/* The one way into the conversation pane (a room, a conversation or a new one): it shows the pane, lets go of whatever
   room or conversation was open there, and draws nothing until the caller does. */
function enterConversation() {
  show("people-conversation");
  $("people-message-form").hidden = true;
  $("people-messages").replaceChildren();
}

function drawRoom(view) {
  $("people-back").hidden = false;
  $("people-message-form").hidden = false;
  $("people-conversation-note").textContent = `${view.name} — ${words("people.room.member", "Only members may join this room.")}`
    + (view.limited ? ` ${words("people.room.limited", "Only recent messages are shown.")}` : "");
  $("people-messages").replaceChildren(...view.messages.map((message) => {
    const item = document.createElement("li"), who = document.createElement("strong");
    item.className = message.role;
    who.textContent = message.who;
    item.append(who, document.createTextNode(message.content));
    return item;
  }));
}

async function openRoom(id) {
  enterConversation();
  openRoomId = id;
  $("people-conversation-note").textContent = "";
  const key = store.get(PERSON), generation = roomGeneration;
  const current = () => key === store.get(PERSON) && generation === roomGeneration && openRoomId === id;
  let busy = false, reads = 0, last = "";
  const read = async () => {
    if (busy || !current()) return;
    busy = true;
    try {
      const view = await call(`/api/people/rooms/${encodeURIComponent(id)}`, undefined, key);
      if (!current()) return;
      const fingerprint = JSON.stringify(view);
      if (fingerprint !== last) { last = fingerprint; drawRoom(view); }
    } catch (error) {
      if (current()) {
        clearInterval(pollTimer); $("people-message-form").hidden = true; $("people-messages").replaceChildren();
        say(error.message, true);
      }
      throw error;
    } finally { busy = false; }
  };
  try { await read(); } catch { return; }
  if (!current()) return;
  pollTimer = setInterval(() => {
    if (!current() || ++reads > 100) {
      clearInterval(pollTimer);
      if (current()) say(words("people.room.refresh", "Live updates paused. Reopen the room to refresh."));
      return;
    }
    void read().catch(() => undefined);
  }, 3000);
}

function showConversation(messages, access) {
  $("people-back").hidden = !!store.get(HANDOFF);
  $("people-message-form").hidden = access === "viewer";
  $("people-conversation-note").textContent = access === "viewer"
    ? words("people.conversation.read-only", "Shared with you to read. It updates by itself.")
    : access === "driver" ? words("people.conversation.joined", "Shared with you. The owner sees what you write, with your name.") : "";
  $("people-messages").replaceChildren(...messages.map((m) => {
    const item = document.createElement("li");
    item.className = m.role;
    const who = document.createElement("strong");
    who.textContent = m.role === "user" ? words("people.conversation.person", "Person") : words("people.conversation.assistant", "Assistant");
    item.append(who, document.createTextNode(m.content));
    return item;
  }));
}

async function readConversation() {
  if (store.get(HANDOFF)) return call("/api/people/handoff", undefined, store.get(HANDOFF));
  return personCall(`/api/people/conversations/${openId}`);
}
async function openConversation(id) {
  enterConversation();
  openId = id;
  const generation = roomGeneration, key = store.get(PERSON), handoff = store.get(HANDOFF);
  const current = () => generation === roomGeneration && openId === id && key === store.get(PERSON) && handoff === store.get(HANDOFF);
  const view = await readConversation();
  if (!current()) return;
  showConversation(view.messages, view.access || "own");
  pollTimer = setInterval(() => readConversation().then((next) => {
    if (!current()) return;
    if (next.messages.length !== $("people-messages").children.length) showConversation(next.messages, next.access || "own");
  }).catch(() => { if (current()) clearInterval(pollTimer); }), 3000);
}

async function send(prompt) {
  if (openRoomId) return sendRoom(prompt);
  const generation = roomGeneration, key = store.get(PERSON), handoff = store.get(HANDOFF), id = openId;
  const current = () => generation === roomGeneration && key === store.get(PERSON) && handoff === store.get(HANDOFF);
  say(words("people.conversation.working", "Working on it…"));
  if (handoff) await call("/api/run", { prompt, sessionId: id }, handoff);
  else {
    const done = await call(id ? `/api/people/conversations/${id}/message` : "/api/people/conversations", { prompt }, key);
    if (!current()) return;
    openId = done.sessionId;
  }
  if (!current()) return;
  await openConversation(openId);
  say("");
}

async function sendRoom(text) {
  if (!openRoomId || !store.get(PERSON) || $("people-message-form").hidden) return;
  roomGeneration += 1;
  clearInterval(pollTimer);
  const id = openRoomId, key = store.get(PERSON), generation = roomGeneration;
  $("people-message-form").hidden = true;
  try {
    await call(`/api/people/rooms/${encodeURIComponent(id)}/message`, { text }, key);
    if (key !== store.get(PERSON) || generation !== roomGeneration || openRoomId !== id) return;
    await openRoom(id);
    say("");
  } catch (error) {
    if (key === store.get(PERSON) && generation === roomGeneration && openRoomId === id) {
      clearInterval(pollTimer); $("people-messages").replaceChildren(); say(error.message, true);
    }
  }
}

function wireConversation() {
  $("people-message-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const prompt = $("people-message").value.trim();
    if (!prompt) return;
    $("people-message").value = "";
    send(prompt).catch((error) => say(error.message, true));
  });
  $("people-handoff-form").addEventListener("submit", (event) => {
    event.preventDefault();
    store.set(HANDOFF, $("people-handoff-key").value.trim());
    openConversation(openId).catch((error) => { store.set(HANDOFF, ""); say(error.message, true); });
  });
}

async function start() {
  await initLanguage().catch(() => undefined);
  applyLanguage();
  wireSignIn(); wireHome(); wireConversation();
  const hash = new URLSearchParams(location.hash.slice(1));
  history.replaceState(null, "", location.pathname);
  if (/^[a-f0-9-]{36}$/.test(hash.get("handoff") || "")) {
    openId = hash.get("handoff");
    show("people-handoff");
    return;
  }
  await loadProviders();
  if (hash.get("oidc") || hash.get("error")) return finishProvider(hash.get("oidc"), hash.get("state"));
  if (store.get(PERSON)) await openHome().catch(() => show("people-signin"));
}

/** Back from an identity service: this tab holds the sign-in it started, and finishes it with the answer. */
async function finishProvider(code, state) {
  let saved = {};
  try { saved = JSON.parse(sessionStorage.getItem("branch-person-ticket") || "{}"); sessionStorage.removeItem("branch-person-ticket"); } catch { /* none */ }
  ticket = saved.ticket || "";
  left = saved.left || [];
  if (!ticket || !code) { say(words("people.signin.oidc-failed", "That account did not sign you in here."), true); return; }
  try {
    await afterStep(await step("oidc", "finish", { code, state }));
  } catch (error) {
    if (left.length) drawSteps();
    say(error.message || words("people.signin.oidc-failed", "That account did not sign you in here."), true);
  }
}

start().catch((error) => say(error.message, true));
