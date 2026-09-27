import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { acceptKey, readFrame } from "../dist/ws.js";
import { busyTaskCount } from "../dist/comfort/auto-update.js";
import { runningTaskCount } from "../dist/desktop/quit-guard.js";
import { chromium } from "playwright";

/**
 * Talk live makes a task first and opens the conversation on that task's socket afterwards. When the
 * socket never opens a conversation, the task must still end, or it holds "update by itself" and the
 * quit question until Branch restarts. Nothing here reaches the internet: the live service is a small
 * local stand-in, and the page is the new window in headless Chromium with fake media and a socket that never opens.
 */
const settle = (ms) => new Promise((done) => setTimeout(done, ms));
const until = async (check, what, limit = 10000) => {
  const deadline = Date.now() + limit;
  for (;;) {
    const found = check();
    if (found !== undefined && found !== null && found !== false) return found;
    if (Date.now() >= deadline) throw new Error(`waited ${limit}ms and never saw ${what}`);
    await settle(20);
  }
};

async function served(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-live-never-opens-"));
  const dataDir = join(root, "data");
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir });
  const server = await startServer(app, { dataDir, port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const call = async (method, path, body, key = server.token) => {
    const response = await fetch(server.url + path, {
      method,
      headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try { json = await response.json(); } catch { /* no body */ }
    return { status: response.status, json };
  };
  return { app, server, call };
}
/** A connection the catalog says can hold a live conversation, pointed at `endpoint`. */
function livePreset(app, endpoint) {
  app.runtime.models.register({
    id: "live-openai", name: "live-openai", model: "live-model", catalogId: "openai",
    provider: { name: "openai", complete: async () => ({ content: "", toolCalls: [] }), audio: () => ({ endpoint, apiKey: "sk-not-used" }) },
  });
  app.runtime.models.configure("local", { activePreset: "live-openai" });
}
/** A stand-in for the live service: it takes the connection, `answerAfterMs` late, and reads what it is sent. */
async function fakeLiveService(t, { answerAfterMs = 0 } = {}) {
  const server = createServer((_request, response) => response.writeHead(404).end());
  const sockets = [];
  server.on("upgrade", async (request, socket) => {
    sockets.push(socket);
    if (answerAfterMs) await settle(answerAfterMs);
    socket.write([
      "HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${acceptKey(String(request.headers["sec-websocket-key"] ?? ""))}`, "", "",
    ].join("\r\n"));
    let pending = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      for (let decoded = readFrame(pending); decoded; decoded = readFrame(pending)) {
        pending = pending.subarray(decoded.consumed);
        if (decoded.opcode === 0x8) socket.end(Buffer.from([0x88, 0x00]));
      }
    });
    socket.on("error", () => undefined);
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => { for (const socket of sockets) socket.destroy(); return new Promise((done) => server.close(done)); });
  return { endpoint: `http://127.0.0.1:${server.address().port}` };
}
const liveTasks = (app) => app.store.sqlite.prepare("SELECT id FROM tasks WHERE prompt='A live conversation'").all().map((row) => String(row.id));

test("a live conversation whose socket never connects ends by itself as stopped, and holds no update or quit", async (t) => {
  const { app, call } = await served(t);
  livePreset(app, "ws://127.0.0.1:9/realtime");
  app.live.connectWaitMs = 1000;
  assert.equal((await call("POST", "/api/comfort", { card: "notify", values: { autoUpdate: "install" } })).status, 200);
  const made = await call("POST", "/api/voice/live", { sessionId: null });
  assert.equal(made.status, 200);
  const { runId } = made.json;
  assert.equal(app.store.run(runId).status, "running", "Talk live makes its task before the socket opens");
  assert.equal(busyTaskCount(app.store), 1, "and while it waits, it counts as working");

  await until(() => app.store.run(runId).status !== "running", "the task end by itself");
  const run = app.store.run(runId);
  assert.equal(run.status, "cancelled", "it ends as stopped");
  assert.equal(run.output, "The live conversation never connected.");
  const ended = app.store.events(runId).filter((event) => event.kind === "voice.live.ended");
  assert.equal(ended.length, 1, "its history says why, once");
  assert.equal(ended[0].data.reason, "The live conversation never connected");
  assert.equal(runningTaskCount(app.store), 0, "the quit question no longer counts it");
  assert.equal(busyTaskCount(app.store), 0, "nor does the update's count");
  const ready = (await call("GET", "/api/comfort/update-readiness")).json;
  assert.equal(ready.busyTasks, 0, "the readiness count is clear too");
  const plan = (await call("POST", "/api/comfort/update-plan", { updaterPhase: "available" })).json;
  assert.equal(plan.busyTasks, 0);
  assert.equal(plan.step, "install", "so the update installs by itself again");
});

/** Opens the task's socket as the page does, says "start", and waits until the conversation is open. */
async function talk(server, runId) {
  const client = new WebSocket(`${server.url.replace(/^http/, "ws")}/api/runs/${runId}/ws`, ["bearer", server.token]);
  const kinds = [];
  client.addEventListener("message", (event) => { try { kinds.push(JSON.parse(String(event.data)).kind); } catch { /* sound */ } });
  const closed = new Promise((done) => client.addEventListener("close", done, { once: true }));
  await new Promise((done, failed) => { client.addEventListener("open", done, { once: true }); client.addEventListener("error", failed, { once: true }); });
  client.send(JSON.stringify({ live: "start" }));
  await until(() => kinds.includes("voice.live.ready"), "the conversation open");
  return { client, closed };
}

test("a live conversation that opens in time is not ended by the wait, and still ends the usual way", async (t) => {
  const service = await fakeLiveService(t);
  const { app, server, call } = await served(t);
  app.web.policy.configure({ allowPrivateAddresses: true });
  livePreset(app, service.endpoint);
  app.live.connectWaitMs = 3000; // long enough for the socket to say "start" on a busy machine
  const { runId } = (await call("POST", "/api/voice/live", { sessionId: null })).json;
  const { client, closed } = await talk(server, runId);

  await settle(2 * app.live.connectWaitMs); // the wait has run out well before this
  assert.equal(app.store.run(runId).status, "running", "the wait never ends a conversation that opened in time");
  assert.equal(app.store.events(runId).some((event) => event.kind === "voice.live.ended"), false);

  client.send(JSON.stringify({ live: "stop" }));
  await until(() => app.store.run(runId).status !== "running", "the conversation's own Stop end it");
  assert.equal(app.store.run(runId).status, "completed", "its own ending is unchanged");
  assert.match(app.store.run(runId).output, /You ended the conversation\.$/);
  client.close();
  await closed;
});

test("a live conversation still being opened when the wait runs out is given the time it needs", async (t) => {
  const service = await fakeLiveService(t, { answerAfterMs: 6000 });
  const { app, server, call } = await served(t);
  app.web.policy.configure({ allowPrivateAddresses: true });
  livePreset(app, service.endpoint);
  app.live.connectWaitMs = 2500; // runs out after "start", while the service is still answering
  const { runId } = (await call("POST", "/api/voice/live", { sessionId: null })).json;
  const { client, closed } = await talk(server, runId);
  assert.equal(app.store.run(runId).status, "running", "the conversation opened on a task that is still working");
  assert.equal(app.store.events(runId).some((event) => event.kind === "voice.live.ended"), false);

  client.send(JSON.stringify({ live: "stop" }));
  await until(() => app.store.run(runId).status !== "running", "the conversation's own Stop end it");
  assert.equal(app.store.run(runId).status, "completed");
  client.close();
  await closed;
});

test("Stop ends a live conversation's task that never connected, and still needs the owner's key", async (t) => {
  const { app, call } = await served(t);
  livePreset(app, "ws://127.0.0.1:9/realtime");
  app.live.connectWaitMs = 10 * 60_000; // only Stop can end these within this test
  const first = (await call("POST", "/api/voice/live", { sessionId: null })).json.runId;
  const second = (await call("POST", "/api/voice/live", { sessionId: null })).json.runId;

  assert.equal((await call("POST", `/api/runs/${second}/cancel`, {}, null)).status, 401, "without the key, nothing is stopped");
  assert.equal(app.store.run(second).status, "running");

  assert.deepEqual((await call("POST", `/api/runs/${first}/cancel`, {})).json, { cancelled: true });
  const run = app.store.run(first);
  assert.equal(run.status, "cancelled");
  assert.equal(run.output, "Stopped before the live conversation connected.");
  assert.equal(app.store.run(second).status, "running", "only the task asked about is stopped");
  assert.deepEqual((await call("POST", `/api/runs/${first}/cancel`, {})).json, { cancelled: false }, "a second Stop has nothing left to stop");
  assert.deepEqual((await call("POST", `/api/runs/${second}/cancel`, {})).json, { cancelled: true });
  assert.equal(busyTaskCount(app.store), 0);
  assert.equal(runningTaskCount(app.store), 0);
});

/* ---------- the page: the new window's Talk live (public/app/chat/talklive.js), in headless Chromium ---------- */

/** Until `check` (run in the page) answers something, or the limit passes. */
const pageUntil = async (page, check, what, limit = 10000) => {
  const deadline = Date.now() + limit;
  for (;;) {
    const found = await check().catch(() => null);
    if (found !== undefined && found !== null && found !== false) return found;
    if (Date.now() >= deadline) throw new Error(`waited ${limit}ms and never saw ${what}`);
    await settle(50);
  }
};

test("when the live socket never opens, the page stops the task it made and says why", async (t) => {
  const { app, server, call } = await served(t);
  livePreset(app, "ws://127.0.0.1:9/realtime");
  app.live.connectWaitMs = 10 * 60_000; // only the page can end it within this test
  assert.equal((await call("POST", "/api/onboarding", { done: true })).status, 200);
  const browser = await chromium.launch({ headless: true, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // The window's socket does not get through: it fails, then closes, a moment after it is made. The microphone is counted.
  await page.addInitScript(() => {
    window.__sockets = []; window.__mic = 0;
    const media = navigator.mediaDevices, ask = media.getUserMedia.bind(media);
    media.getUserMedia = async (c) => { window.__mic += 1; return ask(c); };
    window.WebSocket = class extends EventTarget {
      constructor(url, protocols) {
        super();
        this.readyState = 0;
        window.__sockets.push({ url, protocols });
        setTimeout(() => { this.readyState = 3; this.dispatchEvent(new Event("error")); this.dispatchEvent(new Event("close")); }, 5);
      }
      send() { throw new Error("This socket is not open"); }
      close() { this.readyState = 3; }
    };
  });
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#prompt").waitFor({ timeout: 120000 });
  const button = page.locator(".composer [data-act='voice']");
  assert.equal(await button.getAttribute("aria-disabled"), null, "Talk live is offered in the composer");

  await button.click();
  const runId = await until(() => liveTasks(app)[0], "the press make its task");
  await until(() => app.store.run(runId).status !== "running", "the page stop the task");
  assert.equal(liveTasks(app).length, 1, "one press made one task");
  const sockets = await page.evaluate(() => window.__sockets);
  assert.deepEqual(sockets, [{ url: `${server.url.replace(/^http/, "ws")}/api/runs/${runId}/ws`, protocols: ["bearer", server.token] }]);
  assert.equal(app.store.run(runId).status, "cancelled", "the page stopped the task its socket could not reach");
  assert.equal(app.store.run(runId).output, "Stopped before the live conversation connected.");
  assert.equal(busyTaskCount(app.store), 0, "so it holds no update");
  assert.equal(runningTaskCount(app.store), 0, "and no quit question");

  const en = JSON.parse(await readFile(new URL("../public/locales/en.json", import.meta.url), "utf8"));
  const fr = JSON.parse(await readFile(new URL("../public/locales/fr.json", import.meta.url), "utf8"));
  assert.equal(en["voiceLive.neverConnected"], "The live conversation could not connect, so it was stopped.");
  await pageUntil(page, async () => (await page.locator(".toast").innerText()) === en["voiceLive.neverConnected"], "the owner told why");
  assert.ok(fr["voiceLive.neverConnected"] && fr["voiceLive.neverConnected"] !== en["voiceLive.neverConnected"], "and it is in French too");
  assert.equal(await page.locator("#app > .voice").count(), 0, "the live view is gone");
  assert.equal(await button.getAttribute("aria-disabled"), null, "Talk live is ready to be pressed again");
  assert.equal(await page.evaluate(() => window.__mic), 0, "and the microphone was never asked for");
  assert.deepEqual(errors, []);
});

test("pressing Talk live twice while the engine is still answering makes one task, not two", async (t) => {
  const { app, server, call } = await served(t);
  livePreset(app, "ws://127.0.0.1:9/realtime");
  app.live.connectWaitMs = 10 * 60_000;
  assert.equal((await call("POST", "/api/onboarding", { done: true })).status, 200);
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // The same socket that never gets through, so the one task the press made is stopped by the page.
  await page.addInitScript(() => {
    window.WebSocket = class extends EventTarget {
      constructor() {
        super();
        this.readyState = 0;
        setTimeout(() => { this.readyState = 3; this.dispatchEvent(new Event("close")); }, 5);
      }
      send() { throw new Error("This socket is not open"); }
      close() { this.readyState = 3; }
    };
  });
  let asked = 0;
  await page.route("**/api/voice/live", async (route) => { asked += 1; await settle(600); await route.continue(); });
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#prompt").waitFor({ timeout: 120000 });

  // Both presses in one turn, so the second lands while the first is still waiting on the engine.
  await page.evaluate(() => { const button = document.querySelector(".composer [data-act='voice']"); button.click(); button.click(); });
  const runId = await until(() => liveTasks(app)[0], "the press make its task");
  await until(() => app.store.run(runId).status !== "running", "the page stop the task");
  await settle(1000);
  assert.equal(asked, 1, "the engine was asked once");
  assert.equal(liveTasks(app).length, 1, "two presses made one task");
  assert.deepEqual(errors, []);
});
