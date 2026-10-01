/* wire-greyed (browser-build lane): the browser's own rows in Settings, each saving what the engine then does
   (tests/browser-settings-care.test.mjs proves the engine side, tests/owner-browser-window.test.mjs the full-size view).
   - Computer & browser › The browser: Ask before a site it hasn't visited, Open the browser full size when a task starts.
   - › The browser, more: Record browser tasks, Number the clickable things, and Run the browser in a sandbox (the
     sandbox's own mode, GET/POST /api/browser/container).
   - Permissions › Isolation › Downloads may come from: Anywhere, Known sites and Ask each time (tests/browser-download-hold.test.mjs).
   - Which browser stays greyed: your own Chrome is lent one task at a time, never as a standing choice. */
import test from "node:test";
import assert from "node:assert/strict";
import { openSettingsPage, settingsWindow, setLevel, isSoon } from "./settings-window.mjs";

test("the browser's switches and the sandbox's mode are live, save, and read back after a reload", async (t) => {
  const { page, errors, call } = await settingsWindow(t, { name: "wire-browser-settings" });
  await openSettingsPage(page, "computer");
  await setLevel(page, "advanced");
  const care = async () => (await call("/api/comfort")).values.browser;
  const flip = async (id, field, want) => {
    const box = page.locator(`#${id}`);
    await box.waitFor();
    assert.equal(await isSoon(box), false, `${id} is live`);
    assert.equal(await box.isChecked(), !want, `${id} shows the engine's value`);
    await box.click();
    for (let i = 0; i < 50 && (await care())[field] !== want; i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal((await care())[field], want, `${id} saved`);
  };
  await flip("b-new", "askNewSites", true);
  await flip("b-watch", "openFullSize", false);
  await flip("f15-record-browser-tasks", "recordTasks", true);
  await flip("f15-number-the-clickable-things", "numberMarks", false);
  const sandbox = page.locator('[data-act="b-sandbox"][data-v="when-needed"]');
  assert.equal(await isSoon(sandbox), false);
  await page.locator('[data-act="b-sandbox"][data-v="off"][aria-pressed="true"]').waitFor();
  await sandbox.click();
  await page.locator('[data-act="b-sandbox"][data-v="when-needed"][aria-pressed="true"]').waitFor();
  assert.equal((await call("/api/browser/container")).mode, "when-needed");
  const which = page.locator('[data-why="f15-which-browser"]').first();
  assert.equal(await isSoon(which), true, "which browser stays greyed");
  assert.match(await which.getAttribute("data-tip"), /one task at a time/);
  await page.reload();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 60000 });
  await openSettingsPage(page, "computer");
  await setLevel(page, "advanced");
  await page.locator("#b-new").waitFor();
  assert.equal(await page.locator("#b-new").isChecked(), true);
  assert.equal(await page.locator("#b-watch").isChecked(), false);
  assert.equal(await page.locator("#f15-record-browser-tasks").isChecked(), true);
  assert.equal(await page.locator("#f15-number-the-clickable-things").isChecked(), false);
  await page.locator('[data-act="b-sandbox"][data-v="when-needed"][aria-pressed="true"]').waitFor();
  assert.deepEqual(errors, []);
});

/* The page is shown only once its reads are back (settings.js waitFirst). Drawn before, every switch read off: on a
   slow runner the first test above saw Ask before a site unticked after the reload although the engine kept it on
   (Checks run 36817487706, line 44). The engine's answer is held back here so the gap is always there. */
test("Computer & browser is shown with the engine's values, even when its read is slow", async (t) => {
  const slow = (page) => page.route("**/api/comfort", async (route) => {
    if (route.request().method() === "GET") await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue();
  });
  const { page, errors, call } = await settingsWindow(t, { name: "wire-browser-slow-read", route: slow });
  await call("/api/comfort", { card: "browser", values: { askNewSites: true } });
  assert.equal((await call("/api/comfort")).values.browser.askNewSites, true);
  await openSettingsPage(page, "computer");
  await setLevel(page, "advanced");
  await page.locator("#b-new").waitFor();
  assert.equal(await page.locator("#b-new").isChecked(), true, "Ask before a site shows the engine's value when first shown");
  assert.deepEqual(errors, []);
});

/* The same page reached by a link's or a command's home (chat/goto.js) goes the page list's way, so it waits too. */
test("Computer & browser opened by its home waits for the engine's values too", async (t) => {
  const slow = (page) => page.route("**/api/comfort", async (route) => {
    if (route.request().method() === "GET") await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue();
  });
  const { page, errors, call, server } = await settingsWindow(t, { name: "wire-browser-slow-home", route: slow });
  await call("/api/comfort", { card: "browser", values: { askNewSites: true } });
  await page.goto(new URL("/#open=settings:computer", server.url).href);
  await page.locator('[data-act="setpage"][data-v="computer"][aria-current="true"]').waitFor();
  await page.locator("#b-new").waitFor();
  assert.equal(await page.locator("#b-new").isChecked(), true, "Ask before a site shows the engine's value when first shown");
  assert.deepEqual(errors, []);
});

/* A live reload puts the open page back and draws it before any read (shell/liveupdate.js restoreOpen), so the page is
   drawn without the engine's values. Until they are back the browser's switches wait and cannot be moved; they are
   never shown off. The page's read is held here until the waiting switch has been seen. */
test("Computer & browser drawn before its read shows the browser's switches waiting, then the engine's values", async (t) => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const { page, errors, call } = await settingsWindow(t, { name: "wire-browser-restore" });
  t.after(() => release());
  await call("/api/comfort", { card: "browser", values: { askNewSites: true } });
  await page.route("**/api/comfort", async (route) => {
    if (route.request().method() === "GET") await held;
    await route.continue();
  });
  await page.evaluate(() => sessionStorage.setItem("branch-live-restore",
    JSON.stringify({ view: "settings", setPage: "computer", at: Date.now() })));
  await page.reload();
  const box = page.locator("#b-new");
  await box.waitFor();
  assert.equal(await box.isDisabled(), true, "waiting for the engine, it cannot be moved");
  assert.equal(await box.getAttribute("aria-busy"), "true", "and says it is waiting, not that it is off");
  release();
  await page.locator("#b-new:not([disabled])").waitFor();
  assert.equal(await box.getAttribute("aria-busy"), null);
  assert.equal(await box.isChecked(), true, "then it shows the engine's value");
  assert.deepEqual(errors, []);
});

test("Downloads may come from: Known sites and Ask each time are saved", async (t) => {
  const { page, errors, call } = await settingsWindow(t, { name: "wire-downloads-from" });
  await openSettingsPage(page, "permissions");
  await setLevel(page, "technical");
  await page.locator('[data-act="p-dl"][data-v="anywhere"][aria-pressed="true"]').waitFor();
  const known = page.locator('[data-act="p-dl"][data-v="known"]');
  assert.equal(await isSoon(known), false);
  await known.click();
  await page.locator('[data-act="p-dl"][data-v="known"][aria-pressed="true"]').waitFor();
  assert.equal((await call("/api/comfort")).values.browser.downloadsFrom, "known");
  await page.locator('[data-act="p-dl"][data-v="ask"]').click();
  await page.locator('[data-act="p-dl"][data-v="ask"][aria-pressed="true"]').waitFor();
  assert.equal((await call("/api/comfort")).values.browser.downloadsFrom, "ask");
  assert.deepEqual(errors, []);
});
