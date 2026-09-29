// Taps every screen and control of the phone app (apps/mobile/web, the prototype's pass-8 phone) against a throwaway
// engine, in English, French, Spanish and German, in light and dark, as an iPhone (393×852) and an Android phone
// (412×915) with touch, and confirms each live control through the engine's own GET routes.
//   node design/redesign/tools/verify-phone-app.cjs            (builds apps/mobile/www first; needs `npx tsc -p .`)
//   SHOTS=<folder> keeps a screenshot of every screen in every pass (default: none).
// What it starts, and stops again: an engine on PORT (default 3722) with a fresh data folder under FIN_DIR (default the
// system temp folder; dist/cli.js start), or none when TOKEN is given (it then uses the engine already on PORT), and a
// stand-in model service on 127.0.0.1 that speaks OpenAI's shape (the engine may reach it: its launch file allows this
// computer's addresses). The phone's native side is played by a stand-in (window.branchPhoneFake) whose `request`
// carries the owner's key to the engine from Node, as the native side adds the key itself; the page never holds it.
// With TOKEN, start that engine so it may reach the stand-in model on this computer, as the script does itself:
//   BRANCH_INTEGRATIONS=<file holding {"web":{"allowPrivateAddresses":true}}> BRANCH_DATA_DIR=<fresh dir> BRANCH_PORT=<PORT> node dist/cli.js start
// otherwise no question ever waits and the Allow, No and Allow all steps time out.
// Nothing touches port 3210, the installed app or the owner's own data.
"use strict";
const http = require("node:http");
const { spawn } = require("node:child_process");
const { createHash, generateKeyPairSync, sign } = require("node:crypto");
const { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } = require("node:fs");
const os = require("node:os");
const { extname, join } = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = join(__dirname, "..", "..", "..");
const WWW = join(ROOT, "apps", "mobile", "www");
const SHOTS = process.env.SHOTS || "";
let playwright;
try { playwright = require("playwright"); } catch { playwright = require("playwright"); }

let failures = 0, passes = 0;
const check = (ok, what, detail = "") => { if (ok) passes++; else failures++; console.log(`${ok ? "PASS" : "FAIL"} ${what}${detail && !ok ? ` (${detail})` : ""}`); };
const note = (what) => console.log(`NOTE ${what}`);
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(what, test, ms = 20000) {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await pause(250)) { const v = await test().catch(() => null); if (v) return v; }
  throw new Error(`timed out: ${what}`);
}
const freePort = () => new Promise((done) => { const s = http.createServer().listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => done(port)); }); });

/* ---------- the engine, the stand-in model and the phone page ---------- */
const E = { base: "", token: "" };
async function api(path, body, method) {
  const r = await fetch(`${E.base}/api/${path}`, { method: method ?? (body === undefined ? "GET" : "POST"), headers: { authorization: `Bearer ${E.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${path}: ${r.status} ${data.error ?? ""}`);
  return data;
}
const wire = (name) => `branch_${createHash("sha256").update(name).digest("hex").slice(0, 24)}`;
function standIn(port) {
  return new Promise((done) => {
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        if (req.method === "GET") return res.end(JSON.stringify({ object: "list", data: [{ id: "stand-in", object: "model" }, { id: "stand-in-b", object: "model" }] }));
        const body = JSON.parse(raw), messages = body.messages ?? [];
        const last = messages.map((m) => m.role).lastIndexOf("user");
        const prompt = typeof messages[last]?.content === "string" ? messages[last].content : JSON.stringify(messages[last]?.content ?? "");
        const tools = messages.slice(last + 1).filter((m) => m.role === "tool").length;
        let message = { role: "assistant", content: `Answer to: ${prompt.slice(0, 50)}` };
        if (/write a file/.test(prompt) && !tools) message = { role: "assistant", content: null, tool_calls: [{ id: `c${Date.now()}${Math.random()}`, type: "function", function: { name: wire("files.write"), arguments: JSON.stringify({ path: `notes/${Date.now()}.md`, content: "hi" }) } }] };
        const finish = message.tool_calls ? "tool_calls" : "stop";
        if (/"stream":\s*true/.test(raw)) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          const delta = message.tool_calls ? { role: "assistant", tool_calls: [{ index: 0, ...message.tool_calls[0] }] } : message;
          return res.end(`data: ${JSON.stringify({ id: "r", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`);
        }
        res.end(JSON.stringify({ id: "r", object: "chat.completion", model: body.model, choices: [{ index: 0, message, finish_reason: finish }], usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 } }));
      });
    });
    server.listen(port, "127.0.0.1", () => done(server));
  });
}
function startEngine(dir, port) {
  writeFileSync(join(dir, "launch.json"), JSON.stringify({ web: { allowPrivateAddresses: true } }));
  const engine = spawn(process.execPath, ["dist/cli.js", "start"], { cwd: ROOT, env: { ...process.env, NODE_TEST_CONTEXT: "", BRANCH_DATA_DIR: join(dir, "data"), BRANCH_PORT: String(port), BRANCH_INTEGRATIONS: join(dir, "launch.json") } });
  const token = new Promise((resolve, reject) => {
    engine.stdout.on("data", (d) => { const m = /paste into browser\): ([a-f0-9]+)/.exec(String(d)); if (m) resolve(m[1]); });
    engine.on("exit", (code) => reject(new Error(`the engine stopped (${code})`)));
  });
  return { engine, token };
}
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".woff2": "font/woff2", ".txt": "text/plain" };
function servePage(port) {
  return new Promise((done) => {
    const server = http.createServer((req, res) => {
      const path = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/+/, "") || "index.html";
      const file = join(WWW, path);
      if (!file.startsWith(WWW) || !existsSync(file)) { res.writeHead(404).end(); return; }
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
    });
    server.listen(port, "127.0.0.1", () => done(server));
  });
}

/* ---------- the phone's native side, played from Node ---------- */
/** A device answering the window's "Pair a phone" square with its own Ed25519 key, as BranchNode does natively. */
function deviceKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"), sign: (text) => sign(null, Buffer.from(text), privateKey).toString("base64") };
}
async function openPost(path, body) {
  const r = await fetch(`${E.base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}
function nativeSide(state) {
  const key = state.key ?? (state.key = deviceKey());
  return {
    async session() { return state.paired ? { paired: true, origin: E.base, pairedAt: new Date().toISOString() } : { paired: false }; },
    async forget() { state.paired = false; state.forgotten = true; },
    async request({ method, path, body, base64, contentType, query }) {
      const url = `${E.base}${path}${query ? `?${query}` : ""}`;
      const headers = { authorization: `Bearer ${E.token}` };
      let payload;
      if (base64) { headers["content-type"] = contentType || "application/octet-stream"; payload = Buffer.from(base64, "base64"); }
      else if (body !== null && body !== undefined) { headers["content-type"] = "application/json"; payload = JSON.stringify(body); }
      state.requests.push(`${method} ${path}`);
      const r = await fetch(url, { method, headers, body: payload });
      return { status: r.status, data: await r.json().catch(() => null) };
    },
    async getSwitches() { return { switches: state.switches }; },
    async setSwitches({ switches }) { state.switches = switches; },
    async switchesChanged() {},
    async look() { return state.look; },
    async setLook(look) { state.look = look; },
    async notify(n) { state.notified.push(n); },
    async lastSeen() { return { at: Date.now() }; },
    async takeShared() { const items = state.shared; state.shared = []; return { items }; },
    async clearShared() {},
    async unlock() { return { unlocked: true }; },
    async deviceKey() { return { publicKey: key.publicKey }; },
    async deviceStatus() { return state.lent ? { paired: true, origin: E.base, nodeId: state.lent, never: [], canSign: true } : { paired: false, never: [], canSign: true }; },
    async deviceForget() { state.lent = null; },
    /** Pairing with the window's square: ask, wait for the owner's yes, then ask once for the phone's key. */
    async phonePair({ offer, code, name }) {
      if (!offer) return { paired: false, error: "not a phone square" };
      const asked = await openPost("/api/devices/pair", { offer, code, name: name || "Verify phone", platform: "ios", publicKey: key.publicKey, offers: [] });
      if (asked.status !== 200) return { paired: false, error: asked.data.error };
      state.requestId = asked.data.requestId;
      for (let i = 0; i < 120; i++) {
        const status = await openPost("/api/devices/pair/status", { requestId: state.requestId, signature: key.sign(`branch-node-status-v1\n${state.requestId}`) });
        if (status.data.status === "approved") break;
        if (status.data.status === "refused") return { paired: false, error: "refused" };
        await pause(250);
      }
      const session = await openPost("/api/devices/pair/session", { requestId: state.requestId, signature: key.sign(`branch-phone-session-v1\n${state.requestId}`) });
      state.sessionAnswer = session.status;
      if (session.status !== 200 || !session.data.token) return { paired: false, error: session.data.error || `Branch answered ${session.status}.` };
      state.paired = true;
      return { paired: true };
    },
  };
}
const SIZES = [
  { name: "iphone", platform: "ios", viewport: { width: 393, height: 852 }, ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148" },
  { name: "android", platform: "android", viewport: { width: 412, height: 915 }, ua: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36" },
];
const freshState = (extra = {}) => ({ paired: true, switches: {}, look: { theme: "slate", mode: "dark" }, notified: [], requests: [], shared: [], lent: null, ...extra });
async function phonePage(browser, size, state) {
  const context = await browser.newContext({ viewport: size.viewport, hasTouch: true, isMobile: true, deviceScaleFactor: 2, userAgent: size.ua, permissions: ["microphone", "camera"] });
  const page = await context.newPage();
  page.errors = [];
  page.on("pageerror", (error) => page.errors.push(error.message));
  const native = nativeSide(state);
  await page.exposeFunction("__native", (method, args) => (native[method] ? native[method](args ?? {}) : undefined));
  await page.addInitScript((platform) => {
    globalThis.branchPhoneFake = new Proxy({ platform }, { get: (target, method) => (method === "platform" ? target.platform : method === "then" ? undefined : (args) => globalThis.__native(method, args)) });
  }, size.platform);
  await page.goto(E.page);
  await page.waitForFunction(() => document.body.dataset.ready === "true", null, { timeout: 20000 });
  return page;
}

/* ---------- moving about the phone ---------- */
const settle = (page, ms = 500) => page.waitForTimeout(ms);
async function tap(page, selector) {
  const target = page.locator(selector).first();
  await target.waitFor({ state: "visible", timeout: 10000 });
  await target.tap();
  await settle(page);
}
async function goTo(page, scr) {
  const trail = { home: ["tab:home"], chats: ["tab:chats"], inbox: ["tab:inbox"], more: ["tab:more"], automations: ["tab:more", "go:automations"], library: ["tab:more", "go:library"],
    trunks: ["tab:more", "go:trunks"], usage: ["tab:more", "go:usage"], settings: ["tab:more", "go:settings"], themes: ["tab:more", "go:settings", "go:themes"],
    accounts: ["tab:more", "go:settings", "go:accounts"], notif: ["tab:more", "go:settings", "go:notif"], chatapps: ["tab:more", "go:settings", "go:chatapps"],
    localm: ["tab:more", "go:settings", "go:localm"], pair: ["tab:more", "go:settings", "go:pair"] }[scr];
  await page.evaluate(() => document.querySelector('.p-sheet-bg')?.click());
  for (let i = 0; i < 4 && await page.locator("#tabs[hidden]").count(); i++) await tap(page, '[data-act="back"]');
  for (const step of trail) {
    const [kind, v] = step.split(":");
    await tap(page, kind === "tab" ? `[data-act="tab"][data-v="${v}"]` : `[data-act="go"][data-v="${v}"]`);
  }
  await settle(page, 700);
}
/** What every screen must be: no sideways scroll, no key shown in place of words, no page error. */
async function screenOk(page, label, lang) {
  const report = await page.evaluate(() => {
    const doc = document.documentElement, wide = doc.scrollWidth - doc.clientWidth;
    const scrolls = [...document.querySelectorAll(".p-scroll, .p-msgs")].filter((node) => node.scrollWidth - node.clientWidth > 1).map((node) => {
      const edge = node.getBoundingClientRect().right;
      const wide = [...node.querySelectorAll("*")].find((child) => child.getBoundingClientRect().right > edge + 1);
      return `${node.scrollWidth - node.clientWidth}px by ${wide ? `${wide.tagName.toLowerCase()}.${[...wide.classList].join(".")}` : "?"}`;
    });
    const text = document.getElementById("phone").innerText + [...document.querySelectorAll("[placeholder],[aria-label]")].map((n) => ` ${n.getAttribute("placeholder") ?? ""} ${n.getAttribute("aria-label") ?? ""}`).join("");
    const keys = text.match(/\b(phone8|phone|window|place|nav|settings|appearance)\.[a-z][\w.-]+/g) ?? [];
    const holes = text.match(/\{[a-z]+\}/g) ?? [];
    return { wide, scrolls, keys, holes, lang: doc.lang };
  });
  check(report.wide <= 0 && report.scrolls.length === 0, `${label}: no sideways scroll`, JSON.stringify(report));
  check(report.keys.length === 0 && report.holes.length === 0, `${label}: every word is a word, none a key or a hole`, [...report.keys, ...report.holes].join(" "));
  check(report.lang === lang, `${label}: the page says it is in ${lang}`, report.lang);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${label.replace(/[^a-z0-9-]+/gi, "-")}.png`) });
}

/* ---------- what the engine holds before the phone looks ---------- */
const D = {};
async function seed(standPort) {
  await api("onboarding", { done: true });
  await api("connections/from-preset", { provider: "custom", key: "stand-in-test-key", model: "stand-in", name: "Stand-in", extras: { baseUrl: `http://127.0.0.1:${standPort}/v1` } });
  await api("models", { activePreset: "custom" });
  const { policy } = await api("policy");
  await api("policy", { ...policy, rules: [{ tool: "files.write", decision: "ask", remember: "session" }] });
  D.chat = (await api("run", { prompt: "hello from the verify script" })).sessionId;
  D.trunk = (await api("trunks", { name: "Scout", title: "Research" })).trunk;
  await api("schedules", { prompt: "Water the plants", dueAt: new Date(Date.now() + 86400000).toISOString(), kind: "reminder" });
  await api("action", { tool: "memory.put", args: { text: "The owner likes short answers", source: "verify-phone-app" } }).catch((error) => note(`memory.put: ${error.message}`));
  await api("documents", { name: "notes.txt", content: Buffer.from("phone notes").toString("base64") }).catch((error) => note(`documents: ${error.message}`));
}
/** Makes n more questions wait (each a task that asks before writing a file) and answers when they all do. */
async function asksWaiting(n) {
  const start = (await api("policy")).waiting.length;
  for (let i = 0; i < n; i++) await api("run", { prompt: `please write a file ${Date.now()} ${i}` });
  return until(`${n} more questions waiting`, async () => { const { waiting } = await api("policy"); return waiting.length >= start + n ? waiting : null; });
}
async function setLook(language, mode) {
  await api("look", { language });
  const { preferences } = await api("state");
  await api("preferences", { ...preferences, appearance: mode === "light" ? "daylight" : "forest", followSystem: false });
}


/* ---------- the run ---------- */
const WORLD = { chat: null };
/** One step: a failure is recorded with its reason and the run goes on to the next step. */
async function step(what, work) {
  try { await work(); } catch (error) { check(false, what, error.message); }
}

async function liveControls(page, state, size) {
  const label = (x) => `${size.name}: ${x}`;
  await step(label("Allow on Home answers exactly that question"), async () => {
    const before = (await api("policy")).waiting.length;
    await asksWaiting(1);
    await goTo(page, "home");
    await until("Allow drawn", () => page.locator('[data-act="allow"]').count());
    await tap(page, '[data-act="allow"]');
    await until("one answered", async () => (await api("policy")).waiting.length <= before);
    check(true, label("Allow: GET /api/policy has one question fewer"));
  });
  await step(label("No in the Inbox refuses exactly that question"), async () => {
    await asksWaiting(1);
    await goTo(page, "inbox");
    await until("No drawn", () => page.locator('[data-act="deny"]').count());
    const before = (await api("policy")).waiting.length;
    await tap(page, '[data-act="deny"]');
    await until("one refused", async () => (await api("policy")).waiting.length < before);
    check(true, label("No: GET /api/policy has one question fewer"));
  });
  await step(label("Allow all answers each listed question once"), async () => {
    await asksWaiting(2);
    await goTo(page, "inbox");
    await until("Allow all drawn", () => page.locator('[data-act="ph-allowall"]').count());
    await tap(page, '[data-act="ph-allowall"]');
    await tap(page, '[data-act="allowall-go"]');
    await until("all answered", async () => (await api("policy")).waiting.length === 0);
    check(true, label("Allow all: GET /api/policy has nothing waiting"));
  });
  await step(label("Forget in Library removes the memory"), async () => {
    await api("action", { tool: "memory.put", args: { text: `The owner likes short answers (${size.name})`, source: "verify-phone-app" } }).catch((error) => note(`memory.put: ${error.message}`));
    const before = ((await api("state")).memory ?? []).length;
    if (!before) { note(label("no memory to forget (memory.put refused)")); return; }
    await goTo(page, "library");
    await tap(page, '[data-act="forget"]');
    await until("memory forgotten", async () => ((await api("state")).memory ?? []).length < before);
    check(true, label("Forget: GET /api/state memory is one shorter"));
  });
  await step(label("Pause and Resume a Trunk"), async () => {
    await goTo(page, "trunks");
    await tap(page, '[data-act="open"][data-to="profile"]');
    await tap(page, '[data-act="pausetrunk"][data-v="pause"]');
    await until("paused", async () => (await api("trunks")).trunks.find((t) => t.id === D.trunk.id)?.paused);
    await tap(page, '[data-act="pausetrunk"][data-v="resume"]');
    await until("resumed", async () => !(await api("trunks")).trunks.find((t) => t.id === D.trunk.id)?.paused);
    check(true, label("Pause/Resume: GET /api/trunks shows paused, then not"));
  });
  await step(label("A theme picked on the phone is every surface's"), async () => {
    await goTo(page, "themes");
    const pick = await page.locator('[data-act="theme"][aria-pressed="false"]').nth(2).getAttribute("data-v");
    await tap(page, `[data-act="theme"][data-v="${pick}"]`);
    await until("theme saved", async () => (await api("look")).theme === pick);
    check(true, label(`Theme: GET /api/look theme is ${pick}`));
  });
  await step(label("The switches are kept by the phone"), async () => {
    await goTo(page, "settings");
    await tap(page, '[data-act="ph-sw"][data-v="notifications"]');
    await until("switch kept", async () => state.switches.notifications === "when-needed");
    await goTo(page, "notif");
    await tap(page, 'input[data-kind="notifyDone"]');
    await until("kind kept", async () => state.switches.notifyDone === "off");
    check(true, label("Switches: the native side holds notifications=when-needed, notifyDone=off"));
  });
  await step(label("Lockdown on from the phone, and never off"), async () => {
    await goTo(page, "settings");
    await tap(page, '[data-act="ph-lockdown"]');
    await until("lockdown on", async () => (await api("lockdown")).on === true);
    await goTo(page, "settings");
    check(await page.locator('[data-act="ph-lockdown"]').isDisabled(), label("Lockdown: GET /api/lockdown on, and the row is greyed (off stays on the computer)"));
    await api("lockdown", { on: false });
  });
  await step(label("A message sent from a new chat reaches Branch"), async () => {
    const words = `hello from the ${size.name} ${Date.now()}`;
    await goTo(page, "chats");
    await tap(page, '[data-act="new"]');
    await page.fill("#ph-in", words);
    await page.locator("#ph-in").press("Enter");
    const found = await until("the conversation", async () => {
      for (const s of (await api("sessions?limit=50")).sessions) {
        const full = await api(`sessions/${s.sessionId}`);
        if ((full.messages ?? []).some((m) => m.role === "user" && String(m.content).includes(words))) return s;
      }
      return null;
    }, 30000);
    check(Boolean(found), label("Send: GET /api/sessions/<id> holds the message"));
    WORLD.chat = found.sessionId;
  });
  await step(label("The model picked for a chat is that chat's"), async () => {
    await until("chat has its id", () => page.evaluate(() => Boolean(document.querySelector('[data-act="ph-sheet"][data-v="model"]'))));
    await tap(page, '[data-act="ph-sheet"][data-v="model"]');
    const id = await page.locator('[data-act="ph-model"]').first().getAttribute("data-v");
    await tap(page, `[data-act="ph-model"][data-v="${id}"]`);
    await until("model saved", async () => (await api(`sessions/${WORLD.chat}/model`)).effective?.presetId === id);
    check(true, label(`Model: GET /api/sessions/<id>/model is ${id}`));
  });
  await step(label("Search finds a chat by its words"), async () => {
    await goTo(page, "chats");
    await page.fill("#ph-q", "verify script");
    await until("a result", () => page.locator(".p-scroll .p-row").count(), 10000);
    check(true, label("Search: POST /api/sessions/search answered, and a row is drawn"));
    await page.fill("#ph-q", "");
  });
  await step(label("The language picked on the phone is Branch's"), async () => {
    await goTo(page, "settings");
    await tap(page, '[data-act="ph-sheet"][data-v="language"]');
    await tap(page, '[data-act="language"][data-v="de"]');
    await until("language saved", async () => (await api("look")).language === "de");
    await until("page in German", () => page.evaluate(() => document.documentElement.lang === "de"));
    check(true, label("Language: GET /api/look language is de and the page says de"));
    await api("look", { language: "en" });
  });
}

async function everyScreen(page, size, lang, mode) {
  for (const scr of ["home", "chats", "inbox", "more", "automations", "library", "trunks", "usage", "settings", "themes", "accounts", "notif", "chatapps", "localm", "pair"])
    await step(`${size.name} ${lang} ${mode} ${scr}`, async () => { await goTo(page, scr); await screenOk(page, `${size.name}-${lang}-${mode}-${scr}`, lang); });
}
async function reopen(page) {
  await page.reload();
  await page.waitForFunction(() => document.body.dataset.ready === "true", null, { timeout: 20000 });
  await settle(page, 1200);
}

async function main() {
  const dir = mkdtempSync(join(process.env.FIN_DIR || os.tmpdir(), "verify-phone-"));
  mkdirSync(join(dir, "data"), { recursive: true });
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
  const standPort = await freePort(), pagePort = await freePort();
  const stand = await standIn(standPort);
  let engine = null;
  E.base = `http://127.0.0.1:${Number(process.env.PORT || 3722)}`;
  if (process.env.TOKEN) E.token = process.env.TOKEN;
  else { const started = startEngine(dir, Number(process.env.PORT || 3722)); engine = started.engine; E.token = await started.token; }
  const { buildWeb } = await import(pathToFileURL(join(ROOT, "apps", "mobile", "scripts", "build-web.mjs")).href);
  await buildWeb();
  const pageServer = await servePage(pagePort);
  E.page = `http://127.0.0.1:${pagePort}/`;
  const browser = await playwright.chromium.launch({ headless: true });
  try {
    await seed(standPort);
    for (const size of SIZES) {
      const state = freshState();
      const page = await phonePage(browser, size, state);
      await everyScreen(page, size, "en", "dark");
      await liveControls(page, state, size);
      for (const [lang, mode] of [["fr", "light"], ["es", "dark"], ["de", "light"]]) {
        await setLook(lang, mode);
        await reopen(page);
        await everyScreen(page, size, lang, mode);
      }
      await setLook("en", "dark");
      await step(`${size.name}: Forget this Branch asks first, then forgets`, async () => {
        await reopen(page);
        await goTo(page, "settings");
        await tap(page, '[data-act="ph-sheet"][data-v="forget"]');
        check(!state.forgotten, `${size.name}: the first tap only asks`);
        await tap(page, '[data-act="forget-go"]');
        await until("forgotten", async () => state.forgotten);
        await until("pair screen", () => page.locator("#address").count());
        check(true, `${size.name}: forgotten, and the Connect screen shows`);
      });
      check(page.errors.length === 0, `${size.name}: no page errors`, page.errors.join(" | "));
      await page.context().close();
    }
  } finally {
    await browser.close();
    pageServer.close();
    stand.close();
    if (engine) { engine.kill(); await pause(1500); }
    if (!process.env.KEEP) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
  console.log(`${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
