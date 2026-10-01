/* Settings › Developer and Settings › Advanced: controls held back for a security review, now live where the engine
   guards them.
   - Tool scripts and WebAssembly: the safety extras' two parts at once; drawn on as they ship, turned off and on again.
   - Tools that join over a WebSocket: the interop part client-tools, off as it ships.
   - "From now on" for a specialist: one standing instruction for one Trunk, listed with Remove in the same dialog.
   Mutation: in public/app/settings/pages/developer.js drop the two WIRES entries, or in advanced.js drop
   specialistOrderLive from markLive, and the matching case goes red. */
import test from "node:test";
import assert from "node:assert/strict";
import { settingsWindow, openSettingsPage, setLevel, isSoon } from "./settings-window.mjs";

const until = async (check, what) => {
  for (let tries = 0; tries < 100; tries++) { if (await check()) return; await new Promise((done) => setTimeout(done, 100)); }
  assert.fail(what);
};

test("Developer: tool scripts and WebAssembly, and tools that join over a WebSocket, change the engine", async (t) => {
  const { page, errors, call } = await settingsWindow(t, { name: "held-developer" });
  await openSettingsPage(page, "general");
  await setLevel(page, "technical");
  await openSettingsPage(page, "developer");
  const scripts = page.locator("#f15-tool-scripts-and-webassembly");
  await until(() => scripts.isChecked(), "drawn on, as both parts ship");
  assert.equal(await isSoon(scripts), false, "live");
  await scripts.click();
  await until(async () => { const m = (await call("/api/safety-extras")).modes; return m["tool-scripts"] === "off" && m["wasm-add-ons"] === "off"; },
    "both parts off in the engine");
  await page.locator("#f15-tool-scripts-and-webassembly").click();
  await until(async () => { const m = (await call("/api/safety-extras")).modes; return m["tool-scripts"] !== "off" && m["wasm-add-ons"] !== "off"; },
    "both on again");

  const socket = page.locator("#f15-tools-that-join-over-a-websocket");
  assert.equal(await socket.isChecked(), false, "off, as it ships");
  assert.equal(await isSoon(socket), false, "live");
  await socket.click();
  const mode = async () => (await call("/api/interop")).parts.find((p) => p.part === "client-tools").mode;
  await until(async () => (await mode()) !== "off", "a program on this computer may now lend tools");
  await page.locator("#f15-tools-that-join-over-a-websocket").click();
  await until(async () => (await mode()) === "off", "and off again");
  assert.deepEqual(errors, []);
});

test("Advanced: a standing instruction for one Trunk is kept, listed and removed", async (t) => {
  const { page, errors, call } = await settingsWindow(t, { name: "held-fno", before: (app) => { app.trunks.create({ name: "Scout" }); } });
  await openSettingsPage(page, "general");
  await setLevel(page, "advanced");
  await openSettingsPage(page, "advanced");
  const add = page.locator('[data-act="ad-fno"]');
  assert.equal(await isSoon(add), false, "Add one is live");
  await add.click();
  // Other Trunks may be listed too (the default one); this is kept for Scout alone.
  await page.locator(".dlg #fno-trunk").click();
  await page.locator('.gsel-pop [role="option"]', { hasText: "Scout" }).click();
  await page.locator(".dlg #fno-text").fill("Always cite the source page.");
  await page.locator('.dlg [data-act="ad-fno-save"]').click();
  await page.locator(".toast", { hasText: "Kept for Scout" }).waitFor();
  const kept = (await call("/api/autonomy/instructions")).instructions;
  assert.equal(kept.length, 1);
  assert.match(kept[0].scope, /^specialist:trunk:/, "kept for that Trunk alone");
  assert.equal(kept[0].text, "Always cite the source page.");
  await add.click();
  const row = page.locator(".dlg .prow", { hasText: "Always cite the source page." });
  await row.waitFor();
  assert.match(await row.innerText(), /Scout/, "listed with its Trunk");
  await row.locator('[data-act="ad-fno-rm"]').click();
  await until(async () => (await call("/api/autonomy/instructions")).instructions.length === 0, "Remove takes it away");
  assert.deepEqual(errors, []);
});

test("Advanced: the standing-instruction dialog opens nothing late over a dialog opened meanwhile", async (t) => {
  let slow = false;
  const route = (page) => page.route("**/api/autonomy/instructions", async (request) => {
    if (slow && request.request().method() === "GET") await new Promise((done) => setTimeout(done, 2500));
    await request.continue();
  });
  let scout = "";
  const { page, errors, call } = await settingsWindow(t, { name: "held-fno-late", route, before: (app) => { scout = app.trunks.create({ name: "Scout" }).id; } });
  await openSettingsPage(page, "general");
  await setLevel(page, "advanced");
  await openSettingsPage(page, "advanced");
  slow = true;
  const read = page.waitForResponse((response) => response.url().endsWith("/api/autonomy/instructions"), { timeout: 15000 });
  await page.locator('[data-act="ad-fno"]').click();
  await page.locator('[data-act="ad-orders"]').first().click();
  await page.locator(".dlg").first().waitFor();
  const shown = await page.locator(".dlg h2").first().innerText();
  await read;
  await page.waitForTimeout(500);
  assert.equal(await page.locator("#fno-text").count(), 0, "the instruction dialog did not open over the newer one");
  assert.equal(await page.locator(".dlg h2").first().innerText(), shown);

  // Nothing open, then another dialog opened and closed while the list was read: still nothing opens late.
  await page.locator('.dlg [data-act="dlg-close"]').first().click();
  await page.locator(".dlg").waitFor({ state: "detached" });
  const again = page.waitForResponse((response) => response.url().endsWith("/api/autonomy/instructions"), { timeout: 15000 });
  await page.locator('[data-act="ad-fno"]').click();
  await page.locator('[data-act="ad-orders"]').first().click();
  await page.locator(".dlg").first().waitFor();
  await page.locator('.dlg [data-act="dlg-close"]').first().click();
  await page.locator(".dlg").waitFor({ state: "detached" });
  await again;
  await page.waitForTimeout(500);
  assert.equal(await page.locator(".dlg").count(), 0, "opened and closed meanwhile: the instruction dialog is not brought up late");

  // Closed while an instruction is being removed: the dialog is not opened again afterwards.
  slow = false;
  await call("/api/autonomy/instructions", { text: "Always cite the source page.", scope: `specialist:trunk:${scout}` });
  await page.route("**/api/autonomy/instructions/remove", async (request) => { await new Promise((done) => setTimeout(done, 2500)); await request.continue(); });
  await page.locator('[data-act="ad-fno"]').click();
  await page.locator('.dlg [data-act="ad-fno-rm"]').first().waitFor();
  const removed = page.waitForResponse((response) => response.url().endsWith("/api/autonomy/instructions/remove"), { timeout: 15000 });
  await page.locator('.dlg [data-act="ad-fno-rm"]').first().click();
  await page.locator('.dlg [data-act="dlg-close"]').first().click();
  await page.locator(".dlg").waitFor({ state: "detached" });
  await removed;
  await page.waitForTimeout(800);
  assert.equal(await page.locator(".dlg").count(), 0, "closed during the removal: not reopened");

  // Saved, then closed and another dialog opened while the save is on its way: its answer never closes the newer one.
  let releaseSave;
  const saveHeld = new Promise((resolve) => { releaseSave = resolve; });
  await page.route("**/api/autonomy/instructions", async (request) => {
    if (request.request().method() === "POST") await saveHeld;
    await request.continue();
  });
  await page.locator('[data-act="ad-fno"]').click();
  await page.locator(".dlg #fno-text").waitFor();
  await page.locator(".dlg #fno-trunk").click();
  await page.locator('.gsel-pop [data-act="gsel-pick"]', { hasText: "Scout" }).click();
  await page.locator(".dlg #fno-text").fill("Say which page each fact came from.");
  const saving = page.waitForRequest((request) => request.url().endsWith("/api/autonomy/instructions") && request.method() === "POST", { timeout: 15000 });
  await page.locator('.dlg [data-act="ad-fno-save"]').click();
  await saving;
  await page.locator('.dlg [data-act="dlg-close"]').first().click();
  await page.locator('[data-act="ad-orders"]').first().click();
  await page.locator(".dlg").first().waitFor();
  const newer = await page.locator(".dlg h2").first().innerText();
  const saved = page.waitForResponse((response) => response.url().endsWith("/api/autonomy/instructions") && response.request().method() === "POST", { timeout: 15000 });
  releaseSave();
  await saved;
  await page.waitForTimeout(500);
  assert.equal(await page.locator(".dlg h2").first().innerText(), newer, "the newer dialog is still open");
  assert.equal(await page.locator(".toast", { hasText: "Kept for Scout" }).count(), 0, "and no word about the old dialog's save");
  assert.deepEqual(errors, []);
});
