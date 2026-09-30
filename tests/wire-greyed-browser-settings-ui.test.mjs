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
