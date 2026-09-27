/* Pass 18c (design/redesign/pass18/PASS18.md, DESIGN-DIRECTION PRs 10 and 11): the update card "Branch <new> is ready"
   shows on Overview and Inbox only, and only while the desktop's updater has found a newer version (flows/whatsnew.js
   waiting, window.branchDesktop.updateStatus); Settings › Models › Connections lists the connection Branch was started
   with (GET /api/state models, preset "default"), named as the status bar names it. Headless.
   Mutations: drop ${updateCard()} from places/overview.js and the first case goes red; drop ${startedWith()} from
   settings/pages/models.js and the second does. */
import test from "node:test";
import assert from "node:assert/strict";
import { openSettingsPage, settingsWindow } from "./settings-window.mjs";

const provider = { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } };

async function place(page, view) {
  await page.locator(`#side [data-act="view"][data-v="${view}"]`).first().click();
  await page.locator("#main .place h1").first().waitFor();
}

test("pass 18: Branch <new> is ready shows on Overview and Inbox only, with the updater's version", async (t) => {
  const route = (page) => page.addInitScript(() => {
    window.branchDesktop = { updateStatus: async () => ({ phase: "available", release: { available: true, latestVersion: "0.99.0-test", notes: "- A line" } }) };
  });
  const { page, errors } = await settingsWindow(t, { provider, route, name: "one-frame" });
  for (const view of ["overview", "inbox"]) {
    await place(page, view);
    const card = page.locator("#main .place .upd18c");
    await card.waitFor({ timeout: 15000 });
    assert.equal((await card.locator("b").textContent()).trim(), "Branch 0.99.0-test is ready", `${view}: the updater's version`);
    assert.equal(await card.locator('[data-act="relnotes17d"][data-v="ready"]').count(), 1, `${view}: Read the release notes`);
    assert.equal(await card.locator('[data-act="install"]').count(), 1, `${view}: Install when nothing is running`);
  }
  await place(page, "automations");
  assert.equal(await page.locator(".upd18c").count(), 0, "not on another place");
  assert.deepEqual(errors, []);
});

test("pass 18: without the desktop's updater no update card is drawn", async (t) => {
  const { page, errors } = await settingsWindow(t, { provider, name: "one-frame-web" });
  await place(page, "overview");
  await page.waitForTimeout(1000);
  assert.equal(await page.locator(".upd18c").count(), 0);
  assert.deepEqual(errors, []);
});

test("pass 18: Models › Connections lists the Default connection the status bar names", async (t) => {
  const { page, errors, call } = await settingsWindow(t, { provider, name: "one-frame-models" });
  const state = await call("/api/state");
  const preset = state.models.presets.find((p) => p.id === "default");
  assert.equal(preset.name, "Default connection");
  await openSettingsPage(page, "models");
  const row = page.locator(".set-col .acct-gs .acct-g").first();
  await row.waitFor();
  assert.equal((await row.locator(".acct-gh > b").textContent()).trim(), "Default connection");
  assert.equal(await row.locator(".pill.ok").count(), 1, "it answers first");
  assert.match(await page.locator("#statusbar, .statusbar").first().textContent(), /Default connection/);
  assert.deepEqual(errors, []);
});
