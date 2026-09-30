/* Headless window + isolated engine; no owner data, real chats or real commands. */
const { chromium } = require("../../../node_modules/playwright");
const { mkdtemp, rm } = require("node:fs/promises");
const { join } = require("node:path");
const assert = require("node:assert/strict");

(async () => {
  const { createBranch } = await import("../../../dist/index.js");
  const { startServer } = await import("../../../dist/server.js");
  const root = await mkdtemp("C:/Users/bishi/AppData/Local/Temp/Codex-session-files/chat-command-ui-");
  let app, server, browser;
  try {
    app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
      provider: { name: "scripted", complete: async () => ({ content: "Done.", toolCalls: [] }) } });
    await app.channels.attach({ id: "chat", kind: "telegram", botName: () => "Test", start: async () => {}, stop: async () => {}, send: async () => "1",
      sendButtons: async () => "2" }, { pairing: true, activation: "mention" });
    app.store.save("settings", app.runtime.owner, "channel-pair:chat:owner", { status: "approved", code: "123456",
      name: "Paired account", requestedAt: new Date().toISOString(), approvedAt: new Date().toISOString() });
    app.sessionLock.setPin({ pin: "1234" });
    server = await startServer(app, { dataDir: join(root, "data"), port: 3468 });
    const call = async (path, body) => {
      const response = await fetch(`${server.url}/api/${path}`, { method: body === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${server.token}`, origin: server.url, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      assert.equal(response.ok, true, path);
      return response.json();
    };
    await call("onboarding", { done: true });
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(server.url);
    await page.getByLabel("Session token", { exact: true }).fill(server.token);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.locator("#prompt").waitFor({ timeout: 60000 });
    await page.keyboard.press("Control+Comma");
    await page.locator('[data-act="setpage"][data-v="chatapps"]').click();
    await page.locator('[data-act="chat-command-edit"]').click();
    console.log("opened command settings");
    assert.equal(await page.locator("#chat-command-on").isChecked(), false);
    await page.locator("#chat-command-on").check();
    await page.locator("[data-chat-command-account]").check();
    await page.locator("#chat-command-pin").fill("9999");
    const failed = page.waitForResponse((response) => response.url().endsWith("/api/channels/owner-commands"));
    await page.locator('[data-act="chat-command-save"]').click();
    assert.equal((await failed).status(), 403);
    console.log("PIN rejection verified");
    assert.equal((await call("channels")).ownerCommands.on, false);
    assert.equal(await page.locator("#chat-command-on").isChecked(), true, "rejected input retained");
    await page.locator("#chat-command-pin").fill("1234");
    const saved = page.waitForResponse((response) => response.url().endsWith("/api/channels/owner-commands"));
    await page.locator('[data-act="chat-command-save"]').click();
    assert.equal((await saved).status(), 200);
    console.log("settings save verified");
    assert.deepEqual((await call("channels")).ownerCommands, { on: true, accounts: [{ channel: "chat", sender: "owner" }] });
    await page.locator('[data-act="chat-command-edit"]').click();
    assert.equal(await page.locator("#chat-command-on").isChecked(), true);
    await page.locator("#chat-command-on").uncheck();
    await page.locator("#chat-command-pin").fill("1234");
    const off = page.waitForResponse((response) => response.url().endsWith("/api/channels/owner-commands"));
    await page.locator('[data-act="chat-command-save"]').click();
    assert.equal((await off).status(), 200);
    assert.equal((await call("channels")).ownerCommands.on, false);
    assert.deepEqual(errors, []);
    console.log("PASS owner command card: off default, paired account, PIN rejection retains input, save and read-back, off and read-back, zero page errors");
  } finally {
    await browser?.close(); await server?.close(); await app?.close(); await rm(root, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
