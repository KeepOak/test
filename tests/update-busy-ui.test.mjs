/**
 * Pressing Update while tasks are working never closes Branch under them without the owner's say:
 * the Updates card asks to wait for them (the update then starts by itself once they have finished)
 * or to update now (they are offered back after, see the update drain). With nothing working, Update
 * goes straight ahead as before.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { openSettingFor } from "./places.mjs";

async function openApp(t) {
  const { chromium } = await import("playwright");
  const root = await mkdtemp(join(tmpdir(), "branch-update-busy-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // The desktop bridge, with a newer version ready; installing only writes down that it was asked.
  await page.addInitScript(() => {
    globalThis.__installs = 0;
    window.branchDesktop = {
      updateStatus: async () => ({ phase: "available", message: "Version 9.9.9 is ready to install.", progress: null }),
      checkForUpdates: async () => ({ phase: "available", message: "Version 9.9.9 is ready to install.", progress: null }),
      installUpdate: async () => { globalThis.__installs += 1; return { phase: "available", message: "", progress: null }; },
      modelSettings: async () => ({}), openExternal: async () => true,
    };
  });
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await openSettingFor(page, "#updates-card");
  await page.locator("#updates-install").waitFor({ state: "visible" });
  return { app, page, errors };
}
const installs = (page) => page.evaluate(() => globalThis.__installs);

// Redesign: Coming soon (install, "Install when nothing is running" in the status bar's update menu), checked at fc541c24.
test.skip("with nothing working, Update goes straight ahead", async (t) => {
  const { page, errors } = await openApp(t);
  await page.locator("#updates-install").click();
  await page.waitForFunction(() => globalThis.__installs === 1);
  assert.equal(await page.locator("#updates-busy").isHidden(), true);
  assert.deepEqual(errors, []);
});

// Redesign: Coming soon (install, "Install when nothing is running" in the status bar's update menu), checked at fc541c24.
test.skip("a working task is asked about first: update now goes ahead, and nothing goes ahead before it", async (t) => {
  const { app, page, errors } = await openApp(t);
  app.store.createRun(app.runtime.owner, "a long job");
  await page.locator("#updates-install").click();
  await page.locator("#updates-busy").waitFor({ state: "visible" });
  assert.match(await page.locator("#updates-busy-text").textContent(), /A task is working\. Wait for it, or update now/);
  assert.equal(await installs(page), 0, "nothing closes under a working task on its own");
  await page.locator("#updates-busy-cancel").click();
  assert.equal(await page.locator("#updates-busy").isHidden(), true, "Not now puts the question away");
  assert.equal(await installs(page), 0);
  await page.locator("#updates-install").click();
  await page.locator("#updates-now").click();
  await page.waitForFunction(() => globalThis.__installs === 1);
  assert.deepEqual(errors, []);
});

// Redesign: Coming soon (install, "Install when nothing is running" in the status bar's update menu), checked at fc541c24.
test.skip("waiting starts the update by itself once the tasks have finished", async (t) => {
  const { app, page, errors } = await openApp(t);
  const one = app.store.createRun(app.runtime.owner, "first job");
  const two = app.store.createRun(app.runtime.owner, "second job");
  await page.locator("#updates-install").click();
  await page.locator("#updates-busy").waitFor({ state: "visible" });
  assert.match(await page.locator("#updates-busy-text").textContent(), /^2 tasks are working/);
  await page.locator("#updates-wait").click();
  await page.waitForFunction(() => /Waiting for 2 tasks to finish/.test(document.getElementById("updates-busy-text").textContent));
  app.store.finish(one.id, "completed", "done");
  await page.waitForFunction(() => /Waiting for a task to finish/.test(document.getElementById("updates-busy-text").textContent), null, { timeout: 10000 });
  assert.equal(await installs(page), 0, "still one working");
  app.store.finish(two.id, "completed", "done");
  await page.waitForFunction(() => globalThis.__installs === 1, null, { timeout: 10000 });
  assert.equal(await page.locator("#updates-busy").isHidden(), true);
  assert.deepEqual(errors, []);
});

// Redesign: Coming soon (install, in the status bar's update menu, and sw:lang), checked at fc541c24.
test.skip("the question follows a language change with its number intact", async (t) => {
  const { app, page } = await openApp(t);
  app.store.createRun(app.runtime.owner, "first job");
  app.store.createRun(app.runtime.owner, "second job");
  await page.locator("#updates-install").click();
  await page.locator("#updates-busy").waitFor({ state: "visible" });
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("fr"));
  t.after(() => page.evaluate(async () => (await import("/i18n.js")).setLanguage("en")).catch(() => undefined));
  assert.match(await page.locator("#updates-busy-text").textContent(), /^2 tâches sont en cours\./);
  assert.equal(await page.locator("#updates-wait").textContent(), "Les attendre");
});

// Redesign: Coming soon (install, "Install when nothing is running" in the status bar's update menu), checked at fc541c24.
test.skip("when the count cannot be had, nothing installs until the owner says so", async (t) => {
  const { page, errors } = await openApp(t);
  await page.route("**/api/comfort/update-plan", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "busy" }) }));
  await page.locator("#updates-install").click();
  await page.locator("#updates-busy").waitFor({ state: "visible" });
  assert.match(await page.locator("#updates-busy-text").textContent(), /could not tell whether any task is working/);
  await page.locator("#updates-wait").click();
  await page.waitForFunction(() => /Still cannot tell/.test(document.getElementById("updates-busy-text").textContent));
  await page.waitForTimeout(3500);
  assert.equal(await installs(page), 0, "an unknown count is never taken as none");
  await page.locator("#updates-now").click();
  await page.waitForFunction(() => globalThis.__installs === 1);
  assert.deepEqual(errors, []);
});

// Redesign: Coming soon (install, "Install when nothing is running" in the status bar's update menu), checked at fc541c24.
test.skip("an answer that is not a real count is never taken as none, however it reads as a number", async (t) => {
  const { page, errors } = await openApp(t);
  let answer = null;
  await page.route("**/api/comfort/update-plan", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ busyTasks: answer }) }));
  for (const odd of [null, false, "", "0", 0.5, -1, "3"]) {
    answer = odd;
    await page.locator("#updates-install").click();
    await page.locator("#updates-busy").waitFor({ state: "visible" });
    assert.match(await page.locator("#updates-busy-text").textContent(), /could not tell whether any task is working/, JSON.stringify(odd));
    assert.equal(await installs(page), 0, `${JSON.stringify(odd)} did not install`);
    await page.locator("#updates-busy-cancel").click();
  }
  assert.deepEqual(errors, []);
});

// Redesign: Coming soon (install, "Install when nothing is running" in the status bar's update menu), checked at fc541c24.
test.skip("slow answers while waiting, and a double press, still install exactly once", async (t) => {
  const { app, page } = await openApp(t);
  const one = app.store.createRun(app.runtime.owner, "a job");
  // Every count takes longer than the 3 s between looks: with looks that overlapped, two "none" answers installed twice.
  await page.route("**/api/comfort/update-plan", async (route) => { await new Promise((r) => setTimeout(r, 4000)); await route.continue(); });
  await page.locator("#updates-install").click();
  await page.locator("#updates-busy").waitFor({ state: "visible", timeout: 10000 });
  await page.locator("#updates-wait").click();
  await page.waitForTimeout(1000);
  app.store.finish(one.id, "completed", "done");
  await page.waitForFunction(() => globalThis.__installs >= 1, null, { timeout: 20000 });
  await page.waitForTimeout(9000);
  assert.equal(await installs(page), 1, "one install, however the answers overlapped");

  // Two presses of Update before the first count has come back.
  await page.evaluate(() => { globalThis.__installs = 0; });
  await page.locator("#updates-install").click();
  await page.locator("#updates-install").click();
  await page.waitForFunction(() => globalThis.__installs >= 1, null, { timeout: 20000 });
  await page.waitForTimeout(5000);
  assert.equal(await installs(page), 1, "a double press starts one update");
});

// Dogfood F4: the Updates card said "5 tasks are working" for five conversations waiting hours for an answer. A
// question left longer than an hour no longer holds an update, and a fresh one is called a question, not work.
const askedAgo = (app, run, ms) =>
  app.store.sqlite.prepare("UPDATE tasks SET updated_at=? WHERE id=?").run(new Date(Date.now() - ms).toISOString(), run.id);
// Redesign: Coming soon (install, "Install when nothing is running" in the status bar's update menu), checked at fc541c24.
test.skip("F4 a question left for hours does not hold an update, and a fresh one is called a question", async (t) => {
  const { app, page, errors } = await openApp(t);
  const old = app.store.createRun(app.runtime.owner, "change a setting");
  app.store.finish(old.id, "needs_input", "May I change it?");
  askedAgo(app, old, 3 * 60 * 60 * 1000);
  await page.locator("#updates-install").click();
  await page.waitForFunction(() => globalThis.__installs === 1);
  assert.equal(await page.locator("#updates-busy").isHidden(), true, "an old question does not hold the update");

  const fresh = app.store.createRun(app.runtime.owner, "send the email");
  app.store.finish(fresh.id, "needs_input", "May I send it?");
  await page.locator("#updates-install").click();
  await page.locator("#updates-busy").waitFor({ state: "visible" });
  assert.match(await page.locator("#updates-busy-text").textContent(), /^A task is waiting for your answer\. Answer it first/);
  await page.locator("#updates-busy-cancel").click();

  app.store.createRun(app.runtime.owner, "a long job");
  await page.locator("#updates-install").click();
  await page.locator("#updates-busy").waitFor({ state: "visible" });
  assert.match(await page.locator("#updates-busy-text").textContent(), /^1 working and 1 waiting for your answer/);
  assert.equal(await installs(page), 1, "nothing more went ahead on its own");
  assert.deepEqual(errors, []);
});
