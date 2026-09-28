/* wire-greyed: the version menu's "Remind me tomorrow" was greyed ("Branch doesn't put updates off"). In the desktop app it
   now puts the "Branch <new> is ready" card away for a day, for the version it offered (chat/rec.js snoozeUpdate), and says
   the update still installs as set. A newer version brings the card back at once. In a browser, where no card is ever
   drawn, the menu offers no reminder at all. Headless, with the desktop's updater stood in.
   Mutation: in public/app/chat/rec.js drop "|| snoozed(U.next.version)" and the first case goes red. */
import test from "node:test";
import assert from "node:assert/strict";
import { settingsWindow } from "./settings-window.mjs";

const provider = { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } };
const updater = (version) => (page) => page.addInitScript((version) => {
  window.branchDesktop = { updateStatus: async () => ({ phase: "available", release: { available: true, latestVersion: localStorage.getItem("test-next") ?? version, notes: "- A line" } }) };
}, version);

async function overview(page) {
  await page.locator('#side [data-act="view"][data-v="overview"]').first().click();
  await page.locator("#main .place h1").first().waitFor();
}

test("Remind me tomorrow puts the ready card away for that version, and a newer one brings it back", async (t) => {
  const { page, errors } = await settingsWindow(t, { provider, route: updater("0.99.0-test"), name: "update-remind" });
  await overview(page);
  await page.locator("#main .place .upd18c").waitFor({ timeout: 15000 });
  await page.locator('[data-act="updmenu"]').first().click();
  const remind = page.locator('.pop [data-act="upd-snooze"]');
  await remind.waitFor();
  assert.equal(await remind.getAttribute("aria-disabled"), null, "Remind me tomorrow is live");
  await remind.click();
  await page.locator(".toast", { hasText: "again tomorrow" }).waitFor();
  await page.waitForTimeout(500);
  assert.equal(await page.locator(".upd18c").count(), 0, "the card is away");
  await page.reload();
  await overview(page);
  await page.waitForTimeout(2500);
  assert.equal(await page.locator(".upd18c").count(), 0, "still away after a reload");
  await page.evaluate(() => localStorage.setItem("test-next", "0.99.1-test"));
  await page.reload();
  await overview(page);
  await page.locator("#main .place .upd18c", { hasText: "0.99.1-test" }).waitFor({ timeout: 15000 });
  assert.deepEqual(errors, []);
});

test("in a browser the version menu offers no reminder", async (t) => {
  const { page, errors } = await settingsWindow(t, { provider, name: "update-remind-web" });
  await overview(page);
  await page.locator('[data-act="updmenu"]').first().click();
  await page.locator(".pop").first().waitFor();
  await page.waitForTimeout(800);
  assert.equal(await page.locator('.pop [data-act="upd-snooze"]').count(), 0);
  assert.deepEqual(errors, []);
});
