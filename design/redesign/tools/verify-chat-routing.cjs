/* Headless window and stand-in chat engine. Never reads the owner's app or desktop. */
const { chromium } = require("../../../node_modules/playwright");
const { mkdtemp, rm } = require("node:fs/promises");
const { join } = require("node:path");
const assert = require("node:assert/strict");
(async () => {
  const { createBranch } = await import("../../../dist/index.js");
  const { startServer } = await import("../../../dist/server.js");
  const root = await mkdtemp("C:/Users/bishi/AppData/Local/Temp/Codex-session-files/chat-route-ui-");
  let app, server, browser;
  try {
    app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
      provider: { name: "stand-in", complete: async () => ({ content: "Done.", toolCalls: [] }) } });
    app.trunks.setMode("trunks", { mode: "on" });
    app.trunks.create({ name: "Ada" }); const bo = app.trunks.create({ name: "Bo" }); await app.trunks.introduced();
    await app.channels.attach({ id: "chat", kind: "telegram", botName: () => "Test", async start() {}, async stop() {}, async send() { return "1"; } },
      { pairing: true, activation: "always", allowlist: ["owner"] });
    server = await startServer(app, { dataDir: join(root, "data"), port: 3468 });
    const call = async (path, body) => {
      const response = await fetch(`${server.url}/api/${path}`, { method: body === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${server.token}`, origin: server.url, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      assert.ok(response.ok, path); return response.json();
    };
    await call("onboarding", { done: true });
    app.channels.mergeWindowMs = 0;
    await app.channels.handle({ channel: "chat", chatId: "dm", chatKind: "direct", senderId: "owner", senderName: "Owner",
      text: "hello", addressed: true, messageId: "in1" });
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    await page.goto(server.url); await page.getByLabel("Session token", { exact: true }).fill(server.token);
    await page.getByRole("button", { name: "Connect", exact: true }).click(); await page.locator("#prompt").waitFor({ timeout: 60000 });
    await page.keyboard.press("Control+Comma"); await page.locator('[data-act="setpage"][data-v="chatapps"]').click();
    await page.locator('[data-act="chat-route-edit"]').click();
    assert.equal(await page.locator("#chat-route-target option").count(), 2);
    await page.locator("#chat-route-trunk").selectOption(bo.id);
    let response = page.waitForResponse(r => r.url().endsWith("/api/channels/routes") && r.request().method() === "POST");
    await page.locator('[data-act="chat-route-save"]').click(); assert.equal((await response).status(), 400);
    assert.equal(await page.locator("#chat-route-trunk").inputValue(), bo.id, "rejected choice retained");
    app.trunks.edit(bo.id, { reach: { channels: ["chat"], commands: false } });
    response = page.waitForResponse(r => r.url().endsWith("/api/channels/routes") && r.request().method() === "POST");
    await page.locator('[data-act="chat-route-save"]').click(); assert.equal((await response).status(), 200);
    assert.equal((await call("channels/routes")).routes[0].trunkId, bo.id);
    await page.locator('[data-act="chat-route-edit"]').click();
    assert.equal(await page.locator("#chat-route-trunk").inputValue(), bo.id);
    await page.locator("#chat-route-target").selectOption(JSON.stringify({ channel: "chat", scope: "dm" }));
    await page.locator("#chat-route-trunk").selectOption("default");
    response = page.waitForResponse(r => r.url().endsWith("/api/channels/routes") && r.request().method() === "POST");
    await page.locator('[data-act="chat-route-save"]').click(); assert.equal((await response).status(), 200);
    assert.equal((await call("channels/routes")).routes.find(r => r.scope === "dm").trunkId, "default");
    assert.deepEqual(errors, []);
    console.log("PASS chat routing: app/chat choices, reach refusal retains choice, save/read-back, default override, zero page errors");
  } finally {
    await browser?.close(); await server?.close(); await app?.close(); await rm(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
