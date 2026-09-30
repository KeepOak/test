/* The screen audit's three browser P0s (audits/screen.md, UP-SCREEN-001, -003, -004), each against a fixture server on
   the loopback address and a headless Chromium of the test's own:
   - a page's WebSockets are held to the same rules as its requests, instead of every one being closed;
   - a name only ever presses the one thing that carries exactly that name;
   - an "are you a person?" check met by any browser step pauses the task until the owner takes over and hands back. */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { chromium } from "playwright"; // a real headless Chromium opens these pages (CI installs it for this file)
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { Budget, ToolRegistry, createBranch, savePolicy, saveWebPagesSettings } from "../dist/index.js";
import { BranchBrowser, registerBrowser } from "../dist/integrations/browser.js";
import { NetworkPolicy } from "../dist/network-policy.js";

assert.equal(typeof chromium.launch, "function");

const context = (runId, signal = new AbortController().signal) => ({ owner: "test", workspace: ".", runId, signal,
  budget: new Budget(), permissions: new Set(["browser.read", "browser.interact"]), depth: 0 });
const page = (title, body) => `<!doctype html><meta charset="utf-8"><title>${title}</title>${body}`;

/** Answers a WebSocket handshake and echoes every short text message back (enough of RFC 6455 for these pages). */
function echoSockets(server) {
  server.on("upgrade", (request, socket) => {
    const accept = createHash("sha1").update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.on("error", () => socket.destroy());
    socket.on("data", (frame) => {
      if ((frame[0] & 0x0f) !== 1) { socket.end(); return; }
      const length = frame[1] & 0x7f, mask = frame.subarray(2, 6);
      const data = Buffer.from(frame.subarray(6, 6 + length)).map((byte, i) => byte ^ mask[i % 4]);
      socket.write(Buffer.concat([Buffer.from([0x81, data.length]), data]));
    });
  });
}
/** Closes a server when the test ends, sockets it upgraded included, so the file never waits on an open connection. */
function closing(t, server) {
  const open = new Set();
  server.on("connection", (socket) => { open.add(socket); socket.on("close", () => open.delete(socket)); });
  t.after(() => new Promise((done) => { for (const socket of open) socket.destroy(); server.close(() => done()); }));
}
/** A server that counts every TCP connection made to it, standing in for a host the rules refuse. */
async function counted(t) {
  const seen = { connections: 0 };
  const server = createServer((_request, response) => response.end("reached"));
  server.on("connection", () => { seen.connections += 1; });
  echoSockets(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  closing(t, server);
  return { port: server.address().port, seen };
}
async function site(t, pages) {
  const server = createServer((request, response) => {
    const path = new URL(request.url, "http://fixture").pathname;
    const made = typeof pages[path] === "function" ? pages[path]() : pages[path];
    const found = typeof made === "object" ? made : { body: made, headers: {} };
    response.writeHead(found.body ? 200 : 404, { "content-type": "text/html; charset=utf-8", ...found.headers }).end(found.body ?? "missing");
  });
  echoSockets(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  closing(t, server);
  return `http://127.0.0.1:${server.address().port}`;
}
/** Opens one socket from the page (or from a worker the page starts) and says how it ended. */
const openSocket = (address, from = "direct") => `(${from === true ? "worker" : from})("${address}")`;
const socketScript = page("Sockets", `<p id="said">nothing</p><script>
  const said = (text) => { document.getElementById("said").textContent = text; };
  const listen = (s, done) => { s.onopen = () => s.send("hello"); s.onmessage = (e) => done("echo:" + e.data);
    s.onclose = (e) => done("closed:" + e.code); };
  window.direct = (u) => new Promise((done) => listen(new WebSocket(u), done));
  window.blank = (u) => new Promise((done) => { const f = document.createElement("iframe"); document.body.append(f);
    listen(new f.contentWindow.WebSocket(u), done); setTimeout(() => done("timeout"), 4000); });
  const inWorker = (u, options) => new Promise((done) => {
    const code = "const s=new WebSocket(" + JSON.stringify(u) + ");s.onopen=()=>s.send('hello');"
      + "s.onmessage=(e)=>postMessage('echo:'+e.data);s.onclose=(e)=>postMessage('closed:'+e.code);s.onerror=()=>postMessage('error');";
    const address = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
    const w = new Worker(address, options);
    URL.revokeObjectURL(address); // as bundlers do: the address is gone before the worker reads it
    w.onmessage = (e) => done(e.data); w.onerror = () => done("worker refused");
    setTimeout(() => done("timeout"), 4000);
  });
  window.worker = (u) => inWorker(u);
  window.moduleWorker = (u) => inWorker(u, { type: "module" });
</script>`);

async function withBrowser(t, config, setup = () => undefined) {
  const browser = new BranchBrowser(config);
  setup(browser);
  const registry = new ToolRegistry();
  registerBrowser(registry, browser);
  t.after(() => browser.close());
  return { browser, run: (name, input, ctx) => registry.execute(name, input, ctx) };
}
/** What the page's script said, read through the browser's own shaped read. */
const said = async (h, ctx, script) => {
  await h.run("browser.wait", { selector: "#said", timeoutMs: 2000 }, ctx);
  return (await h.browser.lookAtPage(ctx, async (p) => ({ said: String(await p.evaluate(script)) }))).said;
};

test("UP-SCREEN-001: a WebSocket to an allowed site works; one to a site off the list is refused and never connects", async (t) => {
  // A strict page policy that allows sockets and blob workers but not reading blobs, as real sites set it.
  const strict = { "content-security-policy": "default-src 'self' 'unsafe-inline'; connect-src 'self' ws:; worker-src blob:" };
  const origin = await site(t, { "/": socketScript, "/strict": { body: socketScript, headers: strict } });
  const refused = await counted(t);
  const h = await withBrowser(t, { allowedOrigins: [origin] });
  const ctx = context("sockets-list");
  await h.run("browser.navigate", { url: `${origin}/` }, ctx);
  const ws = origin.replace("http:", "ws:");
  assert.equal(await said(h, ctx, openSocket(`${ws}/echo`)), "echo:hello", "the allowed socket carried a message both ways");
  assert.equal(await said(h, ctx, openSocket(`ws://127.0.0.1:${refused.port}/x`)), "closed:1008", "the page is told it was refused");
  const worker = await said(h, ctx, openSocket(`ws://127.0.0.1:${refused.port}/x`, true));
  assert.equal(worker, "worker refused", "a worker a page made from a blob is refused a socket off the list too");
  assert.equal(await said(h, ctx, openSocket(`${ws}/echo`, true)), "echo:hello", "and still reaches the allowed site");
  assert.equal(await said(h, ctx, openSocket(`${ws}/echo`, "moduleWorker")), "echo:hello", "a module worker reaches it too");
  assert.equal(await said(h, ctx, openSocket(`ws://127.0.0.1:${refused.port}/x`, "moduleWorker")), "worker refused");
  await h.run("browser.navigate", { url: `${origin}/strict` }, ctx);
  assert.equal(await said(h, ctx, openSocket(`${ws}/echo`, true)), "echo:hello", "a worker still starts under a strict page policy");
  assert.equal(await said(h, ctx, openSocket(`ws://127.0.0.1:${refused.port}/x`, true)), "worker refused");
  const blank = await said(h, ctx, openSocket(`ws://127.0.0.1:${refused.port}/x`, "blank"));
  assert.notEqual(blank, "echo:hello", `a socket from a blank frame the page made is refused too (${blank})`);
  assert.equal(refused.seen.connections, 0, "nothing ever reached the refused site");
  const log = await h.run("browser.network", { filter: "websocket", limit: 20 }, ctx);
  assert.ok(log.requests.some((row) => /refused this WebSocket/.test(row.failure ?? "")), "browser.network says why");
  assert.ok(log.requests.some((row) => row.failure === null), "and lists the one it let through");
});

const PUBLIC = "203.0.113.10";
test("UP-SCREEN-001: in any-website mode a plain ws:// socket goes through the pinned door, and a private one is refused", async (t) => {
  const origin = await site(t, { "/": socketScript });
  const port = Number(new URL(origin).port);
  const refused = await counted(t);
  const lookups = { "echo.test": [PUBLIC], "inside.test": ["127.0.0.1"] };
  const h = await withBrowser(t, { anyWebsite: true }, (browser) => {
    browser.policy = new NetworkPolicy({}, async (host) => lookups[host] ?? [], (address) => (address === PUBLIC ? "127.0.0.1" : address));
  });
  const ctx = context("sockets-any");
  await h.run("browser.navigate", { url: `http://echo.test:${port}/` }, ctx);
  assert.equal(await said(h, ctx, openSocket(`ws://echo.test:${port}/echo`)), "echo:hello", "reached at the judged address");
  assert.equal(await said(h, ctx, openSocket(`ws://inside.test:${refused.port}/x`)), "closed:1008");
  assert.equal(refused.seen.connections, 0, "the private address was never dialled");
});

const deleteHit = `<p id="hit">nothing</p><script>function hit(w){document.getElementById('hit').textContent=w}</script>`;
test("UP-SCREEN-003: \"Delete\" presses the button called exactly that, never \"Delete account\" beside it", async (t) => {
  const origin = await site(t, {
    "/both": page("Both", `<button onclick="hit('account')">Delete account</button><button onclick="hit('delete')">Delete</button>${deleteHit}`),
    "/twins": page("Twins", `<button onclick="hit('one')">Delete</button><button onclick="hit('two')">Delete</button>${deleteHit}`),
    "/only": page("Only", `<button onclick="hit('account')">Delete account</button>${deleteHit}`),
  });
  const h = await withBrowser(t, { allowedOrigins: [origin] });
  const ctx = context("heal-strict");
  const hit = async () => (await h.browser.lookAtPage(ctx, async (p) => ({ text: await p.locator("#hit").textContent() }))).text;

  await h.run("browser.navigate", { url: `${origin}/both` }, ctx);
  const pressed = await h.run("browser.act", { action: "click", name: "Delete" }, ctx);
  assert.equal(pressed.foundBy, "role");
  assert.equal(await hit(), "delete", "the exact one was pressed, though the longer name comes first");

  await h.run("browser.navigate", { url: `${origin}/twins` }, ctx);
  await assert.rejects(h.run("browser.act", { action: "click", name: "Delete" }, ctx), (error) => {
    assert.match(error.message, /"Delete" matches 2 things on this page, so nothing was pressed/);
    assert.match(error.message, /\[\d+\] button "Delete"; \[\d+\] button "Delete"\. Choose the one you mean/, "fresh numbers to choose from");
    return true;
  });
  assert.equal(await hit(), "nothing", "two alike: neither was pressed");

  await h.run("browser.navigate", { url: `${origin}/only` }, ctx);
  await assert.rejects(h.run("browser.act", { action: "click", name: "Delete" }, ctx), (error) => {
    assert.match(error.message, /Nothing on this page matched exactly/);
    assert.match(error.message, /\[\d+\] button "Delete account"/, "the near miss is offered by number, not pressed");
    return true;
  });
  assert.equal(await hit(), "nothing", "a longer name is never taken for the one asked for");
});

/** A Cloudflare-style wall that turns into the shop once `state.solved` is set, standing for the owner finishing it. */
function wall(state) {
  return page("Just a moment...", `<p>Checking your browser before accessing the shop.</p>
    <label><input type="checkbox" id="human" onclick="fetch('/pressed')"> Verify you are human</label>
    <script>setInterval(() => fetch('/solved').then((r) => r.text()).then((t) => {
      if (t === 'yes' && document.title !== 'Shop') { document.title = 'Shop'; document.body.innerHTML = '<h1>Shop</h1>'; }
    }), 50);</script>`);
}
async function wallSite(t, state) {
  return site(t, { "/": () => wall(state), "/solved": () => (state.solved ? "yes" : "no"),
    "/pressed": () => { state.pressed += 1; return "ok"; } });
}
const fakeStore = (events) => ({ get: () => undefined, run: (id) => ({ id, owner: "test", sessionId: "conv-1" }),
  event: (runId, kind, data) => events.push({ runId, kind, data }) });
const waitUntil = async (what, check) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 25));
  assert.ok(check(), what);
};

test("UP-SCREEN-004: a check met by a browser step pauses the task, offers Take over, and carries on after Hand back", async (t) => {
  const state = { solved: false, pressed: 0 };
  const origin = await wallSite(t, state);
  const events = [], notified = [];
  const h = await withBrowser(t, { allowedOrigins: [origin] }, (browser) => {
    browser.store = fakeStore(events);
    browser.notify = (kind, data) => notified.push({ kind, data });
  });
  const ctx = context("challenge-handback");
  const step = h.run("browser.navigate", { url: `${origin}/` }, ctx);
  await waitUntil("the owner was told", () => events.some((e) => e.kind === "attention.needed"));
  const question = events.find((e) => e.kind === "attention.needed").data.question;
  assert.match(question, /Press Take over.*Hand back/);
  assert.match(question, /does not try to get past/);
  assert.ok(events.some((e) => e.kind === "web.challenge" && e.data.route === "browser"));
  assert.equal(notified[0]?.kind, "approval.needed");

  // While the check shows, another step of the task is refused before it touches the page.
  await assert.rejects(h.run("browser.act", { action: "click", selector: "#human" }, ctx), /Take over/);
  assert.equal(state.pressed, 0, "the task never pressed the check");

  const control = h.browser.adoptRun("test", "conv-1", ctx.runId, "owner-window");
  await control.takeOver(control.view().epoch, "owner-window");
  state.solved = true; // the owner finishes the check in the live browser
  await new Promise((r) => setTimeout(r, 300));
  await control.handBack(control.view().epoch, "owner-window", ctx.runId);
  const done = await step;
  assert.equal(done.challenge?.cleared, true, JSON.stringify(done));
  assert.match(done.note, /owner finished the check/);
  const seen = await h.run("browser.snapshot", {}, ctx);
  assert.match(seen.accessibility, /Shop/, "the task carries on on the page the owner handed back");
});

test("UP-SCREEN-004: left unanswered, the step reports the check and every later step is refused at once", async (t) => {
  const state = { solved: false, pressed: 0 };
  const origin = await wallSite(t, state);
  const h = await withBrowser(t, { allowedOrigins: [origin] }, (browser) => { browser.challengeWaitMs = 300; });
  const ctx = context("challenge-timeout");
  const answer = await h.run("browser.navigate", { url: `${origin}/` }, ctx);
  assert.equal(answer.challenged, true);
  assert.match(answer.takeOver, /Take over/);
  const started = Date.now();
  await assert.rejects(h.run("browser.act", { action: "click", selector: "#human" }, ctx), /Take over/);
  assert.ok(Date.now() - started < 2000, "refused at once, not after another wait");
  assert.equal(state.pressed, 0);
});

test("UP-SCREEN-004: stopping the task ends its wait for the owner", async (t) => {
  const origin = await wallSite(t, { solved: false, pressed: 0 });
  const h = await withBrowser(t, { allowedOrigins: [origin] });
  const stop = new AbortController();
  const ctx = context("challenge-abort", stop.signal);
  const step = h.run("browser.navigate", { url: `${origin}/` }, ctx);
  setTimeout(() => stop.abort(new Error("stopped by the owner")), 1500);
  await assert.rejects(step);
});

test("UP-SCREEN-004: the check is told apart from an ordinary page that only talks about captchas", async () => {
  const { pageChallenge } = await import("../dist/integrations/browser-challenge.js");
  const look = (title, text, widget = false) => pageChallenge({ url: () => "https://shop.test/p", evaluate: async () => ({ title, text, widget }) });
  assert.equal((await look("Just a moment...", "Checking your browser"))?.site, "shop.test");
  assert.match((await look("Sign in", "Log in to continue", true))?.what ?? "", /captcha/, "a short page built round a check box");
  assert.equal(await look("How to add a CAPTCHA to your form", "A long guide. ".repeat(200)), null);
  assert.equal(await look("Checkout", "Your basket. ".repeat(200), true), null, "a long page with a check box on it is not a wall");
  assert.equal(await look("Access denied", "You do not have permission to view this page."), null, "an ordinary refusal page");
});

test("UP-SCREEN-004: web.page's browser route meets the check once and reads the page the owner handed back", async (t) => {
  const state = { solved: false, pressed: 0 };
  const origin = await wallSite(t, state);
  const root = await mkdtemp(join(tmpdir(), "branch-screen-p0-"));
  const quiet = { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: quiet });
  const h = await withBrowser(t, { allowedOrigins: [origin] }, (browser) => { browser.store = app.store; });
  t.after(async () => { await app.close(); await discardTemp(root); });
  registerBrowser(app.registry, h.browser);
  const owner = app.runtime.owner;
  savePolicy(app.store, owner, { preset: "off" });
  saveWebPagesSettings(app.store, owner, { mode: "on" });
  const session = app.store.createSession(owner), run = app.store.createRun(owner, "read the shop", session);
  const ctx = { ...context(run.id), owner, permissions: new Set(["web.read", "browser.read", "browser.interact"]) };
  const reading = app.registry.execute("web.page", { url: `${origin}/`, route: "browser" }, ctx);
  const challenges = () => app.store.events(run.id).filter((e) => e.kind === "web.challenge");
  await waitUntil("the owner was told", () => challenges().length === 1);
  const control = h.browser.adoptRun(owner, session, run.id, "owner-window");
  await control.takeOver(control.view().epoch, "owner-window");
  state.solved = true;
  await new Promise((r) => setTimeout(r, 300));
  await control.handBack(control.view().epoch, "owner-window", run.id);
  const page = await reading;
  assert.equal(page.challenged, false, JSON.stringify(page).slice(0, 300));
  assert.match(page.text, /Shop/);
  assert.equal(challenges().length, 1, "handed over once, not again once it was solved");
});
