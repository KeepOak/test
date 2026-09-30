import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { _electron } from "playwright";
import { connected, desktopOptions, offScreen, onboarded, send, STARTUP_MS } from "./fixtures/desktop-options.mjs";
import { DesktopSettings } from "../dist/desktop/settings.js";

test("desktop settings reject key reuse across destinations and unavailable encryption", async () => {
  const { home } = await desktopOptions();
  const file = join(home, "model-settings.json");
  const encryption = {
    available: () => true,
    encrypt: (value) => Buffer.from(`fixture:${value}`),
    decrypt: (value) => value.toString().slice(8),
  };
  const settings = new DesktopSettings(file, encryption);
  const input = { provider: "openai", endpoint: "http://localhost:1234/v1",
    model: "fixture", apiKey: "test-only" };
  await settings.load();
  await settings.save(input);
  await settings.save({ ...input, model: "changed", apiKey: "" });
  await assert.rejects(settings.save({ ...input, endpoint: "http://localhost:4321/v1",
    apiKey: "" }), /Enter an API key/);
  await assert.rejects(settings.save({ ...input, provider: "anthropic", apiKey: "" }), /Enter an API key/);
  assert.equal(settings.environment().BRANCH_API_KEY, "test-only");
  const reloaded = new DesktopSettings(file, encryption);
  await reloaded.load();
  assert.equal(reloaded.summary().model, "changed");
  const unavailable = new DesktopSettings(file, { ...encryption, available: () => false });
  await unavailable.load();
  await assert.rejects(unavailable.save(input), /unavailable/);
  assert.throws(() => unavailable.environment(), /unavailable/);
  await reloaded.save({ provider: "demo", endpoint: "", model: "", apiKey: "" });
  assert.equal(reloaded.summary().hasKey, false);
});

async function fixtureProvider() {
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const asked = JSON.parse(body);
    requests.push({ authorization: request.headers.authorization, body: asked });
    const usage = { prompt_tokens: 12, completion_tokens: 6 };
    // The engine asks an OpenAI-compatible connection for a stream; it is answered in that stream's frames.
    if (asked.stream) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const frame of [{ choices: [{ index: 0, delta: { role: "assistant", content: "Saved connection is working." }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage }]) response.write(`data: ${JSON.stringify(frame)}\n\n`);
      response.end("data: [DONE]\n\n");
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: {
      role: "assistant", content: "Saved connection is working.",
    } }], usage }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, requests, endpoint: `http://127.0.0.1:${server.address().port}/v1` };
}

/* Redesign: the old window drew the desktop's own model-connection form (provider, web address, model, API key,
   "Save model connection") over window.branchDesktop.modelSettings / saveModelSettings. The new window has no such
   form: the prototype has Settings › Models › Connections instead, whose keys go to the engine's own locker
   (POST /api/accounts/add), not to this native store. The native store and its guarded IPC are still what the desktop
   app starts the engine from, so they are driven here from the page, exactly as a form in it would call them, and every
   check on them is kept: the key is encrypted on disk, never handed back, the IPC stays narrow and refuses any other
   window, and the saved connection is used after a restart, through the new window's composer. */
const saveConnection = (page, settings) => page.evaluate((settings) =>
  window.branchDesktop.saveModelSettings(settings).then((summary) => ({ summary }), (error) => ({ error: error.message })), settings);

/**
 * On Linux an Electron app started by Playwright can never reach a keyring: Playwright's launcher
 * always adds --password-store=basic (playwright-core/lib/server/electron/loader.js), and a bare
 * build box has no keyring anyway. The app then refuses to store a key rather than keeping it in
 * plain text, and that refusal is what is checked there. The encrypted path is proved on Windows
 * and macOS, and the storage rules by the unit test above on every system.
 */
async function refusesWithoutKeyStore(t, page, home, connection) {
  const summary = await page.evaluate(() => window.branchDesktop.modelSettings());
  if (summary.canStoreKey) return false;
  assert.equal(process.platform, "linux", "only Linux may lack device key protection");
  assert.match((await saveConnection(page, connection)).error ?? "", /unavailable/);
  const disk = await readFile(join(home, "model-settings.json"), "utf8").catch(() => "");
  assert.equal(disk.includes("fixture-device-key-82743"), false);
  t.skip("no usable keyring under Playwright on Linux: checked that the key is refused, not stored");
  return true;
}

test("native settings encrypt a key, keep IPC narrow, and connect after restart", {
  timeout: 360000,
}, async (t) => {
  const { home, options } = await desktopOptions({ hidden: true });
  delete options.env.BRANCH_PROVIDER;
  const provider = await fixtureProvider();
  const connection = { provider: "openai", endpoint: provider.endpoint, model: "fixture-model", apiKey: "fixture-device-key-82743" };
  let electron;
  try {
    electron = await _electron.launch(options);
    const firstChild = electron.process();
    const page = await electron.firstWindow({ timeout: STARTUP_MS });
    page.setDefaultTimeout(10000);
    await onboarded(page);
    await offScreen(electron, "opened");
    if (await refusesWithoutKeyStore(t, page, home, connection)) return;
    const { summary: saved, error } = await saveConnection(page, connection);
    assert.equal(error, undefined);
    assert.equal(saved.hasKey, true);
    const disk = await readFile(join(home, "model-settings.json"), "utf8");
    assert.equal(disk.includes("fixture-device-key-82743"), false);
    assert.ok(JSON.parse(disk).encryptedKey, "the key is kept, encrypted by the device");
    const summary = await page.evaluate(() => window.branchDesktop.modelSettings());
    assert.equal(summary.hasKey, true);
    assert.equal("encryptedKey" in summary, false);
    assert.equal("apiKey" in summary, false);
    assert.equal((await page.content()).includes("fixture-device-key-82743"), false);
    // The preload's whole surface (src/desktop/preload.cts), which now also carries the quick-ask pair and the live-talk microphone (#376), attach-anything's clipboard files, and hot-update's sender-checked live window calls.
    assert.deepEqual(await page.evaluate(() => Object.keys(window.branchDesktop).sort()),
      ["checkForUpdates", "clipboardFiles", "exportBackup", "exportConversation", "exportMemory", "exportMemoryLines", "installUpdate", "modelSettings", "onHelp", "onQuickAsk", "onUpdateSaid", "onUpdateStatus", "onWindowUpdated", "openExternal", "quickAskKeysChanged", "reloadLive", "restartBranch", "saveModelSettings", "showInFolder", "talkLiveMic", "updateLoop", "updateStatus", "windowLook", "windowRestored", "windowUpdateResult"]);
    // attach-anything: the page cannot read the clipboard's files by asking; only a paste the person made opens that.
    // attach-followups: asked without one, it is told there are none (no error for the page to show).
    assert.deepEqual(await page.evaluate(() => window.branchDesktop.clipboardFiles()), { sent: [], error: null });
    // dogfood-ux-3: Show in folder reveals only a file the engine lists as one the assistant kept, never a path the page makes up.
    assert.match(await page.evaluate(() => window.branchDesktop.showInFolder("C:/Windows/System32/drivers/etc/hosts").then(() => "shown", (error) => error.message)), /not made by the assistant/);
    await verifyOtherWindowDenied(electron, page.url());
    await electron.close();
    assert.equal(firstChild.exitCode, 0);
    electron = undefined;
    electron = await _electron.launch(options);
    const restarted = await electron.firstWindow({ timeout: STARTUP_MS });
    restarted.setDefaultTimeout(10000);
    await connected(restarted);
    await offScreen(electron, "restarted");
    await send(restarted, "Test the saved model connection.");
    await restarted.locator("#conversation .b").filter({ hasText: "Saved connection is working." }).waitFor({ timeout: 30000 });
    assert.equal(provider.requests.length, 1);
    assert.equal(provider.requests[0].authorization, "Bearer fixture-device-key-82743");
    assert.equal(JSON.stringify(provider.requests[0].body).includes("fixture-device-key-82743"), false);
    assert.equal((await restarted.content()).includes("fixture-device-key-82743"), false);
  } finally {
    await electron?.close();
    provider.server.closeAllConnections();
    await new Promise((resolve) => provider.server.close(resolve));
  }
});

async function verifyOtherWindowDenied(electron, url) {
  const opened = electron.waitForEvent("window", { timeout: 10000 });
  const id = await electron.evaluate(({ app, BrowserWindow }, url) => {
    const preload = `${app.getAppPath()}/dist/desktop/preload.cjs`;
    const other = new BrowserWindow({ show: false,
      webPreferences: { preload, sandbox: true, contextIsolation: true } });
    void other.loadURL(url);
    return other.id;
  }, url);
  try {
    const other = await opened;
    const result = await other.evaluate(() =>
      window.branchDesktop.modelSettings().then(() => "allowed", (error) => error.message));
    assert.match(result, /access denied/);
    const save = await other.evaluate(() =>
      window.branchDesktop.saveModelSettings({ provider: "demo", endpoint: "", model: "", apiKey: "" }).then(() => "allowed", (error) => error.message));
    assert.match(save, /access denied/);
  } finally {
    await electron.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.destroy(), id);
  }
}

test("native settings remain usable after a corrupt file or undecryptable key", {
  timeout: 360000,
}, async () => {
  const { home, options } = await desktopOptions({ hidden: true });
  delete options.env.BRANCH_PROVIDER;
  const path = join(home, "model-settings.json");
  const cases = ["{broken", ...["http://127.0.0.1:1234/v1", "broken-url"].map(
    (endpoint) => JSON.stringify({ provider: "openai", endpoint,
      model: "fixture", encryptedKey: "aW52YWxpZA==" }),
  )];
  for (const content of cases) {
    await writeFile(path, content);
    const electron = await _electron.launch(options);
    try {
      const page = await electron.firstWindow({ timeout: STARTUP_MS });
      // The window still opens and reaches Branch (the engine falls back to the offline demonstration).
      await onboarded(page);
      // Redesign: the old form showed this as its note (#model-settings-note); the new window has no such form (see above).
      assert.match((await page.evaluate(() => window.branchDesktop.modelSettings())).issue ?? "", /could not/);
      const { summary, error } = await saveConnection(page, { provider: "demo", endpoint: "", model: "", apiKey: "" });
      assert.equal(error, undefined);
      assert.equal(summary.provider, "demo");
      assert.equal(JSON.parse(await readFile(path, "utf8")).provider, "demo");
    } finally { await electron.close(); }
  }
});

