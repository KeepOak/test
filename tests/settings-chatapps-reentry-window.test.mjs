import test from "node:test";
import assert from "node:assert/strict";
import { settingsWindow, openSettingsPage } from "./settings-window.mjs";
import { waitInPage } from "./wait-in-page.mjs";

test("the real Settings gear refreshes Chat apps after leaving for Customize", { timeout: 60000 }, async (t) => {
  let connected = false, reads = 0;
  const { page, errors } = await settingsWindow(t, { name: "chatapps-reentry", route: async (page) => {
    await page.route("**/api/channels", (route) => {
      reads++;
      return route.fulfill({ json: { channels: connected
        ? [{ id: "telegram", kind: "telegram", health: { state: "online" } }] : [] } });
    });
    await page.route("**/api/channel-setup", (route) => route.fulfill({ json: { channels: [{ id: "telegram", name: "Telegram" }] } }));
  } });
  await openSettingsPage(page, "chatapps");
  await page.locator(".ca17d .empty").waitFor();
  await page.locator('[data-act="ptab"][data-place="customize"][data-v="channels"]').click();
  await waitInPage(page, async () => (await import("/app/core/state.js")).S.view === "customize");
  connected = true; // isolated endpoint receipt, not a real Telegram sign-in or request
  const before = reads;
  await page.getByRole("button", { name: "Settings", exact: true }).first().click();
  await page.locator(".ca17d .prow").filter({ hasText: "Telegram" }).waitFor();
  assert.ok(reads > before, "gear reentry made a fresh channel read without clicking the sidebar page");
  assert.equal(await page.locator(".ca17d .empty").count(), 0);
  await page.locator('[data-act="ptab"][data-place="customize"][data-v="channels"]').click();
  await waitInPage(page, async () => (await import("/app/core/state.js")).S.view === "customize");
  connected = false;
  await page.getByRole("button", { name: "Settings", exact: true }).first().click();
  await page.locator(".ca17d .empty").waitFor();
  assert.equal(await page.locator(".ca17d .prow").count(), 0);
  assert.deepEqual(errors, []);
});
