/* The Telegram Mini App: one task's browser on the owner's phone (src/miniapp/api.ts has every rule). Telegram hands
   the page its signed launch data in the address's #tgWebAppData, so Telegram's own script is not loaded. The session's
   token is kept in this page's memory only; closing the Mini App forgets it. */
const $ = (id) => document.getElementById(id);
const base = location.pathname.replace(/\/miniapp\/telegram\/?$/, "");
const api = (name) => `${base}/api/miniapp/telegram/${name}`;
const runId = new URLSearchParams(location.search).get("run") ?? "";
const launch = new URLSearchParams(location.hash.slice(1)).get("tgWebAppData") ?? globalThis.Telegram?.WebApp?.initData ?? "";
const S = { token: "", holder: "", control: null, frameId: "", tabId: "", busy: false, timer: 0, pending: null };
let words = {};
/** Inputs reach the page one after another, in the order they were made; none is dropped for arriving quickly. */
let queue = Promise.resolve();
const inOrder = (work) => (queue = queue.then(work, work));

const t = (key, fallback) => words[key] ?? fallback;
function applyWords() {
  for (const node of document.querySelectorAll("[data-t]")) node.textContent = t(node.dataset.t, node.textContent);
  for (const node of document.querySelectorAll("[data-t-placeholder]")) node.placeholder = t(node.dataset.tPlaceholder, node.placeholder);
}
async function loadWords() {
  let language = navigator.language?.slice(0, 2) ?? "en";
  try { language = JSON.parse(new URLSearchParams(launch).get("user") ?? "{}").language_code?.slice(0, 2) ?? language; } catch { /* the phone's own */ }
  if (!["en", "fr", "de", "es"].includes(language)) language = "en";
  try { words = await (await fetch(`${base}/miniapp/telegram/locales/${language}.json`, { cache: "no-store" })).json(); } catch { words = {}; }
  applyWords();
}
function note(text) { $("note").textContent = text ?? ""; $("note").hidden = !text; }

async function call(name, body) {
  const response = await fetch(api(name), { method: body === undefined ? "GET" : "POST", cache: "no-store",
    headers: { "content-type": "application/json", ...(S.token ? { authorization: `Bearer ${S.token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const answer = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(answer.error ?? `${response.status}`), { status: response.status });
  return answer;
}
function ended(error) {
  S.token = ""; clearTimeout(S.timer);
  $("live").hidden = true; $("pin").hidden = !launch || !runId;
  note(error?.message ?? t("miniapp.ended", "Your phone's hold on this browser ended."));
}

const holderWords = { you: ["miniapp.holder.you", "You have it"], task: ["miniapp.holder.task", "The task is working"],
  owner: ["miniapp.holder.owner", "Held in Branch's window"], none: ["miniapp.holder.none", "No browser open"] };
function show(view) {
  S.holder = view.holder ?? S.holder;
  const [key, fallback] = holderWords[S.holder] ?? holderWords.none;
  $("holder").textContent = t(key, fallback); $("holder").dataset.holder = S.holder;
  const driving = S.holder === "you";
  $("live").dataset.driving = String(driving);
  $("take").hidden = driving; $("give").hidden = !driving; $("drive").hidden = !driving;
  if (view.page?.frame) $("frame").src = `data:image/jpeg;base64,${view.page.frame}`;
  if (view.page) $("address").textContent = view.page.url ?? "";
  S.control = driving ? view.control ?? S.control : null;
  S.frameId = driving ? view.frameId ?? "" : ""; S.tabId = driving ? view.tabId ?? "" : "";
}
async function refresh() {
  clearTimeout(S.timer);
  if (!S.token) return;
  try { if (!S.busy && !document.hidden) show(await call("browser")); }
  // A page that moved on (409) is read again next time; a hold that ended is shown as ended.
  catch (error) { if (error.status === 401 || error.status === 403 || error.status === 423) { ended(error); return; } }
  S.timer = setTimeout(refresh, document.hidden ? 3000 : 700);
}

async function open(event) {
  event.preventDefault();
  $("pin-open").disabled = true; note("");
  try {
    const answer = await call("session", { initData: launch, runId, pin: $("pin-box").value });
    S.token = answer.token; $("pin-box").value = "";
    $("pin").hidden = true; $("live").hidden = false; show(answer); void refresh();
  } catch (error) { note(error.message); }
  finally { $("pin-open").disabled = false; }
}
function hand(operation) {
  return inOrder(async () => {
    S.busy = true;
    try { show(await call("control", { operation })); S.frameId = ""; } catch (error) { note(error.message); }
    finally { S.busy = false; void refresh(); }
  });
}
/** One input to the page the phone is looking at; the page moved on meanwhile: read it and try once more. */
function drive(tool, args, confirmToken) { return inOrder(() => send(tool, args, confirmToken)); }
async function send(tool, args, confirmToken, retried = false) {
  if (S.holder !== "you") return;
  S.busy = true; note("");
  let again = false;
  try {
    // A fresh view first when there is none yet (just taken over, or the page moved on).
    for (let tries = 0; tries < 6 && (!S.control || !S.frameId); tries++) show(await call("browser"));
    if (!S.control || !S.frameId) return;
    const answer = await call("action", { id: S.control.id, epoch: S.control.epoch, frameId: S.frameId, tabId: S.tabId,
      sequence: S.control.sequence + 1, tool, arguments: args, ...(confirmToken ? { confirmToken } : {}) });
    if (answer.status === "asked") ask(answer, tool, args);
    else if (answer.control) S.control = answer.control;
    // The next input goes to the page as it is after this one.
    show(await call("browser"));
  } catch (error) {
    if (!retried && error.status === 409) again = true;
    else note(error.message);
  } finally { S.busy = false; }
  if (again) { show(await call("browser").catch(() => ({}))); return send(tool, args, confirmToken, true); }
  void refresh();
}
function ask(answer, tool, args) {
  S.pending = { tool, args, token: answer.confirmToken };
  $("question-text").textContent = answer.question; $("question").hidden = false;
}
function answerQuestion(yes) {
  const pending = S.pending; S.pending = null; $("question").hidden = true;
  if (yes && pending) void drive(pending.tool, pending.args, pending.token);
}
/** Where on the page a tap landed, as a fraction of the picture (the page's own size is the picture's). */
function tap(event) {
  const rect = $("frame").getBoundingClientRect();
  const x = (event.clientX - rect.left) / rect.width, y = (event.clientY - rect.top) / rect.height;
  if (x >= 0 && x <= 1 && y >= 0 && y <= 1) void drive("browser.owner_input", { kind: "click", x, y });
}
async function end() {
  try { if (S.token) await call("end", {}); } catch { /* ending anyway */ }
  ended({ message: t("miniapp.ended", "Your phone's hold on this browser ended.") });
  globalThis.Telegram?.WebApp?.close?.();
}

function wire() {
  $("pin").addEventListener("submit", open);
  $("take").addEventListener("click", () => hand("take"));
  $("give").addEventListener("click", () => hand("give"));
  $("end").addEventListener("click", end);
  $("frame").addEventListener("click", tap);
  $("type").addEventListener("submit", (event) => {
    event.preventDefault();
    const text = $("type-box").value;
    if (text) { $("type-box").value = ""; void drive("browser.owner_input", { kind: "text", text }); }
  });
  $("enter").addEventListener("click", () => drive("browser.owner_input", { kind: "key", key: "Enter" }));
  $("up").addEventListener("click", () => drive("browser.owner_input", { kind: "wheel", dx: 0, dy: -500 }));
  $("down").addEventListener("click", () => drive("browser.owner_input", { kind: "wheel", dx: 0, dy: 500 }));
  $("back").addEventListener("click", () => drive("browser.owner_input", { kind: "back" }));
  $("question-yes").addEventListener("click", () => answerQuestion(true));
  $("question-no").addEventListener("click", () => answerQuestion(false));
  document.addEventListener("visibilitychange", () => { if (!document.hidden) void refresh(); });
}

wire();
await loadWords();
if (!launch || !runId) note(t("miniapp.noData", "Open this from the button in your Telegram chat."));
else $("pin").hidden = false;
