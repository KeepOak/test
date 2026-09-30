/* The Telegram Mini App's way into one task's browser (src/miniapp/api.ts): Telegram's signed launch data and the App
   lock PIN open a session held to that task's browser and nothing else. Launch data that Telegram didn't sign, that is
   too old, or that names somebody other than the person who started the task opens nothing; a wrong PIN opens
   nothing; the session's token is not a Branch key; Lockdown ends every session at once. With a session the phone
   sees the page, takes it over (the task really waits), drives it, and hands it back (the task carries on). Real
   headless Chromium against a local page, Branch's own server on port 0; Telegram is a stand-in with a test token. */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright"; // a real headless Chromium opens these pages (CI installs it for this file)
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, savePolicy } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { BranchBrowser, registerBrowser } from "../dist/integrations/browser.js";
import { setLockdown } from "../dist/lockdown.js";
import { signInitData, verifyInitData } from "../dist/miniapp/init-data.js";

assert.equal(typeof chromium.launch, "function");
const botToken = "123456:test-token-for-this-file-only";
const now = () => String(Math.floor(Date.now() / 1000));
const launch = (userId, extra = {}, token = botToken) => signInitData({ auth_date: now(), user: JSON.stringify({ id: userId, first_name: "Sam" }), ...extra }, token);

async function until(check, label, tries = 600) {
  for (let i = 0; i < tries; i++) { const value = await check(); if (value) return value; await delay(20); }
  assert.fail(`Timed out: ${label}`);
}

test("launch data is Telegram's only when this bot's token signed exactly these fields, recently", () => {
  const good = launch(42);
  assert.equal(verifyInitData(good, botToken).userId, "42");
  assert.throws(() => verifyInitData(launch(42, {}, "999:another-bot"), botToken), /didn't come from your Telegram/, "another bot's");
  const tampered = new URLSearchParams(good); tampered.set("user", JSON.stringify({ id: 7, first_name: "Sam" }));
  assert.throws(() => verifyInitData(tampered.toString(), botToken), /didn't come from your Telegram/, "a field changed after signing");
  assert.throws(() => verifyInitData(`${good}&user=${encodeURIComponent('{"id":7}')}`, botToken), /didn't come from your Telegram/, "a field twice");
  const old = signInitData({ auth_date: String(Math.floor(Date.now() / 1000) - 3600), user: '{"id":42}' }, botToken);
  assert.throws(() => verifyInitData(old, botToken), /too long ago/, "an hour old");
  assert.throws(() => verifyInitData(signInitData({ auth_date: now() }, botToken), botToken), /didn't come from your Telegram/, "no user");
  assert.throws(() => verifyInitData("", botToken), /didn't come from your Telegram/);
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-telegram-miniapp-"));
  const site = createServer((request, response) => response.writeHead(200, { "content-type": "text/html" })
    .end(`<!doctype html><title>Page ${request.url}</title><h1>${request.url}</h1>`));
  site.listen(0, "127.0.0.1"); await once(site, "listening");
  const origin = `http://127.0.0.1:${site.address().port}`;
  let release, rounds = 0;
  const held = new Promise((done) => { release = done; });
  const provider = { name: "scripted", async complete() {
    rounds++;
    if (rounds === 1) return { content: "", toolCalls: [{ id: "a", name: "browser.navigate", arguments: JSON.stringify({ url: `${origin}/one` }) }] };
    if (rounds === 2) { await held; return { content: "", toolCalls: [{ id: "b", name: "browser.navigate", arguments: JSON.stringify({ url: `${origin}/two` }) }] }; }
    return { content: "Both pages seen.", toolCalls: [] };
  } };
  t.after(() => release()); // first, so a failed test never leaves its task waiting while the engine closes
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const browser = new BranchBrowser({ allowedOrigins: [origin] });
  browser.store = app.store; app.browser = browser;
  registerBrowser(app.registry, browser);
  savePolicy(app.store, app.runtime.owner, { preset: "off" });
  app.sessionLock.setPin({ pin: "2468" });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await browser.close(); await app.close(); site.close(); await discardTemp(root); });
  app.channels.mergeWindowMs = 0;
  const sent = [];
  const adapter = { id: "tg", kind: "telegram", botName: () => "Branch", async start() {}, async stop() {},
    async send(chatId, text) { sent.push(text); return String(sent.length); }, async edit() {}, async sendTyping() {},
    miniAppUser: (initData) => verifyInitData(initData, botToken) };
  await app.channels.attach(adapter, { activation: "always", pairing: true, allowlist: ["42"] });
  app.channels.setPermissionSettings({ extras: true, rules: [{ channel: "tg", sender: "42", allow: ["browser.read"], note: "Me" }] });
  const task = app.channels.handle({ channel: "tg", chatId: "42", chatKind: "direct", senderId: "42", senderName: "Sam", text: "look at both", addressed: true, messageId: "m1" });
  const run = await until(() => app.store.runs(app.runtime.owner).find((r) => r.status === "running"), "the task");
  await until(async () => (await browser.watch(app.runtime.owner, run.id))?.url?.endsWith("/one"), "the task's first page");
  const base = String(server.url).replace(/\/$/, "");
  const call = async (path, { token, body, method = body ? "POST" : "GET" } = {}) => {
    const response = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  return { app, run, task, sent, release, call, origin };
}

test("only Telegram's signed launch data for the task's own person, with the PIN, opens a session held to that browser", async (t) => {
  const { app, run, task, sent, release, call, origin } = await fixture(t);
  const open = (initData, pin = "2468") => call("/api/miniapp/telegram/session", { body: { initData, runId: run.id, pin } });
  assert.equal((await open(launch(42, {}, "999:another-bot"))).status, 401, "not signed by this bot");
  assert.equal((await open(launch(43))).status, 403, "somebody who didn't start the task");
  assert.equal((await open(launch(42, { chat_type: "group" }))).status, 403, "from a group");
  assert.equal((await open(launch(42), "1111")).status, 403, "a wrong PIN");
  const opened = await open(launch(42));
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  const token = opened.body.token;
  assert.equal(opened.body.holder, "task");
  assert.equal((await call("/api/runs", { token })).status, 401, "the session is not a Branch key");
  assert.equal((await call("/api/miniapp/telegram/browser", { token: "nope" })).status, 401);

  const watching = await call("/api/miniapp/telegram/browser", { token });
  assert.equal(watching.body.status, "watching");
  assert.ok(watching.body.page.frame.length > 1000, "a real picture of the page");
  assert.match(watching.body.page.url, /\/one$/);

  const taken = await call("/api/miniapp/telegram/control", { token, body: { operation: "take" } });
  assert.equal(taken.body.holder, "you", JSON.stringify(taken.body));
  release(); // the task's next step, while the phone holds the browser
  await delay(1500);
  assert.equal(app.store.run(run.id).status, "running", "the task waits for Hand back");

  const view = await call("/api/miniapp/telegram/browser", { token });
  assert.equal(view.body.status, "ready", JSON.stringify(view.body).slice(0, 300));
  const { control, frameId, tabId } = view.body;
  const drove = await call("/api/miniapp/telegram/action", { token, body: { id: control.id, epoch: control.epoch, frameId, tabId,
    sequence: control.sequence + 1, tool: "browser.navigate", arguments: { url: `${origin}/three` } } });
  assert.equal(drove.status, 200, JSON.stringify(drove.body));
  await until(async () => /\/three$/.test((await call("/api/miniapp/telegram/browser", { token })).body.page?.url ?? ""), "the phone drove the page");

  const given = await call("/api/miniapp/telegram/control", { token, body: { operation: "give" } });
  assert.equal(given.body.holder, "task");
  assert.equal(await task, "replied");
  assert.ok(sent.some((text) => /Both pages seen/.test(text)), "the task carried on and finished");
  assert.equal((await call("/api/miniapp/telegram/browser", { token })).status, 409, "a finished task's session ends");
  const hands = app.store.events(run.id).filter((e) => e.kind === "browser.hands").map((e) => e.data.pressed ?? e.data.input ?? (e.data.opened ? "opened" : "?"));
  assert.deepEqual(hands, ["opened", "take over", "browser.navigate", "hand back"], "every change of hands and input is on the task's record");
});

test("Lockdown ends the phone's session at once, and nothing opens while it is on", async (t) => {
  const { app, run, call, release, task } = await fixture(t);
  const opened = await call("/api/miniapp/telegram/session", { body: { initData: launch(42), runId: run.id, pin: "2468" } });
  assert.equal(opened.status, 200);
  setLockdown(app.store, app.runtime.owner, { on: true });
  assert.equal((await call("/api/miniapp/telegram/browser", { token: opened.body.token })).status, 401, "ended the moment Lockdown came on");
  assert.equal((await call("/api/miniapp/telegram/session", { body: { initData: launch(42), runId: run.id, pin: "2468" } })).status, 403);
  setLockdown(app.store, app.runtime.owner, { on: false });
  release();
  await task; // the task ends before the engine closes
});
