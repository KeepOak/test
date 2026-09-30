/* Settings › Advanced's Restart and Settings › Updates' Undo (greyed-remaining, desktop-app group).
   Restart was greyed everywhere, the desktop app included, though the desktop bridge can restart Branch: it now
   restarts Branch in the desktop app (window.branchDesktop.restartBranch) and the engine in a browser tab (POST
   /api/dashboard/restart, as Branch itself › Restart the engine). Undo the last update stays greyed, and says where
   going back really is: `branch rollback` (its old reason sent people to a page that rolls back settings, not versions). */
import test from "node:test";
import assert from "node:assert/strict";
import { settingsWindow, openSettingsPage, setLevel, isSoon } from "./settings-window.mjs";

async function advancedRestart(t, route) {
  const w = await settingsWindow(t, { name: "greyed-restart", route });
  await openSettingsPage(w.page, "general");
  await setLevel(w.page, "technical");
  await openSettingsPage(w.page, "advanced");
  const button = w.page.locator('#main [data-act="restart16"]');
  await button.waitFor();
  return { ...w, button };
}

test("in a browser tab Restart restarts the engine through the engine's own route", async (t) => {
  let asked = 0;
  const { page, button, errors } = await advancedRestart(t, (page) => page.route("**/api/dashboard/restart", (route) => {
    asked++; return route.fulfill({ status: 200, contentType: "application/json", body: "{\"restarting\":true}" });
  }));
  assert.equal(await isSoon(button), false, "Restart is live");
  await button.click();
  for (let i = 0; i < 50 && asked === 0; i++) await page.waitForTimeout(100);
  assert.equal(asked, 1, "the engine was asked to restart once");
  assert.deepEqual(errors, []);
});

test("in the desktop app Restart asks the desktop bridge, never the engine route", async (t) => {
  let asked = 0;
  const { page, button, errors } = await advancedRestart(t, async (page) => {
    await page.addInitScript(() => { window.restarted = 0; window.branchDesktop = { restartBranch: async () => { window.restarted++; } }; });
    await page.route("**/api/dashboard/restart", (route) => { asked++; return route.fulfill({ status: 200, contentType: "application/json", body: "{}" }); });
  });
  await button.click();
  await page.waitForFunction(() => window.restarted === 1);
  assert.equal(asked, 0, "the engine route was not used");
  assert.deepEqual(errors, []);
});

test("Undo the last update stays greyed and points to branch rollback", async (t) => {
  const { page, errors } = await settingsWindow(t, { name: "greyed-undo" });
  await openSettingsPage(page, "general");
  await setLevel(page, "technical");
  await openSettingsPage(page, "updates");
  const undo = page.locator('#main [data-why="undo-the-last-update"]');
  await undo.waitFor({ state: "attached" }); // under the page's closed "More"
  assert.equal(await isSoon(undo), true);
  const tip = await undo.getAttribute("data-tip");
  assert.match(tip, /branch rollback/);
  assert.doesNotMatch(tip, /Branch itself › Roll back/, "not the page that rolls back settings");
  assert.deepEqual(errors, []);
});
