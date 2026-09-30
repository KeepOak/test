/* The Telegram Mini App's page on the owner's phone (public/miniapp/telegram), its own door (src/miniapp/door.ts) and
   the button that opens it (src/miniapp/phone-access.ts). The door serves the Mini App and nothing else of Branch; the
   button appears under a Telegram task's browser picture only while Tailscale really forwards an HTTPS address to that
   door; the page, opened as Telegram opens it, asks for the PIN, shows the page, takes it over, taps and types into
   it, and hands it back so the task finishes. Real headless Chromium (hidden) for both the task's browser and the
   phone; Branch's own server and the door on free ports; Telegram and Tailscale are stand-ins. */
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
import { signInitData, verifyInitData } from "../dist/miniapp/init-data.js";
import { readServe } from "../dist/miniapp/phone-access.js";
import { TelegramAdapter } from "../dist/channels/telegram.js";

assert.equal(typeof chromium.launch, "function");
const botToken = "123456:test-token-for-this-file-only";
const tailnet = "desk.tail1234.ts.net";
const serveFor = (port, mount = "/branch", target = `http://127.0.0.1:${port}`) =>
  JSON.stringify({ TCP: { 443: { HTTPS: true } }, Web: { [`${tailnet}:443`]: { Handlers: { [mount]: { Proxy: target } } } } });

async function until(check, label, tries = 750) {
  for (let i = 0; i < tries; i++) { const value = await check(); if (value) return value; await delay(20); }
  assert.fail(`Timed out: ${label}`);
}

test("the Mini App's address is known only while Tailscale forwards HTTPS on the tailnet name to its door", () => {
  assert.equal(readServe(serveFor(4100), 4100), `https://${tailnet}/branch/miniapp/telegram`);
  assert.equal(readServe(serveFor(4100, "/", "http://localhost:4100"), 4100), `https://${tailnet}/miniapp/telegram`);
  assert.equal(readServe(serveFor(4100, "/", "http://127.0.0.1:4100/branch"), 4100), `https://${tailnet}/miniapp/telegram`);
  assert.equal(readServe(serveFor(4100), 4101), null, "forwarded somewhere else");
  assert.equal(readServe(serveFor(4100, "/", "http://127.0.0.1:4100/other"), 4100), null, "to another path");
  assert.equal(readServe(serveFor(4100, "/", "http://192.168.1.5:4100"), 4100), null, "to another computer");
  assert.equal(readServe(JSON.stringify({ Web: { "example.com:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:4100" } } } } }), 4100), null, "not a tailnet name");
  assert.equal(readServe(JSON.stringify({ Foreground: { a: JSON.parse(serveFor(4100)) } }), 4100), `https://${tailnet}/branch/miniapp/telegram`);
  assert.equal(readServe("not json", 4100), null);
  assert.equal(readServe("{}", 4100), null);
});

test("Telegram gets the Mini App button as a web_app button and the others as presses, with the bot's token checking launch data", async () => {
  const bodies = [];
  const fetch = async (url, init) => {
    bodies.push({ url: String(url), markup: JSON.parse(init.body.get("reply_markup")) });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 9 } }), { headers: { "content-type": "application/json" } });
  };
  const adapter = new TelegramAdapter({ id: "tg", token: botToken, fetch, pollTimeoutSeconds: 0 });
  const file = { name: "b.jpg", mediaType: "image/jpeg", bytes: new Uint8Array([1, 2, 3]), caption: "step" };
  const buttons = [{ label: "Take over", value: "br:t:x" }, { label: "Drive it here", value: "", webApp: `https://${tailnet}/branch/miniapp/telegram?run=x` }];
  assert.equal(await adapter.sendPicture("42", file, buttons), "9");
  await adapter.editPicture("42", "9", file, buttons);
  for (const { markup } of bodies) assert.deepEqual(markup.inline_keyboard[0], [{ text: "Take over", callback_data: "br:t:x" },
    { text: "Drive it here", web_app: { url: `https://${tailnet}/branch/miniapp/telegram?run=x` } }]);
  assert.match(bodies[0].url, /sendPhoto$/); assert.match(bodies[1].url, /editMessageMedia$/);
  const launch = signInitData({ auth_date: String(Math.floor(Date.now() / 1000)), user: '{"id":42}' }, botToken);
  assert.equal(adapter.miniAppUser(launch).userId, "42");
  assert.throws(() => new TelegramAdapter({ id: "tg", token: "999:other", fetch, pollTimeoutSeconds: 0 }).miniAppUser(launch));
});

async function fixture(t, { serve = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-miniapp-page-"));
  const site = createServer((request, response) => response.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><title>Page</title>
    <input id="q" style="position:fixed;left:0;top:0;width:100vw;height:60vh;font-size:40px"
      oninput="history.replaceState(null, '', '?typed=' + encodeURIComponent(this.value))">`));
  site.listen(0, "127.0.0.1"); await once(site, "listening");
  const origin = `http://127.0.0.1:${site.address().port}`;
  let release, rounds = 0;
  const held = new Promise((done) => { release = done; });
  const provider = { name: "scripted", async complete() {
    rounds++;
    if (rounds === 1) return { content: "", toolCalls: [{ id: "a", name: "browser.navigate", arguments: JSON.stringify({ url: `${origin}/one` }) }] };
    if (rounds === 2) { await held; return { content: "", toolCalls: [{ id: "b", name: "browser.navigate", arguments: JSON.stringify({ url: `${origin}/two` }) }] }; }
    return { content: "Done with the page.", toolCalls: [] };
  } };
  t.after(() => release());
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const browser = new BranchBrowser({ allowedOrigins: [origin] });
  browser.store = app.store; app.browser = browser;
  registerBrowser(app.registry, browser);
  savePolicy(app.store, app.runtime.owner, { preset: "off" });
  app.sessionLock.setPin({ pin: "2468" });
  let doorPort = 0;
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0,
    tailscaleServe: async (file, args) => { assert.deepEqual([file, ...args], ["tailscale", "serve", "status", "--json"]); while (!doorPort) await delay(5); return serve ? serveFor(doorPort) : "{}"; } });
  doorPort = server.miniAppDoor.port;
  await server.phoneAccess.refresh();
  const phone = await chromium.launch({ headless: true });
  t.after(async () => { await phone.close(); await server.close(); await browser.close(); await app.close(); site.close(); await discardTemp(root); });
  app.channels.mergeWindowMs = 0;
  app.channels.liveTiming = { progressAfterMs: 30, editEveryMs: 10, typingEveryMs: 20, reactEveryMs: 5 };
  app.channels.setSwitches({ liveStatus: "on", commands: "on", steering: "on", splitting: "on", steps: "on" });
  const pictures = [], sent = [];
  let next = 700;
  const adapter = { id: "tg", kind: "telegram", botName: () => "Branch", maxFileBytes: 10_000_000, async start() {}, async stop() {},
    async send(chatId, text) { sent.push(text); return String(next++); }, async edit() {}, async sendTyping() {}, async sendFile() { return String(next++); },
    async sendPicture(chatId, file, buttons) { pictures.push(buttons); return String(next++); },
    async editPicture(chatId, messageId, file, buttons) { pictures.push(buttons); },
    miniAppUser: (initData) => verifyInitData(initData, botToken) };
  await app.channels.attach(adapter, { activation: "always", pairing: true, allowlist: ["42"] });
  app.channels.setPermissionSettings({ extras: true, rules: [{ channel: "tg", sender: "42", allow: ["browser.read"], note: "Me" }] });
  const task = app.channels.handle({ channel: "tg", chatId: "42", chatKind: "direct", senderId: "42", senderName: "Sam", text: "look", addressed: true, messageId: "m1" });
  const run = await until(() => app.store.runs(app.runtime.owner).find((r) => r.status === "running"), "the task");
  return { app, server, run, task, pictures, sent, release, phone, doorPort, origin };
}

test("the door serves the Mini App and nothing else of Branch", async (t) => {
  const { doorPort, release, task } = await fixture(t);
  const door = (path) => fetch(`http://127.0.0.1:${doorPort}${path}`);
  for (const path of ["/", "/api/runs", "/branch/api/runs", "/dashboard", "/locales/en.json", "/branch/miniapp/telegram/../../api/runs"])
    assert.equal((await door(path)).status, 404, path);
  const page = await door("/branch/miniapp/telegram");
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy"), /frame-ancestors https:\/\/web\.telegram\.org/);
  assert.match(page.headers.get("content-security-policy"), /script-src 'self'/);
  const words = await (await door("/branch/miniapp/telegram/locales/de.json")).json();
  assert.ok(Object.keys(words).length > 5 && Object.keys(words).every((key) => key.startsWith("miniapp.")), "only the Mini App's own words");
  assert.equal((await door("/api/miniapp/telegram/browser")).status, 401, "its API needs a live session");
  release();
  assert.equal(await task, "replied", "the task ends before the engine closes");
});

test("from the button in Telegram to driving the page on the phone and handing it back", async (t) => {
  const { app, run, task, pictures, sent, release, phone, doorPort } = await fixture(t);
  const buttons = await until(() => pictures.find((set) => set.some((b) => b.webApp)), "the Mini App button under the picture");
  const button = buttons.find((b) => b.webApp);
  assert.equal(button.webApp, `https://${tailnet}/branch/miniapp/telegram?run=${run.id}`);
  // Telegram opens that address with its signed launch data after #, as it does on a phone (the door stands in for Tailscale).
  const launch = signInitData({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: 42, first_name: "Sam", language_code: "en" }) }, botToken);
  const page = await (await phone.newContext({ viewport: { width: 390, height: 780 } })).newPage();
  await page.goto(`http://127.0.0.1:${doorPort}/branch/miniapp/telegram?run=${run.id}#tgWebAppData=${encodeURIComponent(launch)}&tgWebAppVersion=7.0`);
  await page.fill("#pin-box", "1111");
  await page.click("#pin-open");
  await page.waitForSelector("#note:not([hidden])");
  assert.match(await page.textContent("#note"), /PIN/i, "a wrong PIN is refused");
  await page.fill("#pin-box", "2468");
  await page.click("#pin-open");
  await page.waitForFunction(() => document.getElementById("frame").src.startsWith("data:image/jpeg"));
  assert.equal(await page.textContent("#holder"), "The task is working");
  await page.click("#take");
  await page.waitForFunction(() => document.getElementById("holder").dataset.holder === "you");
  release(); // the task's next step, while the phone holds the browser
  await page.waitForFunction(() => document.getElementById("frame").src.startsWith("data:image/jpeg") && !document.getElementById("drive").hidden);
  const box = await page.locator("#frame").boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 4); // on the page's big text box
  await page.fill("#type-box", "hello");
  await page.click("#type button");
  await page.waitForFunction(() => /typed=hello/.test(document.getElementById("address").textContent), null, { timeout: 15_000 });
  assert.equal(app.store.run(run.id).status, "running", "the task waits while the phone drives");
  await page.click("#give");
  assert.equal(await task, "replied");
  assert.ok(sent.some((text) => /Done with the page/.test(text)), "handed back, the task finished");
  const hands = app.store.events(run.id).filter((e) => e.kind === "browser.hands").map((e) => e.data.pressed ?? e.data.input ?? (e.data.opened ? "opened" : "?"));
  assert.deepEqual(hands.slice(0, 2), ["opened", "take over"]);
  assert.ok(hands.filter((h) => h === "browser.owner_input").length >= 2, "the tap and the typing are on the record");
  assert.equal(hands.at(-1), "hand back");
});

test("no Mini App button while Tailscale doesn't forward HTTPS to the door", async (t) => {
  const { pictures, release, task } = await fixture(t, { serve: false });
  await until(() => pictures.length >= 1, "a picture");
  assert.ok(pictures.every((set) => set.every((b) => !b.webApp)), "Take over only");
  release();
  await task;
});
