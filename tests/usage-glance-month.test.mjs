/* The usage list's foot says what this month has cost so far, from the same ledger the Usage screen
   adds up: an estimate from each model's price, and a plain "nothing priced yet" rather than $0 when
   no task had a price. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-glance-month-"));
  // No provider: the offline demonstration provider, whose model id is "demo".
  const app = await createBranch({ dataDir: join(root, "data"), workspace: join(root, "ws") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const call = async (path, body) => {
    const response = await fetch(new URL(path, server.url), { method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return response.json();
  };
  return { app, server, call };
}

test("the glance carries this month's estimated spend, and counts unpriced tasks apart", async (t) => {
  const f = await fixture(t);
  assert.deepEqual((await f.call("/api/usage/glance")).month, { cost: 0, pricedRuns: 0, unpricedRuns: 0 });
  await f.app.runtime.run({ prompt: "No price on file yet" });
  const unpriced = (await f.call("/api/usage/glance")).month;
  assert.equal(unpriced.pricedRuns, 0);
  assert.equal(unpriced.unpricedRuns, 1, "a task with no price is counted, never as $0");
  await f.call("/api/pricing", { overrides: { demo: { input: 1000, output: 1000 } } });
  const priced = (await f.call("/api/usage/glance")).month;
  assert.equal(priced.pricedRuns, 1, "the owner's own price applies to the month");
  assert.ok(priced.cost > 0);
});

/* The new window: the status bar's usage popover (the prototype's "What each connection has left") ends with this month's
   spend beside Open Usage, from the same ledger; with nothing priced it says no sum at all, never $0. */
test("the usage popover's foot says This month: $… beside Open Usage, and never $0 when nothing is priced", async (t) => {
  const { chromium } = await import("playwright");
  const f = await fixture(t);
  await f.call("/api/onboarding", { done: true });
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(f.server.url);
  await page.getByLabel("Session token", { exact: true }).fill(f.server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  const foot = page.locator(".lim-foot");
  const openList = async () => {
    await page.locator('[data-act="usagepop"]').click();
    await foot.waitFor({ state: "visible" });
  };
  await openList();
  assert.doesNotMatch(await foot.innerText(), /\$0\.00|This month/, "nothing priced: no sum, never $0");
  await page.keyboard.press("Escape");
  await foot.waitFor({ state: "detached" });
  await f.app.runtime.run({ prompt: "No price" });
  await f.call("/api/pricing", { overrides: { demo: { input: 1000, output: 1000 } } });
  await openList();
  const month = foot.locator("span", { hasText: "This month:" });
  assert.match(await month.innerText(), /^This month: \$\d+\.\d\d$/);
  const [sum, button] = await Promise.all([month.boundingBox(), foot.getByRole("button", { name: "Open Usage", exact: true }).boundingBox()]);
  assert.ok(sum.x < button.x && Math.abs((sum.y + sum.height / 2) - (button.y + button.height / 2)) < 4, "one line: the sum left, Open Usage right");
  assert.deepEqual(errors, []);
});

// Redesign: replaced by the new window (the prototype's foot says "This month: $…" and nothing when nothing is priced,
// re-pointed above; /usage-ring and branchUsageGlance are gone), and French waits on sw:lang, Coming soon, checked at fc541c24.
test.skip("the list's foot reads This month: about $… beside Open Usage, in English and French", async (t) => {
  const { chromium } = await import("playwright");
  const f = await fixture(t);
  await f.call("/api/onboarding", { done: true });
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(f.server.url);
  await page.getByLabel("Session token", { exact: true }).fill(f.server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  const foot = page.locator("#usage-pop .glance-foot");
  const openList = async () => {
    await page.evaluate(() => globalThis.branchUsageGlance.refresh());
    await page.evaluate(() => { document.getElementById("usage-ring").hidden = false; document.getElementById("status-bar").hidden = false; });
    if (await page.locator("#usage-pop").isHidden()) await page.locator("#usage-ring").click();
    await foot.waitFor({ state: "visible" });
  };
  await openList();
  assert.equal(await foot.locator(".glance-month").innerText(), "This month: nothing priced yet");
  await page.keyboard.press("Escape");
  await f.app.runtime.run({ prompt: "No price" });
  await f.call("/api/pricing", { overrides: { demo: { input: 1000, output: 1000 } } });
  await openList();
  const line = await foot.locator(".glance-month").innerText();
  assert.match(line, /^This month: about \$\d+\.\d\d$/);
  assert.deepEqual(await foot.locator(":scope > *").evaluateAll((nodes) => nodes.map((node) => node.className || node.tagName)), ["glance-month", "BUTTON"]);
  const [month, button] = await Promise.all([foot.locator(".glance-month").boundingBox(), foot.locator("button").boundingBox()]);
  assert.ok(month.x < button.x && Math.abs((month.y + month.height / 2) - (button.y + button.height / 2)) < 4, "one line: the sum left, Open Usage right");
  await page.keyboard.press("Escape");
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("fr"));
  await openList();
  assert.match(await foot.locator(".glance-month").innerText(), /^Ce mois-ci : environ /);
  assert.deepEqual(errors, []);
});
